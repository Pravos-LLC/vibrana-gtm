import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSeason, daysBetween, extractAsOfDate, isPeopleList, weekStart,
  type AnalyzeOptions, type CardInput, type PieceInput, type SeasonInput, type SeasonRecord,
} from "../lib/season-analysis";

const PILLARS: AnalyzeOptions["pillars"] = [
  { slug: "proof", name: "Proof", share: 30 }, { slug: "perspective", name: "Perspective", share: 25 },
  { slug: "build", name: "The Build", share: 25 }, { slug: "lists", name: "Lists", share: 20 },
];
const opts = (extra: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({ pillars: PILLARS, ...extra });

// Two weeks, Tue 2026-10-06 to Fri 2026-10-16.
const season: SeasonRecord = { id: "s", title: "Test season", description: "d", starts_on: "2026-10-06", ends_on: "2026-10-16", pillars: ["proof", "perspective", "build", "lists"] };

const card = (platform: string, date: string, extra: Partial<CardInput> = {}): CardInput => ({
  platform, itemId: `${platform}-${date}`, date, time: "09:00", format: "text", staged: true, text: "approved", asset: "none",
  versions: [], openNotes: 0, copy: "A clean sentence.", ...extra,
});
const piece = (id: string, date: string, pillar: string | null, cards: CardInput[], extra: Partial<PieceInput> = {}): PieceInput => ({
  id, title: id, date, pillar, format: cards[0]?.format ?? "text", platforms: [...new Set(cards.map((c) => c.platform))], cards, ...extra,
});
const run = (pieces: PieceInput[], o: Partial<AnalyzeOptions> = {}, s: Partial<SeasonRecord> = {}) => analyzeSeason({ season: { ...season, ...s }, pieces }, opts(o));
const ids = (a: ReturnType<typeof run>, id: string) => a.checks.filter((c) => c.id === id);

test("dates: week start is Monday, day math is calendar days, as-of dates are read from copy", () => {
  assert.equal(weekStart("2026-10-06"), "2026-10-05");
  assert.equal(weekStart("2026-10-11"), "2026-10-05");
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
  assert.equal(daysBetween("2026-10-05", "2026-11-26"), 52);
  assert.equal(extractAsOfDate("Top 10, as of early Oct 2026."), "2026-10-05");
  assert.equal(extractAsOfDate("Stars as of mid November 2026"), "2026-11-15");
  assert.equal(extractAsOfDate("as of 12 Nov 2026"), "2026-11-12");
  assert.equal(extractAsOfDate("as of October 3, 2026"), "2026-10-03");
  assert.equal(extractAsOfDate("stars pulled 2026-10-05 from GitHub"), "2026-10-05");
  assert.equal(extractAsOfDate("no date here"), null);
});

test("pipeline: counts per platform, percent complete, versions and what is left, in slot order", () => {
  const a = run([
    piece("p2", "2026-10-13", "build", [
      card("linkedin", "2026-10-13", { format: "video", text: "needs-approval", asset: "needs-changes", openNotes: 2, versions: [{ assetId: "v-li", kind: "video", label: "v1.2", revision: 3, versions: 3 }] }),
      card("youtube", "2026-10-13", { format: "video", text: "approved", asset: "approved", staleApprovals: 0 }),
    ]),
    piece("p1", "2026-10-06", "proof", [
      card("linkedin", "2026-10-06", { text: "approved", asset: "approved", versions: [{ assetId: "c1", kind: "copy", label: "v1", revision: 1, versions: 1 }, { assetId: "s1", kind: "image", label: "v1.1", revision: 2, versions: 2 }, { assetId: "s2", kind: "image", label: "v1.1", revision: 2, versions: 2 }] }),
    ]),
    piece("p3", "2026-10-14", "lists", [card("instagram", "2026-10-14", { staged: false, text: "none", asset: "none" })]),
  ]);
  const p = a.pipeline;
  assert.deepEqual(p.pieceRows.map((r) => r.id), ["p1", "p2", "p3"]);
  assert.equal(p.pieces, 3);
  assert.equal(p.cards, 4);
  assert.equal(p.unstagedCards, 1);
  // p1: 2 parts approved. p2 linkedin: text to approve + asset to change; youtube: 2 approved. p3: one unstaged text part.
  assert.deepEqual(p.parts, { total: 7, approved: 4, needsApproval: 2, needsChanges: 1 });
  assert.equal(p.percentComplete, 57);
  assert.equal(p.piecesFullyApproved, 1);
  assert.equal(p.openNotes, 2);
  assert.deepEqual(p.byPlatform.linkedin, { cards: 2, text: { approved: 1, needsApproval: 1, needsChanges: 0, none: 0 }, asset: { approved: 1, needsApproval: 0, needsChanges: 1, none: 0 } });
  assert.deepEqual(p.byPlatform.instagram.text, { approved: 0, needsApproval: 1, needsChanges: 0, none: 0 });
  assert.deepEqual(p.pieceRows[0].versionLabels, ["copy v1", "image v1.1 x2"]);
  assert.equal(p.pieceRows[0].state, "approved");
  assert.equal(p.pieceRows[0].percentComplete, 100);
  assert.equal(p.pieceRows[1].state, "needs-changes");
  assert.equal(p.pieceRows[1].percentComplete, 50);
  assert.equal(p.pieceRows[2].state, "not-staged");
  assert.deepEqual(p.remaining.map((r) => `${r.date} ${r.platform} ${r.part} ${r.state}`), [
    "2026-10-13 linkedin text needs-approval", "2026-10-13 linkedin asset needs-changes", "2026-10-13 linkedin notes open-notes",
    "2026-10-14 instagram text not-staged",
  ]);
});

test("pipeline: an approval that no longer matches the bytes is counted as stale and still left to do", () => {
  const a = run([piece("p", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { text: "needs-approval", staleApprovals: 1 })])]);
  assert.equal(a.pipeline.staleApprovals, 1);
  assert.equal(a.pipeline.remaining[0].state, "approval-stale");
});

