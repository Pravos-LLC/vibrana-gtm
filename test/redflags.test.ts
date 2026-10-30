// Red flags (VIB-424): stance parsing in the drafting call, no drafts for hostile comments, threshold logic
// (healthy debate vs not landing vs backlash), recommended actions, alert de-duplication, the webhook-side
// trigger, CRM filters and the report's Pushback input. Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
});
const draft = await import("../lib/engage/draft.ts");
const rf = await import("../lib/engage/redflags.ts");
const alerts = await import("../lib/engage/alerts.ts");
const who = await import("../lib/engage/who.ts");
const digest = await import("../lib/engage/digest.ts");
const ingest = await import("../lib/engage/ingest.ts");
const pack = await import("../lib/reports/pack.ts");
const { adminDb } = await import("../lib/db.ts");

const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; });

// ---- stance parsing --------------------------------------------------------------------------------

test("stance and objection come back from the drafting call and are guarded", () => {
  const ids = new Set(["a", "b", "c", "d"]);
  const dissent = draft.checkDraft({ comment_id: "a", classification: "reply", stance: "constructive_dissent", objection: "cost — of training is ignored", reply: "Fair point. We priced training in week two.", reason: "" }, ids)!;
  assert.equal(dissent.stance, "constructive_dissent");
  assert.equal(dissent.objection, "cost, of training is ignored", "no dashes in the objection either");
  assert.equal(dissent.reply, "Fair point. We priced training in week two.");
  const kind = draft.checkDraft({ comment_id: "b", classification: "reply", stance: "supportive", objection: "nothing", reply: "Ops went first.", reason: "" }, ids)!;
  assert.equal(kind.objection, "", "supportive comments have no objection");
  const junk = draft.checkDraft({ comment_id: "c", classification: "reply", stance: "furious" as never, objection: "x", reply: "Ok.", reason: "" }, ids)!;
  assert.equal(junk.stance, undefined, "an unknown stance is dropped, not stored");
  const spam = draft.checkDraft({ comment_id: "d", classification: "reply", stance: "spam", objection: "", reply: "Buy now", reason: "link drop" }, ids)!;
  assert.deepEqual([spam.classification, spam.reply], ["spam", ""]);
});

test("hostile and bad-faith comments never get a drafted reply, whatever the model wrote", () => {
  const ids = new Set(["h", "t"]);
  for (const stance of ["hostile", "troll_or_bad_faith"] as const) {
    const r = draft.checkDraft({ comment_id: stance === "hostile" ? "h" : "t", classification: "reply", stance, objection: "AI hype", reply: "Here is why you are wrong.", reason: "" }, ids)!;
    assert.equal(r.reply, "", stance);
    assert.equal(r.classification, "needs_john", stance);
    assert.equal(r.stance, stance);
  }
});

test("the drafting schema asks for stance and objection in the same call (no extra call per comment)", async () => {
  let body: { response_format: { json_schema: { schema: { properties: { replies: { items: { required: string[]; properties: { stance: { enum: string[] } } } } } } } }; messages: { content: string }[] } | null = null;
  const fetcher = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ replies: [{ comment_id: "x", classification: "reply", stance: "misread", objection: "thinks the post says AI replaces people", reply: "The post argues the opposite: the people stay.", reason: "" }] }) } }] }));
  }) as typeof fetch;
  const out = await draft.openRouterReplyWriter({ key: "k", model: "m", fetcher })({ platform: "linkedin", post: "p", thread: [], targets: [{ id: "x", author: "A", text: "So AI replaces people?", kind: "comment" }] });
  const item = body!.response_format.json_schema.schema.properties.replies.items;
  assert.ok(item.required.includes("stance") && item.required.includes("objection"));
  assert.deepEqual(item.properties.stance.enum, ["supportive", "question", "constructive_dissent", "misread", "hostile", "troll_or_bad_faith", "spam"]);
  assert.match(body!.messages[0].content, /never gets a drafted reply/);
  assert.equal(out[0].stance, "misread");
});

