import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { syncChannelReach } from "@/lib/analytics/channels";
import { syncChannels, syncCrm, syncStats, syncStatus } from "@/lib/sync";
import { tagPlaybook } from "@/lib/playbook/tag";
import { autoSchedule } from "@/lib/auto-schedule";
import { recordScheduleReport } from "@/lib/schedule-report";
import { retryUnresolved } from "@/lib/people";

// Vercel cron: Zernio status + metrics + followers + account reach, Twenty funnel. Wise costs and
// enrichment progress need local credentials/files and are pushed by `gtm sync` from the Mac.
// This is the only scheduled stats runner (the Mac LaunchAgent no longer runs stats), and the
// snapshot is idempotent per UTC day either way.
//
// Playbook tags (VIB-421) run last, here rather than in the Sunday report cron: the report already spends
// up to 240 s of its 300 s on one model call, so tagging there would compete with it, while here it is a few
// calls a day (only items newly approved or edited since their tags), each finished well before Sunday.
// Approved items are tagged before they go out, so the report always finds their tags.
export const maxDuration = 800; // an episode final streams its master to Zernio in the auto-schedule pass
// Auto-schedule is the safety net for approval-schedules (John, 2026-10-11): /content schedules on approval, and this
// catches anything that approval run missed (a timeout, a Zernio error). It runs first so the status sync sees it.
// People: LinkedIn tags still missing for @mentions are retried a few a day (LinkedIn rate-limits the lookup).
const NONFATAL = new Set(["playbook", "autoschedule", "people"]);

export async function GET(request: Request) {
  const started = Date.now();
  const secret = process.env.CRON_SECRET;
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries({ autoschedule: async () => { const db = adminDb(); const r = await autoSchedule(db); await recordScheduleReport(db, r).catch((e) => console.error(`sync autoschedule report: ${(e as Error).message}`)); return r; }, status: syncStatus, channels: syncChannels, reach: () => syncChannelReach(adminDb()), stats: () => syncStats(90), crm: syncCrm,
    // No tag call starts after 285 s; rows not reached are tagged tomorrow.
    playbook: () => tagPlaybook(adminDb(), { deadline: started + 285_000 }),
    people: () => retryUnresolved(adminDb(), { max: 15, deadline: started + 600_000 }) })) {
    try {
      results[name] = await fn();
    } catch (e) {
      const error = (e as Error).message;
      // Playbook tags are an enrichment: their failure is logged and reported, never a failed sync.
      if (NONFATAL.has(name)) { console.error(`sync ${name}: ${error}`); results[name] = { nonfatal_error: error }; }
      else results[name] = { error };
    }
  }
  const auto = results.autoschedule as { scheduled?: { id: string; date: string; time: string }[]; failed?: { id: string; error: string }[]; skipped?: { id: string; reason: string }[] } | undefined;
  for (const x of auto?.scheduled ?? []) console.log(`sync autoschedule: ${x.id} -> ${x.date} ${x.time}`);
  for (const x of auto?.failed ?? []) console.error(`sync autoschedule: ${x.id}: ${x.error}`);
  for (const x of auto?.skipped ?? []) console.warn(`sync autoschedule: ${x.id} skipped: ${x.reason}`);
  const pb = results.playbook as { errors?: { id: string; error: string }[]; rejected?: { id: string; reason: string }[]; skipped?: string } | undefined;
  for (const x of pb?.errors ?? []) console.error(`sync playbook: ${x.id}: ${x.error}`);
  for (const x of pb?.rejected ?? []) console.error(`sync playbook: ${x.id} rejected: ${x.reason}`);
  if (pb?.skipped) console.warn(`sync playbook: ${pb.skipped}`);
  const failed = Object.entries(results).some(([name, r]) => !NONFATAL.has(name) && r && typeof r === "object" && "error" in r);
  return NextResponse.json(results, { status: failed ? 500 : 200 });
}
