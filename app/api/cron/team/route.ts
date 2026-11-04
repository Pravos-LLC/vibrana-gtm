import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { loadRuntimeConfig } from "@/lib/runtime-config.mjs";
import { runTeam } from "@/lib/team/run";
import { teamMembers } from "@/lib/team/members";

// Vercel cron, hourly at :20: team performance (/performance/team). Its own route rather than part of /api/cron/sync,
// whose people step can use most of that route's budget: Twenty reads here are paced (one at a time, 1.5 s apart) and
// a CRM or Gmail failure must never fail the content sync.
// The run's own deadline is 250 s, leaving room for a last Twenty read (20 s) and the alert (10 s) inside 300 s.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    const members = teamMembers();
    if (!members.length) return NextResponse.json({ skipped: "GTM_TEAM_MEMBERS is not set" });
    const mail = loadRuntimeConfig().mail;
    const result = await runTeam(adminDb(), members, { deadline: started + 250_000, notify: { to: process.env.REPORT_EMAIL_TO ?? mail.notify, from: process.env.REPORT_EMAIL_FROM ?? mail.from } });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
