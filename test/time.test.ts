// Regression: six Orion items carried time: "\"15:00\"" (escaped quotes). zonedToUtc returned NaN,
// the too-soon guard compared NaN < now (false) and let the post through. Every layer now refuses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidTime, loadCalendar, localDateTime, validate, zonedToUtc, type Calendar, type Item } from "../lib/calendar.ts";
import { sendCalendarItem } from "../lib/publish-item.ts";

const ESCAPED = '"15:00"'; // what YAML `time: "\"15:00\""` parses to
const item = (time: string | undefined): Item => ({
  id: "orion-x", week: 40, date: "2030-10-01", time, pillar: "proof", title: "t", format: "text",
  channels: ["linkedin"], copy: "copy.md", status: "approved",
});

test("isValidTime accepts only 24h HH:MM", () => {
  for (const ok of ["00:00", "09:05", "15:00", "23:59"]) assert.equal(isValidTime(ok), true, ok);
  for (const bad of [ESCAPED, "\\\"15:00\\\"", "15:00 ", "9:00", "24:00", "15:60", "15", "", "15:00:00", 900, null]) {
    assert.equal(isValidTime(bad), false, JSON.stringify(bad));
  }
});

test("validate flags an escaped-quote time", () => {
  assert.deepEqual(validate([item(ESCAPED)]), [`orion-x: bad time ${JSON.stringify(ESCAPED)} (expected HH:MM, 24h, written as time: "15:00")`]);
  assert.deepEqual(validate([item("15:00")]), []);
  assert.deepEqual(validate([item(undefined)]), []);
});

test("loadCalendar rejects the literal YAML that broke the Orion items", () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-time-"));
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, `items:\n  - id: orion-x\n    week: 40\n    date: '2026-10-01'\n    time: "\\"15:00\\""\n    pillar: proof\n    title: t\n    format: text\n    channels: [linkedin]\n    status: approved\n`);
    assert.throws(() => loadCalendar(p), /orion-x: bad time "\\"15:00\\""/);
    assert.equal(loadCalendar(p, { validate: false }).items[0].time, ESCAPED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("zonedToUtc and localDateTime throw instead of producing NaN", () => {
  assert.throws(() => zonedToUtc("2026-10-01", ESCAPED, "Europe/Berlin"), /bad time/);
  assert.throws(() => zonedToUtc("2026/10/01", "15:00", "Europe/Berlin"), /bad date/);
  assert.throws(() => localDateTime(item(ESCAPED)), /orion-x: bad time/);
  assert.equal(zonedToUtc("2026-10-01", "15:00", "Europe/Berlin").toISOString(), "2026-10-01T13:00:00.000Z");
});

test("scheduling refuses a malformed time even with --allow-past and --dry-run", async () => {
  const cal: Calendar = { path: "/nonexistent/calendar.yaml", timezone: "Europe/Berlin", accounts: { linkedin: "acc" }, manual: [], items: [item(ESCAPED)] };
  for (const opts of [{ dry: true }, { dry: true, allowPast: true }, { dry: true, draft: true }]) {
    await assert.rejects(sendCalendarItem(cal, "orion-x", { mode: "schedule", ...opts }, ), /bad time/);
  }
});
