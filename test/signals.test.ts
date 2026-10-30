// Signal Desk: the pure rules (feed parsing, freshness, Clef interpretation, clustering, scoring,
// brief checks, digest escaping, access) and the cron routes' auth gate. Nothing here reaches a service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBrief, briefPrompt } from "../lib/signals/brief.ts";
import { nextState } from "../lib/signals/actions.ts";
import { signalsViewer, teamMayOpen } from "../lib/signals/access.ts";
import { signalsConfig, validateConfig, type Brief, type SignalsConfig } from "../lib/signals/config.ts";
import { digestHtml, digestSubject, digestText } from "../lib/signals/digest.ts";
import { isFresh } from "../lib/signals/pipeline.ts";
import { assignClusters, clefQuestions, clefState, cosine, interpret, laneTaste, scoreStory, storyTitle, type ItemRow } from "../lib/signals/rank.ts";
import { canonicalUrl, decodeEntities, parseFeed, stripHtml } from "../lib/signals/sources.ts";
import { newsItem, tweetDate, tweetItem } from "../lib/signals/x.ts";

const cfg = signalsConfig();
const NOW = new Date("2026-10-05T12:00:00Z");

test("the shipped signals.json is valid and fits Clef's 64-question limit", () => {
  assert.deepEqual(validateConfig(cfg), []);
  assert.ok(Object.keys(clefQuestions(cfg)).length <= 64);
});

test("validateConfig names unknown lanes, bad thresholds and non-questions", () => {
  const bad: SignalsConfig = structuredClone(cfg);
  bad.lanes[0].threshold = 1.5;
  bad.lanes[1].question = "Not a question";
  bad.sources.rss[0].lanes = ["nope"];
  const problems = validateConfig(bad).join("\n");
  assert.match(problems, /threshold/);
  assert.match(problems, /must be a question/);
  assert.match(problems, /unknown lane nope/);
});

test("parseFeed reads RSS items and Atom entries, decoding CDATA and entities", () => {
  const rss = `<rss><channel><item><title><![CDATA[Grid &amp; AI]]></title><link>https://a.test/1?utm_source=x</link>
    <pubDate>Sun, 04 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Utilities warn&lt;/p&gt;</description><dc:creator>Ana</dc:creator></item></channel></rss>`;
  const [item] = parseFeed(rss);
  assert.equal(item.title, "Grid & AI");
  assert.equal(item.link, "https://a.test/1?utm_source=x");
  assert.equal(item.published, "2026-10-04T08:00:00.000Z");
  assert.equal(item.summary, "Utilities warn");
  assert.equal(item.author, "Ana");
  const atom = `<feed><entry><title>Prompt injection</title><link rel="alternate" href="https://b.test/post"></link>
    <published>2026-10-03T10:00:00Z</published><summary>Agents leak</summary></entry></feed>`;
  assert.deepEqual(parseFeed(atom).map((e) => [e.title, e.link]), [["Prompt injection", "https://b.test/post"]]);
  assert.deepEqual(parseFeed("<item><title>No link</title></item>"), []);
});

test("canonicalUrl strips tracking and fragments and refuses non-http schemes", () => {
  assert.equal(canonicalUrl("https://a.test/x?utm_medium=e&id=3&fbclid=9#top"), "https://a.test/x?id=3");
  assert.equal(canonicalUrl("javascript:alert(1)"), null);
  assert.equal(canonicalUrl("not a url"), null);
  assert.equal(decodeEntities("&#8217;&#x2019;&amp;"), "’’&");
  assert.equal(stripHtml("<b>a</b>  <i>b</i>"), "a b");
});

test("isFresh drops archive entries but keeps undated items and recent GitHub repos", () => {
  const base = { url: "https://a.test", source: "s", title: "t" } as const;
  assert.equal(isFresh({ ...base, source_kind: "rss", published_at: "2023-01-01T00:00:00Z" }, 96, NOW), false);
  assert.equal(isFresh({ ...base, source_kind: "rss", published_at: "2026-10-04T00:00:00Z" }, 96, NOW), true);
  assert.equal(isFresh({ ...base, source_kind: "rss" }, 96, NOW), true);
  assert.equal(isFresh({ ...base, source_kind: "github", published_at: "2026-09-29T00:00:00Z" }, 96, NOW), true);
});

