import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { MIRROR_LEASE, runMirror } from "@/lib/crm/mirror";
import { TwentyReader, twentyHealthy } from "@/lib/twenty";

// Vercel cron, hourly at :05: the CRM people mirror (lib/crm/mirror.ts). Its own route and lease, so the paced Twenty
// reads never share a budget with the team or pipeline runs, and only one mirror run reads Twenty at a time.
// The run's own deadline is 250 s, leaving room for a last Twenty read inside 300 s.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const db = adminDb();
  const holder = `mirror-${started}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = await db.rpc("gtm_take_lease", { p_job: MIRROR_LEASE, p_holder: holder, p_seconds: 300 });
  if (lease.error) return NextResponse.json({ skipped: `the lease could not be taken (${lease.error.code ?? "error"})` });
  if (lease.data !== true) return NextResponse.json({ skipped: "another mirror run holds the lease" });
  try {
    const result = await runMirror(db, new TwentyReader({ deadline: started + 250_000 }), { health: () => twentyHealthy() });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    await db.rpc("gtm_release_lease", { p_job: MIRROR_LEASE, p_holder: holder });
  }
}
