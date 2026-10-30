import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// What a commenter linked to (VIB-428). John: "read their stuff and talk about it back to them". When a comment
// carries a link, the drafting run reads the page through Firecrawl (so this server never fetches a URL a
// stranger chose), hands the text to the drafting call as data, and keeps the model's short summary on the row
// (gtm_comments.linked) for the card. The page itself is never stored.

export type LinkedPage = { url: string; title: string | null; text: string };
export type Linked = { url: string; title: string | null; summary: string };
export type PageReader = (url: string, opts?: { timeoutMs?: number }) => Promise<LinkedPage | null>;

/** Links read per comment, characters of each page the drafting call sees, and of all pages in one call. */
export const MAX_LINKS = 2;
export const PAGE_CHARS = 6000;
export const CALL_PAGE_CHARS = 24_000;
/** Sizes kept on the row; with MAX_LINKS they stay well under the column's 4,000-character check. */
const URL_CHARS = 400, TITLE_CHARS = 150, SUMMARY_CHARS = 500;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}]+/gi;
// Media and profile links carry nothing to read; a LinkedIn post or profile page is behind a login wall.
// Video pages carry nothing a page read can use.
const SKIP = /\.(?:png|jpe?g|gif|webp|svg|mp4|mov|pdf)(?:$|[?#])|^https?:\/\/(?:[^/]+\.)?(?:linkedin\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|youtube\.com|youtu\.be|tiktok\.com)\//i;

/** The http(s) links in a comment, cleaned of trailing punctuation, deduped, at most MAX_LINKS. */
export function commentLinks(text: string, max = MAX_LINKS): string[] {
  const out: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    let u = m.replace(/[.,;:!?…]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try { u = new URL(u).toString(); } catch { continue; }
    if (u.length > URL_CHARS || SKIP.test(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** Firecrawl's scrape endpoint: main content as markdown, JS pages rendered, cached up to a day on their side. */
export function firecrawlReader(opts: { key?: string; fetcher?: typeof fetch } = {}): PageReader | null {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  return async (url, call = {}) => {
    const res = await providerFetch(opts.fetcher)("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, maxAge: 86_400_000, timeout: Math.max(5000, (call.timeoutMs ?? 25_000) - 2000) }),
      signal: AbortSignal.timeout(call.timeoutMs ?? 25_000),
    });
    // Our side (bad key, out of credits, rate limit) is worth knowing; a page that will not load is not.
    if ([401, 402, 403, 429].includes(res.status)) throw new ReaderError(`Firecrawl ${res.status}${res.status === 402 ? " (out of credits)" : ""}`);
    const data = await res.json().catch(() => null) as { success?: boolean; data?: { markdown?: string; metadata?: { title?: string; statusCode?: number } } } | null;
    const md = data?.data?.markdown;
    if (!res.ok || !md || (data?.data?.metadata?.statusCode ?? 200) >= 400) return null;
    return { url, title: data?.data?.metadata?.title?.slice(0, 200) ?? null, text: cleanPage(md) };
  };
}

export class ReaderError extends Error {}

/** Markdown down to readable text: no images, links kept as their words, capped at PAGE_CHARS. */
export function cleanPage(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, PAGE_CHARS);
}

/** Reads every target's links once per run, in parallel, within the time left. Failures just mean no page. */
export async function readLinks(texts: { id: string; text: string }[], read: PageReader | null, opts: { cache?: Map<string, Promise<LinkedPage | null>>; timeoutMs?: number; errors?: Set<string> } = {}) {
  const out = new Map<string, LinkedPage[]>();
  if (!read) return out;
  const cache = opts.cache ?? new Map<string, Promise<LinkedPage | null>>();
  const fetched = await Promise.all(texts.map(async (t) => {
    const urls = commentLinks(t.text);
    const pages = await Promise.all(urls.map((u) => {
      if (!cache.has(u)) cache.set(u, read(u, { timeoutMs: opts.timeoutMs }).catch((e) => { if (e instanceof ReaderError) opts.errors?.add(e.message); return null; }));
      return cache.get(u)!;
    }));
    return { id: t.id, pages: pages.filter((p): p is LinkedPage => !!p) };
  }));
  // One call sees at most CALL_PAGE_CHARS of pages: a post with many link comments still drafts, the later
  // comments just go without their page.
  let budget = CALL_PAGE_CHARS;
  for (const f of fetched) {
    const fit = f.pages.filter((p) => { if (p.text.length > budget) return false; budget -= p.text.length; return true; });
    if (fit.length) out.set(f.id, fit);
  }
  return out;
}

/** Two spellings of the same link (a trailing slash, the host's case) count as one. */
export const sameUrl = (a: string, b: string) => {
  const n = (u: string) => { try { const x = new URL(u.trim()); return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return u.trim().replace(/\/+$/, ""); } };
  return n(a) === n(b);
};

/** The model's summaries, kept only for pages we actually read, short and dash-free. */
export function linkedFor(pages: LinkedPage[] | undefined, summaries: { url: string; summary: string }[] | undefined, clean: (s: string) => string): Linked[] | null {
  if (!pages?.length) return null;
  return pages.map((p) => {
    const s = summaries?.find((x) => sameUrl(x.url, p.url)) ?? (pages.length === 1 ? summaries?.[0] : undefined);
    return { url: p.url.slice(0, URL_CHARS), title: p.title ? clean(p.title).slice(0, TITLE_CHARS) : null, summary: clean(s?.summary ?? "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_CHARS) };
  });
}
