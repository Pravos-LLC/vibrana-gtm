import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { runWeb } from "@/lib/signals/run";

// Vercel cron, every two hours: Signal Desk open-web collection, then Clef classification, clustering
// and scoring. X sources come from the Mac (`gtm signals collect-x`), which needs John's X session.
export const maxDuration = 300;

export async function GET(request: Request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // Stop starting new Clef work at 230 s: in-flight calls (30 s timeout) and the rescore must still fit
    // in Vercel's 300 s. Whatever is left runs next time.
    const result = await runWeb(adminDb(), { deadline: started + 230_000 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
