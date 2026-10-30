// Reads open approve-with-note notes (lib/approve-note.ts) from the database. Server and CLI only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { assertNoAgentNotes } from "./copy-guard";
import { FIX_MARKER, fixLanded, parseFixNote, type FixNote } from "./approve-note";

type FeedbackRow = { id: string; asset_id: string; channel: string | null; body: string; created_at: string; resolved_at: string | null };

/** Open approve-with-note notes, for every Story or one. */
export async function loadFixNotes(db: SupabaseClient, storyId?: string): Promise<FixNote[]> {
  let query = db.from("gtm_story_feedback").select("id,asset_id,channel,body,created_at,resolved_at").is("resolved_at", null);
  let storyOf = new Map<string, string>();
  if (storyId) {
    const assets = must(await db.from("gtm_story_assets").select("id,story_id").eq("story_id", storyId), "story assets") as { id: string; story_id: string }[];
    if (!assets.length) return [];
    storyOf = new Map(assets.map((a) => [a.id, a.story_id]));
    query = query.in("asset_id", assets.map((a) => a.id));
  }
  // Open notes are few; the marker is matched here rather than with a LIKE pattern through PostgREST.
  const rows = (must(await query.order("created_at"), "approve-with-note notes") as FeedbackRow[]).filter((r) => r.body.startsWith(FIX_MARKER));
  const missing = [...new Set(rows.map((r) => r.asset_id).filter((id) => !storyOf.has(id)))];
  if (missing.length) {
    const found = must(await db.from("gtm_story_assets").select("id,story_id").in("id", missing), "note assets") as { id: string; story_id: string }[];
    for (const a of found) storyOf.set(a.id, a.story_id);
  }
  return rows.flatMap((r) => {
    const fix = parseFixNote(r.body);
    const story = storyOf.get(r.asset_id);
    return fix && story ? [{ ...fix, id: r.id, storyId: story, assetId: r.asset_id, channel: r.channel, createdAt: r.created_at }] : [];
  });
}


export type ResolveFixResult = { resolved: string; story: string; reapproved: string[]; scheduled: string[]; skipped: Array<{ id: string; reason: string }>; failed: Array<{ id: string; error: string }> };

/**
 * `gtm story resolve <note-id> "<reply>"` on an approve-with-note: refused until a newer version of the part has been
 * staged after John's note (the fix landed). Then it closes the note, re-records John's approval for the fixed bytes on
 * every platform the note covers (he approved it with this note; it is not an agent's own approval), and runs
 * auto-schedule for the Story, so the finished version goes to its best open slot with no second review.
 */
