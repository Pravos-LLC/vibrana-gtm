// Story review and scheduling, shared by the cockpit page and the `gtm story` CLI so everything the
// UI can do can also be done, and proved, from a terminal.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { calendarPath, loadCalendar, updateItem, type Calendar, type Item } from "./calendar";
import { calendarFromDb, loadCalendarDb, updateItemDb } from "./calendar-db";
import { must } from "./db";
import { sendCalendarItem } from "./publish-item";
import { suggestSlot, type Slot } from "./slots";
import { assertNoAgentNotes } from "./copy-guard";
import { syncStoryCopy, type StoryAsset, type StoryChannel } from "./story";
import { nonFinal } from "./stage";
import { isFinalStage } from "./stage";
import { allHandPublished } from "./hand-published";
import { withoutAlternatives } from "./newsletter-card";

/**
 * A client signed in as the cockpit owner. The review RPC checks `auth.uid()` and the owner claim, so it
 * needs a real owner session; this mints one for the existing owner user through the admin API. Only call
 * it for an action John has asked for or taken himself: it records the approval under his user id.
 */
export async function ownerClient(admin: SupabaseClient): Promise<SupabaseClient> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`list users: ${error.message}`);
  const owners = data.users.filter((u) => (u.app_metadata as { gtm_owner?: boolean })?.gtm_owner === true && u.email);
  if (owners.length !== 1) throw new Error(`expected exactly one gtm_owner user, found ${owners.length}`);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: owners[0].email! });
  if (link.error || !link.data.properties?.hashed_token) throw new Error(`owner session: ${link.error?.message ?? "no token"}`);
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error) throw new Error(`owner session: ${verified.error.message}`);
  return client;
}

export type StoryState = {
  assets: Array<{ id: string; kind: string; title: string; revision: number; stage: string | null; channels: Array<{ channel: string; status: string; current: boolean; note: string }> }>;
  /** Every channel approved at the current bytes AND every asset final: a rough-cut approval never counts. */
  allApproved: boolean;
};

export async function storyState(db: SupabaseClient, storyId: string): Promise<StoryState> {
  const assets = must(await db.from("gtm_story_assets").select("*").eq("story_id", storyId).order("title"), "story assets") as StoryAsset[];
  const rows = assets.length ? must(await db.from("gtm_story_asset_channels").select("*").in("asset_id", assets.map((a) => a.id)), "story approvals") as StoryChannel[] : [];
  const state = assets.map((a) => ({
    id: a.id, kind: a.kind, title: a.title, revision: a.revision, stage: a.stage ?? null,
    channels: rows.filter((r) => r.asset_id === a.id).map((r) => ({ channel: r.channel, status: r.status, current: r.status !== "approved" || r.approved_sha256 === a.sha256, note: r.note })),
  }));
  const final = assets.every((a) => isFinalStage(a.stage));
  // A published Substack essay is live and an unused header option is never decided: neither holds the rest of the piece back.
  const deciding = withoutAlternatives(assets, rows);
  return { assets: state, allApproved: final && deciding.length > 0 && deciding.every((r) => r.status === "approved" && state.every((s) => s.channels.every((c) => c.current))) };
}

/** Approves every pending asset/channel pair (or just `only`) for the bytes currently staged. */
export async function approveStory(admin: SupabaseClient, storyId: string, opts: { only?: string; note?: string } = {}) {
  const copies = must(await admin.from("gtm_story_assets").select("id,body").eq("story_id", storyId).eq("kind", "copy"), "story copy") as { id: string; body: string | null }[];
  for (const c of copies) if (!opts.only || c.id === opts.only) assertNoAgentNotes(c.id, c.body);
  const owner = await ownerClient(admin);
  const assets = must(await owner.from("gtm_story_assets").select("id,sha256,revision").eq("story_id", storyId), "story assets") as Pick<StoryAsset, "id" | "sha256" | "revision">[];
  const rows = must(await owner.from("gtm_story_asset_channels").select("asset_id,channel,status").in("asset_id", assets.map((a) => a.id)), "story approvals") as Pick<StoryChannel, "asset_id" | "channel" | "status">[];
  const approved: string[] = [];
  for (const asset of assets) {
    if (opts.only && asset.id !== opts.only) continue;
    for (const row of rows.filter((r) => r.asset_id === asset.id && r.status !== "approved")) {
      const { error } = await owner.rpc("gtm_decide_story_asset", {
        p_asset_id: asset.id, p_channel: row.channel, p_status: "approved", p_note: opts.note ?? "",
        p_expected_sha256: asset.sha256, p_expected_revision: asset.revision,
      });
      if (error) throw new Error(`${asset.id}/${row.channel}: ${error.message}`);
      approved.push(`${asset.id}:${row.channel}`);
    }
  }
  return approved;
}