const answers = (lanes: Record<string, number>, flags: Record<string, number>) => Object.fromEntries([
  ...Object.entries(lanes).map(([k, v]) => [`lane.${k}`, { type: "noul" as const, noul: v }]),
  ...Object.entries(flags).map(([k, v]) => [`flag.${k}`, { type: "noul" as const, noul: v }]),
]);

test("interpret: relevant when a lane clears its threshold and the item has substance", () => {
  const hit = interpret(cfg, answers({ power: 0.91, privacy: 0.01 }, { substance: 0.8, novel: 0.7 }));
  assert.equal(hit.relevant, true);
  assert.equal(hit.lanes.power, 0.91);
  assert.equal(interpret(cfg, answers({ power: 0.4 }, { substance: 0.9 })).relevant, false, "no lane over threshold");
  assert.equal(interpret(cfg, answers({ power: 0.95 }, { substance: 0.1 })).relevant, false, "hype or an ad");
});

test("clefState leads with title, source and author and caps the length", () => {
  const state = clefState({ title: "T", source: "DCD", author: "Ana", body: "x".repeat(10_000) });
  assert.ok(state.startsWith("T\nDCD · Ana\n\n"));
  assert.ok(state.length <= 6000);
});

test("assignClusters: above the cutoff joins, in the grey zone the judge decides, below the floor starts a story", async () => {
  const stories = [{ id: "s1", centroid: [1, 0, 0], item_count: 1, title: "Kolibri launches" }];
  const judged: string[] = [];
  let n = 0;
  const { assignment, stories: out, judged: count } = await assignClusters([
    { id: "close", embedding: [0.99, 0.05, 0], title: "Kolibri is out" },
    { id: "grey-yes", embedding: [0.7, 0.7, 0], title: "Germany's open model" },
    { id: "grey-no", embedding: [0.7, 0, 0.7], title: "Unrelated" },
    { id: "far", embedding: [0, 0, 1], title: "Far" },
  ], stories, { cutoff: 0.95, floor: 0.6, newId: () => `new${++n}`, judge: async (item) => { judged.push(item.id); return item.id === "grey-yes"; } });
  assert.equal(assignment.get("close"), "s1");
  assert.equal(assignment.get("grey-yes"), "s1");
  assert.equal(assignment.get("grey-no"), "new1");
  assert.equal(assignment.get("far"), "new2", "0.71 to grey-no's story is grey, and the judge said no");
  assert.ok(judged.includes("grey-yes") && judged.includes("grey-no") && judged.includes("far"));
  assert.equal(count, judged.length);
  assert.equal(out.find((s) => s.id === "s1")!.item_count, 3);
  assert.equal(stories[0].item_count, 1, "inputs are not mutated");
});

