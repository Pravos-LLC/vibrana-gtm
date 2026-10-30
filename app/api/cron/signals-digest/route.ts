import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { runDigest } from "@/lib/signals/run";

// Vercel cron, once a day at 00:00 UTC (08:00 in Bali): brief the top Signal Desk stories and email the digest.
export const maxDuration = 300;

export async function GET(request: Request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // Briefs stop starting at 200 s so the email (20 s timeout) still goes out inside the 300 s limit.
    const result = await runDigest(adminDb(), { deadline: started + 200_000 });
    return NextResponse.json({ stories: result.stories.length, briefed: result.briefs.briefed, brief_errors: result.briefs.errors.length, sent: result.sent });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
