import publishingMetadata from '../config/publishing-metadata.json';
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { assetIdFromKey, channelApproved, channelTime, heldBy, holdFor, holdReason, loadHolds, planSlots, rebindStoryItem, seasonEndFor } from "../lib/auto-schedule";
import type { Item } from "../lib/calendar";
import { blockedUntil, storyHolds, thirdPartyApproved } from "../lib/third-party";

const TZ = "Europe/Berlin";
// Monday 2026-10-12, 03:15 in Berlin.
const NOW = new Date("2026-10-12T01:15:00Z");
const SEASON = [{ id: "season-1", starts_on: "2026-10-06", ends_on: "2026-12-11" }];

const item = (id: string, date: string, time: string, channel: string, extra: Partial<Item> = {}): Item => ({
  id, week: 0, date, time, pillar: "lists", title: id, format: "carousel", channels: [channel], status: "drafted",
  story_id: id.replace(/-(linkedin|instagram|youtube)$/, ""), story_assets: [`${id}-copy`], ...extra,
});

test("channel times follow the guide: LinkedIn 08:30 (14:00 for video), YouTube 17:00, Instagram 18:00", () => {
  assert.equal(channelTime("linkedin", "carousel"), "08:30");
  assert.equal(channelTime("linkedin", "video"), "14:00");
  assert.equal(channelTime("youtube", "video"), "17:00");
  assert.equal(channelTime("instagram", "carousel"), "18:00");
});