test("cosine is 1 for identical direction, 0 for orthogonal or empty", () => {
  assert.equal(cosine([1, 2], [2, 4]).toFixed(6), "1.000000");
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

const item = (over: Partial<ItemRow>): ItemRow => ({
  id: "i", url: "https://a.test", source: "DCD", source_kind: "rss", author: null, title: "t", body: "", published_at: "2026-10-05T08:00:00Z",
  fetched_at: "2026-10-05T10:00:00Z", metrics: {}, lanes: { power: 0.9 }, flags: { substance: 0.8, novel: 0.8 }, relevant: true,
  classified_at: null, embedding: null, story_id: "s", ...over,
});

test("scoreStory: more independent sources and John's own saves rank higher; old stories decay", () => {
  const one = scoreStory(cfg, [item({})], {}, NOW);
  const three = scoreStory(cfg, [item({}), item({ source: "Utility Dive" }), item({ source: "404 Media" })], {}, NOW);
  const bookmarked = scoreStory(cfg, [item({}), item({ source: "John's X bookmarks", source_kind: "x_bookmark" })], {}, NOW);
  const stale = scoreStory(cfg, [item({ fetched_at: "2026-10-02T10:00:00Z" })], {}, NOW);
  assert.ok(three.score > one.score);
  assert.ok(bookmarked.score > one.score);
  assert.ok(stale.score < one.score / 4);
  assert.deepEqual(one.lanes, ["power"]);
  assert.equal(three.source_count, 3);
  assert.ok(scoreStory(cfg, [item({ source_kind: "arxiv" })], {}, NOW).score < one.score, "papers alone weigh less");
});

test("laneTaste: saves raise a lane, dismissals lower it, within 0.6..1.5", () => {
  const taste = laneTaste([...Array(20)].map(() => ({ action: "dismiss", lanes: ["cost"] })).concat([{ action: "queue", lanes: ["power"] }]));
  assert.equal(taste.cost, 0.6);
  assert.ok(taste.power > 1);
});

test("laneTaste: a rejected candidate is negative taste when the topic or angle was wrong, neutral when the draft was", () => {
  const taste = laneTaste([
    { action: "reject", reason: "topic", lanes: ["builder"] },
    { action: "reject", reason: "angle: not for COOs", lanes: ["builder"] },
    { action: "reject", reason: "voice: too polished", lanes: ["power"] },
    { action: "reject", reason: "timing", lanes: ["cost"] },
  ]);
  assert.ok(taste.builder < 1, `builder ${taste.builder}`);
  assert.equal(taste.builder, 0.84);
  assert.equal(taste.power, 1);
  assert.equal(taste.cost, 1);
  // A reject never counts as a save: before the fix every non-dismiss action raised the lane.
  assert.equal(laneTaste([{ action: "reject", reason: "topic", lanes: ["x"] }]).x, 0.92);
});

test("storyTitle prefers a reported headline over a post", () => {
  assert.equal(storyTitle([{ title: "wake up baby, a huge thread about Kolibri", source_kind: "x_search" }, { title: "Aleph Alpha releases Kolibri", source_kind: "x_news" }]), "Aleph Alpha releases Kolibri");
});

const brief: Brief = {
  headline: "Meta builds gas plants — for AI", what_happened: "A", why_it_matters: "B", tension: "C",
  angles: { linkedin_take: "L", story: "S", video: "V" },
  sources: [{ title: "Real", url: "https://a.test/real", source: "DCD" }, { title: "Invented", url: "https://made.up/x", source: "?" }],
};

test("checkBrief drops sources the input never had and replaces em dashes", () => {
  const items = [{ url: "https://a.test/real", source: "DCD", author: null, title: "Real", body: "", published_at: null }];
  const clean = checkBrief(brief, items);
  assert.deepEqual(clean.sources.map((s) => s.url), ["https://a.test/real"]);
  assert.equal(clean.headline, "Meta builds gas plants, for AI");
  assert.equal(checkBrief({ ...brief, what_happened: "uses 3x\u20134x less compute in 2025\u20132026" }, items).what_happened, "uses 3x-4x less compute in 2025-2026");
  assert.equal(checkBrief({ ...brief, headline: "Meta builds gas plants\u2014for AI" }, items).headline, "Meta builds gas plants, for AI", "an unspaced clause dash is not a range");
  assert.equal(checkBrief({ ...brief, tension: "cost\u2014and risk\u2014rise" }, items).tension, "cost, and risk, rise");
  const none = checkBrief({ ...brief, sources: [{ title: "x", url: "https://made.up", source: "?" }] }, items);
  assert.deepEqual(none.sources.map((s) => s.url), ["https://a.test/real"], "falls back to the real sources");
  assert.match(briefPrompt("T", ["power"], items), /url: https:\/\/a\.test\/real/);
});

test("digest escapes HTML from sources and falls back to links when a brief is missing", () => {
  const stories = [
    { id: "1", title: "<script>x</script>", lanes: ["power"], score: 70, source_count: 2, brief: null, links: [{ title: "A & B", url: "https://a.test/?q=\"1\"", source: "DCD" }] },
    { id: "2", title: "t", lanes: ["privacy"], score: 60, source_count: 1, brief: checkBrief(brief, [{ url: "https://a.test/real", source: "DCD", author: null, title: "Real", body: "", published_at: null }]) },
  ];
  const html = digestHtml(cfg, stories, "https://cockpit.test", "Mon, Oct 5");
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A &amp; B"));
  assert.ok(html.includes("https://cockpit.test/signals"));
  assert.match(digestText(cfg, stories, "https://cockpit.test", "Mon"), /- A & B \(DCD\)/);
  assert.match(digestSubject(stories, "Mon, Oct 5"), /^Signal Desk Mon, Oct 5: /);
});

test("nextState: queuing needs a format; restore clears it", () => {
  assert.deepEqual(nextState("queue", "repost"), { status: "queued", requested_format: "repost" });
  assert.throws(() => nextState("queue"), /format/);
  assert.deepEqual(nextState("restore"), { status: "new", requested_format: null });
  assert.deepEqual(nextState("dismiss"), { status: "dismissed" });
});

test("access: owner and team claims come from app_metadata only; team members reach /signals alone", () => {
  assert.deepEqual(signalsViewer({ email: "user-434e61764074@example.com", app_metadata: { gtm_owner: true } }), { role: "owner", actor: "user-434e61764074@example.com" });
  assert.deepEqual(signalsViewer({ email: "user-773530a442cb@example.com", app_metadata: { gtm_team: true } }), { role: "team", actor: "user-773530a442cb@example.com" });
  assert.equal(signalsViewer({ user_metadata: { gtm_owner: true, gtm_team: true } }), null);
  assert.equal(signalsViewer(null), null);
  assert.equal(teamMayOpen("/signals"), true);
  assert.equal(teamMayOpen("/signals?view=queued".split("?")[0]), true);
  assert.equal(teamMayOpen("/auth/reset"), true);
  assert.equal(teamMayOpen("/content"), false);
  assert.equal(teamMayOpen("/signalsx"), false);
});

test("X items: tweets become x.com status links with the quoted text; trending news becomes x.com/i/trending", () => {
  const t = tweetItem({ id: "123", text: "Meta  gas\nplants", createdAt: "Sun Oct 04 08:33:36 +0000 2026", likeCount: 5, author: { username: "dcd" }, quotedTweet: { text: "orig", author: { username: "x" } } }, "x_search", "X search")!;
  assert.equal(t.url, "https://x.com/dcd/status/123");
  assert.equal(t.title, "Meta gas plants");
  assert.match(t.body!, /Quoting @x: orig/);
  assert.equal(t.published_at, "2026-10-04T08:33:36.000Z");
  assert.equal(tweetItem({ id: "", text: "x" }, "x_like", "l"), null);
  assert.equal(newsItem({ id: "twitter://trending/42", headline: "Kolibri", url: "twitter://trending/42" })!.url, "https://x.com/i/trending/42");
  assert.equal(tweetDate("garbage"), null);
});

const signalsCron = await import("../app/api/cron/signals/route.ts");
const digestCron = await import("../app/api/cron/signals-digest/route.ts");

test("signal cron routes: 401 without the right bearer (nothing runs)", async () => {
  const prev = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    for (const route of [signalsCron, digestCron]) {
      assert.equal((await route.GET(new Request("https://cockpit.test/x", { headers: { authorization: "Bearer undefined" } }))).status, 401);
    }
    process.env.CRON_SECRET = "s3cret-value";
    for (const route of [signalsCron, digestCron]) {
      assert.equal((await route.GET(new Request("https://cockpit.test/x", { headers: { authorization: "Bearer wrong-value!" } }))).status, 401);
      assert.equal((await route.GET(new Request("https://cockpit.test/x"))).status, 401);
    }
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

test("assignClusters stops at the deadline and leaves the rest unassigned for the next run", async () => {
  let calls = 0;
  const { assignment } = await assignClusters(
    [{ id: "a", embedding: [1, 0], title: "a" }, { id: "b", embedding: [0, 1], title: "b" }],
    [], { cutoff: 0.8, floor: 0.6, newId: () => "s", stop: () => calls++ >= 1 },
  );
  assert.deepEqual([...assignment.keys()], ["a"]);
});

test("openRouterWriter sends a strict JSON schema, requires providers that honor it, and checks the brief", async () => {
  const { openRouterWriter } = await import("../lib/signals/brief.ts");
  let sent: Record<string, unknown> = {};
  const reply = (content: unknown, finish = "stop") => (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: finish }] }), { status: 200 });
  }) as typeof fetch;
  const items = [{ url: "https://a.test/real", source: "DCD", author: null, title: "Real", body: "b", published_at: null }];
  const b = await openRouterWriter({ key: "k", model: "test/model", fetcher: reply(brief) })("T", ["power"], items);
  assert.equal(sent.model, "test/model");
  assert.deepEqual(sent.provider, { require_parameters: true });
  assert.equal((sent.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
  assert.deepEqual(b.sources.map((s) => s.url), ["https://a.test/real"], "invented source dropped");
  await assert.rejects(openRouterWriter({ key: "k", fetcher: reply(brief, "length") })("T", [], items), /truncated/);
  assert.throws(() => openRouterWriter({ key: "" }), /OPENROUTER_API_KEY/);
});