export async function resolveFixNote(admin: SupabaseClient, noteId: string, reply: string, deps: {
  owner?: (admin: SupabaseClient) => Promise<SupabaseClient>;
  schedule?: (admin: SupabaseClient, storyId: string) => Promise<{ scheduled: Array<{ id: string }>; skipped: Array<{ id: string; reason: string }>; failed: Array<{ id: string; error: string }> }>;
} = {}): Promise<ResolveFixResult> {
  const row = must(await admin.from("gtm_story_feedback").select("id,asset_id,channel,body,created_at,resolved_at").eq("id", noteId).maybeSingle(), "note") as FeedbackRow | null;
  if (!row) throw new Error(`no note ${noteId}`);
  const fix = parseFixNote(row.body);
  if (!fix) throw new Error(`${noteId} is not an approve-with-note`);
  if (row.resolved_at) throw new Error(`${noteId} is already resolved`);
  const assets = must(await admin.from("gtm_story_assets").select("id,story_id,kind,sha256,revision,body,metadata").in("id", fix.assets), "note assets") as Array<{ id: string; story_id: string; kind: string; sha256: string; revision: number; body: string | null; metadata?: Record<string,unknown> }>;
  if (assets.some(a=>a.metadata?.shared_review === true)) throw new Error("Shared pieces require explicit scoped fix completion; legacy resolve cannot approve them");
  if (assets.length !== fix.assets.length) throw new Error(`${noteId}: ${fix.assets.filter((id) => !assets.some((a) => a.id === id)).join(", ")} no longer exist; restage the part and ask John to approve it in /content`);
  const versions = must(await admin.from("gtm_story_asset_versions").select("asset_id,created_at").in("asset_id", fix.assets), "versions") as Array<{ asset_id: string; created_at: string }>;
  if (!fixLanded({ assets: fix.assets, createdAt: row.created_at, part: fix.part }, versions)) {
    throw new Error(`${noteId}: no new version of ${fix.assets.join(", ")} since John's note. Apply the fix and restage it (gtm story stage), then resolve; until then the piece stays held.`);
  }
  for (const a of assets) if (a.kind === "copy") assertNoAgentNotes(a.id, a.body);
  const storyId = assets[0].story_id;
  const text = reply.trim() || "Fixed as noted.";
  // Close the note first, guarded on still being open, so two agents never both re-approve.
  const closed = must(await admin.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: text }).eq("id", noteId).is("resolved_at", null).select("id"), "resolve") as { id: string }[];
  if (!closed.length) throw new Error(`${noteId} was resolved by someone else just now`);
  const owner = await (deps.owner ?? (async (a: SupabaseClient) => (await import("./story-ops")).ownerClient(a)))(admin);
  const rows = must(await admin.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", fix.assets), "platform rows") as Array<{ asset_id: string; channel: string; status: string; approved_sha256: string | null }>;
  const reapproved: string[] = [];
  // A part John sent back after approving it with the note is his newer decision: "Request changes" closes the fix note
  // at once (supersedeFixNotes), so resolve refuses it as already resolved; a row still rejected is never re-approved
  // here either (review #143 F3). A plain note that is not a change request (a series note) changes nothing (#151 N1).
  const sentBack: Array<{ id: string; reason: string }> = [];
  try {
    for (const a of assets) for (const channel of fix.channels) {
      const r = rows.find((x) => x.asset_id === a.id && x.channel === channel);
      if (!r || (r.status === "approved" && r.approved_sha256 === a.sha256)) continue;
      if (r.status === "rejected") { sentBack.push({ id: `${a.id}:${channel}`, reason: "John requested changes after approving it with a note; not re-approved, it waits for his review" }); continue; }
      const { error } = await owner.rpc("gtm_decide_story_asset", {
        p_asset_id: a.id, p_channel: channel, p_status: "approved", p_note: `approved with note by John; fix applied: ${text}`.slice(0, 5000),
        p_expected_sha256: a.sha256, p_expected_revision: a.revision,
      });
      if (error) throw new Error(`${a.id}/${channel}: ${error.message}`);
      reapproved.push(`${a.id}:${channel}`);
    }
  } catch (e) {
    // Reopen the note so the piece stays held and the next agent sees it.
    await admin.from("gtm_story_feedback").update({ resolved_at: null, resolution: "" }).eq("id", noteId);
    throw e;
  }
  const schedule = deps.schedule ?? (async (a: SupabaseClient, id: string) => (await import("./auto-schedule")).autoSchedule(a, { storyId: id }));
  const r = await schedule(admin, storyId);
  return { resolved: noteId, story: storyId, reapproved, scheduled: r.scheduled.map((s) => s.id), skipped: [...sentBack, ...r.skipped], failed: r.failed };
}

/**
 * "Request changes" on a part that was approved with a note supersedes that note: John's change request is the newer
 * decision, so the fix must not land and re-approve the part (review #143 F3, #151 N1). Closes every open fix note of the
 * Story that covers one of these assets on one of these channels. Returns the closed note ids.
 */
export async function supersedeFixNotes(admin: SupabaseClient, storyId: string, assetIds: string[], channels: string[], note: string): Promise<string[]> {
  const own = (must(await admin.from("gtm_story_assets").select("id").eq("story_id", storyId), "story assets") as { id: string }[]).map((a) => a.id);
  if (!own.length) return [];
  const open = must(await admin.from("gtm_story_feedback").select("id,asset_id,channel,body").in("asset_id", own).is("resolved_at", null), "open notes") as Array<{ id: string; asset_id: string; channel: string | null; body: string }>;
  const hit = open.filter((n) => { const fix = parseFixNote(n.body); return !!fix && fix.assets.some((a) => assetIds.includes(a)) && fix.channels.some((c) => channels.includes(c)); }).map((n) => n.id);
  if (!hit.length) return [];
  must(await admin.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: `Superseded: John requested changes instead (${note.trim().slice(0, 200)})` }).in("id", hit).is("resolved_at", null), "supersede fix notes");
  return hit;
}
