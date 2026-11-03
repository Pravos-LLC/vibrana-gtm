"use server";
// Saving the weekly rhythm from /settings (lib/rhythm-settings.ts). The owner only; the service role writes, and the
// database keeps every version in gtm_settings_history.
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { sessionDb } from "@/lib/supabase/server";
import { loadRhythm, rhythmProblems, RHYTHM_KEY, type RhythmSetting } from "@/lib/rhythm-settings";

async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}

export async function saveRhythm(value: RhythmSetting): Promise<{ ok: true } | { ok: false; error: string }> {
  const who = await owner();
  if (!who) return { ok: false, error: "Not signed in as the cockpit owner." };
  const problems = rhythmProblems(value);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  const db = adminDb();
  const { error } = await db.from("gtm_settings").upsert({ key: RHYTHM_KEY, value, updated_at: new Date().toISOString(), updated_by: who });
  if (error) return { ok: false, error: error.message };
  await loadRhythm(db, { fresh: true });
  for (const p of ["/settings", "/calendar", "/guide", "/content"]) revalidatePath(p);
  return { ok: true };
}

/** Back to the guide's rhythm: the setting is removed (its versions stay in the history). */
export async function resetRhythm(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  const db = adminDb();
  const { error } = await db.from("gtm_settings").delete().eq("key", RHYTHM_KEY);
  if (error) return { ok: false, error: error.message };
  await loadRhythm(db, { fresh: true });
  for (const p of ["/settings", "/calendar", "/guide", "/content"]) revalidatePath(p);
  return { ok: true };
}
