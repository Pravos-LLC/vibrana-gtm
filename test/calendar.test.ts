import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCalendar, parseCopy, updateItem, validate, zonedToUtc, type Item } from "../lib/calendar.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "gtm-cal-"));
const CAL = `# content calendar (comment at top)
timezone: Europe/Berlin
accounts:
  linkedin: acc-li # inline comment
items:
  # first item
  - id: a
    week: 1
    date: 2026-10-06
    pillar: proof
    title: First
    format: text
    channels: [linkedin]
    status: approved
  - id: b   # second
    week: 1
    date: 2026-10-07
    pillar: proof
    title: Second
    format: text
    channels: [linkedin]
    status: drafted
`;

test("loadCalendar applies defaults and stringifies YAML dates", () => {
  const dir = tmp();
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, "items:\n  - { id: x, week: 2, date: 2026-10-06, pillar: p, title: t, format: text, status: idea }\n");
    const cal = loadCalendar(p);
    assert.equal(cal.timezone, "Europe/Berlin");
    assert.deepEqual(cal.manual, ["newsletter", "website"]);
    assert.deepEqual(cal.accounts, {});
    assert.equal(cal.items[0].date, "2026-10-06");
    assert.deepEqual(cal.items[0].channels, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCalendar rejects YAML syntax errors and invalid items with every problem listed", () => {
  const dir = tmp();
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, "items: [\n");
    assert.throws(() => loadCalendar(p), /^Error: calendar\.yaml: /);
    writeFileSync(p, "items:\n  - { id: x, week: 1.5, date: 2026/10/06, status: idea }\n  - { id: y, week: 1, date: 2026/10/06, status: posted }\n");
    assert.throws(() => loadCalendar(p), (e: Error) =>
      /calendar\.yaml invalid/.test(e.message) && /x: week must be an integer/.test(e.message) &&
      /y: bad date/.test(e.message) && /y: bad status posted/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validate enforces Story item shape and a missing id", () => {
  const base = { week: 1, date: "2026-10-06", pillar: "p", title: "t", format: "video", status: "approved" as const };
  const problems = validate([
    { ...base, id: "s1", channels: ["linkedin", "youtube"], story_id: "orion", story_assets: ["a"] },
    { ...base, id: "s2", channels: ["linkedin"], story_id: "orion" },
    { ...base, id: "s3", channels: ["linkedin"], story_assets: ["a"] },
    { ...base, id: "", channels: [] } as Item,
    { ...base, id: "ok", channels: ["linkedin"], story_id: "orion", story_assets: ["a"] },
  ]);
  assert.ok(problems.includes("s1: Story items need one channel and story_assets"));
  assert.ok(problems.includes("s2: Story items need one channel and story_assets"));
  assert.ok(problems.includes("s3: story_assets needs story_id"));
  assert.ok(problems.some((p) => p.startsWith("item without id")));
  assert.ok(!problems.some((p) => p.startsWith("ok:")));
});

test("parseCopy: CRLF-free frontmatter only at the very top; quotes stripped; unknown channel markers stay in text", () => {
  const c = parseCopy(`Body first\n---\nnot: frontmatter\n---\nrest`);
  assert.deepEqual(c.meta, {});
  assert.match(c.base, /not: frontmatter/);
  const q = parseCopy(`---\nyoutube_title: 'Single quoted'\nyoutube_tags: a, b\nBad-Key: x\n---\nText\n--- channel: YouTube ---\nnot a marker`);
  assert.equal(q.meta.youtube_title, "Single quoted");
  assert.equal(q.meta.youtube_tags, "a, b");
  assert.equal(q.meta["Bad-Key"], undefined);
  assert.deepEqual(q.perChannel, {});
  assert.match(q.base, /--- channel: YouTube ---/);
});

test("zonedToUtc across the Europe/Berlin spring-forward switch (2026-03-29)", () => {
  const z = (d: string, t: string) => zonedToUtc(d, t, "Europe/Berlin").toISOString();
  assert.equal(z("2026-03-29", "01:59"), "2026-03-29T00:59:00.000Z"); // CET, UTC+1
  assert.equal(z("2026-03-29", "03:00"), "2026-03-29T01:00:00.000Z"); // CEST, UTC+2
  assert.equal(z("2026-03-28", "08:30"), "2026-03-28T07:30:00.000Z");
  assert.equal(z("2026-03-30", "08:30"), "2026-03-30T06:30:00.000Z");
  // 02:30 does not exist that night: it must resolve to one of the two neighbouring instants.
  assert.ok(["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z"].includes(z("2026-03-29", "02:30")));
});