test("pipeline: an empty season is 0 percent, not NaN", () => {
  const a = run([]);
  assert.equal(a.pipeline.percentComplete, 0);
  assert.equal(a.pipeline.pieces, 0);
  assert.equal(a.cadence.gaps.length, 2);
});

test("date range: weeks, phase, current week, first and last slot, pieces outside the dates", () => {
  const a = run([piece("in", "2026-10-07", "proof", [card("linkedin", "2026-10-07")]), piece("late", "2026-10-30", "proof", [card("linkedin", "2026-10-30")])], { today: "2026-10-14" });
  assert.equal(a.dateRange.weeks, 2);
  assert.equal(a.dateRange.days, 11);
  assert.equal(a.dateRange.phase, "during");
  assert.equal(a.dateRange.currentWeek, 2);
  assert.equal(a.dateRange.firstSlot, "2026-10-07");
  assert.equal(a.dateRange.lastSlot, "2026-10-30");
  assert.deepEqual(a.dateRange.outsideRange, ["late"]);
  assert.equal(ids(a, "date-range")[0].pieceId, "late");
  assert.equal(run([], { today: "2026-09-01" }).dateRange.phase, "before");
  assert.equal(run([], { today: "2026-12-01" }).dateRange.phase, "after");
  assert.equal(run([]).dateRange.phase, "unknown");
});