test("a planned slot that is still ahead and free is kept as is", () => {
  const li = item("s1-01-sample-piece-01-linkedin", "2026-10-13", "14:00", "linkedin", { format: "video" });
  const { slotted, skipped } = planSlots({ items: [li], ready: [li], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(skipped, []);
  assert.deepEqual(slotted.map((s) => [s.id, s.date, s.time, s.moved]), [["s1-01-sample-piece-01-linkedin", "2026-10-13", "14:00", false]]);
});

test("a missed piece moves, with its channels together, to the next day whose primary pillar is its own", () => {
  const top7 = [item("s1-07-top-7-linkedin", "2026-10-08", "08:30", "linkedin"), item("s1-07-top-7-instagram", "2026-10-08", "18:00", "instagram")];
  // A list carousel: Friday is Lists, so the pair skips Monday (Lists is only its fallback) and lands on Friday.
  const tuesday = item("other-linkedin", "2026-10-13", "14:00", "linkedin", { status: "scheduled", zernio_post_id: "z1" });
  const { slotted } = planSlots({ items: [...top7, tuesday], ready: top7, now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(slotted.map((s) => [s.id, s.date, s.time, s.moved, s.from.date]), [
    ["s1-07-top-7-linkedin", "2026-10-16", "08:30", true, "2026-10-08"],
    ["s1-07-top-7-instagram", "2026-10-16", "18:00", true, "2026-10-08"],
  ]);
});

test("pieces planned for a day claim it first; a missed piece takes its next rhythm day", () => {
  const planned = item("wed-linkedin", "2026-10-14", "08:30", "linkedin");
  const missed = item("missed-linkedin", "2026-10-08", "08:30", "linkedin");
  const { slotted } = planSlots({ items: [planned, missed], ready: [missed, planned], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(slotted.map((s) => [s.id, s.date]), [["wed-linkedin", "2026-10-14"], ["missed-linkedin", "2026-10-16"]]);
});

test("a hand-placed piece keeps its day even when another piece holds it; only its own channel being taken moves it", () => {
  // Review F3: John placed both; the lint warns about two pieces on Wednesday instead of the scheduler moving one.
  const a = item("a-linkedin", "2026-10-14", "08:30", "linkedin");
  const b = item("b-instagram", "2026-10-14", "18:00", "instagram");
  assert.deepEqual(planSlots({ items: [a, b], ready: [a, b], now: NOW, timeZone: TZ, seasons: SEASON }).slotted.map((s) => [s.id, s.date, s.moved]),
    [["a-linkedin", "2026-10-14", false], ["b-instagram", "2026-10-14", false]]);
  // Two posts on one channel and day: the second moves instead of double-posting.
  const c = item("c-linkedin", "2026-10-14", "14:00", "linkedin", { format: "video" });
  const moved = planSlots({ items: [a, c], ready: [a, c], now: NOW, timeZone: TZ, seasons: SEASON }).slotted;
  assert.deepEqual(moved.find((s) => s.id === "c-linkedin")!.moved, true);
  assert.notEqual(moved.find((s) => s.id === "c-linkedin")!.date, "2026-10-14");
});

test("nothing is ever slotted in the past or under 30 minutes away", () => {
  // Friday 08:10 Berlin: today's 08:30 LinkedIn slot is 20 minutes away, so the list takes next Friday, its own pillar
  // (a primary day inside PRIMARY_WINDOW_DAYS beats Monday, where Lists is only the fallback).
  const now = new Date("2026-10-16T06:10:00Z");
  const missed = item("late-linkedin", "2026-10-13", "08:30", "linkedin");
  const { slotted } = planSlots({ items: [missed], ready: [missed], now, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(slotted.map((s) => [s.date, s.time]), [["2026-10-23", "08:30"]]);
  for (const s of slotted) assert.ok(new Date(`${s.date}T${s.time}:00+02:00`).getTime() > now.getTime());
});

/** Something scheduled on every weekday of the week of 2026-10-12, so only Saturday is open. */
const busyWeek = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d, n) =>
  item(`busy-${n}-linkedin`, d, "08:30", "linkedin", { status: "scheduled", zernio_post_id: `z${n}`, format: "text", pillar: "proof" }));

test("Saturday takes only Instagram and YouTube: a reel goes there, a LinkedIn leg never does", () => {
  const reel = [item("s1-03-sample-piece-03-youtube", "2026-10-08", "17:00", "youtube", { format: "video", pillar: "perspective" }),
    item("s1-03-sample-piece-03-instagram", "2026-10-08", "18:00", "instagram", { format: "video", pillar: "perspective" })];
  const withLi = [...reel, item("s1-03-sample-piece-03-linkedin", "2026-10-08", "14:00", "linkedin", { format: "video", pillar: "perspective" })];
  const open = planSlots({ items: [...busyWeek, ...reel], ready: reel, now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual([...new Set(open.slotted.map((s) => s.date))], ["2026-10-17"]);
  const li = planSlots({ items: [...busyWeek, ...withLi], ready: withLi, now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual([...new Set(li.slotted.map((s) => s.date))], ["2026-10-19"], "the next Monday, its own pillar");
});

test("a moved piece never adds a second voiceover reel to a week, nor lands within a week of another Orion piece", () => {
  const vo = item("s1-05-sample-piece-05-linkedin", "2026-10-13", "14:00", "linkedin", { status: "scheduled", zernio_post_id: "z9", format: "video", pillar: "perspective" });
  const second = item("s1-06-sample-piece-06-linkedin", "2026-10-08", "14:00", "linkedin", { format: "video", pillar: "perspective" });
  const { slotted } = planSlots({ items: [vo, second], ready: [second], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.ok(slotted[0].date >= "2026-10-19", `grief went to ${slotted[0].date}`);

  const teaser = item("sample-extra-38-linkedin", "2026-10-13", "14:00", "linkedin", { status: "scheduled", zernio_post_id: "z8", format: "video", pillar: "proof" });
  const deck = item("sample-extra-134-linkedin", "2026-10-08", "08:30", "linkedin", { format: "document", pillar: "proof" });
  const orion = planSlots({ items: [teaser, deck], ready: [deck], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.equal(orion.slotted[0].date, "2026-10-20", "the next Tuesday, a week after the teaser");
});

/** Every weekday Mon 2026-10-12 to Fri 2026-12-11 held by a scheduled LinkedIn post, except the dates given. */
const fullSeason = (free: string[] = []) => {
  const out: Item[] = [];
  for (let t = Date.parse("2026-10-12T12:00:00Z"); t <= Date.parse("2026-12-11T12:00:00Z"); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || free.includes(d)) continue;
    out.push(item(`held-${d}-linkedin`, d, "08:30", "linkedin", { status: "scheduled", zernio_post_id: `z-${d}`, format: "text", pillar: "proof", story_id: `held-${d}` }));
  }
  return out;
};

test("F1: a move never lands after the current season ends; a piece with no open day stays put and says it doesn't fit", () => {
  const missed = item("signal-x-linkedin", "2026-10-08", "08:30", "linkedin", { format: "text", pillar: "perspective" });
  const { slotted, skipped } = planSlots({ items: [...fullSeason(), missed], ready: [missed], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(slotted, []);
  assert.match(skipped[0].reason, /^doesn't fit this season: no open day before it ends on 2026-12-11/);
  assert.equal(seasonEndFor(SEASON, "2026-10-17"), "2026-12-11");
  assert.equal(seasonEndFor([...SEASON, { id: "s2", starts_on: "2027-01-12", ends_on: "2027-03-20" }], "2026-12-20"), "2027-03-20", "between seasons: the next one");
});

test("F2: primary day, then fallback day, within two weeks; then the earliest open day ('drops back to whatever is available')", () => {
  // Perspective is Monday only, and no day's fallback. Every Monday is taken, so it takes the first open weekday.
  const mondays = ["2026-10-12", "2026-10-19", "2026-10-26"].map((d) => item(`mon-${d}-linkedin`, d, "14:00", "linkedin", { status: "scheduled", zernio_post_id: `m-${d}`, format: "text", pillar: "proof", story_id: `mon-${d}` }));
  const missed = item("signal-y-linkedin", "2026-10-08", "08:30", "linkedin", { format: "text", pillar: "perspective" });
  const { slotted } = planSlots({ items: [...mondays, missed], ready: [missed], now: NOW, timeZone: TZ, seasons: SEASON });
  // Tuesday would put two text posts in a row (Monday's is text too), so Wednesday: never Mon 7 December.
  assert.deepEqual(slotted.map((s) => s.date), ["2026-10-14"]);
  // A Lists piece with Friday taken in the window takes Monday, its fallback, before any other day.
  const fridays = ["2026-10-16", "2026-10-23"].map((d) => item(`fri-${d}-linkedin`, d, "08:30", "linkedin", { status: "scheduled", zernio_post_id: `f-${d}`, format: "text", pillar: "proof", story_id: `fri-${d}` }));
  const list = item("list-linkedin", "2026-10-08", "08:30", "linkedin", { format: "document", pillar: "lists" });
  assert.deepEqual(planSlots({ items: [...fridays, list], ready: [list], now: NOW, timeZone: TZ, seasons: SEASON }).slotted.map((s) => s.date), ["2026-10-12"]);
});

test("F4: a piece with no pillar is never skipped forever; it takes the earliest open weekday", () => {
  const loose = item("loose-linkedin", "2026-10-08", "08:30", "linkedin", { format: "text", pillar: null as unknown as string });
  const odd = item("odd-linkedin", "2026-10-08", "08:30", "linkedin", { format: "text", pillar: "community" });
  const { slotted, skipped } = planSlots({ items: [loose, odd], ready: [loose, odd], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(skipped, []);
  // The second skips Tuesday only because two text posts in a row break the look rule.
  assert.deepEqual(slotted.map((s) => [s.id, s.date]), [["loose-linkedin", "2026-10-12"], ["odd-linkedin", "2026-10-14"]]);
});

test("F6: legs with no story_id are one piece by their id; they keep one day together", () => {
  const li = item("orphan-piece-linkedin", "2026-10-14", "08:30", "linkedin", { story_id: undefined });
  const ig = item("orphan-piece-instagram", "2026-10-14", "18:00", "instagram", { story_id: undefined });
  const missed = [item("lost-piece-linkedin", "2026-10-08", "08:30", "linkedin", { story_id: undefined }), item("lost-piece-instagram", "2026-10-08", "18:00", "instagram", { story_id: undefined })];
  const { slotted } = planSlots({ items: [li, ig, ...missed], ready: [li, ig, ...missed], now: NOW, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(slotted.filter((s) => s.id.startsWith("orphan")).map((s) => [s.date, s.moved]), [["2026-10-14", false], ["2026-10-14", false]]);
  const lost = slotted.filter((s) => s.id.startsWith("lost"));
  assert.equal(lost.length, 2);
  assert.equal(lost[0].date, lost[1].date, "both legs of the missed piece land on the same day");
});

const SN_HOLD = { storyId: "s1-13-sample-piece-13", who: "example_approver / Example Series", note: "Waiting on example_approver's approval of the v4 cut", heldAt: "2026-10-12T09:00:00Z", kind: "third_party" as const, finalStaged: false };

test("holds, reserve-bank dates and hand-published channels are skipped with a reason", () => {
  const sn = item("s1-13-sample-piece-13-youtube", "2026-11-13", "17:00", "youtube");
  const reserve = item("s1-05-sample-piece-05-linkedin", "2027-01-05", "14:00", "linkedin");
  const letter = item("essay-newsletter", "2026-10-16", "09:00", "newsletter");
  const { slotted, skipped } = planSlots({ items: [sn, reserve, letter], ready: [sn, reserve, letter], now: NOW, timeZone: TZ, seasons: SEASON, holds: [SN_HOLD], manual: ["newsletter"] });
  assert.deepEqual(slotted, []);
  assert.equal(skipped.find((s) => s.id === sn.id)!.reason, "held: publishing blocked until example_approver / Example Series approves the final: Waiting on example_approver's approval of the v4 cut");
  assert.match(skipped.find((s) => s.id === reserve.id)!.reason, /reserve bank/);
  assert.match(skipped.find((s) => s.id === letter.id)!.reason, /by hand/);
});

test("a held piece is never slotted even when it is approved and its slot is free; its siblings and other pieces still are", () => {
  // Every item passed as ready is approved for its channel. The held Story's platforms are skipped, the rest keep their slots.
  const heldLi = item("s1-13-sample-piece-13-linkedin", "2026-10-14", "14:00", "linkedin", { status: "approved" });
  const heldYt = item("s1-13-sample-piece-13-youtube", "2026-10-14", "17:00", "youtube", { status: "approved" });
  const other = item("s1-07-sample-piece-07-linkedin", "2026-10-15", "08:30", "linkedin");
  const { slotted, skipped } = planSlots({ items: [heldLi, heldYt, other], ready: [heldLi, heldYt, other], now: NOW, timeZone: TZ, seasons: SEASON, holds: [SN_HOLD] });
  assert.deepEqual(slotted.map((s) => s.id), [other.id]);
  assert.deepEqual(skipped.map((s) => s.id).sort(), [heldLi.id, heldYt.id]);
  // Released (no holds), the same approved items are slotted.
  assert.equal(planSlots({ items: [heldLi, heldYt, other], ready: [heldLi, heldYt, other], now: NOW, timeZone: TZ, seasons: SEASON, holds: [] }).slotted.length, 3);
});

test("heldBy matches the item's Story, or the Story id prefix when an item has no story_id", () => {
  assert.equal(heldBy({ id: "s1-13-sample-piece-13-instagram", story_id: "s1-13-sample-piece-13" }, [SN_HOLD]), SN_HOLD);
  assert.equal(heldBy({ id: "s1-13-sample-piece-13-instagram", story_id: undefined }, [SN_HOLD]), SN_HOLD);
  assert.equal(heldBy({ id: "s1-07-sample-piece-07-linkedin", story_id: "s1-07-sample-piece-07" }, [SN_HOLD]), undefined);
  // A Story whose id merely starts with a held id is a different piece.
  assert.equal(heldBy({ id: "s1-13-sample-piece-13-2-linkedin", story_id: "s1-13-sample-piece-13-2" }, [SN_HOLD]), undefined);
});

test("holdReason says who and why, and reads well without either", () => {
  assert.equal(holdReason(SN_HOLD), "publishing blocked until example_approver / Example Series approves the final: Waiting on example_approver's approval of the v4 cut");
  assert.equal(holdReason({ ...SN_HOLD, who: "", note: "" }), "publishing blocked until a third party approves the final");
});

test("loadHolds reads held Stories and third parties from gtm_stories, optionally one Story", async () => {
  const calls: string[] = [];
  const rows = [{ id: SN_HOLD.storyId, hold_who: SN_HOLD.who, hold_note: SN_HOLD.note, held_at: SN_HOLD.heldAt, third_party_who: null }];
  const query = (filtered: boolean) => ({
    eq: (col: string, v: string) => { calls.push(`eq ${col}=${v}`); return query(true); },
    then: (resolve: (r: unknown) => void) => resolve({ data: rows, error: null }),
    filtered,
  });
  const db = { from: (t: string) => { calls.push(`from ${t}`); return { select: (cols: string) => { calls.push(`select ${cols}`); return { or: (f: string) => { calls.push(`or ${f}`); return query(false); } }; } }; } };
  const manual = { ...SN_HOLD, kind: "hold" as const, finalStaged: true };
  assert.deepEqual(await loadHolds(db as never), [manual]);
  assert.deepEqual(calls, ["from gtm_stories", "select id,hold_who,hold_note,held_at,third_party_who", "or held_at.not.is.null,third_party_who.not.is.null"]);
  calls.length = 0;
  assert.deepEqual(await holdFor(db as never, SN_HOLD.storyId), manual);
  assert.ok(calls.includes(`eq id=${SN_HOLD.storyId}`));
});

test("a third party's gate: open until they approve the final at its current bytes; a new final re-opens it; a rough cut is never theirs", () => {
  const story = { id: "sn", hold_who: null, hold_note: null, held_at: null, third_party_who: "example_approver / Example Series" };
  const video = (sha: string, stage: string | null) => ({ id: "sn-video", story_id: "sn", kind: "video", sha256: sha, stage });
  const plan = { id: "sn-plan", story_id: "sn", kind: "image", sha256: "p".repeat(64), stage: "enhance-plan" };
  const bound = new Set(["sn-video"]);
  const signed = [{ story_id: "sn", stage: "final", party: "third_party", decision: "approved", assets: [{ asset_id: "sn-video", sha256: "b".repeat(64) }] }];
  assert.deepEqual(storyHolds([story], [video("a".repeat(64), "rough-cut"), plan], bound, []).map((h) => [h.kind, h.who, h.finalStaged]), [["third_party", "example_approver / Example Series", false]]);
  assert.equal(storyHolds([story], [video("b".repeat(64), "final"), plan], bound, signed).length, 0, "signed off on these final bytes; the plan image is not a post");
  assert.equal(storyHolds([story], [video("c".repeat(64), "final"), plan], bound, signed).length, 1, "a new final needs their sign-off again");
  assert.equal(thirdPartyApproved([video("b".repeat(64), "rough-cut")], signed), false, "a rough cut is never signed off");
  assert.equal(storyHolds([{ ...story, third_party_who: null }], [], bound, []).length, 0, "no third party, no gate");
  assert.equal(blockedUntil("example_approver / Example Series"), "Publishing blocked until example_approver / Example Series approves the final");
});

test("the hold migration holds exactly the Example Series shorts (season pieces 18 to 22), replacing config/schedule-holds.json", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261012200000_gtm_story_holds.sql", import.meta.url), "utf8");
  const pattern = new RegExp(sql.match(/where id ~ '([^']+)' and held_at is null/)![1]);
  for (const id of ["s1-18-example-record-19", "s1-19-example-record-20", "s1-20-example-record-21", "s1-21-example-record-22", "s1-22-example-record-23"]) assert.ok(pattern.test(id), id);
  for (const id of ["s1-07-example-record-8", "sample-extra-115", "sample-extra-117", "s1-23-sn-later"]) assert.ok(!pattern.test(id), id);
  assert.match(sql, /hold_who = 'example_approver \/ Example Series', hold_note = 'Awaiting final example approval'/);
  assert.equal(existsSync(new URL("../config/schedule-holds.json", import.meta.url)), false);
});

test("a Story item is ready only when every bound asset is approved for its channel at the current bytes", () => {
  const li = item("p-linkedin", "2026-10-14", "08:30", "linkedin", { story_id: "p", story_assets: ["copy", "slides", "link"] });
  const assets = [{ id: "copy", kind: "copy" as const, sha256: "c1" }, { id: "slides", kind: "image" as const, sha256: "s1" }, { id: "link", kind: "link" as const, sha256: "l1" }];
  const ok = [
    { asset_id: "copy", channel: "linkedin", status: "approved" as const, approved_sha256: "c1" },
    { asset_id: "slides", channel: "linkedin", status: "approved" as const, approved_sha256: "s1" },
  ];
  assert.equal(channelApproved(li, assets, ok), true, "links need no approval");
  assert.equal(channelApproved(li, assets, ok.map((r) => r.asset_id === "slides" ? { ...r, status: "pending" as const } : r)), false, "asset still pending");
  assert.equal(channelApproved(li, assets, ok.map((r) => r.asset_id === "copy" ? { ...r, approved_sha256: "old" } : r)), false, "text changed after approval");
  assert.equal(channelApproved(li, assets, ok.map((r) => ({ ...r, channel: "instagram" }))), false, "approved for another platform only");
  assert.equal(channelApproved({ ...li, story_assets: ["copy", "slides", "missing"] }, assets, ok), false, "a bound asset is missing");
});

test("a rough cut approved at its current bytes is never ready; restaged final (and re-approved) it is", async () => {
  const { notFinalAssets } = await import("../lib/auto-schedule");
  const yt = item("s1-13-sample-piece-13-youtube", "2026-11-13", "17:00", "youtube", { format: "video", story_id: "s1-13-sample-piece-13", story_assets: ["copy", "video"] });
  const rough = [{ id: "copy", kind: "copy" as const, sha256: "c1", stage: null }, { id: "video", kind: "video" as const, sha256: "v1", stage: "rough-cut", title: "Video 9:16" }];
  const approved = [
    { asset_id: "copy", channel: "youtube", status: "approved" as const, approved_sha256: "c1" },
    { asset_id: "video", channel: "youtube", status: "approved" as const, approved_sha256: "v1" },
  ];
  assert.equal(channelApproved(yt, rough, approved), false, "a rough-cut approval means the edit is good, never send it");
  assert.deepEqual(notFinalAssets(yt, rough).map((a) => a.id), ["video"]);
  assert.equal(channelApproved(yt, rough.map((a) => ({ ...a, stage: a.kind === "video" ? "final" : null })), approved), true, "final is ready");
  assert.equal(channelApproved(yt, rough.map((a) => ({ ...a, stage: null })), approved), true, "a stageless (legacy) asset behaves as before");
});

test("a stored media key names its asset", () => {
  assert.equal(assetIdFromKey("stories/s1-07-top-7/s1-07-top-7-slide-03-07018638ad6a0f1d.png"), "s1-07-top-7-slide-03");
  assert.equal(assetIdFromKey("stories/x/no-hash.png"), null);
});

test("rebind: an old key of a bound asset moves to its current bytes; a key of an asset removed from the Story is dropped", () => {
  const story = "s1-01-sample-piece-01";
  const key = (id: string, sha: string) => `stories/${story}/${story}-${id}-${sha}.png`;
  const assets = [
    { id: `${story}-instagram`, source: "posts/maturity/instagram.md", storage_path: null },
    { id: `${story}-slide-01`, source: "media/slide-01.png", storage_path: key("slide-01", "53f4da4a9f8e9590") },
    { id: `${story}-slide-02`, source: "media/slide-02.png", storage_path: key("slide-02", "6ac48a49672db461") },
  ];
  const item = {
    id: `${story}-instagram`, week: 0, date: "2026-10-13", time: "18:00", pillar: "proof", title: "m", format: "carousel", channels: ["instagram"], status: "drafted" as const,
    story_id: story, copy: "posts/maturity/instagram.md",
    story_assets: [`${story}-instagram`, `${story}-slide-01`, `${story}-slide-02`, `${story}-slide-03`],
    media: [key("slide-01", "8df365096c2a3b59"), key("slide-02", "6ac48a49672db461"), key("slide-03", "d013216b7759c646")],
  };
  const r = rebindStoryItem(item, assets);
  assert.equal(r.changed, true);
  assert.deepEqual(r.media, [key("slide-01", "53f4da4a9f8e9590"), key("slide-02", "6ac48a49672db461")]);
  assert.deepEqual(r.story_assets, [`${story}-instagram`, `${story}-slide-01`, `${story}-slide-02`]);
  assert.equal(rebindStoryItem({ ...item, media: r.media, story_assets: r.story_assets }, assets).changed, false, "a current item is left alone");
  // A key of an asset the item is not bound to is never swapped in; the publish gate refuses it.
  const foreign = `stories/${story}/other-asset-0123456789abcdef.png`;
  assert.deepEqual(rebindStoryItem({ ...item, media: [foreign] }, assets).media, [foreign]);
});

test("an approved platform with no calendar item becomes one, bound to exactly what was approved", async () => {
  const { materializeItem } = await import("../lib/auto-schedule");
  const sid = "s1-14-sample-piece-14";
  const piece = { storyId: sid, title: "Robots", date: "2026-11-20", pillar: "perspective", kind: "short" };
  const a = (id: string, kind: "copy" | "video" | "image", path: string | null, body: string | null = null) => ({ id: `${sid}-${id}`, story_id: sid, kind, sha256: "x".repeat(64), source: `src/${id}`, storage_path: path, body });
  const assets = [a("youtube", "copy", null, "text"), a("video-9x16", "video", "stories/v.mp4"), a("cover", "image", "stories/c.png"), a("instagram", "copy", null, "ig")];
  const rows = [
    { asset_id: `${sid}-youtube`, channel: "youtube" }, { asset_id: `${sid}-video-9x16`, channel: "youtube" }, { asset_id: `${sid}-cover`, channel: "youtube" },
    { asset_id: `${sid}-instagram`, channel: "instagram" }, { asset_id: `${sid}-video-9x16`, channel: "instagram" },
  ];
  const made = materializeItem(sid, "youtube", assets, rows, piece);
  assert.ok("row" in made);
  if (!("row" in made)) return;
  assert.equal(made.row.id, `${sid}-youtube`);
  assert.deepEqual(made.row.media, ["stories/v.mp4"], "a cover beside a video is bound, not posted");
  assert.deepEqual(made.row.story_assets, [`${sid}-youtube`, `${sid}-video-9x16`, `${sid}-cover`]);
  assert.deepEqual([made.row.date, made.row.time, made.row.format, made.row.status, made.row.copy_path, made.row.body], ["2026-11-20", "17:00", "video", "drafted", "src/youtube", "text"]);
  assert.match((materializeItem(sid, "youtube", assets, rows, undefined) as { error: string }).error, /no season entry/);
  // Slides only: a LinkedIn document, slides in order.
  const deck = [a("linkedin", "copy", null, "li"), a("slide-02", "image", "stories/2.png"), a("slide-01", "image", "stories/1.png")];
  const li = materializeItem(sid, "linkedin", deck, deck.map((x) => ({ asset_id: x.id, channel: "linkedin" })), piece);
  assert.ok("row" in li && li.row.format === "document" && li.row.time === "08:30");
  assert.deepEqual("row" in li ? li.row.media : [], ["stories/1.png", "stories/2.png"]);
});

// ---- approved Stories with no calendar item (any Story, not only season1.json) ----------------------------------

const H = (c: string) => c.repeat(64);
type A = { id: string; story_id: string; kind: "copy" | "video" | "image" | "link"; sha256: string; source: string; storage_path: string | null; body: string | null; stage?: string | null; title?: string };
const ok = (assets: A[], channels: Record<string, string[]>) => Object.entries(channels).flatMap(([channel, ids]) => ids.map((id) => ({ asset_id: id, channel, status: "approved" as const, approved_sha256: assets.find((a) => a.id === id)!.sha256 })));
const TODAY = "2026-10-17";

test("a Story outside season1.json is put on the calendar from itself: title, pillar and the next Tue-Thu after today", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const sid = "kb-quiet-resistance";
  const assets: A[] = [{ id: `${sid}-linkedin-copy`, story_id: sid, kind: "copy", sha256: H("a"), source: "../kb/quiet-resistance/story/linkedin.md", storage_path: null, body: "---\npillar: proof\nfirst_comment: \"x\"\n---\nYour people aren't resisting AI. They're hiding it, and that is the real finding here.\n" }];
  const r = materializeApproved({ assets, approvals: ok(assets, { linkedin: [`${sid}-linkedin-copy`] }), items: [], manual: ["newsletter", "website"], holds: [], pieces: [], stories: [{ id: sid, title: "The quiet resistance: your people already use AI" }], today: TODAY });
  assert.deepEqual(r.skipped, []);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  // A text-only LinkedIn post is a text post: no media, the text time.
  assert.deepEqual([row.id, row.date, row.time, row.pillar, row.title, row.format, row.media, row.story_assets, row.story_id, row.status],
    [`${sid}-linkedin`, "2026-10-20", "08:30", "proof", "The quiet resistance: your people already use AI", "text", [], [`${sid}-linkedin-copy`], sid, "drafted"]);
});

test("a Story's own planned date and title win; the slot prefix of a Story title is dropped; season pieces keep their entry", async () => {
  const { pieceFor } = await import("../lib/auto-schedule");
  const sid = "sample-extra-136";
  const copy = (body: string): A => ({ id: `${sid}-linkedin`, story_id: sid, kind: "copy", sha256: H("b"), source: "posts/kogui/linkedin.md", storage_path: null, body });
  const rows = [{ asset_id: `${sid}-linkedin`, channel: "linkedin" }];
  const story = { id: sid, title: "Kogui elders to AI builders (unscheduled) | You are the only example it has" };
  assert.deepEqual(pieceFor(sid, "linkedin", [copy("---\npillar: perspective\n---\nText")], rows, undefined, story, TODAY), { storyId: sid, title: "You are the only example it has", date: "2026-10-19", pillar: "perspective", kind: "story" });
  const planned = pieceFor(sid, "linkedin", [copy("---\npillar: perspective\ndate: 2026-10-28\ntitle: Kogui mirror\n---\nText")], rows, undefined, story, TODAY);
  assert.deepEqual("error" in planned ? planned : [planned.date, planned.title], ["2026-10-28", "Kogui mirror"]);
  // No pillar anywhere: reported, never guessed.
  assert.match((pieceFor(sid, "linkedin", [copy("Text")], rows, undefined, story, TODAY) as { error: string }).error, /no pillar/);
  const operationalId = Object.keys(publishingMetadata)[0];
  const operational = pieceFor(operationalId, "linkedin", [{ ...copy("Approved text"), story_id: operationalId }], rows, undefined, { id: operationalId, title: "Example operational item" }, TODAY);
  assert.ok(!("error" in operational));
  if (!("error" in operational)) assert.equal(operational.pillar, (publishingMetadata as Record<string, {pillar:string}>)[operationalId].pillar, "classification repair does not require changing approved copy");
  const season = { storyId: sid, title: "Season name", date: "2026-11-20", pillar: "build", kind: "short" };
  assert.equal(pieceFor(sid, "linkedin", [copy("Text")], rows, season, story, TODAY), season);
});

test("Instagram or YouTube with text only is reported as a skip, never dropped", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const sid = "kb-text";
  const assets: A[] = [{ id: `${sid}-instagram`, story_id: sid, kind: "copy", sha256: H("c"), source: "kb/text/instagram.md", storage_path: null, body: "---\npillar: perspective\n---\nA caption with no picture." }];
  const r = materializeApproved({ assets, approvals: ok(assets, { instagram: [`${sid}-instagram`] }), items: [], manual: [], holds: [], pieces: [], stories: [], today: TODAY });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.skipped.map((s) => s.id), [`${sid}-instagram`]);
  assert.match(r.skipped[0].reason, /Instagram needs an image or a video/);
});

// s1-13 "AI: power vs. purpose" went out on 2026-10-07 from rows made before Stories existed (`power-vs-purpose-*`, no
// story_id, the video stored under calendar/<item>/<sha16>-<name>). It was staged as a Story and approved later.
function powerVsPurpose() {
  const sid = "sample-extra-113";
  const sha = "4dcd7f639b53d646" + "0".repeat(48);
  const text = (ch: string) => `A post about power and purpose, written for ${ch}, long enough to compare as a whole text.`;
  const assets: A[] = [
    { id: `${sid}-video-9x16`, story_id: sid, kind: "video", sha256: sha, source: "../vibrana-gtm/content-season-2026-10/media/power-vs-purpose-9x16.mp4", storage_path: `stories/${sid}/${sid}-video-9x16-4dcd7f639b53d646.mp4`, body: null, stage: null },
    ...["linkedin", "instagram", "youtube"].map((ch): A => ({ id: `${sid}-${ch}`, story_id: sid, kind: "copy", sha256: H(ch[0]), source: `../vibrana-gtm/content-season-2026-10/posts/power-vs-purpose/${ch}.md`, storage_path: null, body: `---\npillar: perspective\nyoutube_title: Power\n---\n${text(ch)}` })),
  ];
  const approvals = ok(assets, Object.fromEntries(["linkedin", "instagram", "youtube"].map((ch) => [ch, [`${sid}-${ch}`, `${sid}-video-9x16`]])));
  const legacy = ["linkedin", "instagram", "youtube"].map((ch): Item => ({
    id: `power-vs-purpose-${ch}`, week: 41, date: "2026-10-07", time: "14:00", pillar: "perspective", title: "AI: power vs. purpose", format: "video", channels: [ch],
    status: "published", zernio_post_id: `z-${ch}`, copy: `posts/power-vs-purpose/${ch}.md`, media: [`calendar/power-vs-purpose-${ch}/4dcd7f639b53d646-power-vs-purpose-9x16.mp4`], body: text(ch),
  }));
  return { sid, assets, approvals, legacy, text };
}

test("a piece already published from rows not bound to its Story is never made a second time (s1-13)", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const { sid, assets, approvals, legacy } = powerVsPurpose();
  const r = materializeApproved({ assets, approvals, items: legacy, manual: [], holds: [], pieces: [], stories: [{ id: sid, title: "W1 Wed Oct 7 (scheduled) | AI: power vs. purpose" }], today: TODAY });
  assert.deepEqual(r.rows, [], "no duplicate post of published content");
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), [`${sid}-instagram`, `${sid}-linkedin`, `${sid}-youtube`]);
  for (const s of r.skipped) assert.match(s.reason, /power-vs-purpose-(linkedin|instagram|youtube) \(published, on Zernio\) already carries this piece/);
  // Control: without the legacy rows the same Story does materialize, so the guard is what stops it.
  assert.equal(materializeApproved({ assets, approvals, items: [], manual: [], holds: [], pieces: [], stories: [], today: TODAY }).rows.length, 3);
});

test("each kind of evidence on its own marks a row as carrying the piece, on the same channel only", async () => {
  const { alreadyOnCalendar } = await import("../lib/auto-schedule");
  const { sid, assets, legacy, text } = powerVsPurpose();
  const base = legacy[0]; // linkedin
  const bare: Item = { ...base, copy: undefined, media: [], body: undefined, story_assets: undefined };
  assert.equal(alreadyOnCalendar(sid, "linkedin", assets, [bare]), undefined, "a row with nothing in common is not the piece");
  assert.ok(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, media: base.media }]), "same video bytes (sha256 prefix in the key)");
  assert.ok(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, media: [`stories/${sid}/${sid}-video-9x16-4dcd7f639b53d646.mp4`] }]), "same storage key");
  assert.ok(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, copy: base.copy }]), "same copy file under another root");
  assert.ok(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, body: `---\npillar: proof\n---\n${text("linkedin")}` }]), "same text, front matter aside");
  assert.ok(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, story_assets: [`${sid}-linkedin`] }]), "names a Story asset");
  assert.equal(alreadyOnCalendar(sid, "instagram", assets, [{ ...bare, media: base.media }]), undefined, "a LinkedIn row never blocks Instagram");
  assert.equal(alreadyOnCalendar(sid, "linkedin", assets, [{ ...bare, copy: "story/linkedin.md" }]), undefined, "a two-segment path is too generic to match");
  assert.equal(alreadyOnCalendar(sid, "linkedin", assets, [{ ...base, story_id: sid }]), undefined, "a row bound to the Story is the Story's own item");
});