test("Google News and Reddit run on the Mac job only; the Vercel run gets every other web source", async () => {
  const { MAC_WEB_SOURCES } = await import("../lib/signals/run.ts");
  const { webJobs } = await import("../lib/signals/sources.ts");
  const names = webJobs(cfg).map((j) => j.name);
  for (const n of MAC_WEB_SOURCES) assert.ok(names.includes(n), `${n} is a real job name`);
  assert.deepEqual(MAC_WEB_SOURCES.sort(), ["google_news", "reddit"]);
});

test("openRouterWriter names the model on HTTP errors and unparseable content; briefTopStories respects its deadline", async () => {
  const { openRouterWriter, briefTopStories } = await import("../lib/signals/brief.ts");
  const items = [{ url: "https://a.test/real", source: "DCD", author: null, title: "Real", body: "b", published_at: null }];
  const http = (async () => new Response(JSON.stringify({ error: { message: "no credit" } }), { status: 402 })) as typeof fetch;
  await assert.rejects(openRouterWriter({ key: "k", model: "m/x", fetcher: http })("T", [], items), /openrouter m\/x: 402 no credit/);
  const junk = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" }, finish_reason: "content_filter" }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(openRouterWriter({ key: "k", model: "m/x", fetcher: junk })("T", [], items), /unparseable brief \(finish_reason content_filter\)/);
  // A deadline already passed: no writer call happens and every due story is reported as skipped.
  let calls = 0;
  const fakeDb = { from: () => { const q: Record<string, unknown> = {}; for (const m of ["select", "order", "limit", "neq", "eq", "gte", "in", "contains", "update"]) q[m] = () => q; (q as { then: unknown }).then = (r: (v: unknown) => void) => r({ data: [{ id: "00000000-0000-4000-8000-000000000001", title: "t", lanes: [], briefed_at: null, last_seen: "2026-10-06T00:00:00Z", status: "new", story_id: "x" }], error: null }); return q; } };
  const out = await briefTopStories(fakeDb as never, cfg, async () => { calls++; return brief; }, new Date(), Date.now() - 1);
  assert.equal(calls, 0);
  assert.match(out.errors[0]?.error ?? "", /time budget/);
});

