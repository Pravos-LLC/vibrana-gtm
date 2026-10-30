import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { runEngage } from "@/lib/engage/run";

// Vercel cron, once a day at 23:00 UTC (07:00 in Bali): poll the comment inbox for anything the webhook
// missed, draft replies for new comments and DMs, and email John "N replies to approve".
export const maxDuration = 300;

export async function GET(request: Request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // Drafting stops starting new posts at 230 s so in-flight calls and the email fit inside 300 s.
    const r = await runEngage(adminDb(), { deadline: started + 230_000 });
    return NextResponse.json({ ...r.stats, errors: r.errors.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
