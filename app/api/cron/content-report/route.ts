import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { runWeeklyReport } from "@/lib/reports/run";

// Vercel cron, Sundays at 00:00 UTC (08:00 in Bali): the weekly content report for the week ending that day.
// A separate route from the daily Signal Desk digest, which fires at the same minute.
export const maxDuration = 300;

export async function GET(request: Request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // The model call must start by 240 s so its answer, the writes and the email fit inside the 300 s limit.
    const r = await runWeeklyReport(adminDb(), { deadline: started + 250_000 });
    return NextResponse.json({ week: r.week, skipped: r.skipped ?? null, id: r.id ?? null, actions: r.actions ?? 0, dropped: r.guard?.dropped.length ?? 0, email_id: r.email_id ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
