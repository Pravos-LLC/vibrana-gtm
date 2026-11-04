// Killing a piece: John's "Kill it, remove from everywhere" (2026-10-16). Before this a kill was only a note, so the rows
// stayed `drafted` on the calendar until an agent got to it. A kill takes every calendar row of the Story off the plan
// (`skipped`, which the calendar hides and /content treats as done), deletes any Zernio post that has not gone out, and
// resolves the open notes on the piece so /work stops waiting for an agent.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { getPost, zernio, ZernioError } from "./zernio";
import { KILLED_KEY } from "./season-board";

export type KillResult = {
  story: string;
  skipped: string[];
  /** Zernio posts deleted (calendar row id -> Zernio post id). */
  deleted: Record<string, string>;
  /** Rows that already went out: left alone. */
  published: string[];
  notesResolved: number;
};

type Row = { id: string; status: string; zernio_post_id: string | null };

const OUT = ["published", "partial"];

/**
 * Takes the whole piece off the calendar and /content. Refuses before changing anything when the id is no Story and has no
 * calendar rows (an unknown id), or when Zernio says a linked post already went out, fully or on some platforms (`partial`), but the row does not
 * know it yet (run `gtm calendar reconcile` first). Published rows are left as they are. Each linked row is skipped right
 * after its own Zernio post is deleted, so a Zernio error part way leaves no row pointing at a deleted post.
 */
export async function killPiece(db: SupabaseClient, storyId: string, opts: { reason?: string } = {}): Promise<KillResult> {
  if (!storyId) throw new Error("killPiece: no story id");
  const rows = must(await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("story_id", storyId), `rows of ${storyId}`) as Row[];
  // A piece John is still reviewing in /content may never have been scheduled: no calendar rows, but a real Story. Its kill
  // is the record plus its notes (sd-anthropic-release-bar, 2026-10-31: the kill was refused and the piece came back).
  if (!rows.length && !must(await db.from("gtm_stories").select("id").eq("id", storyId).maybeSingle(), `story ${storyId}`)) throw new Error(`${storyId} has no calendar rows and no Story: no such piece`);
  const out: KillResult = { story: storyId, skipped: [], deleted: {}, published: [], notesResolved: 0 };
  const live = rows.filter((r) => r.status !== "published" && r.status !== "skipped");
  out.published = rows.filter((r) => r.status === "published").map((r) => r.id);
  if (live.some((r) => r.zernio_post_id === "pending")) throw new Error(`${storyId} has a scheduling attempt in flight (zernio_post_id: pending); wait for it, then kill again`);

  // Check every linked post first, so a half-published piece is never half-killed.
  const linked = live.filter((r) => r.zernio_post_id);
  const gone = new Set<string>();
  for (const r of linked) {
    try {
      const post = await getPost(r.zernio_post_id!);
      if (OUT.includes(post.status)) throw new Error(`${r.id} already went out on Zernio (${r.zernio_post_id}, ${post.status}); run gtm calendar reconcile, then kill again`);
    } catch (e) {
      if (e instanceof ZernioError && e.status === 404) { gone.add(r.id); continue; }
      throw e;
    }
  }

  const skip = async (ids: string[]) => {
    must(await db.from("gtm_content_items").update({ status: "skipped", zernio_post_id: null, updated_at: new Date().toISOString() }).in("id", ids), `skip ${ids.join(", ")}`);
    out.skipped.push(...ids);
  };
  for (const r of linked) {
    if (!gone.has(r.id)) {
      try { await zernio(`/posts/${r.zernio_post_id}`, { method: "DELETE" }); }
      catch (e) { if (!(e instanceof ZernioError && e.status === 404)) throw e; }
      out.deleted[r.id] = r.zernio_post_id!;
    }
    await skip([r.id]);
  }
  const unlinked = live.filter((r) => !r.zernio_post_id).map((r) => r.id);
  if (unlinked.length) await skip(unlinked);

  const assetIds = (must(await db.from("gtm_story_assets").select("id").eq("story_id", storyId), `assets of ${storyId}`) as { id: string }[]).map((a) => a.id);
  if (assetIds.length) {
    const resolved = must(await db.from("gtm_story_feedback")
      .update({ resolved_at: new Date().toISOString(), resolution: opts.reason ?? "Killed: taken off the calendar and /content." })
      .in("asset_id", assetIds).is("resolved_at", null).select("id"), `notes of ${storyId}`) as { id: string }[];
    out.notesResolved = resolved.length;
  }
  // The kill is recorded, so /content hides exactly the pieces that were killed (lib/season-board.ts), never ones whose
  // rows a reconcile skipped.
  const state = must(await db.from("gtm_sync_state").select("value").eq("key", KILLED_KEY).maybeSingle(), "kill record") as { value: Record<string, unknown> } | null;
  must(await db.from("gtm_sync_state").upsert({ key: KILLED_KEY, value: { ...(state?.value ?? {}), [storyId]: { at: new Date().toISOString(), reason: opts.reason ?? "Killed" } }, updated_at: new Date().toISOString() }), "record the kill");
  return out;
}