// ---- threshold logic -------------------------------------------------------------------------------

let n = 0;
const c = (stance: string | null, extra: Partial<Parameters<typeof rf.flagPost>[0][number]> = {}) => ({
  id: `c${++n}`, platform: "linkedin", kind: "comment", is_own: false, zernio_post_id: null, platform_post_id: "urn:li:activity:1", comment_url: null,
  content_item_id: null, post_preview: "Six weeks in, the hard part was never the tool.", permalink: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
  author_id: null, author_username: null, author_name: `Person ${n}`, author_crm: null, author_verified: null, author_followers: null,
  stance: stance as never, objection: null, commented_at: `2026-10-10T0${n % 10}:00:00Z`, status: "drafted", ...extra,
});
const at = (h: number) => `2026-10-10T${String(h).padStart(2, "0")}:00:00Z`;

test("ordinary threads raise nothing: supportive, questions, one lone disagreement, one hostile comment", () => {
  assert.equal(rf.flagPost([c("supportive"), c("question"), c("question")]), null, "questions alone are not debate");
  assert.equal(rf.flagPost([c("supportive"), c("constructive_dissent")]), null, "one disagreement with nothing else is not debate");
  assert.equal(rf.flagPost([c("supportive"), c("hostile")]), null, "one hostile comment is noise (9 posts in 3 years of history had exactly one)");
  // Calibrated on 3 years of history (gtm/content/research/comment-history-redflags.md): a disagreement plus
  // one more disagreement or question is debate worth surfacing.
  assert.equal(rf.flagPost([c("supportive"), c("question"), c("constructive_dissent")])!.flag, "healthy_debate");
  assert.equal(rf.flagPost([c("supportive", { is_own: true })]), null);
  assert.equal(rf.flagPost([]), null);
});

test("healthy debate: reasoned dissent plus questions, surfaced as an opportunity", () => {
  const f = rf.flagPost([c("constructive_dissent", { objection: "training cost is ignored" }), c("question"), c("question"), c("supportive")])!;
  assert.equal(f.flag, "healthy_debate");
  assert.equal(f.action, "reply_to_critic", "an unanswered critic is worth a direct reply");
  const answered = rf.flagPost([c("constructive_dissent", { status: "sent" }), c("constructive_dissent", { status: "sent" }), c("question", { status: "sent" })])!;
  assert.equal(answered.action, "leave_it");
});

test("not landing: misreads on one point, clustered into the core objection", () => {
  const f = rf.flagPost([
    c("misread", { objection: "thinks the post says AI replaces people" }), c("misread", { objection: "reads it as AI replacing people" }),
    c("supportive"), c("question"),
  ])!;
  assert.equal(f.flag, "not_landing");
  assert.equal(f.action, "clarify");
  assert.deepEqual(f.also, ["adjust_future_content"]);
  assert.equal(f.objections[0].n, 2, "both misreads are about the same point");
  assert.equal(rf.flagPost([c("misread"), c("misread"), c("misread")])!.action, "follow_up", "three or more: one follow-up comment beats three replies");
});

test("backlash by volume: 3 hostile comments flag it even among 20 supportive (absolute counts, not ratios)", () => {
  const list = [...Array.from({ length: 20 }, () => c("supportive")), c("hostile", { commented_at: at(1) }), c("hostile", { commented_at: at(8) }), c("troll_or_bad_faith", { commented_at: at(16) })];
  const f = rf.flagPost(list)!;
  assert.equal(f.flag, "backlash");
  assert.equal(f.counts.negative, 3);
  assert.match(f.reasons[0], /3 hostile or bad-faith/);
  assert.deepEqual(f.also, ["adjust_future_content"]);
  // Two hostile comments far apart are not backlash.
  assert.equal(rf.flagPost([c("hostile", { commented_at: at(1) }), c("hostile", { commented_at: at(9) }), c("supportive")]), null);
});

