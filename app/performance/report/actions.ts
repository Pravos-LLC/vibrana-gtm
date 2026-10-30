"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { decideAction } from "@/lib/reports/actions";
import { sessionDb } from "@/lib/supabase/server";

export type DecideResult = { ok: true; status: string; decided_by: string | null; decided_at: string | null } | { ok: false; error: string };

/**
 * Accept or dismiss one change a weekly report proposed. Owner only (the gtm_owner claim, checked here);
 * the write uses the service client because the browser role cannot write gtm_* tables. Accepting edits the
 * calendar row (a date, a slot swap, a format, or a new idea slot) and never approves or schedules a post.
 */
export async function decideReportChange(id: string, decision: "accept" | "dismiss"): Promise<DecideResult> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  if (claims?.app_metadata?.gtm_owner !== true) return { ok: false, error: "Only the cockpit owner decides report changes." };
  if (decision !== "accept" && decision !== "dismiss") return { ok: false, error: "Unknown decision." };
  try {
    const r = await decideAction(adminDb(), id, decision, claims.email ?? "owner");
    revalidatePath("/performance/report", "layout");
    revalidatePath("/calendar");
    return { ok: true, status: r.status, decided_by: r.decided_by, decided_at: r.decided_at };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not apply the change." };
  }
}
