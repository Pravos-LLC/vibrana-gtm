// The weekly content report (VIB-418): the input pack, the guard that keeps the model to the pack's own
// numbers and ids, applying an accepted calendar change, and the run (dry and real) against a mocked
// database, OpenRouter and Resend. Nothing here reaches a service.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", OPENROUTER_API_KEY: "or_test", RESEND_API_KEY: "re_test",
  GTM_COCKPIT_URL: "https://cockpit.test", REPORT_TZ: "Asia/Makassar",
});
delete process.env.ZERNIO_API_KEY;
delete process.env.LATE_API_KEY;

const { beforeDeadline, buildPack, leadingValue } = await import("../lib/reports/pack.ts");
const { allowedNumbers, checkReport, cleanText, unsupportedNumbers } = await import("../lib/reports/guard.ts");
const { applyAction, decideAction } = await import("../lib/reports/actions.ts");
const { actionRows, runWeeklyReport } = await import("../lib/reports/run.ts");
const { reportHtml, reportSubject } = await import("../lib/reports/email.ts");
const { adminDb } = await import("../lib/db.ts");
import type { PackInputs, MetricSnap, ItemRow } from "../lib/reports/pack.ts";
import type { Report, ReportAction } from "../lib/reports/guard.ts";
import type { ReportWeek } from "../lib/reports/week.ts";

const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; });
const body = (b: string | null) => JSON.parse(b ?? "null");

const NOW = new Date("2026-10-11T01:00:00Z"); // Sunday 09:00 in Bali
const WK: ReportWeek = {
  season: { id: "season-1", starts_on: "2026-10-06", ends_on: "2026-12-11" }, week: 1, from: "2026-10-05", to: "2026-10-11", today: "2026-10-11",
  prev: { week: 0, from: "2026-09-28", to: "2026-10-04" }, next: { from: "2026-10-12", to: "2026-10-25" },
};
const snap = (over: Partial<MetricSnap>): MetricSnap => ({
  zernio_post_id: "z", platform: "linkedin", content_item_id: null, is_external: true, published_at: "2026-10-07T12:00:00Z",
  platform_post_url: null, content_preview: "", captured_at: "2026-10-11T00:00:00Z",
  impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, views: 0, extras: {}, ...over,
});
const item = (over: Partial<ItemRow>): ItemRow => ({ id: "x", date: "2026-10-14", time: "08:30", pillar: "proof", format: "carousel", channels: ["linkedin"], status: "drafted", title: "X", ...over });
const INPUTS = (): PackInputs => ({
  metrics: [
    snap({ zernio_post_id: "li-1", content_item_id: "pvp-linkedin", impressions: 324, reach: 195, likes: 7, comments: 4, content_preview: "AI's power vs. purpose" }),
    snap({ zernio_post_id: "ig-1", platform: "instagram", published_at: "2026-10-10T16:00:00Z", platform_post_url: "https://ig.test/p/1", reach: 90, views: 120, likes: 3 }),
    snap({ zernio_post_id: "li-0", content_item_id: "intro-linkedin", published_at: "2026-10-01T07:00:00Z", impressions: 1481, reach: 955, likes: 29, comments: 6, saves: 1, extras: { sends: 2 } }),
    snap({ zernio_post_id: "old", published_at: "2026-06-01T07:00:00Z", impressions: 9999 }),
  ],
  items: [
    item({ id: "pvp-linkedin", date: "2026-10-07", pillar: "perspective", format: "video", status: "published", published_at: "2026-10-07T12:00:00Z", title: "AI: power vs. purpose" }),
    item({ id: "pvp-instagram", date: "2026-10-10", pillar: "perspective", format: "video", channels: ["instagram"], status: "published", published_at: "2026-10-10T16:00:00Z", urls: { instagram: "https://ig.test/p/1" }, title: "AI: power vs. purpose" }),
    item({ id: "intro-linkedin", date: "2026-10-01", pillar: "perspective", format: "image", status: "published", published_at: "2026-10-01T07:00:00Z", title: "Reintroduction" }),
    item({ id: "essay-substack", date: "2026-10-09", pillar: "proof", format: "text", channels: ["newsletter"], status: "published", published_at: "2026-10-09T01:00:00Z", title: "Regenera essay" }),
    item({ id: "top-7-linkedin", date: "2026-10-14", pillar: "lists", format: "document", title: "Example campaign title 7" }),
    item({ id: "wave-linkedin", date: "2026-10-15", pillar: "perspective", format: "video", status: "scheduled", zernio_post_id: "zz", title: "The Wave" }),
    item({ id: "loop-linkedin", date: "2027-01-05", pillar: "perspective", format: "video", title: "Loop engineering" }),
  ],
  followers: [
    { account_id: "a-li", platform: "linkedin", date: "2026-10-04", followers: 3766 },
    { account_id: "a-li", platform: "linkedin", date: "2026-10-11", followers: 3768 },
  ],
  signals: [{ id: "sig-1", title: "Grid strain", status: "queued", requested_format: "story", lanes: ["power"], score: 4.25, brief: { headline: "Utilities warn on AI load" } }],
  comments: null, manual: null, baseline: null, zernio: null, gaps: [],
});

