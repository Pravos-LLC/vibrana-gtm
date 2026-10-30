"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { parseManualEntry, saveManualEntry } from "@/lib/analytics/manual";
import { sessionDb } from "@/lib/supabase/server";

export type ManualResult = { ok: true; saved: Record<string, number> } | { ok: false; error: string };

/**
 * Stores a week's manual numbers (Substack, YouTube impressions and CTR) in gtm_manual_metrics. Owner only:
 * the gtm_owner claim is checked here, and the write uses the service client because RLS is read-only.
 */
export async function saveManualMetrics(input: { week: string; channel: string; values: Record<string, string>; note?: string }): Promise<ManualResult> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  if (claims?.app_metadata?.gtm_owner !== true) return { ok: false, error: "Only the cockpit owner can add stats." };
  const parsed = parseManualEntry(input ?? { week: "", channel: "", values: {} });
  if (!parsed.ok) return parsed;
  try {
    const row = await saveManualEntry(adminDb(), parsed.entry, claims.email ?? "owner");
    revalidatePath("/performance");
    return { ok: true, saved: (row as { metrics: Record<string, number> }).metrics };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save." };
  }
}