/**
 * Take one channel off a piece (John, 2026-11-02: approval picks the channels): its unsent calendar rows are skipped and
 * any Zernio post that has not gone out is deleted, exactly like a kill but for one channel. A leg that already went out
 * is left alone and reported. Refuses while a send is in flight.
 */
export async function dropPieceChannel(db: SupabaseClient, storyId: string, channel: string, opts: { dryRun?: boolean } = {}): Promise<{ skipped: string[]; deleted: Record<string, string>; published: string[] }> {
  const rows = (must(await db.from("gtm_content_items").select("id,status,zernio_post_id,channels").eq("story_id", storyId), `rows of ${storyId}`) as (Row & { channels: string[] | null })[])
    .filter((r) => (r.channels ?? []).includes(channel));
  const out = { skipped: [] as string[], deleted: {} as Record<string, string>, published: rows.filter((r) => r.status === "published").map((r) => r.id) };
  const live = rows.filter((r) => r.status !== "published" && r.status !== "skipped");
  if (live.some((r) => r.zernio_post_id === "pending")) throw new Error(`${channel}: a send is in flight; wait for it, then try again`);
  // Check every linked post first, so a channel that already went out is never half-dropped.
  const gone = new Set<string>();
  for (const r of live.filter((x) => x.zernio_post_id)) {
    try {
      const post = await getPost(r.zernio_post_id!);
      if (OUT.includes(post.status)) throw new Error(`${r.id} already went out on Zernio (${r.zernio_post_id}, ${post.status}); run gtm calendar reconcile`);
    } catch (e) {
      if (e instanceof ZernioError && e.status === 404) { gone.add(r.id); continue; }
      throw e;
    }
  }
  if (opts.dryRun) return { ...out, skipped: live.map((r) => r.id) };
  for (const r of live) {
    if (r.zernio_post_id && !gone.has(r.id)) {
      try { await zernio(`/posts/${r.zernio_post_id}`, { method: "DELETE" }); }
      catch (e) { if (!(e instanceof ZernioError && e.status === 404)) throw e; }
      out.deleted[r.id] = r.zernio_post_id;
    }
    must(await db.from("gtm_content_items").update({ status: "skipped", zernio_post_id: null, updated_at: new Date().toISOString() }).eq("id", r.id), `skip ${r.id}`);
    out.skipped.push(r.id);
  }
  return out;
}

/**
 * The bank (John, 2026-11-02: no seasons): "not now" for a piece. Every unsent leg leaves the calendar as `banked` and any
 * Zernio post that has not gone out is deleted; nothing schedules it until John schedules it from the bank. Checks every
 * linked post before changing anything, like a kill.
 */
export async function bankPiece(db: SupabaseClient, storyId: string): Promise<{ banked: string[]; deleted: Record<string, string> }> {
  const rows = must(await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("story_id", storyId), `rows of ${storyId}`) as Row[];
  const live = rows.filter((r) => !["published", "skipped", "banked"].includes(r.status));
  if (!live.length) throw new Error(`${storyId} has nothing on the calendar to bank`);
  if (live.some((r) => r.zernio_post_id === "pending")) throw new Error(`${storyId} has a send in flight; wait for it, then bank it`);
  const gone = new Set<string>();
  for (const r of live.filter((x) => x.zernio_post_id)) {
    try {
      const post = await getPost(r.zernio_post_id!);
      if (OUT.includes(post.status)) throw new Error(`${r.id} already went out on Zernio (${r.zernio_post_id}, ${post.status}); run gtm calendar reconcile`);
    } catch (e) {
      if (e instanceof ZernioError && e.status === 404) { gone.add(r.id); continue; }
      throw e;
    }
  }
  const out = { banked: [] as string[], deleted: {} as Record<string, string> };
  for (const r of live) {
    if (r.zernio_post_id && !gone.has(r.id)) {
      try { await zernio(`/posts/${r.zernio_post_id}`, { method: "DELETE" }); }
      catch (e) { if (!(e instanceof ZernioError && e.status === 404)) throw e; }
      out.deleted[r.id] = r.zernio_post_id;
    }
    must(await db.from("gtm_content_items").update({ status: "banked", zernio_post_id: null, updated_at: new Date().toISOString() }).eq("id", r.id), `bank ${r.id}`);
    out.banked.push(r.id);
  }
  return out;
}

/** Out of the bank: its legs go back to approved dated yesterday (a missed slot), so the scheduler places them by the
 * normal rules, never today and never on an off day. */
export async function unbankPiece(db: SupabaseClient, storyId: string, today: string): Promise<string[]> {
  const rows = must(await db.from("gtm_content_items").select("id").eq("story_id", storyId).eq("status", "banked"), `banked rows of ${storyId}`) as { id: string }[];
  if (!rows.length) throw new Error(`${storyId} has nothing in the bank`);
  const { addDays } = await import("./week");
  const missed = addDays(today, -1);
  const week = (await import("./calendar")).weekOfDate(missed);
  must(await db.from("gtm_content_items").update({ status: "approved", date: missed, week, updated_at: new Date().toISOString() }).in("id", rows.map((r) => r.id)).eq("status", "banked"), `unbank ${storyId}`);
  return rows.map((r) => r.id);
}