test("backlash by velocity: 2 hostile comments inside 3 hours", () => {
  const f = rf.flagPost([c("troll_or_bad_faith", { commented_at: at(10) }), c("troll_or_bad_faith", { commented_at: at(12) })])!;
  assert.equal(f.flag, "backlash");
  assert.match(f.reasons.join(" "), /within 3 h/);
  assert.equal(f.action, "hide_and_report", "a troll-led pile-on: hide and report");
});

test("backlash by who: one disagreement from a CRM contact is enough, and the action is a direct reply", () => {
  const f = rf.flagPost([c("constructive_dissent", { author_crm: "icp", author_name: "Known Buyer", objection: "pricing is unclear" }), c("supportive")])!;
  assert.equal(f.flag, "backlash");
  assert.equal(f.action, "reply_to_critic");
  assert.equal(f.who.known, 1);
  assert.equal(f.who.icp, 1);
  assert.deepEqual(f.who.notable[0], { name: "Known Buyer", stance: "constructive_dissent", tags: ["ICP"] });
  assert.equal(rf.flagPost([c("supportive", { author_crm: "icp" }), c("question", { author_crm: "contact" })]), null, "a supportive contact is not pushback");
});

test("hostile without trolls goes to John; a repeat commenter is tagged; flags sort most severe first", () => {
  const f = rf.flagPost([c("hostile", { author_id: "u1" }), c("hostile", { author_id: "u1" }), c("hostile")], { priorAuthors: new Set() })!;
  assert.equal(f.action, "john_decides");
  assert.equal(f.who.repeat, 1);
  const flags = rf.computeFlags([
    c("constructive_dissent", { platform_post_id: "p1" }), c("question", { platform_post_id: "p1" }), c("question", { platform_post_id: "p1" }),
    c("hostile", { platform_post_id: "p2", commented_at: at(1) }), c("hostile", { platform_post_id: "p2", commented_at: at(2) }),
  ]);
  assert.deepEqual(flags.map((x) => x.flag), ["backlash", "healthy_debate"]);
  for (const x of flags) assert.ok(Object.keys(rf.REDFLAGS.actions).includes(x.action), "the action comes from the fixed set");
});

test("thresholds come from content/guide/redflags.json", () => {
  const strict = { ...rf.REDFLAGS, backlash: { ...rf.REDFLAGS.backlash, min_negative: 5, velocity: { min_negative: 5, within_hours: 1 } } };
  assert.equal(rf.flagPost([c("hostile"), c("hostile"), c("hostile")], { cfg: strict }), null);
});

// ---- alert de-duplication ----------------------------------------------------------------------------

const FLAG = () => rf.flagPost([c("hostile", { commented_at: at(10) }), c("hostile", { commented_at: at(11) })])!;

const RPC = REST + "rpc/gtm_claim_red_flag_alert";

test("the claim is one atomic RPC with the configured cooldown; a null answer means already alerted", async () => {
  const m = use([{ method: "POST", url: RPC, json: null }]);
  assert.equal(await alerts.claimAlert(adminDb(), FLAG(), { via: "webhook" }), null);
  assert.equal(m.calls.length, 1, "no separate select/insert/select dance");
  const body = JSON.parse(m.calls[0].body!);
  assert.equal(body.p_post_key, "linkedin|urn:li:activity:1");
  assert.equal(body.p_flag, "backlash");
  assert.equal(body.p_cooldown_hours, 24);
  assert.equal(body.p_stats.via, "webhook");
});