// ---- the pack ------------------------------------------------------------------------------------------------

test("pack: posts by window and stage, URL fallback join, platform units, follower deltas, upcoming and reserve", () => {
  const p = buildPack(INPUTS(), WK, NOW);
  assert.deepEqual(p.posts.map((x) => [x.ref, x.platform, x.window, x.stage, x.item_id]), [
    ["P1", "linkedin", "previous_week", "final", "intro-linkedin"],
    ["P2", "linkedin", "this_week", "settling", "pvp-linkedin"],
    ["P3", "instagram", "this_week", "maturing", "pvp-instagram"], // joined by its URL; 9 hours old
  ], "the June post is outside the 8-week cohort");
  assert.deepEqual(p.posts[0].rate, { value: 2.4, per: "impression" });
  assert.deepEqual(p.posts[2].native_reach, { value: 90, unit: "reach" }, "Instagram is judged per account reached");
  assert.equal(p.posts[0].saves_sends, 3, "saves plus sends from extras");
  const li = p.channels.find((c) => c.platform === "linkedin")!;
  assert.deepEqual(li.this_week, { posts: 1, engagements: 11, comments: 4, saves_sends: 0, native_reach: 324 });
  assert.deepEqual(li.followers, { start: 3766, end: 3768, net: 2, previous_net: null });
  assert.deepEqual(p.unmeasured.map((u) => u.item_id), ["essay-substack"], "a newsletter has no metrics: unknown, not zero");
  assert.deepEqual(p.upcoming.map((u) => u.id), ["top-7-linkedin", "wave-linkedin"]);
  assert.deepEqual(p.reserve.map((u) => u.id), ["loop-linkedin"]);
  assert.equal(p.facts["P2.comments"], 4);
  assert.equal(p.facts["followers.linkedin.net"], 2);
  assert.equal(p.facts["change.linkedin.engagements"], 11 - 36);
  assert.equal(p.facts["mix.pieces"], 2, "pvp counts once across channels, plus the essay (the intro was last week)");
  // Medians come from final posts only: one LinkedIn perspective post, flagged thin.
  assert.deepEqual(p.medians.by_pillar, [{ platform: "linkedin", key: "perspective", n: 1, thin: true, rate: 2.4, engagements: 36, leading: 1481 }]);
  assert.ok(p.gaps.some((g) => /playbook tags/.test(g)) && p.gaps.some((g) => /comment queue/.test(g)));
});

const TAGS = (hook: string, storyline: string, cta: string, confidence = "high") => ({ hook, storyline, cta, confidence, rationale: "r", cta_awareness: "use", body_hash: "h", taxonomy_version: 1, model: "m", tagged_at: "t" });

