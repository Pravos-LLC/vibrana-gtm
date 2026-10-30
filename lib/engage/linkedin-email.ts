import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// LinkedIn email intake (VIB-423). Zernio reads comments on LinkedIn posts it published, but not on
// posts John made natively in LinkedIn. For those, LinkedIn's "X commented on your post" notification
// email is the only machine-readable trace. A job on the Hermes box (or the Mac) reads those emails with
// the `gog` CLI, parses them here, and POSTs the comments to the cockpit's /api/engage/intake.
// Pure parsing below; the gog and HTTP calls are at the bottom.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
export type GmailMessage = { id: string; internalDate?: string; payload?: GmailPart };

export type LinkedInEmailComment = {
  gmail_id: string;
  kind: "commented" | "replied" | "mentioned";
  author_name: string;
  /** The comment text, or null when the email did not carry it (the card then says "open it"). */
  text: string | null;
  activity_urn: string | null;
  /** Normalized to Zernio's form, urn:li:comment:(urn:li:activity:A,C), so both intakes dedupe. */
  comment_urn: string | null;
  comment_url: string | null;
  post_url: string | null;
  received_at: string | null;
};

const POST = "(?: on (?:your|a|the|their) post)?";
const SUBJECT = new RegExp(`^(.+?)(?: and \\d+ others?)? (commented on your post|replied to (?:your|a) comment${POST}|mentioned you in a comment${POST})(?:$|[\\s.:!])`, "i");

export function parseSubject(subject: string): { author: string; kind: LinkedInEmailComment["kind"] } | null {
  const m = SUBJECT.exec(subject.trim());
  if (!m) return null;
  const verb = m[2].toLowerCase();
  // Display names carry pronouns and emoji ("Sam Okafor (He/Him) 🏄"); keep the name.
  const author = m[1].normalize("NFC").replace(/\s*\((?:he|she|they)\/\w+\)/gi, "").replace(/[^\p{L}\p{N}\s.'’-]/gu, "").replace(/\s+/g, " ").trim();
  return { author: author || m[1].trim(), kind: verb.startsWith("replied") ? "replied" : verb.startsWith("mentioned") ? "mentioned" : "commented" };
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(p: GmailPart | undefined, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) { const r = findPart(c, mime); if (r) return r; }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `${inner} ${href}\n`)
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, entity);
}

function entity(m: string, e: string): string {
  try {
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
  } catch { return m; }
  return ENTITIES[e.toLowerCase()] ?? m;
}
/** LinkedIn's plain-text part also carries HTML entities (&#39;) and non-breaking spaces. */
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, entity).replace(/\u00a0/g, " ");

/** The post and comment ids from any LinkedIn link in the email (tracking parameters dropped). */
export function linkedinIds(body: string): { activity: string | null; commentUrn: string | null; rawComment: string | null } {
  const text = body.replace(/%3A/gi, ":").replace(/%28/gi, "(").replace(/%29/gi, ")").replace(/%2C/gi, ",");
  const act = /urn:li:(activity|ugcPost|share):(\d{6,})/.exec(text) ?? /feed\/update\/(activity):(\d{6,})/.exec(text);
  const com = /urn:li:comment:\((?:urn:li:)?(activity|ugcPost|share):(\d{6,}),(\d{6,})\)/.exec(text);
  return {
    activity: act ? `urn:li:${act[1]}:${act[2]}` : null,
    commentUrn: com ? `urn:li:comment:(urn:li:${com[1]}:${com[2]},${com[3]})` : null,
    rawComment: com ? `urn:li:comment:(${com[1]}:${com[2]},${com[3]})` : null,
  };
}

const BOILERPLATE = [
  /^[-=_.·•]{4,}$/, /intended for/i, /learn why we included/i, /unsubscribe/i, /^©/, /linkedin corporation/i,
  /you are receiving/i, /^help:/i, /^\d+\s+(likes?|comments?|reactions?|reposts?)\b/i, /^(reply|like|view (post|comment|all comments)|see more|see comment)$/i,
  /^your post:/i, /^on your post\b/i, /^view .{1,60}'s comment/i, /^(get the new linkedin|linkedin app)/i,
];