test("held, hand-published and not-final approvals are reported with their reason; unapproved and already-made ones are not", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const copy = (sid: string, ch: string): A => ({ id: `${sid}-${ch}`, story_id: sid, kind: "copy", sha256: H("d"), source: `x/${sid}/${ch}.md`, storage_path: null, body: "---\npillar: perspective\n---\nSome text." });
  const held = [copy("held-a", "linkedin")];
  const news = [copy("news-a", "newsletter")];
  const rough: A[] = [copy("rough-a", "linkedin"), { id: "rough-a-video", story_id: "rough-a", kind: "video", sha256: H("e"), source: "v.mp4", storage_path: "stories/rough-a/v.mp4", body: null, stage: "rough", title: "Video" }];
  const pending = [copy("pending-a", "linkedin")];
  const made = [copy("made-a", "linkedin")];
  const assets = [...held, ...news, ...rough, ...pending, ...made];
  const approvals = [
    ...ok(held, { linkedin: ["held-a-linkedin"] }), ...ok(news, { newsletter: ["news-a-newsletter"] }), ...ok(rough, { linkedin: ["rough-a-linkedin", "rough-a-video"] }),
    { asset_id: "pending-a-linkedin", channel: "linkedin", status: "pending" as const, approved_sha256: null }, ...ok(made, { linkedin: ["made-a-linkedin"] }),
  ];
  const holds = [{ storyId: "held-a", who: "example_approver", note: "", heldAt: null, kind: "third_party" as const, finalStaged: true }];
  const items = [item("made-a-linkedin", "2026-10-20", "08:30", "linkedin", { story_id: "made-a" })];
  const r = materializeApproved({ assets, approvals, items, manual: ["newsletter", "website"], holds, pieces: [], stories: [], today: TODAY });
  assert.deepEqual(r.rows, []);
  const by = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
  assert.deepEqual(Object.keys(by).sort(), ["held-a-linkedin", "news-a-newsletter", "rough-a-linkedin"]);
  assert.match(by["held-a-linkedin"], /^held: publishing blocked until example_approver/);
  assert.equal(by["news-a-newsletter"], "newsletter is published by hand");
  assert.match(by["rough-a-linkedin"], /not final: Video is at stage rough/);
});

