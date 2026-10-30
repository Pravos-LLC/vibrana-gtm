import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Who a comment is from (VIB-424), from cheap signals only: the name or handle the comment carries, and a
// yes/no from the CRM. Never scrapes a profile and never copies CRM data: Twenty answers with a count, and
// only the match level ("none" | "contact" | "icp") is stored on the comment.
import type { CrmMatch } from "./parse";

const BASE = () => process.env.TWENTY_BASE ?? "https://brand.example.com";
/** ICP: a CRM person the qualification pipeline marked as an offer fit. */
const ICP_FILTER = "{gtmOfferFit:{in:[PROTOTYPE,WORKFLOW,BOTH]}}";

/** A GraphQL string literal (JSON escaping is valid GraphQL) for an exact, case-insensitive ilike. */
const lit = (s: string) => JSON.stringify(s.replace(/[\\%_]/g, (m) => `\\${m}`));

/** The filters that identify this person, strongest first; empty when the comment carries too little. */
export function crmFilters(author: { name: string | null; username: string | null; platform: string }): string[] {
  const out: string[] = [];
  const handle = author.username?.replace(/^@/, "").trim();
  if (handle && author.platform === "linkedin" && /^[a-z0-9-]{3,100}$/i.test(handle)) out.push(`{linkedinLink:{primaryLinkUrl:{ilike:${lit(`%/in/${handle}%`)}}}}`);
  if (handle && (author.platform === "twitter" || author.platform === "x") && /^\w{2,30}$/.test(handle)) out.push(`{xLink:{primaryLinkUrl:{ilike:${lit(`%/${handle}`)}}}}`);
  // A full name needs two parts: a single word ("Sam") would match half the CRM.
  const parts = (author.name ?? "").normalize("NFC").replace(/[^\p{L}\p{M}\s'’-]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) out.push(`{and:[{name:{firstName:{ilike:${lit(parts[0])}}}},{name:{lastName:{ilike:${lit(parts.slice(1).join(" "))}}}}]}`);
  return out;
}

type Count = (filter: string) => Promise<number>;

function twentyCount(): Count | null {
  assertLiveProvidersAllowed();
  const token = process.env.TWENTY_API_KEY;
  if (!token) return null;
  return async (filter) => {
    const res = await providerFetch()(`${BASE()}/graphql`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: `{ people(filter:${filter}) { totalCount } }` }),
    });
    const json = await res.json().catch(() => null) as { data?: { people?: { totalCount?: number } }; errors?: unknown } | null;
    if (!res.ok || json?.errors || typeof json?.data?.people?.totalCount !== "number") throw new Error(`Twenty ${res.status}`);
    return json.data.people.totalCount;
  };
}

/**
 * Is this author a CRM person, and an ICP one? null when the CRM is not configured or the comment carries
 * too little to match on (the card then shows nothing rather than a guess).
 */
export async function crmMatch(author: { name: string | null; username: string | null; platform: string }, count: Count | null = twentyCount()): Promise<CrmMatch | null> {
  if (!count) return null;
  const filters = crmFilters(author);
  if (!filters.length) return null;
  for (const f of filters) {
    if ((await count(f)) > 0) return (await count(`{and:[${f},${ICP_FILTER}]}`)) > 0 ? "icp" : "contact";
  }
  return "none";
}

/** One lookup per author per run. */
export function crmMatcher(count: Count | null = twentyCount()) {
  const cache = new Map<string, Promise<CrmMatch | null>>();
  return (a: { name: string | null; username: string | null; platform: string }) => {
    const key = `${a.platform}|${(a.username ?? "").toLowerCase()}|${(a.name ?? "").toLowerCase()}`;
    if (!cache.has(key)) cache.set(key, crmMatch(a, count).catch(() => null));
    return cache.get(key)!;
  };
}

/** The stable identity of a commenter on one platform, for "has commented before". */
export const authorKey = (c: { platform: string; author_id?: string | null; author_username?: string | null; author_name?: string | null }) =>
  `${c.platform}|${(c.author_id ?? c.author_username ?? c.author_name ?? "?").toLowerCase()}`;
