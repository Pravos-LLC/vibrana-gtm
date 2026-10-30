import test from "node:test";
import assert from "node:assert/strict";
import { channelAllowed, dayLabels, fitRank, gapsFor, isRealDate, lanesOf, lintCalendar, lookOf, parseWeeks, pieceKeyOf, RHYTHM, weekdayOf, type LintPost } from "../lib/rhythm";

// The week of Mon 2026-10-19.
const post = (id: string, date: string, channel: string, extra: Partial<LintPost> = {}): LintPost => ({
  id, date, channels: [channel], status: "scheduled", pillar: "proof", format: "video", storyId: id.replace(/-(linkedin|instagram|youtube)$/, ""), title: id, ...extra,
});
const rules = (posts: LintPost[]) => lintCalendar(posts, "2026-10-19")[0].issues.map((i) => i.rule);

test("the day map is John's: Mon Perspective, Tue Proof, Wed Build, Thu Voices, Fri Lists, Sat Reels, Sun off", () => {
  assert.deepEqual(RHYTHM.days.map((d) => [d.day, d.primary]), [["Mon", "perspective"], ["Tue", "proof"], ["Wed", "build"], ["Thu", "voices"], ["Fri", "lists"], ["Sat", "reels"], ["Sun", null]]);
  assert.deepEqual(dayLabels("2026-10-19"), { primary: "Perspective", fallback: ["Lists"] });
  assert.deepEqual(dayLabels("Fri"), { primary: "Lists", fallback: ["Build", "Proof"] });
  assert.deepEqual(dayLabels("2026-10-25"), { primary: "Off", fallback: [] });
  assert.equal(weekdayOf("2026-10-24"), "Sat");
});

test("LinkedIn posts weekdays only; Saturday is Instagram and YouTube; Sunday nothing", () => {
  assert.equal(channelAllowed("2026-10-23", "linkedin"), true);
  assert.equal(channelAllowed("2026-10-24", "linkedin"), false);
  assert.equal(channelAllowed("2026-10-24", "instagram"), true);
  assert.equal(channelAllowed("2026-10-23", "youtube"), false, "Friday is a list carousel: LinkedIn and Instagram");
  assert.equal(channelAllowed("2026-10-25", "instagram"), false);
});

test("looks: carousels are Prism Light, text is text, video reads the traits file or infers from the Story id", () => {
  assert.equal(lookOf("s1-04-sample-piece-04", "carousel"), "prism");
  assert.equal(lookOf("s1-01-sample-piece-01", "document"), "prism", "the deck of a voiceover piece is still a deck");
  assert.equal(lookOf("s1-01-sample-piece-01", "video"), "voiceover");
  assert.equal(lookOf("sample-extra-38", "video"), "prism", "the Orion teaser's cover is a Prism Light portrait");
  assert.equal(lookOf("s1-99-sn-new-clip", "video"), "talking-head");
  assert.equal(lookOf("coherence-c9-new", "video"), "talking-head");
  assert.equal(lookOf("signal-x", "image"), "text");
  assert.equal(lookOf(null, "video"), "footage");
});

test("lanes and fit: a Example Series clip fills Thursday Voices; a proof piece is Thursday's fallback; nothing fits Sunday", () => {
  const example_approver = lanesOf("perspective", ["talking-head"]);
  assert.deepEqual(example_approver, ["perspective", "voices"]);
  assert.equal(fitRank("Thu", example_approver), 0);
  assert.equal(fitRank("Mon", example_approver), 0);
  assert.equal(fitRank("Thu", ["proof"]), 1);
  assert.equal(fitRank("Fri", ["proof"]), 2);
  assert.equal(fitRank("Tue", ["lists"]), -1);
  assert.equal(fitRank("Sat", lanesOf("build", ["voiceover"])), 0);
  assert.equal(fitRank("Sun", ["perspective"]), -1);
});

test("one piece a day, and a piece's channels on one day", () => {
  const twoPieces = [post("a-linkedin", "2026-10-20", "linkedin"), post("b-instagram", "2026-10-20", "instagram")];
  assert.ok(rules(twoPieces).includes("one-piece"));
  const split = [post("c-linkedin", "2026-10-20", "linkedin"), post("c-youtube", "2026-10-27", "youtube")];
  assert.ok(rules(split).includes("split"));
  const sameDay = [post("d-linkedin", "2026-10-20", "linkedin"), post("d-youtube", "2026-10-20", "youtube"), post("d-instagram", "2026-10-20", "instagram")];
  assert.deepEqual(rules(sameDay).filter((r) => r === "one-piece" || r === "split"), []);
});

test("killed legs are not on the calendar: skipped rows never count", () => {
  const killed = [post("a-linkedin", "2026-10-20", "linkedin"), post("b-linkedin", "2026-10-20", "linkedin", { status: "skipped" })];
  assert.ok(!rules(killed).includes("one-piece"));
  assert.deepEqual(gapsFor([post("x-linkedin", "2026-10-21", "linkedin", { status: "skipped" })], "2026-10-21", "2026-10-21").map((g) => g.date), ["2026-10-21"]);
});

test("a piece on the wrong day is flagged; LinkedIn on Saturday is flagged", () => {
  assert.ok(rules([post("e-linkedin", "2026-10-20", "linkedin", { pillar: "lists", format: "document" })]).includes("pillar-fit"));
  assert.ok(!rules([post("e-linkedin", "2026-10-23", "linkedin", { pillar: "lists", format: "document" })]).includes("pillar-fit"));
  assert.ok(rules([post("s1-03-sample-piece-03-linkedin", "2026-10-24", "linkedin", { pillar: "perspective" })]).includes("channel-day"));
});