// ---- an approve-with-note holds only the platforms its note covers ---------------------------------------------

async function noteHold(storyId: string, part: "text" | "media", channels: string[], assets: string[]) {
  const { encodeFixNote, parseFixNote } = await import("../lib/approve-note");
  const { fixHold } = await import("../lib/auto-schedule");
  const parsed = parseFixNote(encodeFixNote({ part, channels, assets }, "Clean it up."))!;
  return fixHold({ ...parsed, id: "n1", storyId, createdAt: "2026-10-17T06:34:36Z" });
}

test("a fix note on the newsletter header does not hold the LinkedIn post (kb-tokenmaxxing)", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const sid = "kb-tokenmaxxing";
  const hold = await noteHold(sid, "media", ["newsletter"], [`${sid}-substack-header`, `${sid}-substack-header-v2-2`]);
  const assets: A[] = [
    { id: `${sid}-linkedin-copy`, story_id: sid, kind: "copy", sha256: H("f"), source: "kb/tokenmaxxing/story/linkedin.md", storage_path: null, body: "---\npillar: perspective\n---\nYour AI bill is an org chart." },
    { id: `${sid}-substack-header`, story_id: sid, kind: "image", sha256: H("1"), source: "hero.jpg", storage_path: `stories/${sid}/h.jpg`, body: null, stage: "final" },
  ];
  const approvals = ok(assets, { linkedin: [`${sid}-linkedin-copy`], newsletter: [`${sid}-substack-header`] });
  const r = materializeApproved({ assets, approvals, items: [], manual: ["newsletter", "website"], holds: [hold], pieces: [], stories: [], today: TODAY });
  assert.deepEqual(r.rows.map((x) => [x.id, x.format]), [[`${sid}-linkedin`, "text"]]);
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]), [[`${sid}-newsletter`, "newsletter is published by hand"]]);
  // And once it has a calendar item, the planner slots it too.
  const li = item(`${sid}-linkedin`, "2026-10-14", "08:30", "linkedin", { story_id: sid, format: "text" });
  assert.equal(planSlots({ items: [li], ready: [li], now: NOW, timeZone: TZ, seasons: SEASON, holds: [hold] }).slotted.length, 1);
});

