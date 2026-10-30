// Sunday candidates (VIB-420): the deterministic selection and its balancing, put-validation (the voice guard,
// slides.json, video scripts, sources), reading the routine's working directory, the Story a candidate becomes,
// and the email. Pure functions only; the database paths are in test/db/candidates.test.ts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFetchMock } from "./support/fetch-mock.ts";

Object.assign(process.env, { RESEND_API_KEY: "re_test", REPORT_TZ: "Asia/Makassar" });
const { defaultWeekStart, lensOfLanes, selectCandidates, slugify } = await import("../lib/candidates/select.ts");
const { candidateProblems, putProblems } = await import("../lib/candidates/validate.ts");
const { parseVideoLines, readPutInput } = await import("../lib/candidates/read.ts");
const { candidateStory, editDiff } = await import("../lib/candidates/store.ts");
const { candidatesSubject, candidatesText, sendCandidatesEmail } = await import("../lib/candidates/email.ts");
type SelectInput = import("../lib/candidates/select.ts").SelectInput;
type SignalRow = SelectInput["queued"][number];
type CandidateInput = import("../lib/candidates/validate.ts").CandidateInput;
type CandidateRow = import("../lib/candidates/store.ts").CandidateRow;

let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const brief = (headline: string, audience_fit = 0.8) => ({ headline, what_happened: "w", why_it_matters: "y", tension: "t", angles: { linkedin_take: "l", story: "s", video: "v" }, sources: [{ title: `${headline} source`, url: `https://example.test/${slugify(headline)}`, source: "Example" }], audience_fit, audience_reason: `reason for ${headline}` });
const signal = (title: string, lanes: string[], score: number, extra: Partial<SignalRow> = {}): SignalRow => ({
  id: uuid(), title, lanes, score, status: "new", requested_format: null, brief: brief(title), last_seen: "2026-10-10T00:00:00Z", acted_at: null, ...extra,
});
const input = (over: Partial<SelectInput> = {}): SelectInput => ({ week_start: "2026-10-12", queued: [], briefed: [], actions: [], taken: { signals: [], actions: [] }, sources: {}, ...over });

// ---- selection ---------------------------------------------------------------------------------------

test("lensOfLanes: the lens holding most lanes; a tie goes to the first lane's lens; unknown lanes have none", () => {
  assert.equal(lensOfLanes(["builder"]), "thought_leadership");
  assert.equal(lensOfLanes(["power", "builder", "datacenters"]), "regenerative");
  assert.equal(lensOfLanes(["governance", "ethics"]), "transformation");
  assert.equal(lensOfLanes(["ethics", "governance"]), "regenerative");
  assert.equal(lensOfLanes(["unknown"]), null);
});

test("selection balances the lenses: 6 picks from a pool skewed to one lens take 2 of each", () => {
  const briefed = [
    ...Array.from({ length: 8 }, (_, i) => signal(`Builder story ${i}`, ["builder"], 90 - i)),
    signal("Power story", ["power"], 40), signal("Ethics story", ["ethics"], 30),
    signal("Cost story", ["cost"], 35), signal("Governance story", ["governance"], 20),
  ];
  const r = selectCandidates(input({ briefed }));
  assert.equal(r.candidates.length, 6);
  assert.deepEqual(r.balance.lens, { transformation: 2, thought_leadership: 2, regenerative: 2 });
  // Within a lens the highest score wins: the two best builder stories, not all eight.
  assert.deepEqual(r.candidates.filter((c) => c.lens === "thought_leadership").map((c) => c.title), ["Builder story 0", "Builder story 1"]);
  assert.deepEqual(r.warnings, []);
});

test("selection is deterministic: the same input gives the same candidates in the same order", () => {
  const briefed = [signal("A", ["builder"], 50), signal("B", ["power"], 50), signal("C", ["cost"], 50), signal("D", ["open_source"], 49), signal("E", ["bias"], 48), signal("F", ["privacy"], 47), signal("G", ["ethics"], 46)];
  const a = selectCandidates(input({ briefed }));
  const b = selectCandidates(input({ briefed: [...briefed].reverse() }));
  assert.deepEqual(a.candidates.map((c) => [c.slug, c.format, c.pillar]), b.candidates.map((c) => [c.slug, c.format, c.pillar]));
});

