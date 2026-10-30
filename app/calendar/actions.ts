"use server";

import { revalidatePath } from "next/cache";
import { loadCalendarDb } from "@/lib/calendar-db";
import { adminDb } from "@/lib/db";
import { sendCalendarItem, type PublishMode } from "@/lib/publish-item";
import { killPiece } from "@/lib/kill-piece";
import { movePiece, moveRefusal, pieceLegsDb, siblingLegs } from "@/lib/move-piece";
import { failureReason, retryCalendarItem } from "@/lib/retry-item";
import { sessionDb } from "@/lib/supabase/server";

export async function publishCalendarPost(id: string, mode: PublishMode): Promise<{ ok: true; status: "scheduled" | "published"; summary: string } | { ok: false; error: string }> {
  if (mode !== "now" && mode !== "schedule") return { ok: false, error: "Choose publish now or schedule." };
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) {
    return { ok: false, error: "Not signed in as the cockpit owner." };
  }
  try {
    const db = adminDb();
    const result = await sendCalendarItem(await loadCalendarDb(db), id, { mode, db });
    if ("dryRun" in result) return { ok: false, error: "Nothing was sent." };
    revalidatePath("/calendar");
    revalidatePath("/");
    const published = mode === "now" && result.zernioStatus === "published";
    return {
      ok: true,
      status: published ? "published" : "scheduled",
      summary: published ? "Published through Zernio." : mode === "now" ? `Zernio accepted it (${result.zernioStatus}).` : `Scheduled for ${result.scheduledFor ?? "the calendar time"} Berlin.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Zernio did not accept the post.";
    return { ok: false, error: message.replace(/\. Move the date or pass --allow-past\./, ". Use Publish now, or move the date.") };
  }
}

async function isOwner() {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  return (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
}

const refresh = () => { revalidatePath("/calendar"); revalidatePath("/content"); revalidatePath("/"); };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export type MovedLeg = { id: string; from: string; to: string };

/**
 * Drag-and-drop and the sheet's date and time: move a post to another day. By default the whole piece moves (every leg
 * of its Story that has not gone out, each keeping its own time; a time applies to this post only). Scheduled legs are
 * moved on Zernio first. A day whose channel another piece holds comes back as a clash the board offers to "Move anyway"
 * (`force`). Every leg moved comes back,
 * so the board can say so for legs that are not on screen.
 */
export async function moveCalendarPost(id: string, date: string, opts: { time?: string; all?: boolean; force?: boolean } = {}): Promise<{ ok: true; date: string; moved: MovedLeg[]; failed: Array<{ id: string; error: string }> } | { ok: false; error: string; clash?: boolean }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    const r = await movePiece(adminDb(), id, { date, ...(opts.time ? { time: opts.time } : {}) }, { all: opts.all !== false, force: opts.force === true });
    refresh();
    return { ok: true, date, moved: r.moved.map((m) => ({ id: m.id, from: `${m.from.date} ${m.from.time ?? ""}`.trim(), to: `${m.to.date} ${m.to.time ?? ""}`.trim() })), failed: r.failed };
  } catch (error) {
    return moveRefusal(error);
  }
}

/** The legs of a post's piece, from the database: what "Move all N platforms" would move (the sheet shows them). */
export async function calendarPieceLegs(id: string): Promise<{ ok: true; legs: Array<{ id: string; date: string; time: string | null; channels: string[]; status: string }> } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    const { legs } = await pieceLegsDb(adminDb(), id);
    const moving = new Set([id, ...siblingLegs(legs, id).move.map((l) => l.id)]);
    return { ok: true, legs: legs.filter((l) => moving.has(l.id)).map((l) => ({ id: l.id, date: l.date, time: l.time ?? null, channels: l.channels ?? [], status: l.status })) };
  } catch (error) {
    return { ok: false, error: message(error, "Could not load the piece.") };
  }
}

/** "Kill piece": every leg of the Story off the calendar, unsent Zernio posts deleted, open notes resolved. */
export async function killCalendarPiece(storyId: string): Promise<{ ok: true; skipped: number; deleted: number } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    const r = await killPiece(adminDb(), storyId, { reason: "Killed by John from the cockpit: taken off the calendar and /content." });
    refresh();
    return { ok: true, skipped: r.skipped.length, deleted: Object.keys(r.deleted).length };
  } catch (error) {
    return { ok: false, error: message(error, "Could not kill the piece.") };
  }
}

/** Why a failed post failed, in Zernio's words. */
export async function calendarFailure(id: string): Promise<{ ok: true; reason: string | null } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try { return { ok: true, reason: await failureReason(adminDb(), id) }; }
  catch (error) { return { ok: false, error: message(error, "Could not read the failure from Zernio.") }; }
}

/** Retry a failed post from its current approved text, at its calendar slot. */
export async function retryCalendarPost(id: string): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    const r = await retryCalendarItem(adminDb(), id);
    refresh();
    return { ok: true, summary: `Sent again: ${r.status}${r.scheduledFor ? ` for ${r.scheduledFor.replace("T", " ").slice(0, 16)} Berlin` : ""}.` };
  } catch (error) {
    return { ok: false, error: message(error, "Zernio did not accept the post.").replace(/\. Move the date or pass --allow-past\./, ". Move it to a later slot, then retry.") };
  }
}