test("a fix note on the LinkedIn text holds LinkedIn, and only LinkedIn", async () => {
  const sid = "s1-07-x";
  const hold = await noteHold(sid, "text", ["linkedin"], [`${sid}-linkedin`]);
  const li = item(`${sid}-linkedin`, "2026-10-14", "08:30", "linkedin");
  const ig = item(`${sid}-instagram`, "2026-10-14", "18:00", "instagram");
  const r = planSlots({ items: [li, ig], ready: [li, ig], now: NOW, timeZone: TZ, seasons: SEASON, holds: [hold] });
  assert.deepEqual(r.slotted.map((s) => s.id), [`${sid}-instagram`]);
  assert.deepEqual(r.skipped.map((s) => s.id), [`${sid}-linkedin`]);
  assert.match(r.skipped[0].reason, /^held: waiting for the fix \(linkedin\): John approved it with a note \(n1\)/);
  assert.equal(heldBy({ id: `${sid}-linkedin`, story_id: sid, channels: ["linkedin"] }, [hold]), hold);
});

test("a fix note on the shared text holds every platform that text goes to; whole-Story holds keep their scope", async () => {
  const sid = "s1-20-sample-piece-20";
  const hold = await noteHold(sid, "text", ["linkedin", "instagram", "youtube"], [`${sid}-linkedin`, `${sid}-instagram`, `${sid}-youtube`]);
  const items = ["linkedin", "instagram", "youtube"].map((ch) => item(`${sid}-${ch}`, "2026-10-14", channelTime(ch, "video"), ch, { format: "video" }));
  const r = planSlots({ items, ready: items, now: NOW, timeZone: TZ, seasons: SEASON, holds: [hold] });
  assert.deepEqual([r.slotted, r.skipped.map((s) => s.id).sort()], [[], items.map((i) => i.id).sort()]);
  // A withdrawn final (rework) and a third party's gate hold the whole Story, whatever the channel.
  const rework = { storyId: sid, who: "", note: "withdrawn", heldAt: null, kind: "rework" as const, finalStaged: true };
  const third = { storyId: sid, who: "example_approver", note: "", heldAt: null, kind: "third_party" as const, finalStaged: true };
  for (const h of [rework, third]) assert.equal(heldBy({ id: `${sid}-youtube`, story_id: sid, channels: ["youtube"] }, [h]), h);
});