test("the audience gate: off-audience and stale briefed stories never fill the week; it is drafted short instead", () => {
  const offAudience = Array.from({ length: 8 }, (_, i) => signal(`Trading tool ${i}`, ["builder", "power", "cost"][i % 3] ? [["builder", "power", "cost"][i % 3]] : [], 90 - i, { brief: brief(`Trading tool ${i}`, 0.2) }));
  const unscored = signal("Unscored", ["power"], 80, { brief: { ...brief("Unscored"), audience_fit: undefined, audience_reason: undefined } });
  const stale = signal("Stale but fitting", ["cost"], 4);
  const fitting = [signal("COO budget question", ["cost"], 30), signal("People lead hiring story", ["ethics"], 20)];
  const r = selectCandidates(input({ briefed: [...offAudience, unscored, stale, ...fitting] }));
  assert.deepEqual(r.candidates.map((c) => c.title).sort(), ["COO budget question", "People lead hiring story"]);
  assert.equal(r.pool.gated, 10);
  assert.match(r.gated.find((g) => g.title === "Trading tool 0")!.why, /audience fit 0.2 under 0.6/);
  assert.match(r.gated.find((g) => g.title === "Unscored")!.why, /no audience fit scored/);
  assert.match(r.gated.find((g) => g.title === "Stale but fitting")!.why, /score 4 under 5/);
  assert.match(r.warnings.join("\n"), /only 2 stories to draft/);
  assert.equal(r.candidates[0].audience_reason, "reason for COO budget question");
  // Queued signals bypass the gate: John chose them.
  const q = signal("John's pick", ["builder"], 3, { status: "queued", requested_format: "story", brief: brief("John's pick", 0.1) });
  assert.ok(selectCandidates(input({ queued: [q] })).candidates.some((c) => c.title === "John's pick"));
});

test("selection-time fits fill in briefs that predate audience_fit, and only for ids that were asked", async () => {
  const { scoreFits, checkFits, needsFit } = await import("../lib/candidates/fit.ts");
  const old = signal("Old brief", ["cost"], 50, { brief: { ...brief("Old brief"), audience_fit: undefined, audience_reason: undefined } });
  const fresh = signal("New brief", ["power"], 40);
  const inp = input({ briefed: [old, fresh] });
  assert.deepEqual(needsFit(inp).map((s) => s.id), [old.id]);
  assert.deepEqual(checkFits({ stories: [{ id: old.id, audience_fit: 85, audience_reason: "budget \u2014 now" }, { id: "made-up", audience_fit: 1, audience_reason: "x" }] }, [old]), { [old.id]: { audience_fit: 0.85, audience_reason: "budget, now" } });
  const scored = await scoreFits(inp, async (todo) => Object.fromEntries(todo.map((s) => [s.id, { audience_fit: 0.9, audience_reason: "scored" }])));
  const r = selectCandidates(scored);
  assert.deepEqual(r.candidates.map((c) => [c.title, c.audience_fit]).sort(), [["New brief", 0.8], ["Old brief", 0.9]]);
});

test("the Perspective cap: no more than 2 Perspective picks while another pillar can take the story", () => {
  const briefed = ["cost", "power", "governance", "ethics", "privacy", "bias"].map((lane, i) => signal(`Story ${lane}`, [lane], 60 - i));
  const r = selectCandidates(input({ briefed }));
  assert.equal(r.candidates.length, 6);
  assert.ok(r.balance.pillar.perspective <= 2, JSON.stringify(r.balance.pillar));
  assert.ok(!r.warnings.some((w) => /over the cap/.test(w)));
  // Queued picks John fixed as Perspective by report can exceed it; then it is a warning, not a silent skew.
  const actions = [0, 1, 2].map((i) => ({ id: uuid(), report_id: "r", position: i, status: "proposed", proposal: "p", rationale: "", change: { title: `Report take ${i}`, pillar: "perspective" } }));
  assert.match(selectCandidates(input({ actions })).warnings.join(), /3 perspective picks, over the cap of 2/);
});