/** Limits match the database check on gtm_stories (gtm_set_story_hold). */
export const HOLD_WHO_MAX = 200;
export const HOLD_NOTE_MAX = 2000;

/**
 * Pending third-party approval, from the CLI (service role): `hold` puts the Story on hold with an optional who and
 * note (a held Story is never auto-scheduled, even when approved); `null` releases it ("Third party approved"). For a
 * Story that names a third party, releasing is their sign-off on the final: it is refused until every platform's media
 * is final, and it is logged against the final's bytes, so a new final needs their sign-off again. The cockpit goes
 * through the owner-checked gtm_set_story_hold, which applies the same rules. Throws when the Story does not exist.
 */
export async function setStoryHold(admin: SupabaseClient, storyId: string, hold: { who?: string; note?: string } | null, release: { note?: string } = {}) {
  const who = (hold?.who ?? "").trim(), note = (hold?.note ?? release.note ?? "").trim();
  if (who.length > HOLD_WHO_MAX) throw new Error(`--who is limited to ${HOLD_WHO_MAX} characters`);
  if (note.length > HOLD_NOTE_MAX) throw new Error(`--note is limited to ${HOLD_NOTE_MAX} characters`);
  const now = new Date().toISOString();
  const current = must(await admin.from("gtm_stories").select("id,held_at,hold_who,third_party_who").eq("id", storyId).maybeSingle(), "story") as { id: string; held_at: string | null; hold_who: string | null; third_party_who: string | null } | null;
  if (!current) throw new Error(`no Story ${storyId}`);
  if (!hold && current.third_party_who) {
    const assets = must(await admin.from("gtm_story_assets").select("id,title,kind,sha256,revision,stage").eq("story_id", storyId).in("kind", ["video", "image"]), "story media") as Array<{ id: string; title: string; kind: string; sha256: string; revision: number; stage: string | null }>;
    const bound = assets.length ? new Set((must(await admin.from("gtm_story_asset_channels").select("asset_id").in("asset_id", assets.map((a) => a.id)), "channels") as { asset_id: string }[]).map((r) => r.asset_id)) : new Set<string>();
    const media = assets.filter((a) => bound.has(a.id)).sort((a, b) => a.id.localeCompare(b.id));
    const early = nonFinal(media);
    if (early.length) throw new Error(`${current.third_party_who} sees the final only, and ${early.map((a) => `${a.title} is at stage ${a.stage}`).join(", ")}. Stage the final first.`);
    must(await admin.from("gtm_story_stage_decisions").insert({
      story_id: storyId, stage: "final", party: "third_party", who: current.hold_who?.trim() || current.third_party_who, decision: "approved",
      note: note || "recorded from the gtm CLI", assets: media.map((a) => ({ asset_id: a.id, sha256: a.sha256, revision: a.revision })),
    }), "third-party decision");
  }
  const update = hold
    ? { held_at: current.held_at ?? now, held_by: null, hold_who: who, hold_note: note, updated_at: now }
    : { held_at: null, held_by: null, hold_who: null, hold_note: "", updated_at: now };
  must(await admin.from("gtm_stories").update(update).eq("id", storyId), `hold ${storyId}`);
}

/**
 * Removes one asset from a Story, and only it: its platform rows, versions and notes go with it (database cascade);
 * every other asset and approval is untouched. For production assets that were staged into /content by mistake (a
 * storyboard on a "plan" channel). Refused when a calendar item posts it or a platform approved it.
 */
