import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { engageAgentAuthorized } from "@/lib/engage-agent-auth";
import { handleAgent } from "@/lib/engage/agent";

// Engage from Claude Code. Guarded by ENGAGE_AGENT_TOKEN, a secret of its own (not CRON_SECRET). One POST per
// verb: { verb: "next" | "reply" | "copied" | "skip" | "hide" | "not-spam" | "lesson", ...fields }.
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!engageAgentAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  try {
    const r = await handleAgent(adminDb(), String(body.verb ?? ""), body);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
