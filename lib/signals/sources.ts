import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Open-web fetchers for the Signal Desk. Each returns normalized SignalItems or throws; the collector
// runs them side by side and records per-source counts, so one broken feed never sinks the run.
// Only feeds and public APIs meant for programmatic reading are used (no page scraping); Reddit falls
// back to fetching the same feed URL through TinyFish when it refuses John's Mac.
import type { FeedSource, SignalItem, SignalsConfig } from "./config";

const UA = "Mozilla/5.0 (compatible; vibrana-signals/1.0; +https://brand.example.com)";
const TIMEOUT_MS = 15_000;

type Fetcher = typeof fetch;

async function getText(url: string, fetcher: Fetcher, accept = "*/*"): Promise<string> {
  const res = await providerFetch(fetcher)(url, { headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.text();
}

async function getJson<T>(url: string, fetcher: Fetcher, headers: Record<string, string> = {}): Promise<T> {
  const res = await providerFetch(fetcher)(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.json() as Promise<T>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function stripHtml(s: string): string {
  return decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Drops tracking parameters and fragments so the same article from two feeds dedupes. */
export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|s$|smid$|cmpid$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export type FeedEntry = { title: string; link: string; published: string | null; summary: string; author: string | null };

const tag = (block: string, name: string) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1];

/** Parses RSS 2.0 <item> and Atom <entry> elements. Tolerant by design: feeds in the wild are messy. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedEntry[] = [];
  for (const block of blocks) {
    const atomLink = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1]
      ?? block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const link = decodeEntities((tag(block, "link")?.trim() || atomLink || tag(block, "guid") || "").trim());
    const title = stripHtml(tag(block, "title") ?? "");
    if (!link || !title) continue;
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date");
    const parsed = date ? new Date(decodeEntities(date).trim()) : null;
    out.push({
      title, link,
      published: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      summary: stripHtml(tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? tag(block, "content:encoded") ?? "").slice(0, 2000),
      author: stripHtml(tag(block, "dc:creator") ?? tag(block, "name") ?? tag(block, "author") ?? "") || null,
    });
  }
  return out;
}

function feedItems(entries: FeedEntry[], source: string, kind: SignalItem["source_kind"], max = 50): SignalItem[] {
  const out: SignalItem[] = [];
  for (const e of entries.slice(0, max)) {
    const url = canonicalUrl(e.link);
    if (url) out.push({ url, source, source_kind: kind, author: e.author, title: e.title, body: e.summary, published_at: e.published });
  }
  return out;
}

export async function fetchFeed(feed: FeedSource, fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  return feedItems(parseFeed(await getText(feed.url, fetcher, "application/rss+xml, application/atom+xml, application/xml, text/xml")), feed.name, "rss");
}

export async function fetchArxiv(cfg: SignalsConfig["sources"]["arxiv"], fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  const cats = cfg.categories.map((c) => `cat:${c}`).join(" OR ");
  const q = encodeURIComponent(`(${cats}) AND (${cfg.query})`);
  const xml = await getText(`https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=${cfg.max}`, fetcher);
  return feedItems(parseFeed(xml), "arXiv", "arxiv", cfg.max);
}

type HnHit = { objectID: string; title: string | null; url: string | null; points: number; num_comments: number; author: string; created_at: string };

export async function fetchHn(cfg: SignalsConfig["sources"]["hn"], fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  const data = await getJson<{ hits: HnHit[] }>(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${cfg.max}`, fetcher);
  const out: SignalItem[] = [];
  for (const hit of data.hits) {
    if (!hit.title || hit.points < cfg.min_points) continue;
    const url = canonicalUrl(hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`);
    if (url) out.push({ url, source: "Hacker News", source_kind: "hn", author: hit.author, title: hit.title, published_at: hit.created_at, metrics: { points: hit.points, comments: hit.num_comments } });
  }
  return out;
}

type GhRepo = { html_url: string; full_name: string; description: string | null; stargazers_count: number; forks_count: number; created_at: string; owner: { login: string }; topics?: string[] };

export async function fetchGithub(cfg: SignalsConfig["sources"]["github"], fetcher: Fetcher = fetch, now = new Date()): Promise<SignalItem[]> {
  const since = new Date(now.getTime() - cfg.created_within_days * 86_400_000).toISOString().slice(0, 10);
  const headers: Record<string, string> = { "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const seen = new Map<string, SignalItem>();
  for (const topic of cfg.topics) {
    const q = encodeURIComponent(`topic:${topic} created:>=${since} stars:>=${cfg.min_stars}`);
    const data = await getJson<{ items: GhRepo[] }>(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${cfg.max}`, fetcher, headers);
    for (const repo of data.items) {
      const ageDays = Math.max(1, (now.getTime() - new Date(repo.created_at).getTime()) / 86_400_000);
      seen.set(repo.html_url, {
        url: repo.html_url, source: "GitHub", source_kind: "github", author: repo.owner.login,
        title: `${repo.full_name}: ${repo.description ?? "new repository"}`.slice(0, 1000),
        body: (repo.topics ?? []).join(", "), published_at: repo.created_at,
        metrics: { stars: repo.stargazers_count, forks: repo.forks_count, stars_per_day: Math.round(repo.stargazers_count / ageDays) },
      });
    }
  }
  return [...seen.values()].sort((a, b) => (b.metrics?.stars_per_day ?? 0) - (a.metrics?.stars_per_day ?? 0)).slice(0, cfg.max);
}

type HfPaper = { paper: { id: string; title: string; summary?: string; upvotes?: number }; publishedAt?: string };

export async function fetchHfPapers(cfg: SignalsConfig["sources"]["hf_papers"], fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  const data = await getJson<HfPaper[]>("https://huggingface.co/api/daily_papers", fetcher);
  return data.slice(0, cfg.max).map((p) => ({
    url: `https://huggingface.co/papers/${p.paper.id}`, source: "Hugging Face papers", source_kind: "hf" as const,
    title: p.paper.title, body: (p.paper.summary ?? "").slice(0, 2000), published_at: p.publishedAt ?? null,
    metrics: { upvotes: p.paper.upvotes ?? 0 },
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TinyFish fetches a URL from its own network and hands back the body. Reddit lets an anonymous caller
 * read about one feed a minute, so it falls back to TinyFish (TINY_FISH_API_KEY, from the Tessera root
 * env) when refused.
 */
export async function tinyfishText(url: string, fetcher: Fetcher = fetch, key: string | undefined = undefined): Promise<string> {
  assertLiveProvidersAllowed();
  key ??= process.env.TINY_FISH_API_KEY;
  if (!key) throw new Error("no TINY_FISH_API_KEY for the TinyFish fallback");
  const res = await providerFetch(fetcher)("https://agent.tinyfish.ai/v1/fetch", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ urls: [url], format: "html" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`tinyfish ${res.status}`);
  const data = (await res.json()) as { results?: { text?: string }[]; errors?: { error: string; status?: number }[] };
  const err = data.errors?.[0];
  if (err) throw new Error(`tinyfish: ${err.error}${err.status ? ` ${err.status}` : ""}`);
  return unwrapFetched(data.results?.[0]?.text ?? "");
}

/**
 * TinyFish's html format returns a raw (non-HTML) body escaped once inside <pre> or <blockquote>. Its
 * markdown format is not used: it backslash-escapes `_` and `*`, which breaks every feed link.
 */
export function unwrapFetched(html: string): string {
  const inner = html.match(/<(pre|blockquote)[^>]*>([\s\S]*)<\/\1>/i)?.[2] ?? html;
  return inner.replace(/&(lt|gt|amp|quot|#39|apos);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: "\"", "#39": "'", apos: "'" })[e] ?? _);
}

/**
 * Google News search feeds, one per query (boolean syntax: quotes, OR, parentheses), last two days. They
 * replace GDELT, which refused every network we tried (John's Mac, Vercel, TinyFish). Items are stored as
 * `rss`: the link is a news.google.com redirect, so the publisher comes from <source> and leaves the title.
 */
export async function fetchGoogleNews(cfg: SignalsConfig["sources"]["google_news"], fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  const out = new Map<string, SignalItem>();
  for (const query of cfg.queries) {
    const q = encodeURIComponent(`${query} when:2d`);
    const xml = await getText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, fetcher, "application/rss+xml");
    for (const block of (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []).slice(0, cfg.max_per_query)) {
      const [entry] = parseFeed(block);
      const url = entry && canonicalUrl(entry.link);
      if (!url || !entry.title) continue;
      const publisher = stripHtml(tag(block, "source") ?? "");
      const title = publisher && entry.title.endsWith(` - ${publisher}`) ? entry.title.slice(0, -publisher.length - 3) : entry.title;
      out.set(url, { url, source: publisher || "Google News", source_kind: "rss", title, published_at: entry.published });
    }
  }
  return [...out.values()];
}

/**
 * One subreddit feed. Reddit gives an anonymous caller about one feed a minute and says when the window
 * resets (x-ratelimit-reset, seconds): wait for it once, then fall back to TinyFish.
 */
async function redditFeed(url: string, fetcher: Fetcher, wait: (ms: number) => Promise<unknown>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await providerFetch(fetcher)(url, { headers: { "user-agent": UA, accept: "application/atom+xml" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return res.text();
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.status === 429 && attempt === 0 && reset > 0 && reset <= 60) {
      await wait((reset + 1) * 1000);
      continue;
    }
    try {
      return await tinyfishText(url, fetcher);
    } catch (e) {
      throw new Error(`${res.status} from www.reddit.com; ${(e as Error).message}`);
    }
  }
}

export async function fetchReddit(cfg: SignalsConfig["sources"]["reddit"], fetcher: Fetcher = fetch, wait: (ms: number) => Promise<unknown> = sleep): Promise<SignalItem[]> {
  const out: SignalItem[] = [];
  for (const sub of cfg.subreddits) {
    const xml = await redditFeed(`https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=${cfg.max}`, fetcher, wait);
    out.push(...feedItems(parseFeed(xml), `r/${sub}`, "reddit", cfg.max));
  }
  return out;
}

type BskyPost = {
  uri: string; indexedAt: string; author: { handle: string; displayName?: string };
  record: { text?: string; createdAt?: string };
  embed?: { external?: { uri: string; title?: string; description?: string } };
  likeCount?: number; repostCount?: number;
};

/** Public Bluesky author feeds (no login). Reposts count: what these researchers amplify is signal. */
export async function fetchBluesky(cfg: SignalsConfig["sources"]["bluesky"], fetcher: Fetcher = fetch): Promise<SignalItem[]> {
  const out: SignalItem[] = [];
  for (const account of cfg.accounts) {
    const data = await getJson<{ feed: { post: BskyPost; reason?: unknown }[] }>(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(account.handle)}&limit=${cfg.per_account}&filter=posts_no_replies`, fetcher);
    for (const { post, reason } of data.feed) {
      const rkey = post.uri.split("/").pop();
      const text = (post.record.text ?? "").trim();
      const ext = post.embed?.external;
      const title = text || ext?.title || "";
      if (!rkey || !title) continue;
      out.push({
        url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
        source: reason ? `Bluesky (shared by ${account.name})` : "Bluesky",
        source_kind: "bluesky", author: post.author.displayName || post.author.handle,
        title: title.slice(0, 280),
        body: [text.length > 280 ? text : "", ext ? `${ext.title ?? ""} ${ext.description ?? ""} ${ext.uri}` : ""].join(" ").trim().slice(0, 2000),
        published_at: post.record.createdAt ?? post.indexedAt,
        metrics: { likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0 },
      });
    }
  }
  return out;
}

/** Every open-web source as a named job, so the collector can count and time each one separately. */
export function webJobs(cfg: SignalsConfig, fetcher: Fetcher = fetch): { name: string; run: () => Promise<SignalItem[]> }[] {
  return [
    ...cfg.sources.rss.map((feed) => ({ name: `rss:${feed.name}`, run: () => fetchFeed(feed, fetcher) })),
    { name: "arxiv", run: () => fetchArxiv(cfg.sources.arxiv, fetcher) },
    { name: "hn", run: () => fetchHn(cfg.sources.hn, fetcher) },
    { name: "github", run: () => fetchGithub(cfg.sources.github, fetcher) },
    { name: "hf_papers", run: () => fetchHfPapers(cfg.sources.hf_papers, fetcher) },
    { name: "google_news", run: () => fetchGoogleNews(cfg.sources.google_news, fetcher) },
    { name: "reddit", run: () => fetchReddit(cfg.sources.reddit, fetcher) },
    { name: "bluesky", run: () => fetchBluesky(cfg.sources.bluesky, fetcher) },
  ];
}
