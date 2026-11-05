import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { runPipeline } from "@/lib/sales/run";

// Vercel cron, hourly at :50: the pipeline dashboard's stored numbers (stage history, outreach outcomes, the Twenty
// lastContactedAt write-back, site traffic). Its own route so a slow mailbox or CRM never delays the content sync.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runPipeline(adminDb(), { deadline: Date.now() + 250_000 }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
