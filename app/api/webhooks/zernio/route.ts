import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import { adminDb } from "@/lib/db";
import { syncStatus } from "@/lib/sync";
import { syncDelta } from "@/lib/analytics/delta";
import { ingestEngageEvent } from "@/lib/engage/ingest";

// The 2xx goes out at once; after() work (a fast thread's classification and red-flag check, VIB-424)
// may take up to a model call, so the function gets room beyond the default.
export const maxDuration = 120;

// Zernio signs the raw body: X-Zernio-Signature = hex HMAC-SHA256(secret, body). Must 2xx within 5s.
export async function POST(request: Request) {
  const body = await request.text();
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  const sig = Buffer.from((request.headers.get("x-zernio-signature") ?? request.headers.get("x-late-signature") ?? "").trim().toLowerCase(), "hex");
  const expected = createHmac("sha256", secret ?? "").update(body).digest();
  if (!secret || sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const event = request.headers.get("x-zernio-event") ?? "unknown";
  const eventId = request.headers.get("x-zernio-event-id") ?? createHmac("sha256", "id").update(body).digest("hex");
  const { error } = await adminDb().from("gtm_zernio_events").upsert({ event_id: eventId, event, payload });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (event.startsWith("post.")) after(() => syncStatus().then(() => undefined));
  // An account's analytics sync finished: fold the changed posts into today's snapshots (VIB-417).
  if (event === "analytics.synced") after(() => syncDelta(adminDb()).then(() => undefined));
  // Comments and DMs feed the engage queue; the daily run replays stored events if this step fails.
  if (event === "comment.received" || event === "message.received") after(() => ingestEngageEvent(event, payload));
  return NextResponse.json({ ok: true });
}
