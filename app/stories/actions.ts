"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { sessionDb } from "@/lib/supabase/server";
import { HOLD_NOTE_MAX, HOLD_WHO_MAX, scheduleStoryItems } from "@/lib/story-ops";
import { scheduleApproved } from "@/lib/schedule-approved";
import { findAgentNotes } from "@/lib/copy-guard";
import { killPiece as killStoryPiece } from "@/lib/kill-piece";
import { channelText, checkLinkedinLength } from "@/lib/channel-rules";
import { parseCopy } from "@/lib/calendar";
import { unpublished } from "@/lib/newsletter-card";
import { markEssayPublished } from "@/lib/mark-published";
import { nonFinal } from "@/lib/stage";
import { EDITABLE_FIELDS, REVIEW_CHANNELS, hasBannedDash, writeCopy, type EditableField } from "@/lib/season";
import { allHandPublished, isHandPublished } from "@/lib/hand-published";
import type { StoryChannel } from "@/lib/story";
import type { StoryHold } from "@/lib/season-review";
import { PIPELINES, isFormat, type Format } from "@/lib/pipelines";
import { encodeFixNote, encodeFormatsNote, FIX_NOTE_MAX } from "@/lib/approve-note";

type Decision = StoryChannel["status"];
type Result = { ok: true } | { ok: false; error: string };

/** Browser decisions always use the owner's session and database RLS. */
export async function decideStoryAsset(input: { assetId: string; channel: string; status: Decision; note: string; expectedSha256: string; expectedRevision: number }): Promise<Result> {
  const result = await decideOne(input);
  if (result.ok && input.status === "approved") scheduleApproved(result.storyId);
  return result.ok ? { ok: true } : result;
}

