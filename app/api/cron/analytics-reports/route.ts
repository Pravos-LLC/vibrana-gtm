import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { loadRuntimeConfig } from "@/lib/runtime-config.mjs";
import { deliverReports } from "@/lib/analytics-reports/store";

// Vercel cron, hourly at :40: email John a link to each newly published analytics report, and from Monday noon
// in Bali, alert once when last week has no report (lib/analytics-reports/store.ts).
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const mail = loadRuntimeConfig().mail;
    const r = await deliverReports(adminDb(), { to: process.env.REPORT_EMAIL_TO ?? mail.notify, from: process.env.REPORT_EMAIL_FROM ?? mail.from });
    return NextResponse.json(r, { status: r.errors.length ? 500 : 200 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