test("pack: playbook tags and conversations are included when present (optional inputs)", () => {
  const inp = INPUTS();
  inp.items[0].playbook_tags = TAGS("news-peg", "news-take", "none");
  inp.comments = [{ platform: "linkedin", content_item_id: "pvp-linkedin", at: "2026-10-08T03:00:00Z", kind: "comment" }];
  const p = buildPack(inp, WK, NOW);
  const post = p.posts.find((x) => x.item_id === "pvp-linkedin")!;
  assert.deepEqual(post.playbook_tags, { hook: "news-peg", storyline: "news-take", cta: "none", cta_awareness: "use", confidence: "high" }, "only ids, the CTA flag and confidence reach the model");
  assert.equal(post.conversations, 1);
  assert.deepEqual(p.conversations, { this_week: 1, by_platform: { linkedin: 1 } });
  assert.equal(leadingValue("conversations", post), 4, "the larger of the platform count and the queue, never their sum");
  assert.ok(!p.gaps.some((g) => /No playbook tags yet|comment queue/.test(g)));
  assert.ok(p.gaps.some((g) => /1 of this week's posts have no playbook tags/.test(g)), "the untagged Instagram post is named");
});

test("pack: the playbook read counts CTA flags, names the ids in use, and medians hooks, storylines and CTAs on settled posts", () => {
  const inp = INPUTS();
  inp.items.find((i) => i.id === "pvp-linkedin")!.playbook_tags = TAGS("news-peg", "news-take", "comment-keyword");
  inp.items.find((i) => i.id === "pvp-instagram")!.playbook_tags = TAGS("cold-open", "conversation-clip", "soft-link");
  inp.items.find((i) => i.id === "intro-linkedin")!.playbook_tags = TAGS("first-person-scene", "scene-to-insight", "open-question");
  const p = buildPack(inp, WK, NOW);
  const pb = p.playbook!;
  assert.deepEqual(pb.week, { posts: 2, tagged: 2, untagged: 0, cta: { use: 0, limit: 1, avoid: 1 }, avoid_refs: ["P2"], limit_refs: ["P3"] });
  assert.deepEqual(pb.cohort, { tagged: 3, cta: { use: 1, limit: 1, avoid: 1 } });
  assert.deepEqual(pb.standard.hooks.map((h) => h.id), ["cold-open", "first-person-scene", "news-peg"]);
  assert.deepEqual(pb.standard.hooks.find((h) => h.id === "news-peg")!.example_creators, []);
  assert.equal(pb.standard.ctas.find((c) => c.id === "comment-keyword")!.awareness, "avoid");
  assert.ok(pb.standard.ctas.length >= 13, "every CTA with its flag, used or not");
  // Only the intro (final) is in the cohort medians; its leading value is conversations (6 comments).
  assert.deepEqual(pb.medians.by_hook, [{ platform: "linkedin", key: "first-person-scene", n: 1, thin: true, rate: 2.4, engagements: 36, leading: 6 }]);
  assert.equal(p.facts["playbook.week.cta.avoid"], 1);
  assert.equal(p.facts["playbook.week.cta.limit"], 1);
  assert.equal(p.facts["median.cta.linkedin.open-question.leading"], 6);
  assert.ok(!p.gaps.some((g) => /playbook tags/.test(g)));
});

test("pack: unresolvable tags are left out, and untagged posts this week are named as a gap", () => {
  const inp = INPUTS();
  inp.items.find((i) => i.id === "pvp-linkedin")!.playbook_tags = TAGS("question", "tension", "none");
  inp.items.find((i) => i.id === "intro-linkedin")!.playbook_tags = TAGS("first-person-scene", "scene-to-insight", "none");
  const p = buildPack(inp, WK, NOW);
  assert.equal(p.posts.find((x) => x.item_id === "pvp-linkedin")!.playbook_tags, undefined);
  assert.equal(p.playbook!.week.untagged, 2);
  assert.ok(p.gaps.some((g) => /2 of this week's posts have no playbook tags/.test(g)));
});

test("pack: without any valid tags there is no playbook read", () => {
  const p = buildPack(INPUTS(), WK, NOW);
  assert.equal(p.playbook, null);
  assert.ok(!Object.keys(p.facts).some((k) => k.startsWith("playbook.")));
});

// ---- the guard -----------------------------------------------------------------------------------------------

const EMPTY: Report = { headline: "", lede: "", went_out: [], did_well: [], underperformed: [], patterns: [], against_playbook: [], pillars: [], actions: [] };
const action = (over: Partial<ReportAction>): ReportAction => ({
  type: "move", item_id: "top-7-linkedin", other_item_id: null, new_date: "2026-10-16", new_format: null, new_title: null, new_pillar: null,
  new_channels: [], signal_id: null, proposal: "Move it", rationale: "Because", evidence: [{ fact: "P2.comments", value: 4 }], ...over,
});

test("guard: numbers must come from the pack; fabricated numbers, refs and ids are dropped", () => {
  const pack = buildPack(INPUTS(), WK, NOW);
  const raw: Report = {
    ...EMPTY,
    headline: "LinkedIn drew 4 comments on P2 — a start.",
    lede: "Engagement rose 37% this week.",
    went_out: [{ ref: "P2", note: "324 impressions and 4 comments on Oct 7." }, { ref: "P99", note: "A post that does not exist." }],
    did_well: [
      { ref: "P2", why: "4 comments from 324 impressions.", evidence: [{ fact: "P2.comments", value: 4 }] },
      { ref: "P2", why: "About 1,200 people saw it.", evidence: [{ fact: "P2.impressions", value: 324 }] },
      { ref: "P2", why: "Strong comments.", evidence: [{ fact: "P2.comments", value: 5 }] },
      { ref: "P3", why: "Early reach.", evidence: [{ fact: "P3.reach", value: 90 }] },
    ],
    patterns: [
      { observation: "The Top 7 carousel on Oct 14 is next; the reintroduction had a 2.4% rate per impression.", evidence: [{ fact: "P1.rate", value: 2.4 }] },
      { observation: "We should leverage the 2 net followers.", evidence: [{ fact: "followers.linkedin.net", value: 2 }] },
      { observation: "Follower growth will hit 50 next week.", evidence: [{ fact: "followers.linkedin.net", value: 2 }] },
    ],
    against_playbook: [{ observation: "Question hooks win.", evidence: [{ fact: "P2.comments", value: 4 }] }],
    pillars: [
      { pillar: "perspective", verdict: "too_early", note: "One final post.", evidence: [] },
      { pillar: "proof", verdict: "behind", note: "No evidence.", evidence: [{ fact: "made.up", value: 1 }] },
      { pillar: "memes", verdict: "on_track", note: "?", evidence: [] },
    ],
    actions: [
      action({}),
      action({ item_id: "no-such-item" }),
      action({ item_id: "wave-linkedin" }), // not upcoming-movable? it is upcoming, so it passes the guard; applying refuses later
      action({ new_date: "2026-10-01" }),
      action({ type: "swap", other_item_id: "loop-linkedin" }),
      action({ type: "change_format", new_format: "hologram" }),
      action({ type: "new_story", item_id: null, new_title: "Grid strain and AI", new_pillar: "perspective", new_format: "text", new_channels: ["linkedin"], signal_id: "sig-1", new_date: "2026-10-20" }),
      action({ type: "new_story", item_id: null, new_title: "Bad", new_pillar: "gossip", new_format: "text", new_channels: ["linkedin"], new_date: "2026-10-20" }),
      action({ type: "move", proposal: "Move it to lift reach by 40%." }),
      action({ evidence: [] }),
    ],
  };
  const { report, dropped, cleaned } = checkReport(raw, pack);
  assert.equal(report.headline, 'LinkedIn drew 4 comments on "AI: power vs. purpose" (LinkedIn), a start.', "em dash becomes a comma; a ref in prose becomes the post's title");
  assert.equal(report.lede, "", "37% is not in the pack");
  assert.deepEqual(report.went_out.map((e) => e.ref), ["P2"]);
  assert.deepEqual(report.did_well.map((e) => e.why), ["4 comments from 324 impressions."]);
  assert.equal(report.patterns.length, 2);
  assert.equal(report.patterns[1].observation, "We should the 2 net followers.", "banned word struck");
  assert.deepEqual(cleaned, [{ section: "patterns", removed: "leverage" }]);
  assert.deepEqual(report.against_playbook, [], "no playbook tags in the pack, so nothing to grade");
  assert.deepEqual(report.pillars.map((p) => p.pillar), ["perspective"]);
  assert.deepEqual(report.actions.map((a) => [a.type, a.item_id, a.other_item_id]), [
    ["move", "top-7-linkedin", null], ["move", "wave-linkedin", null], ["swap", "top-7-linkedin", "loop-linkedin"], ["new_story", null, null],
  ]);
  assert.equal(report.actions[3].signal_id, "sig-1");
  const reasons = dropped.map((d) => `${d.section}: ${d.reason}`).join("\n");
  for (const r of [/lede: unsupported numbers: 37/, /went_out: unknown post ref P99/, /did_well: unsupported numbers: 1,200/, /did_well: no evidence that matches/,
    /P3 is still maturing/, /patterns: unsupported numbers: 50/, /against_playbook: no playbook tags/, /pillars: a verdict needs evidence/, /unknown pillar memes/,
    /move needs an upcoming item id \(got no-such-item\)/, /move needs a new date from 2026-10-11/, /unknown format hologram/, /new_story needs a known pillar/,
    /actions: unsupported numbers: 40/, /actions: no evidence/]) assert.match(reasons, r);
});

test("guard: against_playbook keeps claims grounded in a playbook fact and names taxonomy ids", () => {
  const inp = INPUTS();
  inp.items.find((i) => i.id === "pvp-linkedin")!.playbook_tags = TAGS("news-peg", "news-take", "comment-keyword");
  inp.items.find((i) => i.id === "intro-linkedin")!.playbook_tags = TAGS("first-person-scene", "scene-to-insight", "open-question");
  const pack = buildPack(inp, WK, NOW);
  const { report, dropped } = checkReport({
    ...EMPTY,
    against_playbook: [
      { observation: "One post this week used cta:comment-keyword, an avoid CTA in the awareness phase.", evidence: [{ fact: "playbook.week.cta.avoid", value: 1 }] },
      { observation: "The hook:first-person-scene post drew 6 comments.", evidence: [{ fact: "median.hook.linkedin.first-person-scene.leading", value: 6 }] },
      { observation: "Comments were 4 on the video.", evidence: [{ fact: "P2.comments", value: 4 }] },
    ],
  }, pack);
  assert.deepEqual(report.against_playbook.map((e) => e.observation), [
    'One post this week used "Comment a keyword to get it", an avoid CTA in the awareness phase.',
    'The "First-person scene" post drew 6 comments.',
  ]);
  assert.match(dropped.map((d) => d.reason).join("\n"), /no playbook fact in its evidence/);
});

test("guard: every number left in the report traces back to the pack, and evidence values equal the facts", () => {
  const pack = buildPack(INPUTS(), WK, NOW);
  const raw: Report = {
    ...EMPTY, headline: "2 net followers on LinkedIn, 4 comments on the video.", lede: "Week 1 had 2 pieces against a target of 3.",
    went_out: [{ ref: "P2", note: "324 impressions, 11 engagements, a 3.4% rate per impression." }],
    patterns: [{ observation: "LinkedIn engagements fell by 25 against week 0.", evidence: [{ fact: "change.linkedin.engagements", value: -25 }] }],
  };
  const { report, dropped } = checkReport(raw, pack);
  assert.deepEqual(dropped, []);
  const texts = [report.headline, report.lede, ...report.went_out.map((e) => e.note), ...report.patterns.map((e) => e.observation)];
  for (const t of texts) assert.deepEqual(unsupportedNumbers(t, pack), [], t);
  for (const e of report.patterns.flatMap((x) => x.evidence)) assert.equal(pack.facts[e.fact], e.value);
});

test("guard: scaled, multiplied, relative and spelled-out quantities are checked, not waved through (review finding 1)", () => {
  const pack = buildPack(INPUTS(), WK, NOW);
  const bad = (t: string) => unsupportedNumbers(t, pack);
  for (const t of ["2.4K impressions", "4k impressions", "3M views", "2.4 thousand people", "1 million views", "doubled its reach", "half the comments", "reach tripled",
    "twice as many", "a 3x jump", "tenfold", "twelve comments", "seventy saves"]) assert.ok(bad(t).length, `${t} must be flagged`);
  // The same kinds of words are fine when the pack supports them: exact facts, spelled-out facts, numbers from titles.
  for (const t of ["324 impressions", "four comments", "two pieces against a target of three", "the Top 7 carousel"]) assert.deepEqual(bad(t), [], t);
  assert.deepEqual(bad("1.481K impressions"), [], "an expanded value that is a fact passes");
});

test("guard: a fabricated headline falls back to a plain statement built from the pack", () => {
  const pack = buildPack(INPUTS(), WK, NOW);
  const { report, dropped } = checkReport({ ...EMPTY, headline: "Reach tripled to 12,000." }, pack);
  assert.equal(report.headline, "Week 1: 2 pieces went out across 2 platform posts.");
  assert.equal(dropped[0].section, "headline");
  assert.ok(allowedNumbers(pack).has("7"), "a number inside a title (Top 7) may be restated");
});

test("cleanText: ranges keep a hyphen, clause dashes become commas, banned phrases go", () => {
  assert.equal(cleanText("3x–4x faster — and seamless"), "3x-4x faster, and");
  assert.equal(cleanText("Going forward, we post twice."), "We post twice.");
});

test("actionRows: the structured change is stored for John to accept, nothing else", () => {
  const rows = actionRows("r1", { ...EMPTY, actions: [action({}), action({ type: "new_story", item_id: null, new_title: "T", new_pillar: "build", new_format: "text", new_channels: ["linkedin"], new_date: "2026-10-20", signal_id: null })] });
  assert.deepEqual(rows.map((r) => [r.type, r.item_id, r.change]), [
    ["move", "top-7-linkedin", { date: "2026-10-16" }],
    ["new_story", null, { date: "2026-10-20", format: "text", title: "T", pillar: "build", channels: ["linkedin"] }],
  ]);
});

// ---- accepting a change ------------------------------------------------------------------------------------

const ACTION = { id: "act-1", report_id: "r1", position: 0, item_id: "top-7-linkedin", other_item_id: null, proposal: "p", rationale: "r", evidence: [], status: "proposed", applied: null, decided_by: null, decided_at: null };

const MOVE = { ...ACTION, type: "move", change: { date: "2030-10-16" }, status: "accepted", decided_by: "user-f538cb95fc21@example.com", decided_at: "2030-10-11T01:00:00Z" };
const APPROVED_ITEM = { id: "top-7-linkedin", date: "2030-10-14", time: "08:30", format: "document", status: "approved", zernio_post_id: null, title: "T", pillar: "lists", channels: ["linkedin"] };

test("accept claims the change first, then moves the date (and week); nothing is approved or scheduled", async () => {
  const m = use([
    { method: "PATCH", url: REST + "gtm_report_actions", json: [MOVE] },
    { method: "GET", url: REST + "gtm_content_items", json: [APPROVED_ITEM] },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  const r = await decideAction(adminDb(), "act-1", "accept", "user-f538cb95fc21@example.com");
  assert.equal(r.status, "accepted");
  const patches = m.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => new URL(c.url).pathname.split("/").at(-1)), ["gtm_report_actions", "gtm_content_items", "gtm_report_actions"], "claim, apply, record");
  assert.match(patches[0].url, /status=eq\.proposed/, "the claim only succeeds from proposed");
  assert.equal(body(patches[0].body).status, "accepted");
  const b = body(patches[1].body);
  assert.equal(b.date, "2030-10-16");
  assert.equal(b.week, 42);
  assert.ok(!("status" in b) && !("approved_hash" in b) && !("zernio_post_id" in b), "accepting never touches approval or scheduling");
  assert.deepEqual(body(patches[2].body).applied, { before: [{ id: "top-7-linkedin", date: "2030-10-14" }], after: [{ id: "top-7-linkedin", date: "2030-10-16" }] });
});

test("a second, overlapping accept finds nothing to claim and changes nothing (review finding 3)", async () => {
  const m = use([
    { method: "PATCH", url: REST + "gtm_report_actions", json: [] },
    { method: "GET", url: REST + "gtm_report_actions", json: { status: "accepted" } },
  ]);
  await assert.rejects(decideAction(adminDb(), "act-1", "accept", "user-f538cb95fc21@example.com"), /Already accepted/);
  assert.ok(!m.calls.some((c) => c.url.includes("gtm_content_items") || c.url.includes("/rpc/")), "no calendar read or write");
});

test("a change that cannot be applied is released back to proposed, with the reason", async () => {
  const m = use([
    { method: "PATCH", url: REST + "gtm_report_actions?id=eq.act-1&status=eq.proposed", json: [{ ...MOVE, item_id: "wave-linkedin" }] },
    { method: "GET", url: REST + "gtm_content_items", json: [{ ...APPROVED_ITEM, id: "wave-linkedin", status: "scheduled", zernio_post_id: "zz" }] },
    { method: "PATCH", url: REST + "gtm_report_actions", status: 204 },
  ]);
  await assert.rejects(decideAction(adminDb(), "act-1", "accept", "user-f538cb95fc21@example.com"), /scheduled and already in Zernio/);
  const release = m.calls.filter((c) => c.method === "PATCH").at(-1)!;
  assert.deepEqual(body(release.body), { status: "proposed", decided_by: null, decided_at: null });
  assert.match(release.url, /status=eq\.accepted/);
});

test("accept refuses an item already handed to Zernio, and a date in the past", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: [{ id: "wave-linkedin", date: "2030-10-15", time: null, format: "video", status: "scheduled", zernio_post_id: "zz", title: "W", pillar: "perspective", channels: ["linkedin"] }] }]);
  await assert.rejects(applyAction(adminDb(), { ...ACTION, item_id: "wave-linkedin", type: "move", change: { date: "2030-10-20" } } as never, "2030-10-11"), /scheduled and already in Zernio/);
  await assert.rejects(applyAction(adminDb(), { ...ACTION, type: "move", change: { date: "2030-10-01" } } as never, "2030-10-11"), /not a future date/);
});