test("cadence: pieces per week against 3, gaps, under and over; newsletter-only pieces are not social slots", () => {
  const a = run([
    piece("a", "2026-10-06", "proof", [card("linkedin", "2026-10-06")]),
    piece("b", "2026-10-07", "build", [card("linkedin", "2026-10-07")]),
    piece("c", "2026-10-08", "lists", [card("instagram", "2026-10-08")]),
    piece("n", "2026-10-09", "proof", [card("newsletter", "2026-10-09")]),
  ]);
  assert.deepEqual(a.cadence.weeks.map((w) => [w.socialPieces, w.status]), [[3, "on-target"], [0, "gap"]]);
  assert.equal(a.cadence.weeks[0].pieces.length, 4);
  assert.equal(a.cadence.weeks[0].linkedinSlots, 2);
  assert.equal(a.cadence.plannedSlots, 3);
  assert.equal(a.cadence.targetSlots, 6);
  assert.equal(a.cadence.openSlots, 3);
  assert.deepEqual(a.cadence.gaps, [2]);
  assert.equal(ids(a, "cadence").length, 1);
  assert.equal(ids(a, "cadence")[0].severity, "warn");
  const over = run(["a", "b", "c", "d"].map((x, i) => piece(x, `2026-10-0${6 + i}`, "proof", [card("linkedin", `2026-10-0${6 + i}`)])));
  assert.equal(over.cadence.weeks[0].status, "over");
  // More than the target is fine (John, 2026-10-16): never a finding.
  assert.equal(ids(over, "cadence").find((c) => c.message.includes("Week 1")), undefined);
  // A week that is already over cannot be filled, so only upcoming weeks come back short.
  assert.equal(ids(run([piece("a", "2026-10-06", "proof", [card("linkedin", "2026-10-06")])], { today: "2026-10-20" }), "cadence").length, 0);
  assert.equal(run([], {}, {}).cadence.targetPerWeek, 3);
  assert.equal(run([piece("a", "2026-10-06", "proof", [card("linkedin", "2026-10-06")])], { targetPerWeek: 1 }).cadence.weeks[0].status, "on-target");
});

test("pillar mix: counts, share, delta against guide targets, expected for the season and what is still to go", () => {
  const mk = (n: number, pillar: string, start: number) => Array.from({ length: n }, (_, i) => piece(`${pillar}${i}`, `2026-10-${String(start + i).padStart(2, "0")}`, pillar, [card("linkedin", `2026-10-${String(start + i).padStart(2, "0")}`)]));
  const a = run([...mk(4, "perspective", 6), ...mk(1, "proof", 10), ...mk(1, "lists", 11)]);
  const row = (slug: string) => a.pillars.rows.find((r) => r.slug === slug)!;
  assert.equal(a.pillars.total, 6);
  assert.deepEqual([row("perspective").count, row("perspective").share, row("perspective").target, row("perspective").delta, row("perspective").status], [4, 66.7, 25, 41.7, "over"]);
  assert.deepEqual([row("proof").share, row("proof").delta, row("proof").status], [16.7, -13.3, "under"]);
  assert.equal(row("build").count, 0);
  assert.equal(row("build").status, "under");
  assert.equal(row("lists").status, "on-target");
  // 2 weeks x 3 = 6 slots: proof expects 2 (30%), has 1.
  assert.deepEqual([row("proof").expectedForSeason, row("proof").toGo], [2, 1]);
  // The mix is measured (rows above) and shown, but never a finding: more of one pillar is fine.
  assert.equal(ids(a, "pillar-mix").length, 0);
});

test("pillar mix: a season that selects a subset is measured against renormalized shares and flags other pillars", () => {
  const a = run([piece("x", "2026-10-06", "lists", [card("linkedin", "2026-10-06")]), piece("y", "2026-10-07", "proof", [card("linkedin", "2026-10-07")])], {}, { pillars: ["proof", "build"] });
  const row = (slug: string) => a.pillars.rows.find((r) => r.slug === slug)!;
  assert.equal(row("proof").target, 54.5); // 30 / (30 + 25)
  assert.equal(row("build").target, 45.5);
  assert.equal(row("lists").selected, false);
  assert.equal(row("lists").target, 0);
  assert.deepEqual(a.pillars.unselectedUsed, ["lists"]);
  assert.equal(ids(a, "pillar-selected").length, 1);
});