test("a post newly crossing backlash sends exactly one alert, and says nothing was hidden or answered", async () => {
  const sent: string[] = [];
  const rows = [c("hostile", { commented_at: at(10) }), c("troll_or_bad_faith", { commented_at: at(11) })];
  const m = use([
    { method: "GET", url: REST + "gtm_comments", json: rows },
    { method: "POST", url: RPC, json: "alert-1" },
    { method: "PATCH", url: REST + "gtm_red_flag_alerts", json: [] },
  ]);
  const r = await alerts.checkPostAlert(adminDb(), { platform: "linkedin", zernio_post_id: null, platform_post_id: "urn:li:activity:1" }, { send: async (f) => { sent.push(alerts.alertSubject(f)); return { id: "email-1" }; } });
  assert.deepEqual(r, { flag: "backlash", alerted: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Red flag: backlash on LinkedIn/);
  assert.match(m.calls.find((x) => x.method === "PATCH")!.body!, /email-1/);
  assert.match(alerts.flagLines(FLAG()).join("\n"), /Recommended: /);
});

test("a failed alert email gives the claim back, so the next webhook can still alert (M2)", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_comments", json: [c("hostile", { commented_at: at(10) }), c("hostile", { commented_at: at(11) })] },
    { method: "POST", url: RPC, json: "alert-2" },
    { method: "DELETE", url: REST + "gtm_red_flag_alerts", status: 204 },
  ]);
  await assert.rejects(alerts.checkPostAlert(adminDb(), { platform: "linkedin", zernio_post_id: null, platform_post_id: "urn:li:activity:1" }, { send: async () => { throw new Error("resend 503"); } }), /resend 503/);
  const del = m.calls.find((x) => x.method === "DELETE")!;
  assert.match(decodeURIComponent(del.url), /id=eq\.alert-2/);
  assert.match(decodeURIComponent(del.url), /email_id=is\.null/, "only an unsent claim is released");
});

test("healthy debate never sends an out-of-cycle alert", async () => {
  use([{ method: "GET", url: REST + "gtm_comments", json: [c("constructive_dissent"), c("question"), c("question")] }]);
  const r = await alerts.checkPostAlert(adminDb(), { platform: "linkedin", zernio_post_id: null, platform_post_id: "urn:li:activity:1" }, { send: async () => { throw new Error("must not send"); } });
  assert.deepEqual(r, { flag: "healthy_debate", alerted: false });
});