test("formats: at least one carousel and one video, preferring Lists/Build for the carousel and Regenerative for the video", () => {
  const briefed = [signal("Agents ship", ["builder"], 80), signal("Open models", ["open_source"], 70), signal("Grid strain", ["power"], 60), signal("AI bill", ["cost"], 50), signal("Data centers", ["datacenters"], 40)];
  const r = selectCandidates(input({ briefed }));
  assert.equal(r.balance.format.carousel, 1);
  assert.equal(r.balance.format.video, 1);
  const carousel = r.candidates.find((c) => c.format === "carousel")!;
  assert.ok(["lists", "build"].includes(carousel.pillar), `carousel on ${carousel.pillar}`);
  assert.equal(r.candidates.find((c) => c.format === "video")!.lens, "regenerative");
  assert.deepEqual(carousel.channels, ["linkedin", "instagram"]);
  assert.deepEqual(r.candidates.find((c) => c.format === "text")!.channels, ["linkedin"]);
  // Pillars spread before repeating: Build and Lists both appear, Perspective stays within its cap.
  assert.ok(r.balance.pillar.build >= 1 && r.balance.pillar.lists >= 1, JSON.stringify(r.balance.pillar));
  assert.ok(r.balance.pillar.perspective <= 2);
});

test("queued signals come first, keep a requested video, and the report's new_story actions are in the set", () => {
  const queuedVideo = signal("John wants this video", ["ethics"], 5, { status: "queued", requested_format: "video", acted_at: "2026-10-09T00:00:00Z" });
  const queuedStory = signal("John wants this story", ["builder"], 4, { status: "queued", requested_format: "story", acted_at: "2026-10-10T00:00:00Z" });
  const briefed = Array.from({ length: 10 }, (_, i) => signal(`Briefed ${i}`, [["cost", "power", "builder"][i % 3]], 99 - i));
  const action = { id: uuid(), report_id: uuid(), position: 0, status: "proposed", proposal: "Add a Proof story on the Orion pacing lesson", rationale: "r", change: { title: "Orion pacing lesson", pillar: "proof", format: "carousel", channels: ["linkedin"], date: "2026-10-14" } };
  const r = selectCandidates(input({ queued: [queuedStory, queuedVideo], briefed, actions: [action] }));
  assert.deepEqual(r.candidates.slice(0, 3).map((c) => c.origin), ["queued", "queued", "report"]);
  assert.equal(r.candidates[0].title, "John wants this video", "the older queue entry first");
  assert.equal(r.candidates[0].format, "video");
  const fromReport = r.candidates[2];
  assert.deepEqual([fromReport.pillar, fromReport.lens, fromReport.format, fromReport.channels, fromReport.report_action_id], ["proof", "transformation", "carousel", ["linkedin"], action.id]);
  assert.equal(r.candidates.length, 6);
  assert.equal(r.balance.format.video, 1, "the queued video already meets the video minimum");
});

test("a report action on a queued signal merges into one candidate; dismissed actions and used signals are skipped", () => {
  const q = signal("Queued", ["power"], 10, { status: "queued", requested_format: "repost" });
  const used = signal("Used last week", ["builder"], 99);
  const actions = [
    { id: uuid(), report_id: "r", position: 0, status: "proposed", proposal: "Write it", rationale: "", change: { title: "Queued", pillar: "perspective", signal_id: q.id } },
    { id: uuid(), report_id: "r", position: 1, status: "dismissed", proposal: "No", rationale: "", change: { title: "Dismissed idea", pillar: "build" } },
  ];
  const r = selectCandidates(input({ queued: [q], briefed: [used, signal("Other", ["cost"], 15)], actions, taken: { signals: [used.id], actions: [] } }));
  assert.equal(r.candidates.filter((c) => c.signal_id === q.id).length, 1);
  assert.equal(r.candidates.find((c) => c.signal_id === q.id)!.report_action_id, actions[0].id);
  assert.ok(!r.candidates.some((c) => c.signal_id === used.id));
  assert.ok(!r.candidates.some((c) => c.title === "Dismissed idea"));
  assert.match(r.warnings.join("\n"), /only 2 stories to draft/);
});

test("more than seven forced picks are capped at seven with a warning; slugs stay unique", () => {
  const queued = Array.from({ length: 9 }, (_, i) => signal("Same headline", ["builder"], 10, { status: "queued", requested_format: "story", acted_at: `2026-10-0${i + 1}T00:00:00Z` }));
  const r = selectCandidates(input({ queued }));
  assert.equal(r.candidates.length, 7);
  assert.equal(new Set(r.candidates.map((c) => c.slug)).size, 7);
  assert.match(r.warnings.join("\n"), /more than the 7/);
});

