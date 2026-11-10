// Origami opt-outs (Linear VIB-521). Origami has no global suppression: its exclusion list blocks no API enrollment
// (VIB-497 scope test) and an "Unsubscribe" reply stops only that one sequence. Compliance (hub outbound-compliance
// safeguard 2, operational condition 2) needs immediate global suppression, with any reply that reads as a refusal treated
// as an opt-out. This carries Origami opt-outs into the Twenty CRM and stops the person in every Origami campaign.
//
// Evidence: lead replies (the sequence.reply.received webhook and the hourly poll of GET /send/replies) and sequences
// Origami itself marked unsubscribed (seen as stop_reason `unsubscribed`, status `replied`, on production 2026-11-10; the
// `?status=unsubscribed` filter returned none). Both paths feed one idempotent ingest keyed on (sequence, received time).
// Rule origami-reply-v1 (lib/origami/rule.ts) judges each reply in memory; no body, address or profile URL is stored.
//
// What follows, only when ORIGAMI_OPTOUT_APPLY=1 (John's decision 2026-11-10: confirmed opt-outs apply without a
// per-operation approval once one dry run is approved; `gtm suppression origami-plan` is that dry run):
// - CONFIRMED, one Twenty person: gtmMarketingConsent=UNSUBSCRIBED plus an evidence line, through the guarded Twenty
//   writer (lib/email/suppression.ts applyTwenty), one operation per person (`person:<id>:optout:origami`) however many
//   replies, campaigns or paths reported it.
// - POSSIBLE, one Twenty person: an OPT_OUT_REVIEW operation, which holds email on the desk until a person decides. No
//   consent write.
// - Either: every live sequence of that person (same address or LinkedIn slug) in EVERY Origami campaign is stopped
//   (POST .../people/{sequence_id}/stop, history kept), checked first and read back. A stop is reversible.
// - Zero or several Twenty people: never guessed. The sequences still stop; a health incident asks a person to match it.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TwentyReader } from "../twenty";
import { addressHash, linkedinHash, replyHash } from "../team/crypto";
import { lookupPeople } from "../team/mailbox";
import { normAddress } from "../team/restrictions";
import { linkedinSlug, OrigamiClient, OrigamiError, origamiApplyEnabled, origamiConfigured, settled, settledRow, type Campaign, type PersonDetail, type PersonRow } from "./client";
import { classifyReply, exactPhrase, RULE_VERSION, unsubscribedStatus, type Classification } from "./rule";
import { applyTwenty } from "../email/suppression";

export { RULE_VERSION };
export const APPROVAL_REF = "auto: origami-reply-v1 (standing decision 2026-11-10, VIB-521)";
export const CURSOR_KEY = "origami.replies";
// The poll re-reads the last 10 minutes each run, so a reply stored out of order on Origami's side is still seen.
const OVERLAP_MS = 10 * 60_000;