test("accept a swap goes through the atomic gtm_swap_slots RPC; a new_story adds an idea slot", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items?select=id%2Cdate", json: [
      { id: "a", date: "2030-10-14", time: "08:30", format: "video", status: "drafted", zernio_post_id: null, title: "A", pillar: "proof", channels: ["linkedin"] },
      { id: "b", date: "2031-01-05", time: null, format: "video", status: "drafted", zernio_post_id: null, title: "B", pillar: "build", channels: ["linkedin"] },
    ] },
    { method: "POST", url: REST + "rpc/gtm_swap_slots", json: [] },
    { method: "GET", url: REST + "gtm_content_items?select=id&id=like", json: [{ id: "idea-grid-strain" }] },
    { method: "POST", url: REST + "gtm_content_items", status: 201 },
  ]);
  const swapped = await applyAction(adminDb(), { ...ACTION, item_id: "a", other_item_id: "b", type: "swap", change: {} } as never, "2030-10-11");
  assert.deepEqual(swapped!.after, [{ id: "a", date: "2031-01-05", time: null }, { id: "b", date: "2030-10-14", time: "08:30" }]);
  const rpc = m.calls.find((c) => c.url.endsWith("/rpc/gtm_swap_slots"))!;
  assert.deepEqual(body(rpc.body), { p_a: "a", p_b: "b" }, "one database call swaps both, or neither");
  assert.ok(!m.calls.some((c) => c.method === "PATCH"), "no two-step update");
  const added = await applyAction(adminDb(), { ...ACTION, item_id: null, type: "new_story", change: { date: "2030-10-20", title: "Grid strain", pillar: "perspective", format: "text", channels: ["linkedin"] } } as never, "2030-10-11");
  const insert = body(m.calls.find((c) => c.method === "POST" && c.url.includes("gtm_content_items"))!.body);
  assert.equal(insert.id, "idea-grid-strain-2", "an existing id is never overwritten");
  assert.equal(insert.status, "idea");
  assert.equal((added!.after[0] as { status?: string }).status, "idea");
});