test("webhook trigger: one quiet comment waits for 07:00; a fast thread is claimed, classified once, then checked", async () => {
  const row = { platform: "instagram", zernio_post_id: "c755b8c9b81299f43625c9f4", platform_post_id: "18" } as Parameters<typeof ingest.redFlagCheck>[1];
  let drafted = 0, checked = 0;
  let draftedRows: unknown[] = [];
  const deps = { draft: (async (_db: unknown, o: { rows: unknown[] }) => { drafted++; draftedRows = o.rows; return {}; }) as never, check: (async () => { checked++; return { flag: "backlash", alerted: true }; }) as never };
  use([{ method: "GET", url: REST + "gtm_comments", json: [{ id: "1" }] }]);
  assert.deepEqual(await ingest.redFlagCheck(adminDb(), row, deps), { classified: false, alert: null });
  mock!.restore();
  const m = use([
    { method: "GET", url: REST + "gtm_comments", json: [{ id: "1" }, { id: "2" }] },
    { method: "PATCH", url: REST + "gtm_comments", json: [{ id: "1" }, { id: "2" }] },
  ]);
  const r = await ingest.redFlagCheck(adminDb(), row, deps);
  assert.equal(r.classified, true);
  assert.deepEqual([drafted, checked], [1, 1]);
  assert.equal(draftedRows.length, 2, "only the claimed rows are drafted");
  const claim = decodeURIComponent(m.calls.find((x) => x.method === "PATCH")!.url);
  assert.match(claim, /or=\(stance_at\.is\.null,stance_at\.lt\./, "unclaimed rows, or claims older than 10 min");
  assert.match(claim, /status=eq\.new/);
  // A second webhook racing the first finds nothing left to claim: no model call, but still the check.
  mock!.restore();
  use([
    { method: "GET", url: REST + "gtm_comments", json: [{ id: "1" }, { id: "2" }] },
    { method: "PATCH", url: REST + "gtm_comments", json: [] },
  ]);
  const second = await ingest.redFlagCheck(adminDb(), row, deps);
  assert.equal(second.classified, false);
  assert.deepEqual([drafted, checked], [1, 2]);
});

test("a claim abandoned by a killed run is taken again after 10 min; a failed draft gives its claim back (L10)", async () => {
  const row = { platform: "instagram", zernio_post_id: "c755b8c9b81299f43625c9f4", platform_post_id: "18" } as Parameters<typeof ingest.redFlagCheck>[1];
  const now = new Date("2026-10-11T12:00:00Z");
  const m = use([
    { method: "GET", url: REST + "gtm_comments", json: [{ id: "1" }, { id: "2" }] },
    { method: "PATCH", url: REST + "gtm_comments", times: 1, json: [{ id: "1" }, { id: "2" }] },
    { method: "PATCH", url: REST + "gtm_comments", json: [] },
  ]);
  const failing = { draft: (async () => { throw new Error("openrouter 503"); }) as never, check: (async () => ({ flag: null, alerted: false })) as never, now };
  await assert.rejects(ingest.redFlagCheck(adminDb(), row, failing), /openrouter 503/);
  const patches = m.calls.filter((x) => x.method === "PATCH").map((x) => ({ url: decodeURIComponent(x.url), body: JSON.parse(x.body!) }));
  // The claim's cutoff is exactly CLAIM_STALE_MS before now.
  assert.ok(patches[0].url.includes(`stance_at.lt.${new Date(now.getTime() - ingest.CLAIM_STALE_MS).toISOString()}`), patches[0].url);
  assert.equal(ingest.CLAIM_STALE_MS, 600_000);
  // The release clears stance_at only on the claimed rows that are still new and unlabelled.
  const release = patches[1];
  assert.deepEqual(release.body, { stance_at: null });
  assert.match(release.url, /id=in\.\(1,2\)/);
  assert.match(release.url, /status=eq\.new/);
  assert.match(release.url, /stance=is\.null/);
});

// ---- who, email, report -------------------------------------------------------------------------------

test("CRM lookups use only what the comment carries, need a full name, and store a match level only", async () => {
  assert.deepEqual(who.crmFilters({ name: "Sam", username: null, platform: "instagram" }), [], "one word is too little to match on");
  assert.match(who.crmFilters({ name: "Sam Okafor", username: null, platform: "instagram" })[0], /firstName:\{ilike:"Sam"\}.*lastName:\{ilike:"Okafor"\}/);
  assert.match(who.crmFilters({ name: null, username: "sam-okafor", platform: "linkedin" })[0], /linkedinLink/);
  const counts: string[] = [];
  const level = await who.crmMatch({ name: "Sam Okafor", username: null, platform: "instagram" }, async (f) => { counts.push(f); return f.includes("gtmOfferFit") ? 0 : 1; });
  assert.equal(level, "contact");
  assert.equal(await who.crmMatch({ name: "Sam Okafor", username: null, platform: "instagram" }, null), null, "no CRM configured: unknown, not none");
});

test("the daily email leads with red flags and counts them in the subject", () => {
  const f = FLAG();
  assert.equal(digest.engageSubject([{ platform: "instagram", author: "a", text: "x", classification: "reply" }], [f]), "1 red flag: 1 reply to approve");
  const html = digest.engageHtml([], "https://cockpit.test", "Sun, Oct 11", [f]);
  assert.match(html, /Flags \(1\): 1 backlash/);
  assert.match(html, /engage\?post=linkedin%7Curn%3Ali%3Aactivity%3A1/);
  assert.match(digest.engageText([], "https://cockpit.test", "d", [f]), /Backlash: LinkedIn/);
  const debate = rf.flagPost([c("constructive_dissent"), c("question"), c("question")])!;
  assert.equal(digest.engageSubject([], [debate]), "No replies to approve", "healthy debate is not a red flag in the subject");
  assert.equal(digest.flagsHeading([f, debate]), "Flags (2): 1 backlash, 1 healthy debate");
});

test("the weekly report gets a Pushback input with counts and the objection, citable as facts", () => {
  const p = pack.toPushback(rf.flagPost([c("misread", { objection: "reads it as AI replacing people" }), c("misread", { objection: "AI replacing people" })])!);
  assert.deepEqual([p.flag, p.misreads, p.negative, p.comments, p.action], ["not_landing", 2, 0, 2, "clarify"]);
  assert.match(String(pack.toPushback(rf.flagPost([c("misread", { post_preview: "Line one\r\nline two" }), c("misread")])!).title), /^Line one$/, "no CR in titles (they reach email subjects)");
  const facts = pack.packFacts({ pushback: [p], week: { number: 1, previous: { number: 0 } }, rules: { final_after_days: 7, maturing_hours: {} }, targets: {}, pillars: [], posts: [], channels: [], medians: { by_pillar: [], by_format: [], by_lens: [] }, mix: { pieces: 0, items: 0, carousels: 0, by_pillar: {}, with_cta: 0 }, unmeasured: [], upcoming: [], reserve: [], signals: [], conversations: null } as never);
  assert.equal(facts["pushback.0.misreads"], 2);
  assert.equal(facts["pushback.0.questions"], 0);
});

test("a reply with no valid stance waits for John: the hostile guard cannot be skipped by omission (L3)", () => {
  const r = draft.checkDraft({ comment_id: "x", classification: "reply", reply: "Fair point, ops went first.", reason: "" }, new Set(["x"]))!;
  assert.equal(r.classification, "needs_john");
  assert.equal(r.reply, "Fair point, ops went first.", "the draft is kept for John to approve");
});

test("redFlags reads each flagged post's whole thread, the same scope as the webhook check (L2)", async () => {
  const today = [c("hostile", { commented_at: new Date().toISOString() })];
  const older = [c("hostile", { commented_at: "2026-09-30T10:00:00Z" }), c("hostile", { commented_at: "2026-09-30T20:00:00Z" })];
  const m = use([
    { method: "GET", url: REST + "gtm_comments?select=id%2Cplatform", regex: false, times: 1, json: today },
    { method: "GET", url: REST + "gtm_comments?select=id%2Cplatform", json: older },
    { method: "GET", url: REST + "gtm_comments?select=platform", json: [] },
  ]);
  const flags = await rf.redFlags(adminDb(), new Date(Date.now() - 7 * 86400_000), new Date(Date.now() + 60_000));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].flag, "backlash");
  assert.equal(flags[0].counts.negative, 3, "two older hostile comments count with today's");
  assert.ok(m.calls.some((x) => decodeURIComponent(x.url).includes("platform_post_id=in.(urn:li:activity:1)")));
});

test("stance-only classifier (history backfill) keeps known ids and stances and guards the objection", async () => {
  const { checkLabels, stancePrompt } = await import("../lib/engage/stance.ts");
  const out = checkLabels([
    { comment_id: "a", stance: "constructive_dissent", objection: "cost — ignored" },
    { comment_id: "b", stance: "supportive", objection: "should be dropped" },
    { comment_id: "zzz", stance: "hostile", objection: "x" },
    { comment_id: "c", stance: "furious", objection: "x" },
  ], new Set(["a", "b", "c"]));
  assert.deepEqual(out, [{ comment_id: "a", stance: "constructive_dissent", objection: "cost, ignored" }, { comment_id: "b", stance: "supportive", objection: "" }]);
  assert.match(stancePrompt({ platform: "linkedin", post: "p", comments: [{ id: "a", text: "t" }] }), /comment_id="a"/);
});
