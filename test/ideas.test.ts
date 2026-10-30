// Brainstorming Backlog (gtm_ideas): validation, tags, the board's grouping, when an idea may be promoted, the
// candidate brief it becomes, and the seed file. Pure functions only; the database paths are in test/db/ideas.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { groupByStatus, ideaCandidate, ideaProblems, parseTags, promoteBlocker, IDEA_STATUSES } = await import("../lib/ideas/model.ts");
const { candidateProblems } = await import("../lib/candidates/validate.ts");
type Idea = import("../lib/ideas/model.ts").Idea;

const idea = (over: Partial<Idea> = {}): Idea => ({
  id: "00000000-0000-4000-8000-000000000001", slug: "an-idea", title: "An idea", summary: "If we post the inbox story, operators recognize their own.",
  kind: "content", pillar: "proof", format: "video", effort: "m", impact: 3, status: "shortlisted", source_url: "https://brand.example.com/case-studies/x",
  owner: null, tags: [], promoted_candidate_id: null, promoted_at: null, created_by: null, created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", ...over,
});

test("ideaProblems: a title is enough; every enum, the impact range, links and tags are checked", () => {
  assert.deepEqual(ideaProblems({ title: "Just a title" }), []);
  assert.match(ideaProblems({ title: "  " }).join(), /needs a title/);
  const bad = ideaProblems({ title: "T", kind: "campaign" as never, status: "done" as never, pillar: "hype" as never, format: "gif" as never, effort: "xl" as never, impact: 6, source_url: "javascript:alert(1)", tags: ["Not OK"] });
  for (const re of [/kind must be/, /status must be/, /pillar must be/, /format must be/, /effort must be/, /impact is a whole number/, /source must be an http/, /tags are/]) assert.match(bad.join("\n"), re);
  assert.match(ideaProblems({ title: "T", impact: 2.5 }).join(), /whole number/);
  assert.deepEqual(ideaProblems({ status: "parked" }, { partial: true }), [], "a patch need not repeat the title");
  assert.match(ideaProblems({ title: "" }, { partial: true }).join(), /needs a title/, "but cannot blank it");
});

test("parseTags: comma separated, lowercased, dashed, de-duplicated; # is dropped", () => {
  assert.deepEqual(parseTags("Lead Magnet, #simulator, simulator,, real estate"), ["lead-magnet", "simulator", "real-estate"]);
  assert.deepEqual(parseTags(["a", " A "]), ["a"]);
  assert.deepEqual(parseTags(undefined), []);
});

test("groupByStatus: every status in order, each column by impact, then the cheaper effort, then the newest", () => {
  const rows = [
    idea({ slug: "low", impact: 1, status: "idea" }),
    idea({ slug: "high-l", impact: 5, effort: "l", status: "idea" }),
    idea({ slug: "high-s", impact: 5, effort: "s", status: "idea" }),
    idea({ slug: "none", impact: null, status: "idea", updated_at: "2026-10-13T00:00:00Z" }),
    idea({ slug: "shipped", status: "shipped" }),
  ];
  const g = groupByStatus(rows);
  assert.deepEqual(g.map((c) => c.status), [...IDEA_STATUSES]);
  assert.deepEqual(g[0].ideas.map((i) => i.slug), ["high-s", "high-l", "low", "none"]);
  assert.deepEqual(g.find((c) => c.status === "shipped")!.ideas.map((i) => i.slug), ["shipped"]);
  assert.deepEqual(g.find((c) => c.status === "parked")!.ideas, []);
});

test("promoteBlocker: lead magnets and tools are built, not posted; a pillar and a source are needed; once only", () => {
  assert.equal(promoteBlocker(idea()), null);
  assert.match(promoteBlocker(idea({ kind: "lead_magnet" }))!, /built, not posted/);
  assert.match(promoteBlocker(idea({ kind: "tool" }))!, /built, not posted/);
  assert.match(promoteBlocker(idea({ pillar: null }))!, /set a pillar/);
  assert.equal(promoteBlocker(idea({ pillar: null }), { pillar: "lists" }), null, "the promote call may supply the pillar");
  assert.match(promoteBlocker(idea({ source_url: null }))!, /source link/);
  assert.match(promoteBlocker(idea({ promoted_candidate_id: "00000000-0000-4000-8000-000000000009" }))!, /already promoted/);
  assert.match(promoteBlocker(idea({ status: "parked" }))!, /move it back/);
});

test("ideaCandidate: a text brief holding only the summary, no [JOHN] slot, that passes the candidate checks", () => {
  const c = ideaCandidate(idea(), { week_start: "2026-10-19", position: 4 });
  assert.equal(c.slug, "idea-an-idea");
  assert.deepEqual([c.format, c.lens, c.pillar, c.channels, c.position], ["text", "transformation", "proof", ["linkedin"], 4]);
  assert.match(c.body, /^If we post the inbox story/);
  assert.doesNotMatch(c.body, /\[JOHN/);
  assert.deepEqual(c.sources, [{ title: "An idea", url: "https://brand.example.com/case-studies/x", source: "Brainstorming Backlog" }]);
  const p = candidateProblems(c);
  assert.deepEqual(p.errors, []);
  assert.equal(p.john_slots, 0);
  const long = ideaCandidate(idea({ slug: "x".repeat(64), summary: "", format: "text" }), { week_start: "2026-10-19", lens: "regenerative" });
  assert.equal(long.slug.length, 64);
  assert.equal(long.lens, "regenerative");
  assert.doesNotMatch(long.body, /Planned as/);
  assert.match(long.body, /^An idea/, "an idea without a summary is briefed by its title");
});

test("config/ideas-seed.json: valid ideas with unique slugs, no em dashes, the sample worksheet shortlisted as a lead magnet", () => {
  const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../config/ideas-seed.json", import.meta.url)), "utf8")) as (Partial<Idea> & { title: string })[];
  for (const s of seed) assert.deepEqual(ideaProblems(s), [], String(s.slug));
  assert.equal(new Set(seed.map((s) => s.slug)).size, seed.length);
  assert.doesNotMatch(JSON.stringify(seed), /[\u2014\u2013]/);
  const sim = seed.find((s) => s.slug === "sample-planning-worksheet")!;
  assert.deepEqual([sim.kind, sim.status], ["lead_magnet", "shortlisted"]);
  for (const s of seed.filter((x) => x.kind === "content" && x.source_url)) assert.equal(promoteBlocker({ ...idea(), ...s, promoted_candidate_id: null } as Idea), null, `${s.slug} is promotable`);
  for (const s of seed.filter((x) => x.kind === "content" && x.pillar && x.source_url)) {
    assert.deepEqual(candidateProblems(ideaCandidate({ ...idea(), ...s } as Idea, { week_start: "2026-10-19" })).errors, [], `${s.slug} briefs cleanly`);
  }
});