test("beforeDeadline: a slow read loses to the time budget; a spent budget never starts it (review finding 7)", async () => {
  await assert.rejects(beforeDeadline(new Promise((r) => setTimeout(r, 200)), Date.now() + 20, "dashboard"), /no answer before the time budget/);
  await assert.rejects(beforeDeadline(Promise.resolve(1), Date.now() - 1, "dashboard"), /time budget used up/);
  assert.equal(await beforeDeadline(Promise.resolve(7), Infinity, "dashboard"), 7);
});

// ---- the run -----------------------------------------------------------------------------------------------

const SEASON = { id: "season-1", title: "S1", description: "", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: [] };
const READS: Route[] = [
  { method: "GET", url: REST + "gtm_seasons", json: [SEASON] },
  { method: "GET", url: REST + "gtm_post_metrics_latest", json: INPUTS().metrics },
  { method: "GET", url: REST + "gtm_content_items", json: INPUTS().items },
  { method: "GET", url: REST + "gtm_channel_daily", json: INPUTS().followers },
  { method: "GET", url: REST + "gtm_signal_stories", json: INPUTS().signals },
  { method: "GET", url: REST + "gtm_comments", status: 404, json: { code: "PGRST205", message: "Could not find the table 'public.gtm_comments' in the schema cache" } },
  { method: "GET", url: REST + "gtm_manual_metrics", json: [] },
];
const MODEL: Report = {
  ...EMPTY, headline: "4 comments on the LinkedIn video led the week.", lede: "Too early to move pillars.",
  went_out: [{ ref: "P2", note: "324 impressions." }],
  actions: [action({ new_date: "2026-10-16" }), action({ new_date: "1999-01-01" })],
};
const writer = async () => ({ report: structuredClone(MODEL), model: "test/model" });