// ---- F1: a Story with no planned date never posts the same day ------------------------------------------------

test("an undated Story's day is the earliest rhythm day for its pillar strictly after today, inside the season", async () => {
  const { nextSlotDay } = await import("../lib/auto-schedule");
  const next = (today: string, pillar: string, channels = ["linkedin"], seasonEnd?: string) => nextSlotDay(today, { pillar, channels, seasonEnd });
  // Perspective is Monday: from Saturday the 17th that is Monday the 19th; from Monday itself, never today, the next one.
  assert.deepEqual(["2026-10-17", "2026-10-19"].map((d) => next(d, "perspective")), ["2026-10-19", "2026-10-26"]);
  assert.deepEqual(["2026-10-17", "2026-10-20"].map((d) => next(d, "proof")), ["2026-10-20", "2026-10-27"]);
  assert.equal(next("2026-10-17", "lists", ["linkedin", "instagram"]), "2026-10-23", "Friday");
  // A pillar's day that a platform cannot post on (YouTube on Friday) goes to the fallback day all of them can.
  assert.equal(next("2026-10-17", "lists", ["linkedin", "youtube"]), "2026-10-19", "Monday, Lists' fallback");
  // Never after the season: the season ends Wednesday, so a Lists piece takes the earliest day inside it.
  assert.equal(next("2026-12-07", "lists", ["linkedin"], "2026-12-09"), "2026-12-08");
  // No pillar: the earliest day its platforms may post on, never Sunday, never LinkedIn on Saturday.
  assert.equal(nextSlotDay("2026-10-17", {}), "2026-10-19");
});

