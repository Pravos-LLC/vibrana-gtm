import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/db";
import { intakeEmailComments } from "@/lib/engage/intake";

// LinkedIn email intake (VIB-423): the Hermes box (or the Mac) reads LinkedIn's comment notification
// emails with gog and posts the parsed comments here. Guarded by CRON_SECRET like the crons.
export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  try {
    return NextResponse.json(await intakeEmailComments(adminDb(), body));
  } catch (e) {
    const status = e instanceof TypeError ? 400 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