test("run --dry-run: reads, calls the model, guards, and writes or sends nothing", async () => {
  const m = use([...READS, { method: "GET", url: REST + "gtm_content_reports", json: null }]);
  const r = await runWeeklyReport(adminDb(), { week: 1, dryRun: true, now: NOW, write: writer, live: false });
  assert.equal(r.dryRun, true);
  assert.equal(r.report!.headline, MODEL.headline);
  assert.equal(r.report!.actions.length, 1);
  assert.match(r.guard!.dropped[0].reason, /new date/);
  assert.ok(m.calls.every((c) => c.method === "GET"), `only reads: ${m.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`).join(", ")}`);
  assert.ok(!m.calls.some((c) => c.url.includes("resend") || c.url.includes("openrouter")));
});

test("run: saves the report and its actions, emails it, and finishes the run row", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_reports?select=id%2Cstatus", json: null },
    { method: "POST", url: REST + "gtm_content_reports", json: { id: "rep-1" } },
    ...READS,
    { method: "GET", url: REST + "gtm_content_reports", json: null },
    { method: "PATCH", url: REST + "gtm_content_reports", status: 204 },
    { method: "POST", url: REST + "gtm_report_actions", status: 201 },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em-1" } },
  ]);
  const r = await runWeeklyReport(adminDb(), { week: 1, now: NOW, write: writer, live: false, to: "user-f538cb95fc21@example.com" });
  assert.deepEqual([r.id, r.actions, r.email_id], ["rep-1", 1, "em-1"]);
  const start = body(m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_content_reports"))!.body);
  assert.deepEqual([start.kind, start.week, start.period_start, start.period_end, start.status], ["weekly", 1, "2026-10-05", "2026-10-11", "running"]);
  const actions = body(m.calls.find((c) => c.url.startsWith(REST + "gtm_report_actions"))!.body);
  assert.deepEqual(actions.map((a: { type: string; change: unknown }) => [a.type, a.change]), [["move", { date: "2026-10-16" }]]);
  const email = body(m.calls.find((c) => c.url.startsWith("https://api.resend.com"))!.body);
  assert.match(email.subject, /^Week 1 report: 4 comments on the LinkedIn video led the week\. \(1 change to decide\)$/);
  assert.match(email.html, /https:\/\/cockpit\.test\/performance\/report\/1/);
  const finish = m.calls.filter((c) => c.method === "PATCH").map((c) => body(c.body)).at(-1);
  assert.deepEqual([finish.status, finish.email_id], ["done", "em-1"]);
});

test("run --force on a written week clears the old report before the new one is written (review finding 9)", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_reports?select=id%2Cstatus", json: { id: "rep-1", status: "done" } },
    { method: "PATCH", url: REST + "gtm_content_reports", status: 204 },
    { method: "DELETE", url: REST + "gtm_report_actions", status: 204 },
    ...READS,
    { method: "GET", url: REST + "gtm_content_reports", json: null },
    { method: "POST", url: REST + "gtm_report_actions", status: 201 },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em-2" } },
  ]);
  await runWeeklyReport(adminDb(), { week: 1, now: NOW, write: writer, live: false, force: true });
  const restart = body(m.calls.find((c) => c.method === "PATCH")!.body);
  assert.deepEqual([restart.status, restart.report, restart.headline], ["running", null, null]);
  assert.match(m.calls.find((c) => c.method === "DELETE")!.url, /status=eq\.proposed/, "only undecided proposals are replaced");
});

test("run: a week that already has a report is skipped unless forced", async () => {
  const m = use([{ method: "GET", url: REST + "gtm_seasons", json: [SEASON] }, { method: "GET", url: REST + "gtm_content_reports", json: { id: "rep-1", status: "done" } }]);
  const r = await runWeeklyReport(adminDb(), { week: 1, now: NOW, write: writer, live: false });
  assert.match(r.skipped!, /already has a report/);
  assert.ok(m.calls.every((c) => c.method === "GET"));
});

test("email: escapes model text", () => {
  const pack = buildPack(INPUTS(), WK, NOW);
  const r = { ...EMPTY, headline: "<b>4</b> comments" };
  assert.match(reportHtml(pack, r, "https://c.test"), /&lt;b&gt;4&lt;\/b&gt; comments/);
  assert.equal(reportSubject(pack, r), "Week 1 report: <b>4</b> comments");
});