test("zonedToUtc across the Europe/Berlin fall-back switch (2026-10-25)", () => {
  const z = (d: string, t: string) => zonedToUtc(d, t, "Europe/Berlin").toISOString();
  assert.equal(z("2026-10-25", "01:59"), "2026-10-24T23:59:00.000Z"); // CEST, UTC+2
  assert.equal(z("2026-10-25", "03:00"), "2026-10-25T02:00:00.000Z"); // CET, UTC+1
  assert.equal(z("2026-10-24", "08:30"), "2026-10-24T06:30:00.000Z");
  assert.equal(z("2026-10-26", "08:30"), "2026-10-26T07:30:00.000Z");
  // 02:30 happens twice: either reading is a real instant.
  assert.ok(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"].includes(z("2026-10-25", "02:30")));
});

test("zonedToUtc handles a zone on the other side of UTC and both US switches", () => {
  const z = (d: string, t: string) => zonedToUtc(d, t, "America/New_York").toISOString();
  assert.equal(z("2026-03-07", "09:00"), "2026-03-07T14:00:00.000Z"); // EST
  assert.equal(z("2026-03-09", "09:00"), "2026-03-09T13:00:00.000Z"); // EDT
  assert.equal(z("2026-11-02", "09:00"), "2026-11-02T14:00:00.000Z"); // EST again
  assert.equal(zonedToUtc("2026-10-06", "08:30", "Asia/Makassar").toISOString(), "2026-10-06T00:30:00.000Z"); // WITA, no DST
});

test("updateItem changes only the patched item and keeps every comment", () => {
  const dir = tmp();
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, CAL);
    const before = loadCalendar(p);
    updateItem(p, "b", { status: "scheduled", zernio_post_id: "post-1" });
    const after = readFileSync(p, "utf8");
    for (const c of ["# content calendar (comment at top)", "# inline comment", "# first item", "# second"]) assert.ok(after.includes(c), `lost ${c}`);
    const cal = loadCalendar(p);
    assert.equal(cal.items[1].status, "scheduled");
    assert.equal(cal.items[1].zernio_post_id, "post-1");
    assert.deepEqual(cal.items[0], before.items[0]);
    assert.deepEqual({ ...cal.items[1], status: "drafted", zernio_post_id: undefined }, { ...before.items[1], zernio_post_id: undefined });
    assert.deepEqual([cal.timezone, cal.accounts], [before.timezone, before.accounts]);
    updateItem(p, "b", { zernio_post_id: null });
    assert.equal(loadCalendar(p).items[1].zernio_post_id, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("updateItem writes a sibling temp file then renames it over the calendar", () => {
  const dir = tmp();
  const { writeFileSync: realWrite, renameSync: realRename } = fs;
  const ops: string[] = [];
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, CAL);
    fs.writeFileSync = ((f: string, ...rest: unknown[]) => { ops.push(`write ${f}`); return (realWrite as any)(f, ...rest); }) as typeof fs.writeFileSync;
    fs.renameSync = ((a: string, b: string) => { ops.push(`rename ${a} -> ${b}`); return realRename(a, b); }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    updateItem(p, "a", { status: "skipped" });
    const tmpFile = `${p}.${process.pid}.tmp`;
    assert.deepEqual(ops, [`write ${tmpFile}`, `rename ${tmpFile} -> ${p}`]);
    assert.deepEqual(readdirSync(dir), ["calendar.yaml"]);
  } finally {
    fs.writeFileSync = realWrite; fs.renameSync = realRename; syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateItem on an unknown id throws and leaves the file untouched", () => {
  const dir = tmp();
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, CAL);
    assert.throws(() => updateItem(p, "nope", { status: "published" }), /no calendar item nope/);
    assert.equal(readFileSync(p, "utf8"), CAL);
    assert.deepEqual(readdirSync(dir), ["calendar.yaml"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the week comes from the date: a YAML week that disagrees is ignored, and a date change moves the week with it", () => {
  const dir = tmp();
  try {
    const p = join(dir, "calendar.yaml");
    writeFileSync(p, "timezone: Europe/Berlin\nitems:\n  - { id: x, week: 40, date: 2026-10-06, pillar: proof, title: t, format: text, channels: [linkedin], status: idea }\n");
    assert.equal(loadCalendar(p).items[0].week, 41);
    updateItem(p, "x", { date: "2027-01-05" });
    assert.match(readFileSync(p, "utf8"), /week: 1\b/);
    assert.equal(loadCalendar(p).items[0].week, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
