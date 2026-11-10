import { NextResponse, after } from "next/server";
import { adminDb } from "@/lib/db";
import { OrigamiClient, origamiApplyEnabled } from "@/lib/origami/client";
import { handleWebhookReply } from "@/lib/origami/optouts";
import { replyEvidence, verifySignature } from "@/lib/origami/webhook";
import { TwentyReader } from "@/lib/twenty";

// Origami webhooks (VIB-521): sequence.reply.received carries a lead's reply. Standard Webhooks signature with
// ORIGAMI_WEBHOOK_SECRET; dormant (503) until the secret is set. Origami delivers at least once, so each webhook-id is
// recorded and a repeat is acknowledged without work. The 2xx goes out at once; the reply is judged, matched and its
// sequences stopped in after(). If that work fails, the hourly poll (/api/cron/team) records the same reply under the same
// evidence key. With ORIGAMI_OPTOUT_APPLY off the delivery is acknowledged and nothing else happens.
export const maxDuration = 120;

export async function POST(request: Request) {
  const secret = process.env.ORIGAMI_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "disabled: ORIGAMI_WEBHOOK_SECRET is not set" }, { status: 503 });
  const body = await request.text();
  const id = request.headers.get("webhook-id");
  if (!verifySignature({ id, timestamp: request.headers.get("webhook-timestamp"), signature: request.headers.get("webhook-signature") }, body, secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: { type?: unknown };
  try { payload = JSON.parse(body || "{}"); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  const event = typeof payload?.type === "string" && /^[a-z][a-z0-9._]{1,60}$/.test(payload.type) ? payload.type : "unknown";
  const db = adminDb();
  const seen = await db.from("gtm_origami_webhook_deliveries").upsert({ webhook_id: id!.slice(0, 200), event }, { onConflict: "webhook_id", ignoreDuplicates: true }).select("webhook_id");
  if (seen.error) return NextResponse.json({ error: "could not record the delivery" }, { status: 500 });
  if (!(seen.data ?? []).length) return NextResponse.json({ ok: true, duplicate: true });
  if (event !== "sequence.reply.received") return NextResponse.json({ ok: true, ignored: event });
  if (!origamiApplyEnabled()) return NextResponse.json({ ok: true, applied: false });
  const evidence = replyEvidence(payload);
  if (!evidence) return NextResponse.json({ ok: true, ignored: "no usable reply" });
  const started = Date.now();
  after(async () => {
    try {
      await handleWebhookReply(db, new TwentyReader({ deadline: started + 100_000 }), new OrigamiClient({ deadline: started + 100_000 }), evidence, new Date());
    } catch { /* the hourly poll records and processes the same reply */ }
  });
  return NextResponse.json({ ok: true });
}