test("macWebDue: Google News and Reddit are asked at most every 4 hours from the Mac", async () => {
  const { macWebDue } = await import("../lib/signals/run.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const stamp = `${mkdtempSync(`${tmpdir()}/signals-`)}/sub/mac-web.last`;
  const t = Date.parse("2026-10-06T00:00:00Z");
  assert.equal(macWebDue(stamp, t), true, "first run");
  assert.equal(macWebDue(stamp, t + 3600_000), false, "an hour later");
  assert.equal(macWebDue(stamp, t + 4 * 3600_000), true, "four hours later");
});

// What TinyFish's html format returns for a raw feed: the body escaped once inside <pre> or <blockquote>.
const tinyfishHtml = (body: string, el = "pre") => `<html>\n  <body>\n    <${el}>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</${el}>\n  </body>\n</html>`;

test("TinyFish fallback: asks for html, unescapes the body exactly once, and reports its errors", async () => {
  const { unwrapFetched, tinyfishText, parseFeed, canonicalUrl } = await import("../lib/signals/sources.ts");
  // Underscores and entities survive: TinyFish's markdown format turned the_internet into the\_internet.
  const feed = `<feed><entry><title>AT&amp;T &amp; &quot;AI&quot;</title><link href="https://www.reddit.com/r/a/comments/1x/the_internet_is_wild/"/></entry></feed>`;
  for (const el of ["pre", "blockquote"]) {
    assert.equal(unwrapFetched(tinyfishHtml(feed, el)), feed, el);
    const [entry] = parseFeed(unwrapFetched(tinyfishHtml(feed, el)));
    assert.equal(canonicalUrl(entry.link), "https://www.reddit.com/r/a/comments/1x/the_internet_is_wild/");
  }
  let sent: { url: string; init?: RequestInit } | undefined;
  const ok = (async (url: string, init?: RequestInit) => { sent = { url, init }; return new Response(JSON.stringify({ results: [{ text: tinyfishHtml(feed) }], errors: [] })); }) as typeof fetch;
  assert.equal(await tinyfishText("https://a.test/feed", ok, "k"), feed);
  assert.equal(sent?.url, "https://agent.tinyfish.ai/v1/fetch");
  assert.equal(JSON.parse(String(sent?.init?.body)).format, "html");
  assert.equal((sent?.init?.headers as Record<string, string>)["x-api-key"], "k");
  const refused = (async () => new Response(JSON.stringify({ results: [], errors: [{ url: "u", error: "target_http_error", status: 429 }] }))) as typeof fetch;
  await assert.rejects(tinyfishText("https://a.test/feed", refused, "k"), /tinyfish: target_http_error 429/);
  await assert.rejects(tinyfishText("https://a.test/feed", ok, ""), /TINY_FISH_API_KEY/);
});

const atom = (title: string) => `<?xml version="1.0"?><feed><entry><title>${title}</title><link href="https://www.reddit.com/r/x/comments/${title}/"/><updated>2026-10-12T00:00:00Z</updated></entry></feed>`;

test("fetchReddit waits out Reddit's rate-limit window once, then falls back to TinyFish", async () => {
  const { fetchReddit } = await import("../lib/signals/sources.ts");
  const prev = process.env.TINY_FISH_API_KEY;
  process.env.TINY_FISH_API_KEY = "k";
  try {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const limited = () => new Response("", { status: 429, headers: { "x-ratelimit-reset": "37" } });
    // a: served at once. b: limited, then served after the wait. c: limited twice, so TinyFish serves it.
    const calls: string[] = [];
    const seen = new Map<string, number>();
    const fetcher = (async (url: string) => {
      if (url.startsWith("https://agent.tinyfish.ai")) { calls.push("tinyfish"); return new Response(JSON.stringify({ results: [{ text: tinyfishHtml(atom("c_d"), "blockquote") }], errors: [] })); }
      const sub = url.match(/\/r\/(\w+)\//)![1];
      const n = (seen.get(sub) ?? 0) + 1;
      seen.set(sub, n);
      calls.push(`${sub}${n}`);
      if (sub === "a" || (sub === "b" && n === 2)) return new Response(atom(sub));
      return limited();
    }) as typeof fetch;
    const items = await fetchReddit({ subreddits: ["a", "b", "c"], max: 5 }, fetcher, wait);
    assert.deepEqual(items.map((i) => i.title), ["a", "b", "c_d"]);
    assert.equal(items[2].url, "https://www.reddit.com/r/x/comments/c_d/");
    assert.deepEqual(calls, ["a1", "b1", "b2", "c1", "c2", "tinyfish"]);
    assert.deepEqual(waits, [38_000, 38_000]);
  } finally {
    if (prev === undefined) delete process.env.TINY_FISH_API_KEY; else process.env.TINY_FISH_API_KEY = prev;
  }
});

test("fetchGoogleNews: one feed per query, publisher as source, title without the publisher suffix", async () => {
  const { fetchGoogleNews } = await import("../lib/signals/sources.ts");
  const item = (id: string, title: string, publisher: string) => `<item><title>${title} - ${publisher}</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><pubDate>Sun, 11 Oct 2026 14:00:00 GMT</pubDate><description>x</description><source url="https://${publisher.toLowerCase()}.com">${publisher}</source></item>`;
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return new Response(`<rss><channel>${item("A1", "Grid strain from AI", "Futurism")}${item("B2", "Second", "Wired")}${item("A1", "Grid strain from AI", "Futurism")}</channel></rss>`);
  }) as typeof fetch;
  const items = await fetchGoogleNews({ max_per_query: 2, queries: ['"data center" (power OR grid)', "AI Act"] }, fetcher);
  assert.equal(urls.length, 2);
  assert.match(decodeURIComponent(urls[0]), /q="data center" \(power OR grid\) when:2d&hl=en-US/);
  assert.deepEqual(items.map((i) => [i.title, i.source, i.source_kind]), [["Grid strain from AI", "Futurism", "rss"], ["Second", "Wired", "rss"]]);
  assert.equal(items[0].published_at, "2026-10-11T14:00:00.000Z");
});