test("slugify cuts at a word boundary and drops apostrophes; the default week is the Monday after today in Bali", () => {
  assert.equal(slugify("A social post claims Google’s energy growth equals New Zealand’s consumption"), "a-social-post-claims-googles-energy-growth");
  assert.equal(slugify("Héllo, world!"), "hello-world");
  assert.equal(defaultWeekStart(new Date("2026-10-11T07:00:00Z")), "2026-10-12"); // Sunday 15:00 Bali
  assert.equal(defaultWeekStart(new Date("2026-10-10T20:00:00Z")), "2026-10-12"); // already Sunday in Bali
});

// ---- put-validation --------------------------------------------------------------------------------

const deck = { template: "listicle", slides: [
  { type: "cover", title: "Five agent patterns" }, ...[1, 2, 3, 4, 5].map((i) => ({ type: "item", n: i, title: `Pattern ${i}`, body: "Why it matters." })), { type: "cta", title: "Which one is your team missing?" },
] };
const good = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  slug: "agents-ship", title: "Agents ship", format: "text", lens: "thought_leadership", pillar: "build", body: "---\nhook: h1\n---\nA plain post. [JOHN: your take on the pricing]",
  sources: [{ title: "Source", url: "https://example.test/a", source: "Example" }], rubric: { overall: "pass", rounds: 1 }, score: 82, ...over,
});

test("a clean candidate passes and its [JOHN: ...] slots are counted, not refused", () => {
  const p = candidateProblems(good());
  assert.deepEqual(p.errors, []);
  assert.equal(p.john_slots, 1);
});

test("the voice guard refuses em and en dashes and banned words anywhere a reader sees, including slides", () => {
  assert.match(candidateProblems(good({ body: "One thing — then another." })).errors.join(), /em or en dash/);
  assert.match(candidateProblems(good({ title: "Q3 – Q4" })).errors.join(), /title: has an em or en dash/);
  assert.match(candidateProblems(good({ body: "We leverage agents." })).errors.join(), /banned "leverage"/);
  assert.match(candidateProblems(good({ body: "Agents that unlocked it." })).errors.join(), /banned "unlock"/);
  assert.match(candidateProblems(good({ body: "Harness the power of AI today." })).errors.join(), /banned "harness the power of ai"/);
  const slides = { ...deck, slides: deck.slides.map((s, i) => (i === 2 ? { ...s, body: "A seamless handoff." } : s)) };
  assert.match(candidateProblems(good({ format: "carousel", slides })).errors.join(), /slides\.json: uses the banned "seamless"/);
  assert.deepEqual(candidateProblems(good({ body: "The landscape outside the window." })).errors, [], "qualified bans (landscape as metaphor) are the judge's call");
  assert.match(candidateProblems(good({ body: "We will organise it." })).warnings.join(), /British spelling \(organise\)/);
});

test("links stay out of the post text: LinkedIn uses first_comment, Instagram never has one", () => {
  assert.match(candidateProblems(good({ body: "Read it at https://example.test/x" })).errors.join(), /link in the post text/);
  assert.deepEqual(candidateProblems(good({ body: "---\nfirst_comment: https://example.test/x\n---\nNo link here." })).errors, []);
  assert.match(candidateProblems(good({ channels: ["linkedin", "instagram"], instagram: "See brand.example.com/case-studies" })).errors.join(), /Instagram captions never carry a link/);
});

test("slides.json follows the vibrana-carousel schema", () => {
  assert.deepEqual(candidateProblems(good({ format: "carousel", slides: deck })).errors, []);
  const errs = (slides: unknown) => candidateProblems(good({ format: "carousel", slides: slides as never })).errors.join("\n");
  assert.match(errs(null), /slides\.json must be an object/);
  assert.match(errs({ ...deck, template: "poster" }), /template must be one of listicle, case-study, framework/);
  assert.match(errs({ ...deck, slides: deck.slides.slice(0, 2) }), /at least 3 slides/);
  assert.match(errs({ ...deck, slides: [deck.slides[1], ...deck.slides] }), /first slide must be the cover/);
  assert.match(errs({ ...deck, slides: [...deck.slides.slice(0, 2), { type: "item", title: "No number" }, ...deck.slides.slice(2)] }), /needs a number n and a title/);
  assert.match(errs({ ...deck, slides: [...deck.slides, { type: "hologram", title: "x" }] }), /unknown type "hologram"/);
  assert.match(errs({ ...deck, sample: true }), /SAMPLE badge/);
  assert.match(candidateProblems(good({ format: "carousel", slides: { ...deck, slides: deck.slides.slice(0, 4) } })).warnings.join(), /the guide asks for 6 to 10/);
  assert.match(candidateProblems(good({ format: "text", slides: deck })).errors.join(), /slides belong to a carousel/);
});