test("N1: an undated Story never takes a day another piece holds, even one placed by hand and not sent yet", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const sid = "kb-build-x";
  const assets: A[] = [{ id: `${sid}-linkedin`, story_id: sid, kind: "copy", sha256: H("c"), source: "kb/b/linkedin.md", storage_path: null, body: "---\npillar: build\n---\nA build note." }];
  // John placed the Maturity Model document on Wed 21 (drafted, not on Zernio): Wednesday is Build, but it is his.
  const doc = item("s1-01-sample-piece-01-document-linkedin", "2026-10-21", "08:30", "linkedin", { story_id: "s1-01-sample-piece-01-document", format: "document", pillar: "build" });
  const r = materializeApproved({ assets, approvals: ok(assets, { linkedin: [`${sid}-linkedin`] }), items: [doc], manual: [], holds: [], pieces: [], stories: [], today: "2026-10-17", seasonEnd: "2026-12-11" });
  assert.deepEqual(r.rows.map((x) => x.date), ["2026-10-28"], "the next Wednesday, not the 21st");
  // A killed row does not hold its day.
  const killed = { ...doc, status: "skipped" as const };
  assert.deepEqual(materializeApproved({ assets, approvals: ok(assets, { linkedin: [`${sid}-linkedin`] }), items: [killed], manual: [], holds: [], pieces: [], stories: [], today: "2026-10-17" }).rows.map((x) => x.date), ["2026-10-21"]);
});

