// The guide's rhythm.blocked (John, 2026-11-02: Proof, Build and Lists never go to Instagram) is refused on every send
// path: a calendar send, and a shared piece's channel delivery, including one reserved before the block existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Calendar, Item } from "../lib/calendar.ts";
import { sendCalendarItem } from "../lib/publish-item.ts";
import { assertChannelTakesPiece, CHANNEL_BLOCKED, deliveryPillar, sendPieceDelivery } from "../lib/piece-delivery.ts";
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

test("a shared piece's delivery is refused before any claim when its channel never takes the piece's pillar", async () => {
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["proof"] }];
  const cal = { items: [
    { id: "p-linkedin", story_id: "p", pillar: "proof", channels: ["linkedin"] },
    { id: "p-instagram", story_id: "p", pillar: "", channels: ["instagram"] },
    { id: "q-instagram", story_id: "q", pillar: "perspective", channels: ["instagram"] },
  ] } as unknown as Calendar;
  let claimed = false;
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { calendar_id: "p-instagram", story_id: "p", channel: "instagram" }, error: null }) }) }) }),
    rpc: async () => { claimed = true; return { data: null, error: null }; },
  };
  try {
    assert.equal(deliveryPillar(cal, { calendar_id: "p-instagram", story_id: "p" }), "proof");
    assert.throws(() => assertChannelTakesPiece(cal, { calendar_id: "p-instagram", story_id: "p", channel: "instagram" }), CHANNEL_BLOCKED);
    assert.doesNotThrow(() => assertChannelTakesPiece(cal, { calendar_id: "q-instagram", story_id: "q", channel: "instagram" }));
    assert.doesNotThrow(() => assertChannelTakesPiece(cal, { calendar_id: "p-linkedin", story_id: "p", channel: "linkedin" }));
    await assert.rejects(sendPieceDelivery(db as never, "delivery-1", cal), CHANNEL_BLOCKED);
    assert.equal(claimed, false);
  } finally {
    delete RHYTHM.blocked;
  }
});

test("a Story classified only in the private traits file is still blocked when no row carries a pillar", async () => {
  const { TRAITS } = await import("../lib/rhythm.ts");
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["build"] }];
  TRAITS["t-story"] = { pillar: "build" };
  const cal = { items: [{ id: "t-story-instagram", story_id: "t-story", pillar: "", channels: ["instagram"] }] } as unknown as Calendar;
  try {
    assert.equal(deliveryPillar(cal, { calendar_id: "t-story-instagram", story_id: "t-story" }), "build");
    assert.throws(() => assertChannelTakesPiece(cal, { calendar_id: "t-story-instagram", story_id: "t-story", channel: "instagram" }), CHANNEL_BLOCKED);
  } finally {
    delete RHYTHM.blocked;
    delete TRAITS["t-story"];
  }
});