test("pillar mix: pieces without a pillar are named, and a week with no Proof or Build slot is flagged", () => {
  const a = run([
    piece("nopillar", "2026-10-06", null, [card("linkedin", "2026-10-06")]),
    piece("op1", "2026-10-07", "perspective", [card("linkedin", "2026-10-07")]),
    piece("op2", "2026-10-08", "lists", [card("linkedin", "2026-10-08")]),
    piece("pf", "2026-10-13", "proof", [card("linkedin", "2026-10-13")]),
  ]);
  assert.deepEqual(a.pillars.missing, ["nopillar"]);
  assert.equal(ids(a, "pillar-set")[0].pieceId, "nopillar");
  const weekFlags = ids(a, "week-pillars").map((c) => c.message);
  assert.ok(weekFlags.some((m) => m.startsWith("Week 1 has no Proof or Build")));
  assert.ok(!weekFlags.some((m) => m.includes("touches")));
  assert.ok(!weekFlags.some((m) => m.startsWith("Week 2 has no Proof")));
});

test("format mix: at least one carousel a week on LinkedIn and Instagram, for weeks that have posts", () => {
  const a = run([
    piece("w1", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { format: "carousel" }), card("instagram", "2026-10-06", { format: "text" })]),
    piece("w2", "2026-10-13", "proof", [card("linkedin", "2026-10-13", { format: "text" }), card("instagram", "2026-10-13", { format: "carousel" })]),
  ]);
  assert.deepEqual(a.formats.weeksWithoutCarousel, [{ platform: "linkedin", week: 2 }, { platform: "instagram", week: 1 }]);
  assert.equal(ids(a, "format-weekly-carousel").length, 2);
  assert.deepEqual(a.formats.byFormat, { carousel: 1, text: 1 });
  assert.equal(a.formats.byPlatform.linkedin.carousel, 1);
  // An empty week is a cadence gap, not a carousel miss.
  assert.equal(ids(run([piece("w1", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { format: "carousel" }), card("instagram", "2026-10-06", { format: "carousel" })])]), "format-weekly-carousel").length, 0);
});

test("guardrails: placeholders and dashes block, British spellings and hashtag counts warn", () => {
  const a = run([
    piece("g", "2026-10-06", "proof", [
      card("linkedin", "2026-10-06", { copy: "---\nfirst_comment: x\n---\n\nI organise [JOHN: add a scene]. It — works #one #two #three" }),
      card("instagram", "2026-10-06", { text: "needs-approval", copy: "Colour and behaviour. #one #two" }),
      card("youtube", "2026-10-06", { copy: "Fine. #many #tags #here #on #youtube #is #ignored" }),
    ]),
  ]);
  const by = (id: string) => ids(a, id);
  assert.equal(by("placeholder").length, 1);
  assert.equal(by("placeholder")[0].severity, "block");
  assert.equal(by("placeholder")[0].platform, "linkedin");
  assert.match(by("placeholder")[0].message, /\[JOHN: add a scene\]/);
  assert.equal(by("dash")[0].severity, "block");
  assert.equal(by("british-spelling").length, 2);
  assert.ok(by("british-spelling").every((c) => c.severity === "warn"));
  const tags = by("hashtags");
  assert.deepEqual(tags.map((c) => c.platform).sort(), ["instagram", "linkedin"]);
  assert.match(tags.find((c) => c.platform === "linkedin")!.message, /3 hashtags/);
  assert.match(tags.find((c) => c.platform === "instagram")!.message, /2 hashtags/);
  assert.equal(a.summary.block, 2);
});

