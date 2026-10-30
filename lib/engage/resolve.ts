// Closing a red flag (VIB-424 follow-up). The flag is a recommendation; John decides, and sometimes the answer
// is "this is fine" (the guest already replied to the comments, the post was read correctly, the thread died).
// A resolved flag leaves /engage and the 07:00 email until a newer comment lands on that post, and the note
// John writes becomes a classification lesson, so later runs judge a thread like that one more carefully.
// The weekly report keeps the flags it was built from: it is a record of the week, not a to-do list.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { addLesson } from "./learn";
import { FLAG_LABEL, REDFLAGS, redFlags, type FlagType, type RedFlag } from "./redflags";

export const NOTE_MAX = 400;

/** Flags John has not closed. A closed one comes back only when a comment newer than the closing arrives. */
export async function unresolvedFlags(db: SupabaseClient, flags: RedFlag[]): Promise<RedFlag[]> {
  if (!flags.length) return flags;
  const rows = must(await db.from("gtm_red_flag_resolutions").select("post_key,resolved_at").in("post_key", flags.map((f) => f.post_key)).order("resolved_at", { ascending: false }), "red flag resolutions") as { post_key: string; resolved_at: string }[];
  const latest = new Map<string, number>();
  for (const r of rows) if (!latest.has(r.post_key)) latest.set(r.post_key, Date.parse(r.resolved_at));
  return flags.filter((f) => {
    const at = latest.get(f.post_key);
    return at === undefined || (f.last_at != null && Date.parse(f.last_at) > at);
  });
}

/** The lesson text a resolution note becomes: what the thread looked like, and what John decided. */
export function lessonFor(flag: FlagType, title: string, note: string): string {
  return `A "${FLAG_LABEL[flag].toLowerCase()}" flag on "${title.slice(0, 60)}" was closed by John: ${note}`.slice(0, 500);
}

/**
 * Closes the active flag on one post. `note` is optional but is what teaches the model: with one, it is kept
 * on the resolution and written as a classification lesson. The flag is re-read here (not trusted from the
 * browser), so a flag that has already cleared or been closed is reported rather than recorded twice.
 */
export async function resolveFlag(db: SupabaseClient, postKey: string, note: string | null, actor: string, now = new Date()): Promise<{ ok: true; lesson: boolean } | { ok: false; error: string }> {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (text.length > NOTE_MAX) return { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` };
  const [flag] = (await redFlags(db, new Date(now.getTime() - REDFLAGS.window_days * 86400_000), new Date(now.getTime() + 60_000))).filter((f) => f.post_key === postKey);
  if (!flag) return { ok: false, error: "That flag is no longer active." };
  if (!(await unresolvedFlags(db, [flag])).length) return { ok: false, error: "That flag is already resolved." };
  // The resolution first: if it cannot be written the flag stays open and no lesson is taught from a note that was never applied.
  const row = must(await db.from("gtm_red_flag_resolutions").insert({ post_key: postKey, flag: flag.flag, note: text || null, resolved_by: actor }).select("id").single(), "resolve red flag") as { id: string };
  let lessonId: string | null = null;
  if (text.length >= 3) {
    // A lesson that cannot be written (too long once framed) must not lose the resolution.
    lessonId = await addLesson(db, "classification", lessonFor(flag.flag, flag.title, text)).then((l) => l.id).catch(() => null);
    if (lessonId) await db.from("gtm_red_flag_resolutions").update({ lesson_id: lessonId }).eq("id", row.id);
  }
  return { ok: true, lesson: lessonId != null };
}
