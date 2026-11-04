// The guide's rhythm.blocked (John, 2026-11-02: Proof, Build and Lists never go to Instagram) is refused on every send
// path that sends a calendar item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Calendar, Item } from "../lib/calendar.ts";
import { sendCalendarItem } from "../lib/publish-item.ts";
import { RHYTHM } from "../lib/rhythm.ts";

const item = (over: Partial<Item> = {}): Item => ({
  id: "carousel-x-linkedin", week: 41, date: "2030-10-07", time: "09:00", pillar: "build", title: "Calendar title",
  format: "carousel", channels: ["linkedin"], copy: "carousel-x/linkedin.md", media: ["carousel-x/out/carousel.pdf"], status: "approved", ...over,
});
function workspace(copy: string) {
  const dir = mkdtempSync(join(tmpdir(), "gtm-block-"));
  mkdirSync(join(dir, "carousel-x/out"), { recursive: true });
  writeFileSync(join(dir, "carousel-x/linkedin.md"), copy);
  writeFileSync(join(dir, "carousel-x/out/carousel.pdf"), "%PDF-1.4\n");
  const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: { linkedin: "li", instagram: "ig" }, manual: [], items: [] };
  return { dir, cal };
}

test("every send path refuses a channel the guide blocks for the piece's pillar, even when the leg has no pillar", async () => {
    const { dir, cal } = workspace("Body without links.");
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["build"] }];
  try {
    const li = item();
    const ig = { ...item({ id: "carousel-x-instagram", channels: ["instagram"], story_id: "carousel-x" }), pillar: undefined } as unknown as Item;
    cal.items = [{ ...li, story_id: "carousel-x" } as Item, ig];
    await assert.rejects(sendCalendarItem(cal, ig.id, { dry: true }), /instagram never takes build pieces/);
    const open = item({ id: "carousel-y-instagram", channels: ["instagram"], pillar: "perspective" });
    cal.items.push(open);
    assert.ok("dryRun" in await sendCalendarItem(cal, open.id, { dry: true }));
  } finally {
    delete RHYTHM.blocked;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Story classified only in the private traits file is still blocked when no row carries a pillar", async () => {
  const { TRAITS } = await import("../lib/rhythm.ts");
  const { dir, cal } = workspace("Body without links.");
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["build"] }];
  TRAITS["t-story"] = { pillar: "build" };
  try {
    const ig = { ...item({ id: "t-story-instagram", channels: ["instagram"], story_id: "t-story" }), pillar: undefined } as unknown as Item;
    cal.items = [ig];
    await assert.rejects(sendCalendarItem(cal, ig.id, { dry: true }), /instagram never takes build pieces/);
  } finally {
    delete RHYTHM.blocked;
    delete TRAITS["t-story"];
    rmSync(dir, { recursive: true, force: true });
  }
});
