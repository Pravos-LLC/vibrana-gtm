"use server";

import { revalidatePath } from "next/cache";
import { sessionDb } from "@/lib/supabase/server";
import { parsePillars, validateSeasonFields } from "@/lib/seasons";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Saves a Season's title, description, dates and pillars. The owner's session calls the owner-checked
 * gtm_update_season function; the browser role cannot write the table. Dates and pillar slugs are validated
 * here first (pillars against content/guide/pillars.json) so the owner gets a plain message, and the
 * function refuses the same inputs again.
 */
export async function updateSeason(input: { id: string; title: string; description: string; startsOn: string; endsOn: string; pillars: string[] }): Promise<Result> {
  const pillars = parsePillars(input.pillars);
  const errors = validateSeasonFields({ title: input.title, description: input.description, starts_on: input.startsOn, ends_on: input.endsOn, pillars });
  if (errors.length) return { ok: false, error: errors.join(" ") };
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) {
    return { ok: false, error: "Not signed in as the cockpit owner." };
  }
  const { error } = await db.rpc("gtm_update_season", {
    p_id: input.id, p_title: input.title.trim(), p_description: input.description, p_starts_on: input.startsOn, p_ends_on: input.endsOn, p_pillars: pillars,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/content");
  return { ok: true };
}
