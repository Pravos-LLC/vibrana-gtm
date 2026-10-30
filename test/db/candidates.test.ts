// Sunday candidates (VIB-420) against the real LOCAL database: put, edit, Send to Review (staging through the
// same writer as `gtm story stage`, claimed once) and Reject (a reason on the signal's feedback).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, FIXTURE_CANDIDATE_CAROUSEL, FIXTURE_CANDIDATE_TEXT, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const { putCandidates, editCandidate, sendToReview, rejectCandidate, listCandidates, waitingCount } = await import("../../lib/candidates/store.ts");
const { loadSelectInput, selectCandidates } = await import("../../lib/candidates/select.ts");
type CandidateInput = import("../../lib/candidates/validate.ts").CandidateInput;

const SIGNAL = "00000000-0000-4000-8000-0000000000f1";
// A season that covers the fixture candidates' week: Send to Review refuses a week no season covers.
const SEASON = { id: "season-9", title: "Fixture candidates season", starts_on: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10), ends_on: new Date(Date.now() + 120 * 86400_000).toISOString().slice(0, 10) };
before(async () => {
  await seed();
  const { error } = await admin().from("gtm_seasons").insert(SEASON);
  if (error) throw new Error(error.message);
});

const deck = { template: "listicle", slides: [{ type: "cover", title: "Cover" }, ...[1, 2, 3, 4, 5].map((n) => ({ type: "item", n, title: `Item ${n}`, body: "Body." })), { type: "cta", title: "Over to you" }] };
const input = (slug: string, over: Partial<CandidateInput> = {}): CandidateInput => ({
  slug, title: `Title ${slug}`, format: "text", lens: "regenerative", pillar: "perspective", body: `Body of ${slug}.`,
  sources: [{ title: "s", url: "https://example.com/s", source: "x" }], rubric: { overall: "pass", rounds: 1 }, score: 70, ...over,
});

test("put is all or nothing: one bad candidate writes none of the week", async () => {
  const db = admin();
  const r = await putCandidates(db, "2030-01-07", [input("ok-one"), input("bad-one", { body: "We leverage it — fast." })]);
  assert.equal(r.written.length, 0);
  assert.match(r.problems.errors.join("\n"), /em or en dash[\s\S]*banned "leverage"/);
  assert.equal((await listCandidates(db, { week_start: "2030-01-07" })).length, 0);
  await assert.rejects(putCandidates(db, "2030-01-08", [input("x")]), /not a Monday/);
});

test("put upserts the week; a rerun replaces untouched drafts and keeps decided or edited ones", async () => {
  const db = admin();
  const week = "2030-01-14";
  const first = await putCandidates(db, week, [input("a"), input("b", { format: "carousel", lens: "thought_leadership", pillar: "lists", slides: deck })]);
  assert.deepEqual(first.written, ["a", "b"]);
  const [a, b] = await listCandidates(db, { week_start: week });
  assert.deepEqual([a.slug, a.channels, b.channels, b.agent_draft.slides], ["a", ["linkedin"], ["linkedin", "instagram"], deck]);
  await editCandidate(db, a.id, "body", "John's own text.", "owner@gtm.test");
  await rejectCandidate(db, b.id, "angle", null, "owner@gtm.test");
  const again = await putCandidates(db, week, [input("a", { body: "Agent v2." }), input("b", { format: "carousel", lens: "thought_leadership", pillar: "lists", slides: deck }), input("c")]);
  assert.deepEqual(again.written, ["c"]);
  assert.deepEqual(again.kept.map((k) => k.slug), ["a", "b"]);
  assert.equal((await listCandidates(db, { week_start: week })).find((c) => c.slug === "a")!.body, "John's own text.");
});

test("edit keeps the agent's draft frozen and logs John's change; a stale page and a decided candidate are refused", async () => {
  const db = admin();
  const [row] = await listCandidates(db, { week_start: undefined }).then((rows) => rows.filter((r) => r.id === FIXTURE_CANDIDATE_CAROUSEL));
  const r = await editCandidate(db, row.id, "body", "Five patterns, John's words.", "owner@gtm.test", row.updated_at);
  assert.equal(r.changed, true);
  assert.equal(r.row.body, "Five patterns, John's words.");
  assert.equal((r.row.agent_draft as { body: string }).body, row.body, "agent_draft stays the agent's");
  assert.deepEqual(r.row.edits.map((e) => [e.field, e.before, e.after, e.by]), [["body", row.body, "Five patterns, John's words.", "owner@gtm.test"]]);
  await assert.rejects(editCandidate(db, row.id, "title", "New", "owner@gtm.test", row.updated_at), /changed since the page loaded/);
  await assert.rejects(editCandidate(db, row.id, "slides", "{not json", "owner@gtm.test"), /not valid JSON/);
  await assert.rejects(editCandidate(db, row.id, "slides", JSON.stringify({ template: "listicle", slides: [] }), "owner@gtm.test"), /at least 3 slides/);
  const dash = await editCandidate(db, row.id, "title", "Five patterns — kept", "owner@gtm.test");
  assert.match(dash.warnings.join(), /em or en dash/, "John's own wording is a warning, not a refusal");
  await editCandidate(db, row.id, "title", "Fixture five agent patterns", "owner@gtm.test");
});