test("at most one voiceover reel a week; two talking heads wanted", () => {
  const two = [post("s1-03-sample-piece-03-instagram", "2026-10-20", "instagram"), post("s1-05-sample-piece-05-instagram", "2026-10-24", "instagram")];
  const report = lintCalendar(two, "2026-10-19")[0];
  assert.equal(report.counts.voiceoverReels, 2);
  assert.ok(report.issues.some((i) => i.rule === "voiceover" && i.severity === "error"));
  assert.ok(report.issues.some((i) => i.rule === "talking-heads"), "no talking head this week");
  const heads = [post("sample-extra-114-linkedin", "2026-10-19", "linkedin"), post("s1-13-sample-piece-13-linkedin", "2026-10-22", "linkedin")];
  assert.equal(lintCalendar(heads, "2026-10-19")[0].counts.talkingHeads, 2);
  assert.ok(!rules(heads).includes("talking-heads"));
});

test("no two days in a row with the same look, at most two Prism Light pieces a week", () => {
  const decks = ["2026-10-20", "2026-10-21"].map((d, i) => post(`deck${i}-linkedin`, d, "linkedin", { format: "document" }));
  assert.ok(rules(decks).includes("look-adjacent"));
  const spaced = ["2026-10-19", "2026-10-21", "2026-10-23"].map((d, i) => post(`deck${i}-linkedin`, d, "linkedin", { format: "document" }));
  assert.ok(!rules(spaced).includes("look-adjacent"));
  assert.ok(rules(spaced).includes("prism-cap"));
  // YouTube is not a grid that shows covers side by side: a YouTube-only leg does not count.
  const yt = [post("f-youtube", "2026-10-20", "youtube", { format: "document" }), post("g-linkedin", "2026-10-21", "linkedin", { format: "document" })];
  assert.ok(!rules(yt).includes("look-adjacent"));
});

test("the same topic needs a clear day between; Orion needs a week, across week boundaries too", () => {
  const brain = [post("sample-extra-131-linkedin", "2026-10-20", "linkedin", { format: "document" }), post("sample-extra-39-linkedin", "2026-10-21", "linkedin")];
  assert.ok(rules(brain).includes("topic"));
  const spaced = [post("sample-extra-131-linkedin", "2026-10-19", "linkedin", { format: "document" }), post("sample-extra-39-linkedin", "2026-10-21", "linkedin")];
  assert.ok(!rules(spaced).includes("topic"));
  const orion = [post("sample-extra-38-linkedin", "2026-10-16", "linkedin"), post("sample-extra-134-linkedin", "2026-10-20", "linkedin", { format: "document" })];
  assert.ok(rules(orion).includes("topic"), "4 days after the teaser, in the next week");
});

test("LinkedIn caption: warn over 3,000, error over 4,000, published posts are history", () => {
  const caption = (n: number, status = "scheduled") => [post("h-linkedin", "2026-10-20", "linkedin", { caption: "x".repeat(n), status })];
  assert.deepEqual(lintCalendar(caption(3100), "2026-10-19")[0].issues.filter((i) => i.rule === "caption").map((i) => i.severity), ["warn"]);
  assert.deepEqual(lintCalendar(caption(4323), "2026-10-19")[0].issues.filter((i) => i.rule === "caption").map((i) => i.severity), ["error"]);
  assert.deepEqual(lintCalendar(caption(4323, "published"), "2026-10-19")[0].issues.filter((i) => i.rule === "caption"), []);
});

test("gaps are empty weekdays and say what the day wants; Saturday and Sunday are never gaps", () => {
  const gaps = gapsFor([post("a-linkedin", "2026-10-19", "linkedin")], "2026-10-19", "2026-10-25");
  assert.deepEqual(gaps.map((g) => [g.day, g.wants]), [["Tue", "Proof, then Build"], ["Wed", "Build, then Proof"], ["Thu", "Voices, then Proof"], ["Fri", "Lists, then Build, then Proof"]]);
});

test("F4: a piece with no pillar, or one outside the four, is flagged by name", () => {
  const issues = (pillar: string | null) => lintCalendar([post("t-linkedin", "2026-10-20", "linkedin", { pillar, format: "text" })], "2026-10-19")[0].issues.filter((i) => i.rule === "pillar-fit").map((i) => i.message);
  assert.match(issues(null)[0], /has no pillar; set one/);
  assert.match(issues("community")[0], /unknown pillar \(community\)/);
});

test("F5: --weeks must be a whole number from 1 to 52", () => {
  assert.equal(parseWeeks(undefined), 4);
  assert.equal(parseWeeks("9"), 9);
  for (const bad of ["abc", "0", "53", "2.5", "-1", ""]) assert.throws(() => parseWeeks(bad), /--weeks must be a whole number from 1 to 52/);
});

test("F6: rows with no Story are one piece by their id, so a piece's legs are never two pieces", () => {
  assert.equal(pieceKeyOf(null, "orphan-linkedin"), "orphan");
  assert.equal(pieceKeyOf(undefined, "orphan-instagram"), "orphan");
  assert.equal(pieceKeyOf("s1-01", "s1-01-linkedin"), "s1-01");
  const legs = [post("orphan-linkedin", "2026-10-20", "linkedin", { storyId: null }), post("orphan-instagram", "2026-10-20", "instagram", { storyId: null })];
  assert.ok(!rules(legs).includes("one-piece"));
});

test("N3: --from must be a real date", () => {
  assert.equal(isRealDate("2026-10-19"), true);
  for (const bad of ["2026-13-01", "2026-02-30", "2026-1-01", "tomorrow", ""]) assert.equal(isRealDate(bad), false, bad);
});