test("approved on a Saturday before the guide time (04:00 Berlin): the new item goes to its rhythm day, never that Saturday", async () => {
  const { materializeApproved } = await import("../lib/auto-schedule");
  const { rowToItem } = await import("../lib/calendar-db");
  const now = new Date("2026-10-17T02:00:00Z"); // Saturday 04:00 Berlin, before LinkedIn's 08:30 and Instagram's 18:00
  const sid = "kb-x";
  const assets: A[] = [
    { id: `${sid}-linkedin`, story_id: sid, kind: "copy", sha256: H("7"), source: "kb/x/linkedin.md", storage_path: null, body: "---\npillar: perspective\n---\nA text post." },
    { id: `${sid}-instagram`, story_id: sid, kind: "copy", sha256: H("8"), source: "kb/x/instagram.md", storage_path: null, body: "---\npillar: perspective\n---\nA caption." },
    { id: `${sid}-video`, story_id: sid, kind: "video", sha256: H("9"), source: "v.mp4", storage_path: `stories/${sid}/v.mp4`, body: null, stage: "final" },
  ];
  const r = materializeApproved({ assets, approvals: ok(assets, { linkedin: [`${sid}-linkedin`], instagram: [`${sid}-instagram`, `${sid}-video`] }), items: [], manual: [], holds: [], pieces: [], stories: [], today: "2026-10-17" });
  // Perspective: Monday the 19th, both platforms the same day.
  assert.deepEqual(r.rows.map((x) => x.date), ["2026-10-19", "2026-10-19"]);
  const items = r.rows.map(rowToItem);
  const plan = planSlots({ items, ready: items, now, timeZone: TZ, seasons: SEASON });
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.slotted.map((s) => [s.id, s.date, s.time]), [[`${sid}-linkedin`, "2026-10-19", "08:30"], [`${sid}-instagram`, "2026-10-19", "18:00"]]);
});

// ---- F3: a post over its platform's length limit is never sent ------------------------------------------------

test("length limits: LinkedIn 4,000 (UTF-16, as LinkedIn counts), Instagram 2,200, YouTube 5,000 and a 100-character title", async () => {
  const { checkChannelLength, checkChannelLinks } = await import("../lib/channel-rules");
  const copy = (base: string, meta: Record<string, string> = {}) => ({ base, perChannel: {}, meta });
  assert.deepEqual(checkChannelLength("x", ["linkedin", "instagram", "youtube"], copy("a".repeat(2200))), []);
  // kb-quiet-resistance (3,301) fits; LinkedIn's own refusals were at 4,022 and 4,323.
  assert.deepEqual(checkChannelLength("x", ["linkedin"], copy("a".repeat(3301))), []);
  assert.deepEqual(checkChannelLength("x", ["linkedin"], copy("a".repeat(4000))), []);
  assert.deepEqual(checkChannelLength("x", ["linkedin"], copy("a".repeat(4323))), ["x: too long: the LinkedIn post is 4,323 characters; LinkedIn takes at most 4,000. Shorten it and restage."]);
  // LinkedIn counts UTF-16 units: an emoji is two there, one on the platforms that count code points.
  assert.equal(checkChannelLength("x", ["linkedin"], copy("😀".repeat(2000))).length, 0);
  assert.match(checkChannelLength("x", ["linkedin"], copy("😀".repeat(2001)))[0], /LinkedIn post is 4,002 characters/);
  assert.equal(checkChannelLength("x", ["instagram"], copy("😀".repeat(2200))).length, 0);
  // Reserved characters count once (LinkedIn's 4,323 for sample-extra-45 is the plain length of a text with 15 of them).
  assert.equal(checkChannelLength("x", ["linkedin"], copy("(a)".repeat(1333))).length, 0);
  assert.match(checkChannelLength("x", ["instagram"], copy("a".repeat(2201)))[0], /Instagram caption is 2,201 characters; Instagram takes at most 2,200/);
  assert.match(checkChannelLength("x", ["youtube"], copy("a".repeat(5001)))[0], /YouTube description is 5,001 characters; YouTube takes at most 5,000/);
  assert.match(checkChannelLength("x", ["youtube"], copy("ok", { youtube_title: "t".repeat(101) }))[0], /YouTube title is 101 characters; YouTube takes at most 100/);
  assert.deepEqual(checkChannelLength("x", ["newsletter"], copy("a".repeat(10_000))), [], "hand-published channels have no limit here");
  // The same rule is in the hard rules the send (buildPost) and `gtm check` already enforce.
  assert.ok(checkChannelLinks("x", ["linkedin"], copy("a".repeat(4001))).errors.some((e) => /too long/.test(e)));
});

test("an approved post over the limit is skipped with the channel and the count, not scheduled", async () => {
  const { tooLong } = await import("../lib/auto-schedule");
  const body = `---\npillar: proof\n---\n${"word ".repeat(820)}`.trimEnd();
  const li = item("kb-quiet-resistance-linkedin", "2026-11-03", "08:30", "linkedin", { story_id: "kb-quiet-resistance", copy: "kb/qr/linkedin.md", format: "text" });
  const reason = tooLong(li, [{ kind: "copy", source: "kb/qr/linkedin.md", body }]);
  assert.equal(reason, "too long: the LinkedIn post is 4,099 characters; LinkedIn takes at most 4,000. Shorten it and restage.");
  assert.equal(tooLong(li, [{ kind: "copy", source: "kb/qr/linkedin.md", body: "---\npillar: proof\n---\nShort." }]), null);
  // The bound Story copy is what gets sent, so it is what is measured (not a stale row body).
  assert.equal(tooLong({ ...li, body: "short" }, [{ kind: "copy", source: "kb/qr/linkedin.md", body }])?.startsWith("too long:"), true);
});