async function decideOne(input: { assetId: string; channel: string; status: Decision; note: string; expectedSha256: string; expectedRevision: number }): Promise<{ ok: true; storyId: string } | { ok: false; error: string }> {
  if (!["pending", "approved", "rejected"].includes(input.status)) return { ok: false, error: "Invalid decision." };
  const note = input.note.trim();
  if (input.status === "rejected" && !note) return { ok: false, error: "Add a note explaining what needs to change." };
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) {
    return { ok: false, error: "Not signed in as the cockpit owner." };
  }
  const { data: asset, error: lookupError } = await db.from("gtm_story_assets").select("story_id").eq("id", input.assetId).maybeSingle();
  if (lookupError || !asset) return { ok: false, error: "Story asset not found." };
  const { error } = await db.rpc("gtm_decide_story_asset", {
    p_asset_id: input.assetId, p_channel: input.channel, p_status: input.status,
    p_note: input.status === "pending" ? "" : note, p_expected_sha256: input.expectedSha256,
    p_expected_revision: input.expectedRevision,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/stories/${asset.story_id}`);
  revalidatePath("/stories");
  return { ok: true, storyId: asset.story_id };
}

/** One decision for a shared file: every channel that uses it moves together. */
export async function decideStoryChannels(input: { assetId: string; channels: string[]; status: Decision; note: string; expectedSha256: string; expectedRevision: number }): Promise<Result> {
  const result = await decideChannels(input);
  if (result.ok && result.storyId && input.status === "approved") scheduleApproved(result.storyId);
  return result.ok ? { ok: true } : result;
}

async function decideChannels(input: { assetId: string; channels: string[]; status: Decision; note: string; expectedSha256: string; expectedRevision: number }): Promise<{ ok: true; storyId?: string } | { ok: false; error: string }> {
  if (!input.channels.length) return { ok: false, error: "This file is not assigned to a channel." };
  let storyId: string | undefined;
  for (const channel of input.channels) {
    const one = await decideOne({ ...input, channel });
    if (!one.ok) return one;
    storyId = one.storyId;
  }
  return { ok: true, storyId };
}

/** Saves caption prose and returns the new digest. Editing clears approval. */
export async function saveStoryCopy(input: { assetId: string; prose: string; frontmatter: string; expectedRevision: number }): Promise<{ ok: true; sha256: string; revision: number } | { ok: false; error: string }> {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) {
    return { ok: false, error: "Not signed in as the cockpit owner." };
  }
  const prose = input.prose.trim();
  if (!prose) return { ok: false, error: "The caption is empty." };
  const body = input.frontmatter.trim() ? `---\n${input.frontmatter.trim()}\n---\n\n${prose}\n` : `${prose}\n`;
  const sha256 = createHash("sha256").update(body).digest("hex");
  const db = adminDb();
  const { data: current } = await db.from("gtm_story_assets").select("metadata, source").eq("id", input.assetId).maybeSingle();
  // The trigger bumps the revision and resets every channel approval when the body changes.
  // edited_in_dashboard stops `gtm story stage` from silently overwriting this text with the local file.
  const { data, error } = await db.from("gtm_story_assets")
    .update({ body, sha256, metadata: { ...unpublished((current?.metadata as Record<string, unknown>) ?? {}), edited_in_dashboard: new Date().toISOString() } })
    .eq("id", input.assetId)
    .eq("kind", "copy")
    .eq("revision", input.expectedRevision)
    .select("story_id, sha256, revision, source")
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "This caption changed. Refresh and edit the latest version." };
  // Calendar items that post this copy carry the same text; their approval resets via the DB trigger.
  const { error: itemError } = await db.from("gtm_content_items")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("story_id", data.story_id)
    .eq("copy_path", data.source)
    .contains("story_assets", [input.assetId]);
  if (itemError) return { ok: false, error: `Saved the Story copy, but the calendar item did not update: ${itemError.message}` };
  revalidatePath(`/stories/${data.story_id}`);
  revalidatePath("/calendar");
  return { ok: true, sha256: data.sha256, revision: data.revision };
}

/** Marks every video and cover on a story approved in one step. Captions stay as they are. */
export async function approveAllMedia(storyId: string): Promise<Result> {
  // Owner only, checked here: RLS would empty the reads, but the schedule pass below runs with the service client.
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const { data: assets, error } = await db.from("gtm_story_assets").select("id, sha256, revision, kind, stage").eq("story_id", storyId).in("kind", ["video", "image"]);
  if (error || !assets) return { ok: false, error: error?.message ?? "Could not load media." };
  const ids = assets.map((asset) => asset.id);
  const { data: channels, error: channelError } = ids.length
    ? await db.from("gtm_story_asset_channels").select("asset_id, channel, status").in("asset_id", ids)
    : { data: [], error: null };
  if (channelError) return { ok: false, error: channelError.message };
  // Only final media is approved per platform; a rough cut or a plan is approved as a stage in /content.
  for (const asset of assets.filter((a) => !nonFinal([a]).length)) {
    const rows = (channels ?? []).filter((row) => row.asset_id === asset.id && row.status !== "approved");
    if (!rows.length) continue;
    const result = await decideChannels({
      assetId: asset.id, channels: rows.map((row) => row.channel), status: "approved", note: "",
      expectedSha256: asset.sha256, expectedRevision: asset.revision,
    });
    if (!result.ok) return result;
  }
  revalidatePath(`/stories/${storyId}`);
  scheduleApproved(storyId); // auto-schedule only ever takes final media
  return { ok: true };
}

/** Schedules every calendar item bound to a fully approved Story at the owner's chosen times. */
export async function scheduleStory(storyId: string, slots: Record<string, { date: string; time: string }>): Promise<{ ok: true; summary: string[] } | { ok: false; error: string; summary: string[] }> {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) return { ok: false, error: "Not signed in as the cockpit owner.", summary: [] };
  try {
    const summary = await scheduleStoryItems(adminDb(), storyId, slots);
    revalidatePath(`/stories/${storyId}`);
    revalidatePath("/calendar");
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Zernio did not accept the post.", summary: [] };
  }
}

async function requireOwner() {
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  const owner = (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  return { db, owner };
}

/** Season screen: saves a caption and its editable frontmatter fields (first comment, YouTube title) together. */
export async function saveSeasonCopy(input: { assetId: string; prose: string; fields: Partial<Record<EditableField, string>>; expectedRevision: number; overwrite?: boolean }): Promise<{ ok: true; sha256: string; revision: number } | { ok: false; error: string; conflict?: { revision: number } }> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  if (!input.prose.trim()) return { ok: false, error: "The text is empty." };
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([key]) => (EDITABLE_FIELDS as readonly string[]).includes(key))) as Partial<Record<EditableField, string>>;
  if (hasBannedDash(input.prose) || Object.values(fields).some((value) => hasBannedDash(value ?? ""))) {
    return { ok: false, error: "No em dashes or en dashes in John's copy. Replace them and save again." };
  }
  const { data: current } = await db.from("gtm_story_assets").select("body,revision,kind,metadata").eq("id", input.assetId).maybeSingle();
  if (!current || current.kind !== "copy" || current.body === null) return { ok: false, error: "Caption not found." };
  // An agent restaged this text while John was editing (John, 2026-10-13: "I can't approve the text"). His edit is never
  // dropped: the screen offers "Save mine over it", which saves against the revision on the server now.
  if (current.revision !== input.expectedRevision && !input.overwrite) {
    return { ok: false, error: `An agent updated this text while you were editing (now v${current.revision}). Your edit is still here.`, conflict: { revision: current.revision } };
  }
  const revision = current.revision as number;
  let body: string;
  try { body = writeCopy(current.body, input.prose, fields); } catch (e) { return { ok: false, error: `Not saved: ${e instanceof Error ? e.message : String(e)}. Your edit is still here.` }; }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const admin = adminDb();
  // edited_in_dashboard stops `gtm story stage` from silently overwriting this text with the local file.
  const { data, error } = await admin.from("gtm_story_assets")
    .update({ body, sha256, metadata: { ...unpublished((current.metadata as Record<string, unknown>) ?? {}), edited_in_dashboard: new Date().toISOString() } })
    .eq("id", input.assetId).eq("kind", "copy").eq("revision", revision)
    .select("story_id, sha256, revision, source").maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "This text changed again as you saved. Try once more." };
  // Calendar items that post this copy carry the same text; their approval resets via the DB trigger.
  const { error: itemError } = await admin.from("gtm_content_items")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("story_id", data.story_id)
    .eq("copy_path", data.source)
    .contains("story_assets", [input.assetId]);
  if (itemError) return { ok: false, error: `Saved the text, but the calendar item did not update: ${itemError.message}` };
  // Nothing is revalidated: the screen commits the result in the browser, and ANY revalidatePath in an action makes Next
  // re-render the page the click came from (/content, the whole board) before answering, which is what made Save and
  // Approve take many seconds. /calendar and /stories/<id> are force-dynamic, so they read fresh when opened.
  return { ok: true, sha256: data.sha256, revision: data.revision };
}

type PartAsset = {
  id: string; sha256: string; revision: number; kind: string; body: string | null; stage: string | null;
  /** The platforms this file is posted on, when a decision spans files that differ (a video's 4:5 and 9:16 formats). */
  channels?: string[];
};
type Db = Awaited<ReturnType<typeof sessionDb>>;

/**
 * The assets of one card's text or asset part, with the rows that assign them to the channel. `assetId` narrows it to one
 * file: a Story can carry two newsletter essays, each decided on its own card.
 */
async function partAssets(db: Db, storyId: string, channel: string, part: "text" | "asset", assetId?: string): Promise<{ ok: true; assets: PartAsset[] } | { ok: false; error: string }> {
  if (!(REVIEW_CHANNELS as string[]).includes(channel)) return { ok: false, error: "Unknown platform." };
  const { data: assets, error } = await db.from("gtm_story_assets").select("id, sha256, revision, kind, body, stage").eq("story_id", storyId);
  if (error || !assets) return { ok: false, error: error?.message ?? "Could not load the piece." };
  const wanted = (assets as PartAsset[]).filter((a) => (part === "text" ? a.kind === "copy" : a.kind === "video" || a.kind === "image") && (!assetId || a.id === assetId));
  const { data: rows } = wanted.length ? await db.from("gtm_story_asset_channels").select("asset_id").eq("channel", channel).in("asset_id", wanted.map((a) => a.id)) : { data: [] };
  const mine = wanted.filter((a) => (rows ?? []).some((r: { asset_id: string }) => r.asset_id === a.id));
  return mine.length ? { ok: true, assets: mine } : { ok: false, error: "Nothing to review here." };
}

/** One review decision straight to the database function (no per-row lookups), all rows at once. */
async function decideRows(db: Db, assets: PartAsset[], channel: string, status: Decision, note: string): Promise<Result> {
  // A file only has rows for its own platforms: the 4:5 cut is decided for LinkedIn, the 9:16 cuts for Instagram and YouTube.
  const results = await Promise.all(assets.filter((a) => !a.channels || a.channels.includes(channel)).map((a) => db.rpc("gtm_decide_story_asset", {
    p_asset_id: a.id, p_channel: channel, p_status: status, p_note: status === "pending" ? "" : note,
    p_expected_sha256: a.sha256, p_expected_revision: a.revision,
  })));
  const failed = results.find((r) => r.error);
  return failed?.error ? { ok: false, error: failed.error.message } : { ok: true };
}

/** Approve (or take back) one part of one platform card. No revalidation (see saveSeasonCopy) and no scheduling: callers do that once. */
async function decidePart(db: Db, storyId: string, channel: string, part: "text" | "asset", approve: boolean, assetId?: string): Promise<{ ok: true; final: boolean } | { ok: false; error: string }> {
  const found = await partAssets(db, storyId, channel, part, assetId);
  if (!found.ok) return found;
  if (approve) {
    for (const a of found.assets) {
      const notes = a.kind === "copy" ? findAgentNotes(a.body ?? "") : [];
      if (notes.length) return { ok: false, error: `This text still has a note to John in it (${notes[0].slice(0, 60)}). Fill it in and save, then approve.` };
      // LinkedIn refuses more than 4,000 characters; catch it here, not as a failed post on the day.
      if (a.kind === "copy" && channel === "linkedin" && a.body) {
        const length = checkLinkedinLength("text", channelText(parseCopy(a.body), "linkedin"));
        if (length.errors.length) return { ok: false, error: length.errors[0].replace(/^text: too long: the/, "Too long: the") };
      }
    }
  }
  const result = await decideRows(db, found.assets, channel, approve ? "approved" : "pending", "");
  return result.ok ? { ok: true, final: !nonFinal(found.assets).length } : result;
}

/** Season screen: approve (or take back) the text or the asset of one platform card. They are decided separately. */
export async function setPartApproval(input: { storyId: string; channel: string; part: "text" | "asset"; approve: boolean; assetId?: string }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const result = await decidePart(db, input.storyId, input.channel, input.part, input.approve, input.assetId);
  if (!result.ok) return result;
  // Approval schedules: no second approval (John, 2026-10-11). Approving a rough cut means "the edit is good" and
  // schedules nothing (auto-schedule would refuse it anyway: a channel is ready only when its media is final). A newsletter
  // is published by hand: its approval starts no schedule pass (and auto-schedule never takes it either).
  if (input.approve && result.final && !isHandPublished(input.channel)) scheduleApproved(input.storyId);
  return { ok: true };
}

/**
 * One text for every platform (John, 2026-10-16): approve or take back the text of all platforms in ONE call. The platforms
 * are decided in parallel and auto-schedule runs once. Three round trips (each one re-rendering /content) made Approve take
 * ten seconds.
 */
export async function setTextApprovalAll(input: { storyId: string; channels: string[]; approve: boolean }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const results = await Promise.all(input.channels.map((channel) => decidePart(db, input.storyId, channel, "text", input.approve)));
  const failed = results.findIndex((r) => !r.ok);
  if (failed >= 0) {
    const r = results[failed] as { ok: false; error: string };
    return { ok: false, error: `${input.channels[failed]}: ${r.error}` };
  }
  if (input.approve && results.some((r) => r.ok && r.final)) scheduleApproved(input.storyId);
  return { ok: true };
}

/** Season screen: "Request changes". Marks the part needs-changes on this platform AND records the note, so an agent reworks it. */
/** John's change request supersedes an open "approve with note" on the same part (lib/approve-note-db.ts). */
async function supersede(storyId: string, assetIds: string[], channels: string[], note: string): Promise<Result> {
  try {
    const { supersedeFixNotes } = await import("@/lib/approve-note-db");
    await supersedeFixNotes(adminDb(), storyId, assetIds, channels, note);
    return { ok: true };
  } catch (e) { return { ok: false, error: `Changes requested, but the earlier approve-with-note could not be closed: ${e instanceof Error ? e.message : String(e)}` }; }
}

export async function requestChanges(input: { storyId: string; channel: string; part: "text" | "asset"; note: string; assetId?: string }): Promise<Result> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "Say what needs to change." };
  if (note.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await partAssets(db, input.storyId, input.channel, input.part, input.assetId);
  if (!found.ok) return found;
  const [first] = found.assets.slice().sort((a, b) => a.id.localeCompare(b.id));
  const added = await db.rpc("gtm_add_story_feedback", { p_asset_id: first.id, p_channel: input.channel, p_body: note });
  if (added.error) return { ok: false, error: added.error.message };
  const decided = await decideRows(db, found.assets, input.channel, "rejected", note);
  if (!decided.ok) return decided;
  return supersede(input.storyId, found.assets.map((a) => a.id), [input.channel], note);
}

/**
 * "Approve with note" (John, 2026-10-13): records the note as a "fix before scheduling" note FIRST, then the approval, so
 * the auto-schedule pass that the approval starts already sees the hold. The agent applies the fix, restages and runs
 * `gtm story resolve <note-id>`, which re-records this approval on the fixed bytes and schedules it; the piece never comes
 * back to John. If the approval does not save, the note is closed again, so it can never hold or approve anything.
 */
async function approveWithNoteRows(db: Db, storyId: string, part: "text" | "media", assets: PartAsset[], channels: string[], note: string): Promise<Result> {
  const text = note.trim();
  if (!text) return { ok: false, error: "Write the note first." };
  if (text.length > FIX_NOTE_MAX) return { ok: false, error: `Keep the note under ${FIX_NOTE_MAX} characters.` };
  if (part === "media" && nonFinal(assets).length) return { ok: false, error: "This is not the final yet; approve the stage instead." };
  const sorted = assets.slice().sort((a, b) => a.id.localeCompare(b.id));
  let body: string;
  try { body = encodeFixNote({ part, channels, assets: [...new Set(sorted.map((a) => a.id))] }, text); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const added = await db.rpc("gtm_add_story_feedback", { p_asset_id: sorted[0].id, p_channel: channels.length === 1 ? channels[0] : null, p_body: body });
  if (added.error) return { ok: false, error: added.error.message };
  for (const channel of channels) {
    const result = await decideRows(db, assets, channel, "approved", `approved with note: ${text}`);
    if (!result.ok) {
      if (typeof added.data === "string") await adminDb().from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: "The approval did not save, so this note was closed. Approve again." }).eq("id", added.data).is("resolved_at", null);
      return result;
    }
  }
  // Other platforms that are fully approved still go out; this piece waits for the fix (lib/auto-schedule.ts).
  if (!allHandPublished(channels)) scheduleApproved(storyId);
  return { ok: true };
}

/** Season screen: "Approve with note" on one platform's text. */
export async function approveTextWithNote(input: { storyId: string; channel: string; note: string; assetId?: string }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await partAssets(db, input.storyId, input.channel, "text", input.assetId);
  if (!found.ok) return found;
  return approveWithNoteRows(db, input.storyId, "text", found.assets, [input.channel], input.note);
}

/** Every platform's text of a piece, each copy asset tied to the one platform it is decided for. */
async function textOfChannels(db: Db, storyId: string, channels: string[]): Promise<{ ok: true; assets: PartAsset[] } | { ok: false; error: string }> {
  const out: PartAsset[] = [];
  for (const channel of channels) {
    const found = await partAssets(db, storyId, channel, "text");
    if (!found.ok) return found;
    out.push(...found.assets.map((a) => ({ ...a, channels: [channel] })));
  }
  return out.length ? { ok: true, assets: out } : { ok: false, error: "Nothing to review here." };
}

/** One text for every platform (John, 2026-10-16): "Request changes" records ONE note and sends every platform's text back. */
export async function requestTextChangesAll(input: { storyId: string; channels: string[]; note: string }): Promise<Result> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "Say what needs to change." };
  if (note.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await textOfChannels(db, input.storyId, input.channels);
  if (!found.ok) return found;
  const ids = [...new Set(found.assets.map((a) => a.id))].sort();
  // Stored once, naming every copy file it covers, so it shows on each platform's text and `gtm story feedback` lists them.
  let body: string;
  try { body = encodeFormatsNote(ids, note); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const added = await db.rpc("gtm_add_story_feedback", { p_asset_id: ids[0], p_channel: input.channels.length === 1 ? input.channels[0] : null, p_body: body });
  if (added.error) return { ok: false, error: added.error.message };
  for (const channel of input.channels) {
    const result = await decideRows(db, found.assets, channel, "rejected", note);
    if (!result.ok) return result;
  }
  return supersede(input.storyId, ids, input.channels, note);
}

/** One text for every platform: "Approve with note" holds one fix note over every platform's text. */
export async function approveTextWithNoteAll(input: { storyId: string; channels: string[]; note: string }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await textOfChannels(db, input.storyId, input.channels);
  if (!found.ok) return found;
  return approveWithNoteRows(db, input.storyId, "text", found.assets, input.channels, input.note);
}

/** "Approve with note" on final media, for every platform that posts it. */
export async function approveMediaWithNote(input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; note: string }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await mediaRows(db, input.storyId, input.assetIds, input.channels, input.expected);
  if (!found.ok) return found;
  return approveWithNoteRows(db, input.storyId, "media", found.assets, input.channels, input.note);
}

/** Season screen: a note on one asset that does not change its approval (use requestChanges to send it back). */
export async function addFeedback(input: { assetId: string; channel: string; body: string }): Promise<Result> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Write the feedback first." };
  if (body.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  // Writes go through the owner-checked function: the table itself is read-only to the browser's role.
  const { error } = await db.rpc("gtm_add_story_feedback", { p_asset_id: input.assetId, p_channel: input.channel, p_body: body });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}


/**
 * "Pending third-party approval": holds a piece so approval never schedules it, even when John has approved every
 * platform. Release ("Third party approved") clears the hold and, like an approval, schedules whatever is already
 * approved into its best open slot at once. Writes go through the owner-checked gtm_set_story_hold.
 */
export async function setStoryHold(input: { storyId: string; held: boolean; who?: string; note?: string }): Promise<{ ok: true; hold: StoryHold | null } | { ok: false; error: string }> {
  const who = (input.who ?? "").trim(), note = (input.note ?? "").trim();
  if (who.length > HOLD_WHO_MAX) return { ok: false, error: `Keep "who" under ${HOLD_WHO_MAX} characters.` };
  if (note.length > HOLD_NOTE_MAX) return { ok: false, error: `Keep the note under ${HOLD_NOTE_MAX} characters.` };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const { error } = await db.rpc("gtm_set_story_hold", { p_story_id: input.storyId, p_held: input.held, p_who: who, p_note: note });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/stories/${input.storyId}`);
  if (!input.held) {
    // The database refuses a third party's sign-off before the final is staged, so this only ever releases a final.
    // The pass schedules only what John final-approved (auto-schedule never takes a non-final asset).
    scheduleApproved(input.storyId);
    return { ok: true, hold: null };
  }
  const { data } = await db.from("gtm_stories").select("hold_who,hold_note,held_at,third_party_who").eq("id", input.storyId).maybeSingle();
  return { ok: true, hold: { who: data?.hold_who || data?.third_party_who || who, note: data?.hold_note ?? note, heldAt: data?.held_at ?? new Date().toISOString(), kind: data?.third_party_who ? "third_party" : "hold", finalStaged: false } };
}

