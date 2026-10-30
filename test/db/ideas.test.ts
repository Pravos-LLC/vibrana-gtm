// Brainstorming Backlog (gtm_ideas) against the real LOCAL database: add, list, update, the seed file, and Promote
// (a text-brief Sunday candidate, linked on the idea, once however many clicks race; it then sends to review like
// any other candidate).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const { addIdea, getIdea, listIdeas, promoteIdea, seedIdeas, updateIdea } = await import("../../lib/ideas/store.ts");
const { listCandidates, rejectCandidate, sendToReview } = await import("../../lib/candidates/store.ts");

const SEED = fileURLToPath(new URL("../../config/ideas-seed.json", import.meta.url));
const WEEK = "2030-02-04";
before(async () => {
  await seed();
  const { error } = await admin().from("gtm_seasons").insert({ id: "season-8", title: "Fixture ideas season", starts_on: "2030-01-01", ends_on: "2030-03-31" });
  if (error) throw new Error(error.message);
});

test("add: a title is enough; the slug comes from the title, and a taken slug is refused, never overwritten", async () => {
  const db = admin();
  const a = await addIdea(db, { title: "Inbox at 2am teaser", tags: ["Teaser", "teaser"] });
  assert.deepEqual([a.slug, a.kind, a.status, a.tags, a.pillar], ["inbox-at-2am-teaser", "content", "idea", ["teaser"], null]);
  await assert.rejects(addIdea(db, { title: "Inbox at 2am teaser", summary: "other" }), /already exists/);
  assert.equal((await getIdea(db, "inbox-at-2am-teaser")).summary, "");
  await assert.rejects(addIdea(db, { title: "x", impact: 7 }), /impact is a whole number/);
});

test("seed: loads config/ideas-seed.json; a rerun keeps what John changed", async () => {
  const db = admin();
  const first = await seedIdeas(db, SEED);
  assert.deepEqual(first.added.sort(), ["sample-list-note", "sample-planning-worksheet", "sample-proof-note", "sample-build-note"].sort());
  const sim = await getIdea(db, "sample-planning-worksheet");
  assert.deepEqual([sim.kind, sim.status, sim.format, sim.created_by], ["lead_magnet", "shortlisted", "app", "seed"]);
  await updateIdea(db, "sample-list-note", { status: "parked", impact: "" });
  const again = await seedIdeas(db, SEED);
  assert.deepEqual([again.added, again.kept.length], [[], 4]);
  assert.equal((await getIdea(db, "sample-list-note")).status, "parked");
});

test("update and list: fields change by slug or id, empty strings clear, unknown fields and bad values are refused", async () => {
  const db = admin();
  const sim = await getIdea(db, "sample-planning-worksheet");
  const r = await updateIdea(db, sim.id, { impact: 5, owner: "John", tags: "simulator, lead-magnet" });
  assert.deepEqual([r.impact, r.owner, r.tags], [5, "John", ["simulator", "lead-magnet"]]);
  assert.ok(r.updated_at > sim.updated_at);
  assert.equal((await updateIdea(db, sim.slug, { owner: "" })).owner, null);
  await assert.rejects(updateIdea(db, sim.slug, { promoted_candidate_id: "x" }), /cannot change promoted_candidate_id/);
  await assert.rejects(updateIdea(db, sim.slug, { status: "done" }), /status must be/);
  await assert.rejects(updateIdea(db, "no-such-idea", { status: "parked" }), /No idea/);
  assert.deepEqual((await listIdeas(db, { kind: "lead_magnet" })).map((i) => i.slug), ["sample-planning-worksheet"]);
  assert.deepEqual((await listIdeas(db, { tag: "example-project" })).map((i) => i.slug).sort(), ["sample-proof-note", "sample-build-note"].sort());
});

test("promote: refused for a lead magnet, a missing pillar or source, and a non-Monday week", async () => {
  const db = admin();
  await assert.rejects(promoteIdea(db, "sample-planning-worksheet", { week_start: WEEK }), /built, not posted/);
  await assert.rejects(promoteIdea(db, "inbox-at-2am-teaser", { week_start: WEEK }), /set a pillar/);
  await updateIdea(db, "inbox-at-2am-teaser", { pillar: "proof" });
  await assert.rejects(promoteIdea(db, "inbox-at-2am-teaser", { week_start: WEEK }), /source link/);
  await assert.rejects(promoteIdea(db, "sample-proof-note", { week_start: "2030-02-05" }), /not a Monday/);
  assert.equal((await listCandidates(db, { week_start: WEEK })).length, 0, "nothing was written");
});

