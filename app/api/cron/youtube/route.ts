import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { youtubeConfigured } from "@/lib/youtube/api";
import { syncYouTube } from "@/lib/youtube/sync";

// Vercel cron, daily 07:10 UTC: YouTube Analytics and Reporting API into gtm_yt_* and the weekly manual row.
// Reads a 7-day window ending two days ago (YouTube settles late), so a missed day heals on the next run.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!youtubeConfigured()) return NextResponse.json({ skipped: "YouTube is not connected (YOUTUBE_* env missing)" });
  try {
    return NextResponse.json(await syncYouTube(adminDb(), { today: new Date().toISOString().slice(0, 10) }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