test("a video needs a hook and at least three beats; sources are required and must be links", () => {
  assert.deepEqual(candidateProblems(good({ format: "video", video: { hook: "Hook", beats: ["a", "b", "c"] } })).errors, []);
  assert.match(candidateProblems(good({ format: "video", video: { hook: "", beats: ["a", "b"] } })).errors.join("\n"), /hook line[\s\S]*at least 3 beats/);
  assert.match(candidateProblems(good({ format: "video" })).errors.join(), /needs \{hook, beats\}/);
  assert.match(candidateProblems(good({ sources: [] })).errors.join(), /at least one source/);
  assert.match(candidateProblems(good({ sources: [{ title: "t", url: "example.test", source: "s" }] })).errors.join(), /needs an http\(s\) url/);
});

test("shape errors: slug, format, lens, pillar, channels, ids", () => {
  const e = candidateProblems({ ...good(), slug: "Bad Slug", format: "reel" as never, lens: "growth" as never, pillar: "story" as never, channels: ["tiktok"], signal_id: "nope" }).errors.join("\n");
  for (const re of [/slug must be/, /format must be/, /lens must be/, /pillar must be/, /channels must be/, /signal_id must be/]) assert.match(e, re);
});

test("putProblems: duplicates are errors; the week's count and missing carousel or video are warnings", () => {
  const p = putProblems([good(), good()]);
  assert.match(p.errors.join(), /duplicate slug: agents-ship/);
  assert.match(p.warnings.join("\n"), /2 candidates; the week wants 5 to 7[\s\S]*no carousel[\s\S]*no video/);
  assert.deepEqual(putProblems([]).errors, [], "an empty week is not an error");
  assert.match(putProblems([]).warnings.join(), /no candidates to put/);
  assert.match(candidateProblems(good({ pillar: "proof", lens: "transformation" })).warnings.join(), /needs persona-review/);
  assert.ok(!candidateProblems(good({ pillar: "proof", lens: "transformation", rubric: { overall: "pass", persona_review: "zero BLOCKs" } })).warnings.some((w) => /persona-review/.test(w)));
});

// ---- reading the routine's directory ------------------------------------------------------------------

test("readPutInput reads one folder per candidate and fills gaps from selection.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
  const sid = uuid();
  writeFileSync(join(dir, "selection.json"), JSON.stringify({ week_start: "2026-10-12", candidates: [{ slug: "grid-strain", title: "Grid strain", format: "video", lens: "regenerative", pillar: "perspective", channels: ["linkedin", "youtube"], signal_id: sid, report_action_id: null, sources: [{ title: "s", url: "https://example.test/s", source: "x" }], position: 2 }] }));
  mkdirSync(join(dir, "grid-strain"));
  writeFileSync(join(dir, "grid-strain", "candidate.json"), JSON.stringify({ rubric: { overall: "pass" }, score: 77 }));
  writeFileSync(join(dir, "grid-strain", "linkedin.md"), "The caption.");
  writeFileSync(join(dir, "grid-strain", "video-lines.md"), "# Grid strain\n\n**Hook:** The grid is the new bottleneck.\n\n1. Beat one\n2. Beat two\n3. Beat three\n");
  mkdirSync(join(dir, "notes")); // a folder without candidate.json is ignored
  const r = readPutInput(dir);
  assert.equal(r.week_start, "2026-10-12");
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.deepEqual([c.slug, c.format, c.lens, c.pillar, c.signal_id, c.position, c.body, c.score], ["grid-strain", "video", "regenerative", "perspective", sid, 2, "The caption.", 77]);
  assert.deepEqual([c.video!.hook, c.video!.beats], ["The grid is the new bottleneck.", ["Beat one", "Beat two", "Beat three"]]);
  assert.deepEqual(candidateProblems(c).errors, []);
});

test("parseVideoLines takes a Hook line and numbered or bulleted beats", () => {
  assert.deepEqual(parseVideoLines("Hook: H\n- one\n- two\n3) three").beats, ["one", "two", "three"]);
});

// ---- staging shape, edits and email -----------------------------------------------------------------------