test("guardrails: hashtag ranges are 0 to 2 on LinkedIn and 3 to 5 on Instagram; headings and frontmatter do not count", () => {
  const ok = run([piece("g", "2026-10-06", "proof", [
    card("linkedin", "2026-10-06", { copy: "---\ntitle: '#notatag'\n---\n\n# Heading\n\nBody #one #two" }),
    card("instagram", "2026-10-06", { text: "needs-approval", copy: "Caption\n#a #b #c #d #e" }),
  ])]);
  assert.equal(ids(ok, "hashtags").length, 0);
  assert.equal(ids(run([piece("g", "2026-10-06", "proof", [card("instagram", "2026-10-06", { text: "needs-approval", copy: "Caption #a #b #c #d #e #f" })])]), "hashtags").length, 1);
  // Approved text is final: John approves exactly what he wants posted, so the Instagram tag count is advice for drafts only.
  assert.equal(ids(run([piece("g", "2026-10-06", "proof", [card("instagram", "2026-10-06", { text: "approved", copy: "Caption #a" })])]), "hashtags").length, 0);
  assert.equal(ids(run([piece("g", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { copy: "No tags at all." })])]), "hashtags").length, 0);
});

test("guardrails: a link in the LinkedIn body or Instagram caption blocks; the first comment may carry it", () => {
  const a = run([piece("g", "2026-10-06", "proof", [
    card("linkedin", "2026-10-06", { copy: "---\nfirst_comment: https://brand.example.com/ok\n---\n\nRead https://example.com/x now" }),
    card("instagram", "2026-10-06", { copy: "See brand.example.com/case-studies #a #b #c" }),
    card("youtube", "2026-10-06", { copy: "Link is fine here https://brand.example.com" }),
  ])]);
  const links = ids(a, "channel-link");
  assert.deepEqual(links.map((c) => [c.platform, c.severity]).sort(), [["instagram", "block"], ["linkedin", "block"]]);
  const clean = run([piece("g", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { copy: "---\nfirst_comment: https://brand.example.com/ok\n---\n\nNo link here." })])]);
  assert.equal(ids(clean, "channel-link").length, 0);
});

test("guardrails: a card with no Story is reported, not scanned", () => {
  const a = run([piece("g", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { staged: false, text: "none", copy: "[JOHN: x]" })])]);
  assert.equal(ids(a, "not-staged").length, 1);
  assert.equal(ids(a, "placeholder").length, 0);
});

test("representation: a list of people needs women; unknown is a human review, never a guess", () => {
  const list = (people: PieceInput["people"], title = "Example engineers to follow", pillar: string | null = "lists") =>
    run([piece("l", "2026-10-06", pillar, [card("linkedin", "2026-10-06")], { title, people })]);
  const none = ids(list(undefined), "representation");
  assert.equal(none.length, 1);
  assert.equal(none[0].status, "review");
  assert.equal(none[0].severity, "info");
  assert.match(none[0].message, /Needs human review/);
  const allMen = ids(list([{ name: "A", gender: "man" }, { name: "B", gender: "man" }]), "representation");
  assert.deepEqual([allMen[0].severity, allMen[0].status], ["block", "fail"]);
  const unknown = ids(list([{ name: "A", gender: "man" }, { name: "B" }]), "representation");
  assert.deepEqual([unknown[0].severity, unknown[0].status], ["info", "review"]);
  assert.match(unknown[0].message, /1 of 2 names/);
  assert.equal(ids(list([{ name: "A", gender: "man" }, { name: "B", gender: "woman" }]), "representation").length, 0);
  // Only lists of people are checked.
  assert.equal(ids(list(undefined, "Example campaign title 7"), "representation").length, 0);
  assert.equal(ids(list(undefined, "Example campaign title 12", "perspective"), "representation").length, 0);
  assert.equal(isPeopleList(piece("x", "2026-10-06", "perspective", [], { people: [{ name: "A" }] })), true);
});

