import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { repairWeeks, rowToItem, toYaml, type ContentRow } from "../lib/calendar-db.ts";
import { analyzeSeason } from "../lib/season-analysis.ts";
import { currentSeason } from "../lib/seasons.ts";
import { inWeek, isoWeek, parseIsoWeekArg, seasonWeek, seasonWeekCount, seasonWeekSelector, seasonWeekStart } from "../lib/week.ts";

// Season 1 as it is in the database: Tuesday 2026-10-06 to Friday 2026-12-11.
const S1 = { id: "season-1", title: "Season 1", description: "", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: [] as string[] };

test("season weeks: week 1 is the Monday-to-Sunday week holding the first day; the last day is the last week", () => {
  assert.equal(seasonWeek(S1.starts_on, "2026-10-06"), 1, "season start day");
  assert.equal(seasonWeek(S1.starts_on, "2026-10-05"), 1, "the Monday before the start is in week 1");
  assert.equal(seasonWeek(S1.starts_on, "2026-10-11"), 1, "Sunday closes week 1");
  assert.equal(seasonWeek(S1.starts_on, "2026-10-12"), 2);
  assert.equal(seasonWeek(S1.starts_on, "2026-10-04"), 0, "before the season");
  assert.equal(seasonWeek(S1.starts_on, "2026-12-11"), 10, "season last day");
  assert.equal(seasonWeekCount(S1.starts_on, S1.ends_on), 10);
  assert.equal(seasonWeekStart(S1.starts_on, 1), "2026-10-05");
  assert.equal(seasonWeekStart(S1.starts_on, 10), "2026-12-07");
  assert.equal(seasonWeekCount("2026-10-06", "2026-10-06"), 1, "a one-day season is one week");
  // A season that starts on a Monday and ends on a Sunday.
  assert.equal(seasonWeek("2026-10-05", "2026-10-05"), 1);
  assert.equal(seasonWeekCount("2026-10-05", "2026-10-18"), 2);
});

test("gtm season counts weeks with the same helper: every analysis week matches seasonWeek", () => {
  const a = analyzeSeason({ season: S1, pieces: [] }, { pillars: [], today: "2026-10-06" });
  assert.equal(a.dateRange.weeks, seasonWeekCount(S1.starts_on, S1.ends_on));
  assert.equal(a.dateRange.currentWeek, 1);
  for (const w of a.cadence.weeks) {
    assert.equal(w.start, seasonWeekStart(S1.starts_on, w.index));
    assert.equal(seasonWeek(S1.starts_on, w.start), w.index);
    assert.equal(seasonWeek(S1.starts_on, w.end), w.index);
  }
  assert.equal(analyzeSeason({ season: S1, pieces: [] }, { pillars: [], today: "2026-12-11" }).dateRange.currentWeek, 10);
});

test("ISO weeks, including the year boundary", () => {
  assert.deepEqual(isoWeek("2026-10-05"), { year: 2026, week: 41 });
  assert.deepEqual(isoWeek("2026-10-06"), { year: 2026, week: 41 });
  assert.deepEqual(isoWeek("2026-10-03"), { year: 2026, week: 40 });
  assert.deepEqual(isoWeek("2026-12-31"), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek("2027-01-01"), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek("2027-01-05"), { year: 2027, week: 1 });
  assert.deepEqual(isoWeek("2021-01-03"), { year: 2020, week: 53 });
  assert.deepEqual(parseIsoWeekArg("41"), { week: 41, year: null });
  assert.deepEqual(parseIsoWeekArg("2026-W41"), { week: 41, year: 2026 });
  assert.throws(() => parseIsoWeekArg("54"));
  assert.throws(() => parseIsoWeekArg("W"));
});

test("week selectors: season week by date, range checked; ISO week optionally pinned to a year", () => {
  const w1 = seasonWeekSelector(S1, "1");
  assert.ok(inWeek(w1, "2026-10-06"));
  assert.ok(!inWeek(w1, "2027-01-05"), "2027 week 1 is not season week 1");
  assert.throws(() => seasonWeekSelector(S1, "11"), /give 1 to 10/);
  assert.throws(() => seasonWeekSelector(S1, "0"));
  assert.throws(() => seasonWeekSelector(S1, "1.5"));
  assert.ok(inWeek({ kind: "iso", week: 1, year: null }, "2027-01-05"));
  assert.ok(!inWeek({ kind: "iso", week: 1, year: 2026 }, "2027-01-05"));
});