type Expected = { asset_id: string; sha256: string; revision: number };

/**
 * A stage decision before the final ("Approve rough cut", "Approve plan", or changes with a note). It never touches a
 * platform approval and never schedules: the database logs it against exactly the bytes John looked at.
 */
export async function decideStage(input: { storyId: string; stage: string; decision: "approved" | "changes"; note: string; expected: Expected[] }): Promise<Result> {
  const note = input.note.trim();
  if (input.decision === "changes" && !note) return { ok: false, error: "Say what needs to change." };
  if (note.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  if (!input.expected.length) return { ok: false, error: "Nothing at this stage to decide on. Refresh the page." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const { error } = await db.rpc("gtm_decide_story_stage", {
    p_story_id: input.storyId, p_stage: input.stage, p_decision: input.decision, p_note: note, p_expected: input.expected, p_reset_stages: [],
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/stories/${input.storyId}`);
  return { ok: true };
}

/**
 * "Send back to <stage>": a note at a later stage about an earlier one (an edit note on the final). The earlier stage
 * reads changes, every stage after it returns to todo, and the final's platform approvals are withdrawn, so nothing
 * goes out until the agent restages. Never schedules.
 */
export async function reopenStage(input: { storyId: string; stage: string; note: string; expected: Expected[] }): Promise<Result> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "Say what needs to change." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const { data: story } = await db.from("gtm_stories").select("pipeline").eq("id", input.storyId).maybeSingle();
  if (!isFormat(story?.pipeline)) return { ok: false, error: "This piece has no pipeline." };
  const pipeline = PIPELINES[story.pipeline as Format];
  const at = pipeline.stages.findIndex((s) => s.key === input.stage);
  if (at < 0 || pipeline.stages[at].final) return { ok: false, error: "Unknown stage." };
  const later = pipeline.stages.slice(at + 1).filter((s) => !s.final).map((s) => s.key);
  const { error } = await db.rpc("gtm_decide_story_stage", {
    p_story_id: input.storyId, p_stage: input.stage, p_decision: "reopened", p_note: note, p_expected: input.expected, p_reset_stages: later,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/stories/${input.storyId}`);
  return { ok: true };
}

/**
 * The final media John looks at once for every platform that posts it (one decision across platforms, John 2026-10-12),
 * and for every format of the same video (John 2026-10-13): the 4:5 cut for LinkedIn and the 9:16 cuts for Instagram and
 * YouTube are approved, or sent back, together. Each file is decided only on the platforms it is posted on.
 */
async function mediaRows(db: Db, storyId: string, assetIds: string[], channels: string[], expected: Expected[]): Promise<{ ok: true; assets: PartAsset[] } | { ok: false; error: string }> {
  if (!assetIds.length || !channels.length || channels.some((c) => !(REVIEW_CHANNELS as string[]).includes(c))) return { ok: false, error: "Nothing to review here." };
  const ids = [...new Set(assetIds)];
  const { data, error } = await db.from("gtm_story_assets").select("id, sha256, revision, kind, body, stage").eq("story_id", storyId).in("id", ids);
  if (error || !data || data.length !== ids.length) return { ok: false, error: error?.message ?? "This piece changed. Refresh the page." };
  // The decision binds to the bytes John looked at (the database refuses them if a restage landed since the page loaded).
  const seen = new Map(expected.map((e) => [e.asset_id, e]));
  if (ids.some((id) => !seen.has(id))) return { ok: false, error: "This piece changed. Refresh the page." };
  const { data: rows, error: rowError } = await db.from("gtm_story_asset_channels").select("asset_id, channel").in("asset_id", ids).in("channel", channels);
  if (rowError) return { ok: false, error: rowError.message };
  const on = (id: string) => ((rows ?? []) as Array<{ asset_id: string; channel: string }>).filter((r) => r.asset_id === id).map((r) => r.channel);
  if (ids.some((id) => !on(id).length)) return { ok: false, error: "This piece changed. Refresh the page." };
  return { ok: true, assets: (data as PartAsset[]).map((a) => ({ ...a, sha256: seen.get(a.id)!.sha256, revision: seen.get(a.id)!.revision, channels: on(a.id) })) };
}

/** Approve (or take back) the final media for every platform that posts it, in one decision. Approval schedules. */
export async function setMediaApproval(input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; approve: boolean }): Promise<Result> {
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await mediaRows(db, input.storyId, input.assetIds, input.channels, input.expected);
  if (!found.ok) return found;
  if (input.approve && nonFinal(found.assets).length) return { ok: false, error: "This is not the final yet; approve the stage instead." };
  for (const channel of input.channels) {
    const result = await decideRows(db, found.assets, channel, input.approve ? "approved" : "pending", "");
    if (!result.ok) return result;
  }
  // One approval covers the whole piece (John, 2026-10-16): the formats and covers differ only in framing, so approving
  // any video approves every other final video of the piece that is still waiting, on the platforms that post it. A
  // newsletter's images are its own decision, published by hand: they approve nothing else and schedule nothing.
  if (input.approve && !allHandPublished(input.channels)) {
    const rest = await pendingFinalMedia(db, input.storyId, new Set(input.assetIds));
    for (const [channel, assets] of rest) {
      const result = await decideRows(db, assets, channel, "approved", "");
      if (!result.ok) return result;
    }
    scheduleApproved(input.storyId);
  }
  return { ok: true };
}

/** The piece's other final video and image files with a pending row, grouped by platform, at the bytes on the server now. */
async function pendingFinalMedia(db: Db, storyId: string, skip: Set<string>): Promise<Map<string, PartAsset[]>> {
  const { data: assets } = await db.from("gtm_story_assets").select("id, sha256, revision, kind, body, stage").eq("story_id", storyId).in("kind", ["video", "image"]);
  const mine = ((assets ?? []) as PartAsset[]).filter((a) => !skip.has(a.id) && !nonFinal([a]).length);
  const out = new Map<string, PartAsset[]>();
  if (!mine.length) return out;
  const { data: rows } = await db.from("gtm_story_asset_channels").select("asset_id, channel").eq("status", "pending").in("asset_id", mine.map((a) => a.id)).in("channel", ["linkedin", "instagram", "youtube"]);
  for (const r of (rows ?? []) as Array<{ asset_id: string; channel: string }>) {
    const a = mine.find((m) => m.id === r.asset_id);
    if (a) out.set(r.channel, [...(out.get(r.channel) ?? []), { ...a, channels: [r.channel] }]);
  }
  return out;
}

/** "Request changes" on final media shared by several platforms: one note, every platform sent back. */
export async function requestMediaChanges(input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; note: string }): Promise<Result> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "Say what needs to change." };
  if (note.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const found = await mediaRows(db, input.storyId, input.assetIds, input.channels, input.expected);
  if (!found.ok) return found;
  // Stored once, on the first file, naming every file it covers (every format of the video, unless "Only this format").
  const [first] = found.assets.slice().sort((a, b) => a.id.localeCompare(b.id));
  let body: string;
  try { body = encodeFormatsNote(found.assets.map((a) => a.id), note); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const added = await db.rpc("gtm_add_story_feedback", { p_asset_id: first.id, p_channel: input.channels.length === 1 ? input.channels[0] : null, p_body: body });
  if (added.error) return { ok: false, error: added.error.message };
  for (const channel of input.channels) {
    const result = await decideRows(db, found.assets, channel, "rejected", note);
    if (!result.ok) return result;
  }
  revalidatePath(`/stories/${input.storyId}`);
  return supersede(input.storyId, found.assets.map((a) => a.id), input.channels, note);
}

/**
 * "Note for all": one note for every piece of a series, one feedback row each with a shared batch_id, so the agent
 * fixes it once and resolves them together. It changes no approval. Each note sits on the piece's video (else its
 * first media, else its first text) and records the stage that asset is at.
 */
export async function addSeriesNote(input: { storyIds: string[]; note: string }): Promise<{ ok: true; failed: Array<{ id: string; error: string }> } | { ok: false; error: string }> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "Write the note first." };
  if (note.length > 5000) return { ok: false, error: "Feedback is limited to 5000 characters." };
  if (!input.storyIds.length || input.storyIds.length > 50) return { ok: false, error: "Choose the pieces first." };
  const { db, owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  const batch = randomUUID();
  const { data: assets, error } = await db.from("gtm_story_assets").select("id,story_id,kind").in("story_id", input.storyIds);
  if (error) return { ok: false, error: error.message };
  const rank = (k: string) => (k === "video" ? 0 : k === "image" ? 1 : k === "copy" ? 2 : 3);
  const failed: Array<{ id: string; error: string }> = [];
  for (const storyId of input.storyIds) {
    const target = (assets ?? []).filter((a) => a.story_id === storyId && a.kind !== "link").sort((a, b) => rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id))[0];
    if (!target) { failed.push({ id: storyId, error: "nothing staged" }); continue; }
    const r = await db.rpc("gtm_add_story_feedback", { p_asset_id: target.id, p_channel: null, p_body: note, p_batch_id: batch });
    if (r.error) failed.push({ id: storyId, error: r.error.message });
  }
  return { ok: true, failed };
}

/**
 * "Kill": take the whole piece off the calendar and /content now (John, 2026-10-16: "Kill it, remove from everywhere";
 * a note that said so sat waiting for an agent). Rows go to skipped, unsent Zernio posts are deleted, open notes resolved.
 */
export async function killPiece(input: { storyId: string }): Promise<Result> {
  const { owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    await killStoryPiece(adminDb(), input.storyId, { reason: "Killed by John in /content: taken off the calendar and /content." });
    revalidatePath("/calendar");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not kill the piece." };
  }
}

/**
 * The Mark published button on a Substack essay card: John pasted the live URL, so the essay leaves /content. Replacing a
 * different URL is allowed here, because he typed it on purpose.
 */
export async function markPublished(input: { storyId: string; assetId: string; url: string }): Promise<Result> {
  const { owner } = await requireOwner();
  if (!owner) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    await markEssayPublished(adminDb(), input.storyId, input.assetId, input.url, { force: true });
    revalidatePath("/content");
    revalidatePath(`/stories/${input.storyId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not mark the essay published." };
  }
}
