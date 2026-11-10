// Origami webhooks (VIB-521): Standard Webhooks signatures and the sequence.reply.received payload. Pure.
//
// Signed string `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256 keyed by the base64-decoded bytes of the
// `whsec_...` secret (prefix stripped). `webhook-signature` holds one or more space-separated `v1,<base64>` entries (two
// during a 24-hour secret rotation); any match passes. A timestamp more than 5 minutes from now is refused (replay).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Evidence } from "./optouts";

export const TOLERANCE_S = 5 * 60;

export function verifySignature(h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, secret: string, nowMs = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature || !secret) return false;
  if (!/^\d{1,12}$/.test(h.timestamp) || Math.abs(nowMs / 1000 - Number(h.timestamp)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const want = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest();
  for (const part of h.signature.trim().split(/\s+/)) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

/** Test helper and documentation of the scheme: the header value Origami would send. */
export function sign(id: string, timestamp: string, body: string, secret: string) {
  return `v1,${createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

type ReplyEnvelope = {
  type?: string;
  data?: {
    channel?: string; sequence_id?: string; campaign_id?: string | null;
    outreach_target?: { email?: string | null; linkedin_slug?: string | null } | null;
    reply_message?: { body?: string; received_at?: string } | null;
  };
};

/** The evidence a sequence.reply.received event carries, or null when it is not one we can use. The body and identity stay
 *  in memory: they are judged and matched, never stored. Tail matches (additional_matched_sequence_ids) are not separate
 *  evidence: the person's sequences in every campaign are found and stopped from the primary one. */
export function replyEvidence(payload: unknown): Evidence | null {
  const p = payload as ReplyEnvelope;
  if (p?.type !== "sequence.reply.received" || !p.data) return null;
  const d = p.data, m = d.reply_message;
  const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null;
  const seq = uuid(d.sequence_id);
  if (!seq || !m || typeof m.body !== "string" || typeof m.received_at !== "string" || !Number.isFinite(Date.parse(m.received_at))) return null;
  return {
    kind: "reply", source: "webhook", sequence_id: seq, campaign_id: uuid(d.campaign_id), channel: d.channel === "email" || d.channel === "linkedin" ? d.channel : null,
    received_at: new Date(m.received_at).toISOString(), origami_reply_id: null, body: m.body,
    email: d.outreach_target?.email ?? null, linkedin_slug: d.outreach_target?.linkedin_slug ?? null,
  };
}