test("stale facts: stars older than 14 days before the slot warn; an undated star list needs human review", () => {
  const withFacts = (asOf: string | null | undefined, stars = true, date = "2026-10-20") =>
    run([piece("l", date, "lists", [card("linkedin", date)], { factsAsOf: asOf, mentionsStars: stars })], {}, { ends_on: "2026-10-30" });
  const stale = ids(withFacts("2026-10-05"), "stale-facts");
  assert.deepEqual([stale[0].severity, stale[0].status], ["warn", "fail"]);
  assert.match(stale[0].message, /15 days before/);
  assert.equal(ids(withFacts("2026-10-06"), "stale-facts").length, 0, "14 days is still fresh");
  assert.equal(ids(withFacts("2026-10-18"), "stale-facts").length, 0);
  const undated = ids(withFacts(null), "stale-facts");
  assert.deepEqual([undated[0].severity, undated[0].status], ["info", "review"]);
  assert.equal(ids(withFacts(null, false), "stale-facts").length, 0);
  assert.equal(ids(withFacts("last week"), "stale-facts")[0].status, "review");
});

test("findings are ordered block, warn, info; every check id that ran is listed; the summary adds up", () => {
  const a = run([piece("g", "2026-10-06", "proof", [card("linkedin", "2026-10-06", { copy: "[JOHN: x] colour" })])]);
  const order = a.checks.map((c) => c.severity);
  assert.deepEqual(order, [...order].sort((x, y) => ["block", "warn", "info"].indexOf(x) - ["block", "warn", "info"].indexOf(y)));
  assert.equal(a.summary.block + a.summary.warn + a.summary.info, a.checks.length);
  for (const id of ["orion-coherence-spacing", "format-video-streak"]) assert.ok(!a.ran.includes(id), `${id} was dropped (John, 2026-10-06)`);
  for (const id of ["date-range", "cadence", "pillar-mix", "format-weekly-carousel", "placeholder", "dash", "british-spelling", "hashtags", "channel-link", "representation", "stale-facts"]) {
    assert.ok(a.ran.includes(id), id);
  }
  const input: SeasonInput = { season, pieces: [] };
  assert.equal(analyzeSeason(input, opts()).seasonId, "s");
});

test("a post that already went out, or was skipped, has nothing left to approve or stage", () => {
  const a = run([piece("done", "2026-10-06", "proof", [card("newsletter", "2026-10-06", { itemStatus: "published", text: "needs-approval", asset: "needs-approval" }), card("linkedin", "2026-10-06", { itemStatus: "published", staged: false })])]);
  assert.equal(a.pipeline.remaining.length, 0);
  assert.equal(a.pipeline.piecesFullyApproved, 1);
  assert.equal(ids(a, "not-staged").length, 0);
});

test("a list of people that states how many women it lists passes the representation check", async () => {
  const { statedWomen } = await import("../lib/seasons");
  assert.equal(statedWomen("Ten people worth following. Five of them are women."), 5);
  assert.equal(statedWomen("Seven of these are women."), 7);
  assert.equal(statedWomen("No mention here."), null);
  const base = piece("top-10-engineers-to-follow", "2026-10-06", "lists", [card("linkedin", "2026-10-06")]);
  assert.equal(ids(run([{ ...base, title: "Top 10 engineers to follow" }]), "representation").length, 1);
  assert.equal(ids(run([{ ...base, title: "Top 10 engineers to follow", womenStated: 5 }]), "representation").length, 0);
});

test("date range: a card that already went out before the season is history, a card still to go outside it is a finding", () => {
  const out = (itemStatus: string) => run([piece("early", "2026-10-03", "proof", [card("newsletter", "2026-10-03", { itemStatus }), card("linkedin", "2026-10-13")])]);
  assert.equal(ids(out("published"), "date-range").length, 0);
  assert.equal(ids(out("scheduled"), "date-range").length, 1);
  assert.equal(ids(run([piece("late", "2027-01-26", "proof", [card("linkedin", "2027-01-26")])]), "date-range")[0].message.includes("2027-01-26"), true);
});