export async function removeStoryAsset(admin: SupabaseClient, assetId: string, opts: { dryRun?: boolean } = {}) {
  const asset = must(await admin.from("gtm_story_assets").select("id,story_id,kind,title").eq("id", assetId).maybeSingle(), "asset") as { id: string; story_id: string; kind: string; title: string } | null;
  if (!asset) throw new Error(`no Story asset ${assetId}`);
  const rows = must(await admin.from("gtm_story_asset_channels").select("channel,status").eq("asset_id", assetId), "channels") as { channel: string; status: string }[];
  const approved = rows.filter((r) => r.status === "approved" && r.channel !== "plan");
  if (approved.length) throw new Error(`${assetId} is approved for ${approved.map((r) => r.channel).join(", ")}; it is a post, not a production asset`);
  const items = must(await admin.from("gtm_content_items").select("id").contains("story_assets", [assetId]), "calendar items") as { id: string }[];
  if (items.length) throw new Error(`${assetId} is posted by ${items.map((i) => i.id).join(", ")}; unbind it there first`);
  if (!opts.dryRun) must(await admin.from("gtm_story_assets").delete().eq("id", assetId), `remove ${assetId}`);
  return { removed: assetId, story: asset.story_id, title: asset.title, channels: rows.map((r) => r.channel), dryRun: !!opts.dryRun };
}

/**
 * Takes a Story off one platform (John: "keep it on LinkedIn only"): deletes that platform's rows on every asset of the
 * Story, and any asset left bound to no platform at all (that platform's own caption) goes with them, its versions and
 * notes included (database cascade), so resolve its notes first. Every other platform's rows and approvals are untouched.
 * Refused when the platform already approved an asset, or a calendar item posts the Story there (unschedule it first).
 */
export async function dropStoryChannel(admin: SupabaseClient, storyId: string, channel: string, opts: { dryRun?: boolean } = {}) {
  const assets = must(await admin.from("gtm_story_assets").select("id,title").eq("story_id", storyId), "story assets") as { id: string; title: string }[];
  if (!assets.length) throw new Error(`no Story ${storyId}`);
  const rows = must(await admin.from("gtm_story_asset_channels").select("asset_id,channel,status").in("asset_id", assets.map((a) => a.id)), "channels") as { asset_id: string; channel: string; status: string }[];
  const on = rows.filter((r) => r.channel === channel);
  if (!on.length) throw new Error(`${storyId} has nothing on ${channel}`);
  const approved = on.filter((r) => r.status === "approved");
  if (approved.length) throw new Error(`${approved.map((r) => r.asset_id).join(", ")} ${approved.length === 1 ? "is" : "are"} approved for ${channel}; that is John's decision to undo in /content, not a cleanup`);
  const items = must(await admin.from("gtm_content_items").select("id,channels").eq("story_id", storyId), "calendar items") as { id: string; channels: string[] }[];
  const posting = items.filter((i) => (i.channels ?? []).includes(channel));
  if (posting.length) throw new Error(`${posting.map((i) => i.id).join(", ")} posts ${storyId} on ${channel}; unschedule and remove ${posting.length === 1 ? "it" : "them"} first`);
  const orphans = assets.filter((a) => rows.some((r) => r.asset_id === a.id) && rows.filter((r) => r.asset_id === a.id).every((r) => r.channel === channel));
  if (!opts.dryRun) {
    must(await admin.from("gtm_story_asset_channels").delete().in("asset_id", on.map((r) => r.asset_id)).eq("channel", channel), `drop ${channel}`);
    if (orphans.length) must(await admin.from("gtm_story_assets").delete().in("id", orphans.map((a) => a.id)), "remove assets left on no platform");
  }
  return { story: storyId, channel, rows: on.map((r) => r.asset_id), removedAssets: orphans.map((a) => a.id), dryRun: !!opts.dryRun };
}

export type SlotMap = Record<string, Slot>;

export function defaultSlots(cal: Calendar, storyId: string, now = new Date()): SlotMap {
  return Object.fromEntries(cal.items.filter((i) => i.story_id === storyId).map((i) => [i.id, suggestSlot(i.channels[0], now, cal.timezone)]));
}

/** Schedules every unscheduled calendar item bound to a fully approved Story. Returns one proof line per item. */
export async function scheduleStoryItems(admin: SupabaseClient, storyId: string, slots: SlotMap, opts: { dryRun?: boolean } = {}) {
  const state = await storyState(admin, storyId);
  if (!state.allApproved) throw new Error("Approve every asset for every channel first (a current approval for the staged bytes).");
  return calendarFromDb() ? scheduleDbItems(admin, storyId, slots, opts) : scheduleFileItems(admin, storyId, slots, opts);
}

function checkSlot(item: Item, slot: Slot | undefined): Slot {
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || !/^\d{2}:\d{2}$/.test(slot.time)) throw new Error(`${item.id}: choose a date and time`);
  return slot;
}