export type Evidence = {
  kind: "reply" | "unsubscribed_status";
  source: "webhook" | "poll" | "status_scan";
  sequence_id: string; campaign_id: string | null; channel: "email" | "linkedin" | null;
  received_at: string; origami_reply_id: string | null;
  // In memory only: judged and matched, never stored.
  body?: string; email?: string | null; linkedin_slug?: string | null;
};
export type Identity = { email: string | null; slug: string | null };
export type Match = { match: "matched" | "ambiguous" | "unmatched"; person_id: string | null; consent?: string | null };
export type Seq = { campaign_id: string; sequence_id: string; live: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const iso = (s: string) => new Date(s).toISOString();
const clean = (m: string) => m.slice(0, 280).replace(/[^\s@]+@[^\s@]+/g, "[address]").replace(/linkedin\.com\/in\/\S+/gi, "[profile]");

/** One key per piece of evidence, whichever path saw it first. Pure. */
export const evidenceKey = (e: Pick<Evidence, "kind" | "sequence_id" | "received_at">) =>
  e.kind === "reply" ? `reply:${e.sequence_id}:${iso(e.received_at)}` : `status:${e.sequence_id}`;

/* ------------------------------------------------------------------------------------------------ reading Origami */

/** Lead replies since `since` and every sequence Origami marked unsubscribed, as evidence. Read-only. */
export async function collect(client: OrigamiClient, opts: { since?: string; now: Date }): Promise<{ evidence: Evidence[]; newest: string | null; campaigns: Campaign[] }> {
  const evidence: Evidence[] = [];
  let newest: string | null = null;
  for (const r of await client.replies(opts.since)) {
    const seq = uuid(r.sequence_id);
    if (r.from !== "lead" || !seq || typeof r.body !== "string" || !Number.isFinite(Date.parse(r.received_at))) continue;
    const at = iso(r.received_at);
    evidence.push({ kind: "reply", source: "poll", sequence_id: seq, campaign_id: uuid(r.campaign_id), channel: r.channel === "email" || r.channel === "linkedin" ? r.channel : null,
      received_at: at, origami_reply_id: uuid(r.id), body: r.body });
    if (!newest || at > newest) newest = at;
  }
  const campaigns = await client.campaigns();
  for (const c of campaigns) {
    for (const p of await client.people(c.id)) {
      const seq = uuid(p.sequence_id);
      if (seq && unsubscribedStatus(p)) evidence.push({ kind: "unsubscribed_status", source: "status_scan", sequence_id: seq, campaign_id: c.id.toLowerCase(), channel: null, received_at: opts.now.toISOString(), origami_reply_id: null });
    }
  }
  return { evidence, newest, campaigns };
}

/** Whether the reply received at `receivedAt` is the person's first on the sequence; null when the replies are unknown. */
export function firstReply(d: Pick<PersonDetail, "replies">, receivedAt: string): boolean | null {
  if (!Array.isArray(d.replies)) return null;
  const at = Date.parse(receivedAt);
  return !d.replies.some((r) => r.from === "lead" && Date.parse(r.received_at) < at);
}

/** The rule's verdict. Reads Origami only for an exact phrase, to establish whether it was the first reply. */
export async function judge(client: OrigamiClient, e: Evidence): Promise<{ classification: Classification; reason: string; first: boolean | null; detail?: PersonDetail }> {
  if (e.kind === "unsubscribed_status") return { classification: "confirmed", reason: "origami_unsubscribed", first: null };
  const body = e.body ?? "";
  let first: boolean | null = null, detail: PersonDetail | undefined;
  if (exactPhrase(body) && e.campaign_id) {
    detail = await client.person(e.campaign_id, e.sequence_id);
    first = firstReply(detail, e.received_at);
  }
  return { ...classifyReply(body, first), first, detail };
}

/** Who replied, from the evidence or from the sequence on Origami. */
export async function identityOf(client: OrigamiClient, e: Pick<Evidence, "campaign_id" | "sequence_id" | "email" | "linkedin_slug">, detail?: PersonDetail): Promise<Identity> {
  let email = e.email ? normAddress(e.email) || null : null, slug = linkedinSlug(e.linkedin_slug);
  if ((!email || !slug) && e.campaign_id) {
    const d = detail ?? await client.person(e.campaign_id, e.sequence_id);
    email ??= normAddress(d.identity?.email) || null;
    slug ??= linkedinSlug(d.identity?.linkedin_url);
  }
  return { email, slug };
}

const sameIdentity = (d: PersonDetail, id: Identity) =>
  (!!id.email && normAddress(d.identity?.email) === id.email) || (!!id.slug && linkedinSlug(d.identity?.linkedin_url) === id.slug);

/**
 * The person's sequences in every campaign (draft, paused and active alike: a draft sends once launched). Each campaign is
 * searched by address and by slug, and every live hit is read and checked for the exact identity (search is fuzzy). A row
 * Origami already stopped needs no read. The evidence's own sequence is always included.
 */
export async function findSequences(client: OrigamiClient, id: Identity, origin: { campaign_id: string | null; sequence_id: string } | null, campaigns: Campaign[]): Promise<Seq[]> {
  const found = new Map<string, Seq>(), skipped = new Set<string>();
  const consider = async (campaign: string, row: Pick<PersonRow, "sequence_id" | "status" | "stop_reason">) => {
    const k = `${campaign}:${row.sequence_id}`;
    if (found.has(k) || skipped.has(k)) return;
    if (settledRow(row)) { skipped.add(k); return; }
    const d = await client.person(campaign, row.sequence_id);
    if (!sameIdentity(d, id)) { skipped.add(k); return; }
    found.set(k, { campaign_id: campaign, sequence_id: row.sequence_id.toLowerCase(), live: !settled(d) });
  };
  for (const c of campaigns) {
    const cid = c.id.toLowerCase();
    for (const term of [id.email, id.slug]) {
      if (!term) continue;
      for (const row of await client.people(cid, { search: term })) if (uuid(row.sequence_id)) await consider(cid, row);
    }
  }
  if (origin?.campaign_id && !found.has(`${origin.campaign_id}:${origin.sequence_id}`)) {
    const d = await client.person(origin.campaign_id, origin.sequence_id);
    if (!settled(d)) found.set(`${origin.campaign_id}:${origin.sequence_id}`, { campaign_id: origin.campaign_id, sequence_id: origin.sequence_id, live: true });
  }
  return [...found.values()];
}

/* ------------------------------------------------------------------------------------------------ matching Twenty */

/** Exactly one Twenty person by address (primary or additional), else by LinkedIn slug. Never a guess. Read-only. */
export async function matchTwenty(reader: TwentyReader, id: Identity): Promise<Match> {
  if (id.email) {
    const m = (await lookupPeople(reader, [id.email])).get(id.email);
    if (m && "ambiguous" in m) return { match: "ambiguous", person_id: null };
    if (m) return { match: "matched", person_id: m.person.id, consent: m.person.gtmMarketingConsent ?? null };
  }
  if (id.slug) {
    type Row = { id: string; gtmMarketingConsent: string | null; linkedinLink: { primaryLinkUrl: string | null } | null };
    // ilike can only widen (`_` and `%`); every row is re-checked for the exact slug.
    const rows = await reader.all<Row>("people", "id gtmMarketingConsent linkedinLink { primaryLinkUrl }", { linkedinLink: { primaryLinkUrl: { ilike: `%/in/${id.slug}%` } } }, "PersonFilterInput", 20, 200);
    const hits = rows.filter((r) => linkedinSlug(r.linkedinLink?.primaryLinkUrl) === id.slug);
    if (hits.length > 1) return { match: "ambiguous", person_id: null };
    if (hits.length === 1) return { match: "matched", person_id: hits[0].id, consent: hits[0].gtmMarketingConsent };
  }
  return { match: "unmatched", person_id: null };
}

/* ------------------------------------------------------------------------------------------------ the operations */

type EvidenceRow = { id: number; kind: Evidence["kind"]; channel: string | null; campaign_id: string | null; sequence_id: string; received_at: string; classification: Classification };
export type OpRow = {
  op_key: string; destination: "twenty" | "origami"; action: "person_opt_out" | "sequence_stop"; person_id: string | null; address_hash: null;
  reason: "UNSUBSCRIBED" | "OPT_OUT_REVIEW"; label_id: number; evidence_event_id: null; policy_version: string; state: "approved" | "pending_review";
  approved_at: string | null; approval_ref: string | null; origami_campaign_id: string | null; origami_sequence_id: string | null; evidence_ref: string;
  observed_at: string; last_error: null;
};

/** The plain evidence line an applied opt-out appends to the person's consent evidence: ids and dates only. Pure. */
export const evidenceRef = (r: Pick<EvidenceRow, "kind" | "channel" | "campaign_id" | "sequence_id" | "received_at">) =>
  `an Origami ${r.channel ? `${r.channel} ` : ""}${r.kind === "reply" ? "reply" : "unsubscribe"} received ${iso(r.received_at)} (campaign ${r.campaign_id ?? "unknown"}, sequence ${r.sequence_id}, rule ${RULE_VERSION})`;

/** What one piece of actionable evidence implies. Pure: the same evidence always gives the same keys. */
export function proposeOrigamiOps(r: EvidenceRow, m: Match, seqs: Seq[], labelId: number, now: Date): OpRow[] {
  const confirmed = r.classification === "confirmed";
  const base = { address_hash: null, label_id: labelId, evidence_event_id: null, policy_version: RULE_VERSION, evidence_ref: evidenceRef(r), observed_at: iso(r.received_at), last_error: null } as const;
  const auto = { state: "approved", approved_at: now.toISOString(), approval_ref: APPROVAL_REF } as const;
  const out: OpRow[] = [];
  for (const s of seqs) {
    if (!s.live) continue;
    out.push({ ...base, ...auto, op_key: `stop:${s.campaign_id}:${s.sequence_id}`, destination: "origami", action: "sequence_stop", person_id: m.person_id,
      reason: confirmed ? "UNSUBSCRIBED" : "OPT_OUT_REVIEW", origami_campaign_id: s.campaign_id, origami_sequence_id: s.sequence_id });
  }
  if (m.match === "matched" && m.person_id) {
    if (confirmed) out.push({ ...base, ...auto, op_key: `person:${m.person_id}:optout:origami`, destination: "twenty", action: "person_opt_out", person_id: m.person_id, reason: "UNSUBSCRIBED", origami_campaign_id: null, origami_sequence_id: null });
    // A possible opt-out is a person's review, keyed by its decision (like a Gmail one): never approved here.
    else out.push({ ...base, op_key: `review:${m.person_id}:origami:${labelId}`, destination: "twenty", action: "person_opt_out", person_id: m.person_id, reason: "OPT_OUT_REVIEW",
      state: "pending_review", approved_at: null, approval_ref: null, origami_campaign_id: null, origami_sequence_id: null });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ recording */

export type IngestResult = { recorded: number; duplicate: number; failed: number; confirmed: number; possible: number; none: number };

/**
 * Records each piece of evidence once, judged by the rule. A second sight of the same evidence (webhook then poll, a
 * redelivery, an overlapping poll) changes nothing except filling in what the first path did not carry.
 */
export async function ingest(db: SupabaseClient, client: OrigamiClient, items: Evidence[]): Promise<IngestResult> {
  const out: IngestResult = { recorded: 0, duplicate: 0, failed: 0, confirmed: 0, possible: 0, none: 0 };
  for (const e of items) {
    try {
      const key = evidenceKey(e);
      type Prior = { id: number; origami_reply_id: string | null; campaign_id: string | null };
      let prior = must(await db.from("gtm_origami_replies").select("id,origami_reply_id,campaign_id").eq("evidence_key", key).maybeSingle(), "origami evidence") as Prior | null;
      if (!prior && e.origami_reply_id) prior = must(await db.from("gtm_origami_replies").select("id,origami_reply_id,campaign_id").eq("origami_reply_id", e.origami_reply_id).maybeSingle(), "origami evidence by reply id") as Prior | null;
      if (prior) {
        const patch: Record<string, string> = {};
        if (!prior.origami_reply_id && e.origami_reply_id) patch.origami_reply_id = e.origami_reply_id;
        if (!prior.campaign_id && e.campaign_id) patch.campaign_id = e.campaign_id;
        if (Object.keys(patch).length) must(await db.from("gtm_origami_replies").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", prior.id), "complete origami evidence");
        out.duplicate++;
        continue;
      }
      const j = await judge(client, e);
      const row = {
        evidence_key: key, kind: e.kind, source: e.source, origami_reply_id: e.origami_reply_id, sequence_id: e.sequence_id, campaign_id: e.campaign_id, channel: e.channel,
        received_at: iso(e.received_at), body_hash: e.body != null ? replyHash(e.body) : null, rule_version: RULE_VERSION, classification: j.classification, reason: j.reason,
        first_on_sequence: j.first, match: j.classification === "none" ? "not_needed" : "pending",
      };
      must(await db.from("gtm_origami_replies").upsert(row, { onConflict: "evidence_key", ignoreDuplicates: true }), "record origami evidence");
      out.recorded++; out[j.classification]++;
    } catch { out.failed++; }
  }
  return out;
}

async function ensureLabel(db: SupabaseClient, r: EvidenceRow, m: Match, now: Date): Promise<number> {
  const source = r.kind === "unsubscribed_status" ? "provider" : "deterministic";
  const current = must(await db.from("gtm_email_reply_labels").select("id,person_id").eq("origami_reply_id", r.id).eq("source", source).is("superseded_at", null).maybeSingle(), "origami decision") as { id: number; person_id: string | null } | null;
  if (current && current.person_id === m.person_id) return current.id;
  // Decisions are append-only: a later match (an unmatched person now in Twenty) supersedes the old one.
  if (current) must(await db.from("gtm_email_reply_labels").update({ superseded_at: now.toISOString() }).eq("id", current.id), "supersede origami decision");
  const confirmed = r.classification === "confirmed";
  const row = must(await db.from("gtm_email_reply_labels").insert({ origami_reply_id: r.id, person_id: m.person_id, source, intent: confirmed ? "not_interested" : "uncertain",
    opt_out: confirmed ? "person" : "uncertain", decision_version: 1, labeled_at: now.toISOString() }).select("id").single(), "record origami decision") as { id: number };
  return row.id;
}

/** Writes new operations once. An auto-applied one canceled earlier (its evidence corrected) reopens on new evidence. */
async function recordOps(db: SupabaseClient, ops: OpRow[], now: Date) {
  if (!ops.length) return;
  must(await db.from("gtm_email_sync_ops").upsert(ops, { onConflict: "op_key,destination", ignoreDuplicates: true }), "record origami operations");
  for (const o of ops.filter((x) => x.state === "approved")) {
    must(await db.from("gtm_email_sync_ops").update({ state: "approved", approved_at: now.toISOString(), approval_ref: APPROVAL_REF, label_id: o.label_id, attempts: 0, last_error: null, updated_at: now.toISOString() })
      .eq("op_key", o.op_key).eq("destination", o.destination).eq("state", "canceled"), "reopen origami operation");
  }
}

export type ProcessResult = { processed: number; failed: number; matched: number; ambiguous: number; unmatched: number; stopsProposed: number; skipped?: string };

/** Identity, Twenty match, the person's sequences everywhere, the decision and the operations, for recorded evidence. */
export async function processPending(db: SupabaseClient, client: OrigamiClient, reader: TwentyReader, now: Date, opts: { campaigns?: Campaign[]; limit?: number } = {}): Promise<ProcessResult> {
  const out: ProcessResult = { processed: 0, failed: 0, matched: 0, ambiguous: 0, unmatched: 0, stopsProposed: 0 };
  const holder = `process-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = await db.rpc("gtm_take_lease", { p_job: "origami.optouts.process", p_holder: holder, p_seconds: 600 });
  if (lease.error || lease.data !== true) return { ...out, skipped: "another run is processing Origami evidence" };
  try {
    type Pending = EvidenceRow & { attempts: number };
    const rows = must(await db.from("gtm_origami_replies").select("id,kind,channel,campaign_id,sequence_id,received_at,classification,attempts").is("processed_at", null)
      .neq("classification", "none").lt("attempts", 10).order("id").limit(opts.limit ?? 25), "pending origami evidence") as Pending[];
    if (!rows.length) return out;
    const campaigns = opts.campaigns ?? await client.campaigns();
    for (const r of rows) {
      try {
        if (!r.campaign_id) throw new Error("the sequence's campaign is not known yet (the hourly poll fills it in)");
        const id = await identityOf(client, { campaign_id: r.campaign_id, sequence_id: r.sequence_id });
        if (!id.email && !id.slug) throw new Error("Origami has no address or LinkedIn profile for the sequence");
        const m = await matchTwenty(reader, id);
        const seqs = await findSequences(client, id, { campaign_id: r.campaign_id, sequence_id: r.sequence_id }, campaigns);
        const labelId = await ensureLabel(db, r, m, now);
        const ops = proposeOrigamiOps(r, m, seqs, labelId, now);
        await recordOps(db, ops, now);
        must(await db.from("gtm_origami_replies").update({ processed_at: now.toISOString(), match: m.match, person_id: m.person_id, sequences_found: seqs.length,
          recipient_hash: id.email ? addressHash(id.email) : null, linkedin_hash: id.slug ? linkedinHash(id.slug) : null, last_error: null, updated_at: now.toISOString() }).eq("id", r.id), "origami evidence processed");
        out.processed++; out[m.match]++; out.stopsProposed += ops.filter((o) => o.action === "sequence_stop").length;
      } catch (e) {
        out.failed++;
        await db.from("gtm_origami_replies").update({ attempts: r.attempts + 1, last_error: clean((e as Error).message), updated_at: new Date().toISOString() }).eq("id", r.id);
      }
    }
    return out;
  } finally { await db.rpc("gtm_release_lease", { p_job: "origami.optouts.process", p_holder: holder }); }
}

/* ------------------------------------------------------------------------------------------------ the Origami writer */

type StopOp = { id: number; state: string; attempts: number; label_id: number | null; origami_campaign_id: string; origami_sequence_id: string; applied_at: string | null };

/**
 * Stops approved sequences one at a time, under its own lease. Each is read first (already stopped is success), stopped,
 * then read back; it is confirmed only when Origami shows it can send nothing more. A sequence Origami no longer has
 * (404) sends nothing. Only with ORIGAMI_OPTOUT_APPLY=1.
 */
export async function applyOrigamiStops(db: SupabaseClient, client: OrigamiClient, now: Date, limit = 50) {
  if (!origamiApplyEnabled()) return { skipped: "ORIGAMI_OPTOUT_APPLY is not 1" };
  const holder = `stop-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = await db.rpc("gtm_take_lease", { p_job: "origami.stop.apply", p_holder: holder, p_seconds: 600 });
  if (lease.error || lease.data !== true) return { skipped: "another apply holds the lease, or it could not be taken" };
  try {
    const ops = must(await db.from("gtm_email_sync_ops").select("id,state,attempts,label_id,origami_campaign_id,origami_sequence_id,applied_at").eq("destination", "origami").eq("action", "sequence_stop")
      .in("state", ["approved", "failed", "queued", "applied"]).not("approved_at", "is", null).lt("attempts", 5).order("id").limit(limit), "approved stops") as StopOp[];
    const out = { stopped: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0 };
    for (const op of ops) {
      const move = async (from: string[], patch: Record<string, unknown>) => {
        const r = await db.from("gtm_email_sync_ops").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", op.id).in("state", from).select("id");
        if (r.error) throw new Error(`operation state: ${r.error.message}`);
        return (r.data ?? []).length === 1;
      };
      if (!(await move([op.state], { state: "queued" }))) { out.lost++; continue; }
      try {
        if (op.label_id != null) {
          const l = must(await db.from("gtm_email_reply_labels").select("superseded_at").eq("id", op.label_id).maybeSingle(), "stop evidence") as { superseded_at: string | null } | null;
          if (!l || l.superseded_at) { if (await move(["queued"], { state: "canceled", last_error: "evidence no longer current" })) out.canceled++; continue; }
        }
        const read = async () => {
          try { return settled(await client.person(op.origami_campaign_id, op.origami_sequence_id)); } catch (e) {
            if (e instanceof OrigamiError && e.status === 404) return true;
            throw e;
          }
        };
        let changed = false;
        if (!(await read())) {
          try { await client.stop(op.origami_campaign_id, op.origami_sequence_id, `vib521-stop-${op.id}`); } catch (e) {
            // A conflict can mean it stopped meanwhile; the read-back decides.
            if (!(e instanceof OrigamiError && e.status === 409)) throw e;
          }
          changed = true;
          if (!(await move(["queued"], { state: "applied", applied_at: now.toISOString() }))) throw new Error("the operation changed state while applying");
          if (!(await read())) throw new Error("read-back: the sequence can still send");
        }
        if (!(await move(["queued", "applied"], { state: "confirmed", confirmed_at: new Date().toISOString(), last_error: null, applied_at: op.applied_at ?? now.toISOString() }))) {
          throw new Error("the operation changed state before it was confirmed");
        }
        if (changed) out.stopped++; else out.unchanged++;
      } catch (e) {
        out.failed++;
        await move(["queued", "applied"], { state: "failed", attempts: op.attempts + 1, last_error: clean((e as Error).message) }).catch(() => false);
      }
    }
    return out;
  } finally { await db.rpc("gtm_release_lease", { p_job: "origami.stop.apply", p_holder: holder }); }
}

/* ------------------------------------------------------------------------------------------------ the hourly step */

/** The team cron's Origami step: poll since the cursor, record, process, stop. Off unless ORIGAMI_OPTOUT_APPLY=1. */
export async function runOrigamiOptouts(db: SupabaseClient, reader: TwentyReader, now: Date, opts: { deadline: number; client?: OrigamiClient }) {
  if (!origamiConfigured()) return { skipped: "ORIGAMI_API_KEY is not set" };
  if (!origamiApplyEnabled()) return { skipped: "ORIGAMI_OPTOUT_APPLY is not 1 (dry run: gtm suppression origami-plan)" };
  const client = opts.client ?? new OrigamiClient({ deadline: opts.deadline });
  const state = (must(await db.from("gtm_sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle(), "origami cursor") as { value: { since?: string } } | null)?.value ?? null;
  const since = state?.since ? new Date(Date.parse(state.since) - OVERLAP_MS).toISOString() : undefined;
  const { evidence, newest, campaigns } = await collect(client, { since, now });
  const ingested = await ingest(db, client, evidence);
  // The cursor moves only when everything read was recorded, so a failed item is read again next hour.
  if (!ingested.failed) {
    const next = [state?.since, newest].filter((x): x is string => !!x).sort().pop();
    if (next) must(await db.from("gtm_sync_state").upsert({ key: CURSOR_KEY, value: { since: next, at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" }), "save origami cursor");
  }
  const processed = await processPending(db, client, reader, now, { campaigns });
  const stops = await applyOrigamiStops(db, client, now);
  return { evidence: evidence.length, ingested, processed, stops, requests: client.requests.count };
}

/** The webhook's work, after the 2xx: record this reply, process it, stop the sequences and write Twenty at once. */
export async function handleWebhookReply(db: SupabaseClient, reader: TwentyReader, client: OrigamiClient, e: Evidence, now: Date) {
  const ingested = await ingest(db, client, [e]);
  const processed = await processPending(db, client, reader, now, { limit: 5 });
  const stops = await applyOrigamiStops(db, client, now, 25);
  // The same guarded writer and lease as the hourly run; a held lease leaves the write to the next run.
  const twenty = await applyTwenty(db, reader, now, 5);
  return { ingested, processed, stops, twenty };
}

/* ------------------------------------------------------------------------------------------------ the dry run */

export type PlanReport = {
  rule: string; since: string | null; evidence: number; replies: number; unsubscribedStatuses: number;
  byClassification: Record<Classification, number>; byReason: Record<string, number>;
  people: { confirmed: number; possible: number; noIdentity: number };
  twenty: { checked: boolean; matched: number; ambiguous: number; unmatched: number; consentWrites: number; alreadyUnsubscribed: number; reviewHolds: number; note?: string };
  origami: { sequencesToStop: number; campaignsAffected: number; campaignsScanned: number; requests: number; writes: number };
};

/**
 * What turning ORIGAMI_OPTOUT_APPLY on would do with the evidence on Origami now. Origami reads only (and Twenty reads when
 * a reader is given); no database, no write anywhere. Counts only: no person, address, profile or text.
 */
export async function planOrigami(client: OrigamiClient, reader: TwentyReader | null, now: Date, opts: { since?: string } = {}): Promise<PlanReport> {
  const { evidence, campaigns } = await collect(client, { since: opts.since, now });
  const report: PlanReport = {
    rule: RULE_VERSION, since: opts.since ?? null, evidence: evidence.length, replies: evidence.filter((e) => e.kind === "reply").length, unsubscribedStatuses: evidence.filter((e) => e.kind !== "reply").length,
    byClassification: { confirmed: 0, possible: 0, none: 0 }, byReason: {}, people: { confirmed: 0, possible: 0, noIdentity: 0 },
    twenty: { checked: !!reader, matched: 0, ambiguous: 0, unmatched: 0, consentWrites: 0, alreadyUnsubscribed: 0, reviewHolds: 0, ...(reader ? {} : { note: "TWENTY_API_KEY not set: people were not matched to Twenty" }) },
    origami: { sequencesToStop: 0, campaignsAffected: 0, campaignsScanned: campaigns.length, requests: 0, writes: 0 },
  };
  const people = new Map<string, { confirmed: boolean; match: Match | null; seqs: Seq[] }>();
  const seen = new Set<string>();
  for (const e of evidence) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    const j = await judge(client, e);
    report.byClassification[j.classification]++;
    report.byReason[j.reason] = (report.byReason[j.reason] ?? 0) + 1;
    if (j.classification === "none") continue;
    const id = await identityOf(client, e, j.detail);
    if (!id.email && !id.slug) { report.people.noIdentity++; continue; }
    const pk = createHash("sha256").update(`${id.email ?? ""}|${id.slug ?? ""}`).digest("hex");
    const prior = people.get(pk);
    if (prior) { prior.confirmed ||= j.classification === "confirmed"; continue; }
    const match = reader ? await matchTwenty(reader, id) : null;
    const seqs = await findSequences(client, id, { campaign_id: e.campaign_id, sequence_id: e.sequence_id }, campaigns);
    people.set(pk, { confirmed: j.classification === "confirmed", match, seqs });
  }
  const live = new Map<string, string>();
  for (const p of people.values()) {
    report.people[p.confirmed ? "confirmed" : "possible"]++;
    for (const s of p.seqs) if (s.live) live.set(`${s.campaign_id}:${s.sequence_id}`, s.campaign_id);
    if (!p.match) continue;
    report.twenty[p.match.match]++;
    if (p.match.match !== "matched") continue;
    if (!p.confirmed) report.twenty.reviewHolds++;
    else if (p.match.consent === "UNSUBSCRIBED") report.twenty.alreadyUnsubscribed++;
    else report.twenty.consentWrites++;
  }
  report.origami.sequencesToStop = live.size;
  report.origami.campaignsAffected = new Set(live.values()).size;
  report.origami.requests = client.requests.count;
  report.origami.writes = client.requests.writes;
  return report;
}