test("current season: running, else next to start, else the latest", () => {
  const all = [{ id: "a", starts_on: "2026-01-01", ends_on: "2026-03-01" }, { id: "b", starts_on: "2026-10-06", ends_on: "2026-12-11" }, { id: "c", starts_on: "2027-03-01", ends_on: "2027-05-01" }];
  assert.equal(currentSeason(all, "2026-10-05")?.id, "b", "the day before Season 1 starts");
  assert.equal(currentSeason(all, "2026-12-11")?.id, "b");
  assert.equal(currentSeason(all, "2026-12-12")?.id, "c");
  assert.equal(currentSeason(all, "2028-01-01")?.id, "c");
  assert.equal(currentSeason([], "2026-10-05"), undefined);
});

const row = (id: string, week: number, date: string): ContentRow => ({
  id, week, date, time: "08:30", pillar: "proof", title: "t", format: "text", channels: ["linkedin"], status: "scheduled",
  link: null, cta: null, zernio_post_id: "z", published_at: null, urls: {}, story_id: null, story_assets: [], publication: null,
  body: "b", media: [], approved_hash: null, copy_path: null,
});

test("reading a row derives the week from the date and ignores the stored column", () => {
  assert.equal(rowToItem(row("regenera-li-document", 40, "2026-10-06")).week, 41);
  assert.equal(rowToItem(row("orion-regenera-substack", 43, "2026-10-03")).week, 40);
});

test("repairWeeks: dry run lists id, old and new; the real run updates only the week column of those rows", async () => {
  const rows = [row("ok", 41, "2026-10-05"), row("regenera-li-document", 40, "2026-10-06"), row("orion-regenera-substack", 43, "2026-10-03")];
  const updates: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const db = {
    from: () => ({
      select: () => { const q = { order: () => q, then: (r: (v: unknown) => void) => r({ data: rows.map(({ id, week, date }) => ({ id, week, date })), error: null }) }; return q; },
      update: (patch: Record<string, unknown>) => {
        const u = { patch, filters: [] as [string, unknown][] };
        updates.push(u);
        const q = { eq: (k: string, v: unknown) => { u.filters.push([k, v]); return q; }, then: (r: (v: unknown) => void) => r({ data: null, error: null }) };
        return q;
      },
    }),
  } as never;
  const dry = await repairWeeks(db, { dryRun: true });
  assert.deepEqual(dry.changes, [
    { id: "regenera-li-document", date: "2026-10-06", old: 40, new: 41 },
    { id: "orion-regenera-substack", date: "2026-10-03", old: 43, new: 40 },
  ]);
  assert.equal(updates.length, 0, "a dry run writes nothing");
  await repairWeeks(db);
  assert.deepEqual(updates.map((u) => u.patch), [{ week: 41 }, { week: 40 }]);
  assert.deepEqual(updates[0].filters, [["id", "regenera-li-document"], ["week", 40]]);
});

test("toYaml quotes clock times, so YAML 1.1 readers do not read 14:00 as 840 minutes", () => {
  const value = { items: [{ id: "x", date: "2026-10-06", time: "14:00", title: "Week 6: 3 things" }] };
  const out = toYaml(value);
  assert.match(out, /time: "14:00"/);
  assert.match(out, /title: "?Week 6: 3 things"?/);
  assert.equal(parse(out, { version: "1.1" }).items[0].time, "14:00");
  assert.equal(parse(out).items[0].time, "14:00");
  assert.equal(parse("time: 14:00", { version: "1.1" }).time, 840, "the failure this guards against");
  assert.deepEqual(parse(out), value);
});

test("months: shiftMonth crosses years and monthLastDay is the real last day", async () => {
  const { shiftMonth, monthLastDay } = await import("../lib/week");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(monthLastDay("2026-10"), "2026-10-31");
  assert.equal(monthLastDay("2028-02"), "2028-02-29");
});