/**
 * Database calendar (the default): the slot and the approval go on the gtm_content_items row, and
 * sendCalendarItem publishes from the approved Story snapshot in storage, so this works from Vercel.
 * A dry run never writes: it checks the payload against an in-memory copy of the row.
 */
async function scheduleDbItems(admin: SupabaseClient, storyId: string, slots: SlotMap, opts: { dryRun?: boolean }) {
  // A shared piece's rows belong to its delivery ledger (the database refuses a slot or status write to them).
  const shared = await admin.from("gtm_piece_reviews").select("story_id").eq("story_id", storyId).maybeSingle();
  if (shared.error) throw new Error(`shared review check: ${shared.error.message}`);
  if (shared.data) throw new Error(`${storyId} uses shared review: it schedules from its card in /content (gtm piece status ${storyId}).`);
  const cal = await loadCalendarDb(admin);
  const items = cal.items.filter((i) => i.story_id === storyId && (i.status === "drafted" || i.status === "approved") && !allHandPublished(i.channels));
  if (!items.length) throw new Error("No unscheduled calendar items are bound to this Story.");
  const lines: string[] = [];
  // On the owner's machine, keep the local copy files in step with cockpit edits (publishing itself reads the snapshot).
  if (!opts.dryRun && existsSync(calendarPath())) {
    const written = await syncStoryCopy(admin, loadCalendar(), storyId);
    if (written.length) lines.push(`synced ${written.length} edited caption(s) to the calendar files`);
  }
  for (const item of items) {
    const slot = checkSlot(item, slots[item.id]);
    if (opts.dryRun) {
      const preview: Calendar = { ...cal, items: cal.items.map((i) => (i.id === item.id ? { ...i, date: slot.date, time: slot.time, status: "approved" as const } : i)) };
      await sendCalendarItem(preview, item.id, { mode: "schedule", db: admin, dry: true });
      lines.push(`${item.id}: dry run ok for ${slot.date} ${slot.time} ${cal.timezone}`);
      continue;
    }
    const prior = { date: item.date, time: item.time ?? null, status: item.status };
    await updateItemDb(admin, item.id, { date: slot.date, time: slot.time, status: "approved" });
    try {
      const result = await sendCalendarItem(await loadCalendarDb(admin), item.id, { mode: "schedule", db: admin });
      if (!("dryRun" in result)) lines.push(`${item.id}: scheduled ${result.scheduledFor} ${cal.timezone}, Zernio post ${result.zernioPostId} (${result.zernioStatus})`);
    } catch (error) {
      // Only roll back the slot if Zernio never got the post (sendCalendarItem leaves a real id or "pending" otherwise).
      const now = (await loadCalendarDb(admin)).items.find((i) => i.id === item.id);
      if (!now?.zernio_post_id) await updateItemDb(admin, item.id, prior);
      throw error;
    }
  }
  return lines;
}

/** Legacy file calendar (GTM_CALENDAR_SOURCE=file): the slot is written to calendar.yaml. */
async function scheduleFileItems(admin: SupabaseClient, storyId: string, slots: SlotMap, opts: { dryRun?: boolean }) {
  const cal = loadCalendar();
  const items = cal.items.filter((i) => i.story_id === storyId && (i.status === "drafted" || i.status === "approved") && !allHandPublished(i.channels));
  if (!items.length) throw new Error("No unscheduled calendar items are bound to this Story.");
  const lines: string[] = [];
  const written = await syncStoryCopy(admin, cal, storyId);
  if (written.length) lines.push(`synced ${written.length} edited caption(s) to the calendar files`);
  for (const item of items) {
    const slot = checkSlot(item, slots[item.id]);
    const prior: Partial<Item> = { date: item.date, time: item.time, status: item.status };
    updateItem(cal.path, item.id, { date: slot.date, time: slot.time, status: "approved" });
    try {
      const result = await sendCalendarItem(loadCalendar(), item.id, { mode: "schedule", db: admin, dry: opts.dryRun });
      if ("dryRun" in result) lines.push(`${item.id}: dry run ok for ${slot.date} ${slot.time} ${cal.timezone}`);
      else lines.push(`${item.id}: scheduled ${result.scheduledFor} ${cal.timezone}, Zernio post ${result.zernioPostId} (${result.zernioStatus})`);
    } catch (error) {
      updateItem(cal.path, item.id, prior);
      throw error;
    } finally {
      if (opts.dryRun) updateItem(cal.path, item.id, prior);
    }
  }
  return lines;
}