const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  id: uuid(), week_start: "2026-10-12", slug: "five-agent-patterns", position: 1, status: "candidate", format: "carousel", lens: "thought_leadership", pillar: "lists",
  channels: ["linkedin", "instagram"], title: "Five agent patterns", body: "LinkedIn text.", instagram: "IG caption.", slides: deck, video: null,
  sources: [{ title: "s", url: "https://example.test/s", source: "x" }], rubric: {}, score: 80, playbook: {}, signal_id: null, report_action_id: null,
  agent_draft: { title: "Five agent patterns", body: "LinkedIn text.", instagram: "IG caption.", slides: deck, video: null }, edits: [],
  reject_reason: null, reject_note: null, gtm_story_id: null, content_item_ids: [], decided_by: null, decided_at: null, created_at: "", updated_at: "", ...over,
});

test("candidateStory: a season Story, one copy asset and one drafted item per channel, bound so the approval gate works", () => {
  const c = row();
  const { story, assets, items } = candidateStory(c, "season-1");
  assert.equal(story.id, "s1-c261012-five-agent-patterns");
  assert.equal(story.title, "Candidate wk Oct 12 | Five agent patterns");
  assert.equal(story.season_id, "season-1");
  assert.deepEqual(assets.map((a) => [a.id, a.kind, a.channels, a.body]), [
    ["s1-c261012-five-agent-patterns-linkedin", "copy", ["linkedin"], "LinkedIn text."],
    ["s1-c261012-five-agent-patterns-instagram", "copy", ["instagram"], "IG caption."],
  ]);
  assert.deepEqual(items.map((i) => [i.channels, i.format, i.status, i.date, i.story_assets, i.copy_path === assets.find((a) => a.id === i.id)!.source]), [
    [["linkedin"], "document", "drafted", "2026-10-14", ["s1-c261012-five-agent-patterns-linkedin"], true],
    [["instagram"], "carousel", "drafted", "2026-10-14", ["s1-c261012-five-agent-patterns-instagram"], true],
  ]);
  assert.deepEqual((assets[0].metadata as { slides: unknown }).slides, deck);
});

test("season Story ids: the prefix follows the season, and any season's pieces count as season pieces", async () => {
  const { seasonStoryPrefix, isSeasonStory } = await import("../lib/season-id.ts");
  assert.equal(seasonStoryPrefix("season-1"), "s1-");
  assert.equal(seasonStoryPrefix("season-12"), "s12-");
  assert.equal(seasonStoryPrefix("spring-pilot"), "spring-pilot-");
  assert.equal(candidateStory(row(), "season-2").story.id, "s2-c261012-five-agent-patterns");
  for (const id of ["s1-01-sample-piece-01", "s2-c261214-x", "s12-03-y"]) assert.ok(isSeasonStory(id), id);
  for (const id of ["sample-extra-38", "regenera-essay", "fx-story", "season-1"]) assert.ok(!isSeasonStory(id), id);
});

test("editDiff lists only the fields John changed against the agent's frozen draft", () => {
  assert.deepEqual(editDiff(row()), []);
  assert.deepEqual(editDiff(row({ body: "John's text." })), [{ field: "body", agent: "LinkedIn text.", john: "John's text." }]);
});

test("the email: subject counts the waiting candidates, text names each with its slots, Resend gets one request", async () => {
  const list = [{ slug: "a", title: "A", format: "carousel" as const, pillar: "lists", lens: "thought_leadership", channels: ["linkedin"], body: "---\nhook: x\n---\nFirst line.\nSecond.", score: 80, john_slots: 2 }];
  assert.equal(candidatesSubject(list, "2026-10-12"), "1 candidate waiting for the week of Oct 12");
  const text = candidatesText(list, "2026-10-12", "https://cockpit.test");
  assert.match(text, /https:\/\/cockpit\.test\/signals\?view=candidates/);
  assert.match(text, /1\. A \[Carousel, lists, Thought leadership, rubric 80\]\n {3}First line\.\n {3}2 places need your take/);
  mock = installFetchMock([{ url: "https://api.resend.com/emails", json: { id: "em_1" } }]);
  assert.deepEqual(await sendCandidatesEmail(list, "2026-10-12", { to: "john@example.test", cockpitUrl: "https://cockpit.test" }), { id: "em_1" });
  const body = JSON.parse(mock.calls[0].body!);
  assert.deepEqual([body.to, body.subject], [["john@example.test"], "1 candidate waiting for the week of Oct 12"]);
});
