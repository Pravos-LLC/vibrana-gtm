import { assertLiveProvidersAllowed } from "../demo-safety";
// X sources for the Signal Desk, read with the `bird` CLI on John's Mac (his X web session; no API key).
// Runs from `gtm signals collect-x` under launchd (collect only; the Vercel cron processes). launchd cannot read Safari's cookie file, so the job
// uses ~/.birdclaw/bird-keychain.sh, which passes the cookies from the Keychain (BIRD_COMMAND overrides).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SignalItem, SignalsConfig, SourceKind } from "./config";
import { decodeEntities } from "./sources";

type Tweet = {
  id: string; text: string; createdAt?: string; likeCount?: number; retweetCount?: number; replyCount?: number;
  author?: { username: string; name?: string }; quotedTweet?: { text?: string; author?: { username: string } };
};
type NewsItem = { id: string; headline: string; category?: string; postCount?: number; url: string };

export type BirdRunner = (args: string[]) => Promise<unknown>;

export function birdCommand(): string {
  if (process.env.BIRD_COMMAND) return process.env.BIRD_COMMAND;
  const wrapper = join(homedir(), ".birdclaw", "bird-keychain.sh");
  return existsSync(wrapper) ? wrapper : "bird";
}

export function birdRunner(command = birdCommand()): BirdRunner {
  const run = promisify(execFile);
  return async (args) => {
    assertLiveProvidersAllowed();
    const { stdout } = await run(command, [...args, "--json"], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    return JSON.parse(stdout);
  };
}

const tweets = (data: unknown): Tweet[] => (Array.isArray(data) ? data : (data as { tweets?: Tweet[] })?.tweets ?? []) as Tweet[];

/** "Sun Oct 04 08:33:36 +0000 2026" → ISO; null if unparseable. */
export function tweetDate(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function tweetItem(t: Tweet, kind: SourceKind, source: string): SignalItem | null {
  if (!t.id || !t.author?.username || !t.text) return null;
  // X returns tweet text HTML-encoded (&gt;, &amp;).
  const text = decodeEntities(t.text).replace(/\s+/g, " ").trim();
  const quoted = t.quotedTweet?.text ? ` Quoting @${t.quotedTweet.author?.username ?? "?"}: ${decodeEntities(t.quotedTweet.text).replace(/\s+/g, " ").trim()}` : "";
  return {
    url: `https://x.com/${t.author.username}/status/${t.id}`,
    source, source_kind: kind, author: `@${t.author.username}`,
    title: text.slice(0, 280), body: `${text}${quoted}`.slice(0, 4000),
    published_at: tweetDate(t.createdAt),
    metrics: { likes: t.likeCount ?? 0, retweets: t.retweetCount ?? 0, replies: t.replyCount ?? 0 },
  };
}

export function newsItem(n: NewsItem): SignalItem | null {
  const id = n.url?.match(/^twitter:\/\/trending\/(\d+)$/)?.[1] ?? n.id?.match(/(\d+)$/)?.[1];
  if (!id || !n.headline) return null;
  return {
    url: `https://x.com/i/trending/${id}`, source: `X news${n.category ? ` (${n.category})` : ""}`, source_kind: "x_news",
    title: n.headline, body: n.headline, metrics: { posts: n.postCount ?? 0 },
  };
}

const keep = (items: (SignalItem | null)[]) => items.filter((i): i is SignalItem => i !== null);

/** Every X source as a named job; RTs in a user's timeline are kept (what they amplify is signal). */
export function xJobs(cfg: SignalsConfig, bird: BirdRunner = birdRunner()): { name: string; run: () => Promise<SignalItem[]> }[] {
  const x = cfg.x;
  return [
    { name: "x:bookmarks", run: async () => keep(tweets(await bird(["bookmarks", "-n", String(x.bookmarks)])).map((t) => tweetItem(t, "x_bookmark", "John's X bookmarks"))) },
    { name: "x:likes", run: async () => keep(tweets(await bird(["likes", "-n", String(x.likes)])).map((t) => tweetItem(t, "x_like", "John's X likes"))) },
    { name: "x:news", run: async () => keep(((await bird(["news", "-n", String(x.news.count), ...(x.news.ai_only ? ["--ai-only"] : [])])) as NewsItem[]).map(newsItem)) },
    ...x.searches.map((s) => ({ name: `x:search:${s.query.slice(0, 40)}`, run: async () => keep(tweets(await bird(["search", s.query, "-n", "20"])).map((t) => tweetItem(t, "x_search", "X search"))) })),
    ...x.users.map((u) => ({ name: `x:user:${u}`, run: async () => keep(tweets(await bird(["user-tweets", u, "-n", "10"])).map((t) => tweetItem(t, "x_user", `X @${u}`))) })),
  ];
}
