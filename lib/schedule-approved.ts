import { after } from "next/server";
import { adminDb } from "./db";
import { autoSchedule } from "./auto-schedule";
import { recordScheduleReport } from "./schedule-report";

/**
 * Approval schedules (John, 2026-10-11): once John approves, the approved platform posts go to Zernio in their best open
 * slot, with no second approval. It runs after the response so the click never waits on a video upload; the daily sync
 * cron runs the same pass as a safety net. A post that cannot be scheduled is logged and stays on the calendar. A third
 * party's approval from their review link (/shared) runs the same pass: it opens their gate, and only what John has
 * already final-approved goes out.
 */
export function scheduleApproved(storyId: string) {
  after(async () => {
    try {
      const db = adminDb();
      const r = await autoSchedule(db, { storyId });
      // What could not be scheduled shows in /content's findings (lib/schedule-report.ts), not only in this log.
      await recordScheduleReport(db, r, storyId).catch((e) => console.error(`auto-schedule ${storyId} report: ${(e as Error).message}`));
      for (const s of r.scheduled) console.log(`auto-schedule: ${s.id} -> ${s.date} ${s.time}${s.moved ? ` (moved from ${s.from.date})` : ""}, Zernio ${s.zernioPostId}`);
      for (const f of r.failed) console.error(`auto-schedule: ${f.id} failed: ${f.error}`);
      for (const k of r.skipped) console.warn(`auto-schedule: ${k.id} skipped: ${k.reason}`);
    } catch (error) {
      console.error(`auto-schedule ${storyId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