test("Send to Review stages a Story with pending channels and drafted items, once, however many clicks race", async () => {
  const db = admin();
  const results = await Promise.allSettled([1, 2, 3].map(() => sendToReview(db, FIXTURE_CANDIDATE_CAROUSEL, "owner@gtm.test")));
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "exactly one click stages it");
  for (const r of results.filter((x) => x.status === "rejected")) assert.match(String((r as PromiseRejectedResult).reason), /Already accepted/);
  const c = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof sendToReview>>>).value;
  assert.equal(c.status, "accepted");
  assert.match(c.gtm_story_id!, /^s9-c\d{6}-fixture-five-agent-patterns$/, "the prefix comes from the covering season");

  const story = (await db.from("gtm_stories").select("id,title,season_id").eq("id", c.gtm_story_id!).single()).data!;
  assert.equal(story.season_id, "season-9");
  assert.match(story.title, /^Candidate wk .+ \| Fixture five agent patterns$/);
  const assets = (await db.from("gtm_story_assets").select("id,kind,body,metadata").eq("story_id", story.id).order("id")).data!;
  assert.deepEqual(assets.map((a) => [a.id.replace(story.id, ""), a.kind]), [["-instagram", "copy"], ["-linkedin", "copy"]]);
  assert.equal(assets.find((a) => a.id.endsWith("-linkedin"))!.body, "Five patterns, John's words.", "John's edit is what goes to review");
  assert.equal((assets[0].metadata as { candidate_id: string }).candidate_id, FIXTURE_CANDIDATE_CAROUSEL);
  const channels = (await db.from("gtm_story_asset_channels").select("asset_id,channel,status").in("asset_id", assets.map((a) => a.id)).order("channel")).data!;
  assert.deepEqual(channels.map((x) => [x.channel, x.status]), [["instagram", "pending"], ["linkedin", "pending"]]);
  const items = (await db.from("gtm_content_items").select("id,status,format,channels,story_id,story_assets,copy_path,approved_hash").eq("story_id", story.id).order("id")).data!;
  assert.deepEqual(items.map((i) => [i.status, i.format, i.channels, i.approved_hash]), [["drafted", "carousel", ["instagram"], null], ["drafted", "document", ["linkedin"], null]]);
  assert.deepEqual(c.content_item_ids.sort(), items.map((i) => i.id).sort());
  const waiting = (await listCandidates(db, { status: "candidate" })).map((x) => x.id);
  assert.ok(waiting.includes(FIXTURE_CANDIDATE_TEXT) && !waiting.includes(FIXTURE_CANDIDATE_CAROUSEL));
  assert.equal(await waitingCount(db), waiting.length);
});

test("Send to Review on a signal's candidate marks the signal drafted and links the Story", async () => {
  const db = admin();
  const c = await sendToReview(db, FIXTURE_CANDIDATE_TEXT, "owner@gtm.test");
  const sig = (await db.from("gtm_signal_stories").select("status,gtm_story_id").eq("id", SIGNAL).single()).data!;
  assert.deepEqual(sig, { status: "drafted", gtm_story_id: c.gtm_story_id });
  const fb = (await db.from("gtm_signal_feedback").select("action").eq("story_id", SIGNAL).eq("action", "drafted")).data!;
  assert.equal(fb.length, 1);
  await assert.rejects(rejectCandidate(db, FIXTURE_CANDIDATE_TEXT, "angle", null, "owner@gtm.test"), /Already accepted/);
});

test("Send to Review refuses a week no season covers, and leaves the candidate waiting", async () => {
  const db = admin();
  await putCandidates(db, "2031-06-02", [input("no-season")]);
  const [row] = await listCandidates(db, { week_start: "2031-06-02" });
  await assert.rejects(sendToReview(db, row.id, "owner@gtm.test"), /No season covers the week of 2031-06-02/);
  assert.equal((await listCandidates(db, { week_start: "2031-06-02" }))[0].status, "candidate");
});

test("Reject records the reason on the candidate and as a taste label on its signal", async () => {
  const db = admin();
  const week = "2030-02-04";
  await putCandidates(db, week, [input("rejected-one", { signal_id: SIGNAL })]);
  const [row] = await listCandidates(db, { week_start: week });
  await assert.rejects(rejectCandidate(db, row.id, "bogus" as never, null, "owner@gtm.test"), /Pick a reason/);
  const r = await rejectCandidate(db, row.id, "voice", "  too polished  ", "owner@gtm.test");
  assert.deepEqual([r.status, r.reject_reason, r.reject_note, r.decided_by], ["rejected", "voice", "too polished", "owner@gtm.test"]);
  const fb = (await db.from("gtm_signal_feedback").select("action,reason,candidate_id,actor").eq("candidate_id", row.id)).data!;
  assert.deepEqual(fb, [{ action: "reject", reason: "voice: too polished", candidate_id: row.id, actor: "owner@gtm.test" }]);
  await assert.rejects(rejectCandidate(db, row.id, "angle", null, "owner@gtm.test"), /Already rejected/);
  await assert.rejects(sendToReview(db, row.id, "owner@gtm.test"), /Already rejected/);
  await assert.rejects(editCandidate(db, row.id, "body", "x", "owner@gtm.test"), /Already rejected/);
});

test("selection reads the real tables and never offers a signal another week already used", async () => {
  const db = admin();
  await db.from("gtm_signal_stories").update({ status: "new", brief: { headline: "Fixture grid strain story", what_happened: "w", why_it_matters: "y", tension: "t", angles: { linkedin_take: "l", story: "s", video: "v" }, sources: [] }, last_seen: new Date().toISOString() }).eq("id", SIGNAL);
  const inputThisWeek = await loadSelectInput(db, "2030-03-04");
  assert.ok(inputThisWeek.taken.signals.includes(SIGNAL), "used by the fixture week's candidate");
  const sel = selectCandidates(inputThisWeek);
  assert.ok(!sel.candidates.some((c) => c.signal_id === SIGNAL));
  assert.ok(inputThisWeek.sources[SIGNAL]?.length, "sources come from the signal's sightings");
});