/** Pulls the comment text out of the email body: a quoted line first, else the longest non-boilerplate line. */
export function commentText(body: string, author: string, subject: string): string | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const authorLc = author.toLowerCase();
  const candidates: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lc = l.toLowerCase();
    if (/https?:\/\//.test(l) && l.replace(/\S*https?:\/\/\S+/g, "").trim().length < 15) continue;
    if (lc === subject.trim().toLowerCase() || lc.startsWith(`${authorLc} commented`) || lc.startsWith(`${authorLc} replied`)) continue;
    if (BOILERPLATE.some((r) => r.test(l))) continue;
    // The author's name line, and the headline under it ("Head of Ops at Example"), are not the comment.
    if (lc === authorLc || lc.startsWith(`${authorLc} ·`) || lc.startsWith(`${authorLc} •`)) { if (lines[i + 1] && !/^["“]/.test(lines[i + 1])) i++; continue; }
    candidates.push(l.replace(/\s*\S*https?:\/\/\S+/g, "").trim());
  }
  const quoted = candidates.find((l) => /^["“].+["”]$/.test(l));
  const best = quoted ?? candidates.filter((l) => l.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!best) return null;
  return decode(best).replace(/^["“]\s*/, "").replace(/\s*["”]$/, "").replace(/\s+/g, " ").trim() || null;
}

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** One notification email → a comment, or null when the email is not a comment notification. */
export function parseLinkedInEmail(m: GmailMessage): LinkedInEmailComment | null {
  const subject = header(m, "Subject");
  const from = header(m, "From");
  if (from && !/linkedin\.com/i.test(from)) return null;
  const s = parseSubject(subject);
  if (!s) return null;
  const plain = findPart(m.payload, "text/plain");
  const html = findPart(m.payload, "text/html");
  const body = plain ?? (html ? htmlToText(html) : "");
  const ids = linkedinIds(`${plain ?? ""}\n${html ?? ""}`);
  const postUrl = ids.activity ? `https://www.linkedin.com/feed/update/${ids.activity}/` : null;
  return {
    gmail_id: m.id, kind: s.kind, author_name: s.author,
    text: commentText(body, s.author, subject),
    activity_urn: ids.activity, comment_urn: ids.commentUrn,
    comment_url: postUrl && ids.rawComment ? `${postUrl}?commentUrn=${encodeURIComponent(ids.rawComment)}` : postUrl,
    post_url: postUrl,
    received_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
  };
}

/** The intake payload's external id: the comment URN, else a hash of the Gmail message id. */
export function emailExternalId(c: Pick<LinkedInEmailComment, "comment_urn" | "gmail_id">): string {
  return c.comment_urn ?? `email:${createHash("sha256").update(c.gmail_id).digest("hex").slice(0, 32)}`;
}

// ---- gog (Gmail) and the cockpit endpoint -----------------------------------------------------

export const GMAIL_QUERY = "from:linkedin.com (subject:\"commented on your post\" OR subject:\"replied to your comment\" OR subject:\"mentioned you in a comment\")";

type Exec = (cmd: string, args: string[]) => string;
const run: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });

/** Reads the notification emails of the last `days` days through gog (read-only). */
export function readLinkedInEmails(opts: { days?: number; account?: string; gog?: string; exec?: Exec } = {}): { comments: LinkedInEmailComment[]; emails: number; skipped: number } {
  assertLiveProvidersAllowed();
  const exec = opts.exec ?? run;
  const gog = opts.gog ?? process.env.GOG_COMMAND ?? "gog";
  const acct = opts.account ? ["--account", opts.account] : [];
  const search = JSON.parse(exec(gog, ["gmail", "search", `${GMAIL_QUERY} newer_than:${opts.days ?? 3}d`, "--max", "100", "-j", "--results-only", "--no-input", ...acct]) || "[]");
  const threads = (Array.isArray(search) ? search : search.threads ?? []) as { id: string }[];
  const comments: LinkedInEmailComment[] = [];
  let emails = 0, skipped = 0;
  for (const t of threads) {
    const r = JSON.parse(exec(gog, ["gmail", "thread", "get", t.id, "-j", "--no-input", ...acct])) as { thread?: { messages?: GmailMessage[] } };
    for (const m of r.thread?.messages ?? []) {
      emails++;
      const c = parseLinkedInEmail(m);
      if (c) comments.push(c); else skipped++;
    }
  }
  return { comments, emails, skipped };
}

/** POSTs parsed comments to the cockpit (CRON_SECRET bearer). */
export async function postIntake(comments: LinkedInEmailComment[], opts: { url?: string; secret?: string; fetcher?: typeof fetch } = {}) {
  const base = opts.url ?? process.env.GTM_COCKPIT_URL;
  const secret = opts.secret ?? process.env.CRON_SECRET;
  if (!base || !secret) throw new Error("GTM_COCKPIT_URL and CRON_SECRET are required to post the LinkedIn intake");
  const res = await providerFetch(opts.fetcher)(`${base.replace(/\/$/, "")}/api/engage/intake`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ comments }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({})) as { inserted?: number; duplicates?: number; error?: string };
  if (!res.ok) throw new Error(`intake ${res.status}: ${data.error ?? "failed"}`);
  return data;
}