test("promote: one text-brief candidate, linked once however many clicks race; the idea moves to in production", async () => {
  const db = admin();
  const results = await Promise.allSettled([1, 2, 3].map(() => promoteIdea(db, "sample-proof-note", { week_start: WEEK, lens: "transformation" })));
  const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof promoteIdea>>>[];
  assert.equal(ok.length, 1, "exactly one click promotes it");
  for (const r of results.filter((x) => x.status === "rejected")) assert.match(String((r as PromiseRejectedResult).reason), /already (promoted|has a candidate)/);
  const { idea, candidate } = ok[0].value;
  assert.deepEqual([idea.status, idea.promoted_candidate_id, !!idea.promoted_at], ["in_production", candidate.id, true]);
  const week = await listCandidates(db, { week_start: WEEK });
  assert.equal(week.length, 1, "the losers' rows are gone");
  assert.deepEqual([candidate.slug, candidate.status, candidate.format, candidate.pillar, candidate.channels], ["idea-sample-proof-note", "candidate", "text", "proof", ["linkedin"]]);
  assert.doesNotMatch(candidate.body, /\[JOHN/, "a promoted idea carries no slot for John");
  assert.deepEqual(candidate.sources.map((s) => s.url), ["https://example.test/proof"]);
  assert.equal((candidate.agent_draft as { body: string }).body, candidate.body, "the brief is frozen as the agent's draft, so John's write-up is diffed against it");
  await assert.rejects(promoteIdea(db, "sample-proof-note", { week_start: "2030-02-11" }), /already promoted/);

  // A second idea in the same week goes after it.
  const second = await promoteIdea(db, "sample-build-note", { week_start: WEEK });
  assert.equal(second.candidate.position, candidate.position + 1);

  // From here it is an ordinary candidate: Send to Review stages it for /content.
  const staged = await sendToReview(db, candidate.id, "owner@gtm.test");
  assert.equal(staged.status, "accepted");
  assert.match(staged.gtm_story_id!, /^s8-c300204-idea-sample-proof-note$/);
});

test("a deleted candidate leaves the idea and when it was promoted", async () => {
  const db = admin();
  const idea = await getIdea(db, "sample-build-note");
  const { error } = await db.from("gtm_content_candidates").delete().eq("id", idea.promoted_candidate_id!);
  assert.equal(error, null);
  const after = await getIdea(db, idea.slug);
  assert.deepEqual([after.promoted_candidate_id, after.promoted_at, after.status], [null, idea.promoted_at, "in_production"]);
});

test("rejecting a promoted candidate frees the idea: back on the shortlist, promotable for another week", async () => {
  const db = admin();
  await addIdea(db, { title: "Fixture reject then repromote", pillar: "lists", status: "shortlisted", source_url: "https://example.com/r" });
  const first = await promoteIdea(db, "fixture-reject-then-repromote", { week_start: "2030-02-18" });
  await rejectCandidate(db, first.candidate.id, "timing", "not this week", "owner@gtm.test");
  const freed = await getIdea(db, "fixture-reject-then-repromote");
  assert.deepEqual([freed.promoted_candidate_id, freed.status, freed.promoted_at], [null, "shortlisted", first.idea.promoted_at], "the link clears; when it was promoted stays");
  const again = await promoteIdea(db, "fixture-reject-then-repromote", { week_start: "2030-02-25" });
  assert.deepEqual([again.idea.promoted_candidate_id, again.idea.status, again.candidate.week_start], [again.candidate.id, "in_production", "2030-02-25"]);
  // Rejecting an ordinary candidate touches no idea.
  const other = (await listCandidates(db, { status: "candidate" })).find((c) => !c.slug.startsWith("idea-"))!;
  const before = (await db.from("gtm_ideas").select("slug,status,promoted_candidate_id").order("slug")).data;
  await rejectCandidate(db, other.id, "angle", null, "owner@gtm.test");
  assert.deepEqual((await db.from("gtm_ideas").select("slug,status,promoted_candidate_id").order("slug")).data, before);
});
