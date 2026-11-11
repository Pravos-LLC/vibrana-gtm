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
import { TwentyError, type TwentyReader } from "../twenty";
import { addressHash, linkedinHash, replyHash } from "../team/crypto";
import { emailOwners } from "./identity";
import { normAddress } from "../team/restrictions";
import { isDeadline, linkedinSlug, OrigamiClient, OrigamiError, origamiApplyEnabled, origamiConfigured, settled, settledRow, type Campaign, type PersonDetail, type PersonRow, type Reply } from "./client";
import { classifyReply, exactPhrase, RULE_VERSION, unsubscribedStatus, type Classification } from "./rule";
import { applyTwenty } from "../email/suppression";

export { RULE_VERSION };
export const APPROVAL_REF = "auto: origami-reply-v1 (standing decision 2026-11-10, VIB-521)";
export const CURSOR_KEY = "origami.replies";
export const RUN_KEY = "origami.optouts.run";
const STATUS_FULL_KEY = "origami.status.full";
export const STATUS_PAGES_PER_RUN = 12;
// The poll re-reads the last 72 hours every run. `since` is the reply's received time, not when Origami stored it, so a
// reply that a slow LinkedIn or mailbox sync brings in late is still read; evidence already recorded is skipped by its key
// before anything is judged, so the overlap costs one listing.
export const LOOKBACK_MS = 72 * 3_600_000;

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
// What an error may say in last_error (owner-readable): never an address, a profile slug or a Twenty error body, which can
// echo the query's variables.
export const errorText = (e: unknown) => {
  if (e instanceof TwentyError) return "Twenty: the CRM read or write failed";
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 280).replace(/[^\s@]+@[^\s@]+/g, "[address]").replace(/(linkedin\.com)?\/in\/[^\s"',}]+/gi, "[profile]").replace(/%[^\s"',}]*%/g, "[pattern]");
};

/** One key per piece of evidence, whichever path saw it first. Pure. */
export const evidenceKey = (e: Pick<Evidence, "kind" | "sequence_id" | "received_at">) =>
  e.kind === "reply" ? `reply:${e.sequence_id}:${iso(e.received_at)}` : `status:${e.sequence_id}`;

/* ------------------------------------------------------------------------------------------------ reading Origami */

/** Lead replies received since `since`, as evidence. Read-only. */
export async function collectReplies(client: OrigamiClient, since?: string): Promise<{ evidence: Evidence[]; newest: string | null }> {
  return replyEvidence(await client.replies(since));
}

function replyEvidence(rows: Reply[]): { evidence: Evidence[]; newest: string | null } {
  const evidence: Evidence[] = [];
  let newest: string | null = null;
  for (const r of rows) {
    const seq = uuid(r.sequence_id);
    if (typeof r.from === "string" && r.from !== "lead") continue;
    if (r.from !== "lead" || !seq || typeof r.body !== "string" || !Number.isFinite(Date.parse(r.received_at))) throw new Error("Origami replies: malformed lead evidence; page was not acknowledged");
    const at = iso(r.received_at);
    evidence.push({ kind: "reply", source: "poll", sequence_id: seq, campaign_id: uuid(r.campaign_id), channel: r.channel === "email" || r.channel === "linkedin" ? r.channel : null,
      received_at: at, origami_reply_id: uuid(r.id), body: r.body });
    if (!newest || at > newest) newest = at;
  }
  return { evidence, newest };
}

/**
 * Every sequence Origami marked unsubscribed, as evidence. Read-only. Origami shows its unsubscribes as `status: replied,
 * stop_reason: unsubscribed` (production, 2026-11-10), so the hourly scan reads only the `replied` and `unsubscribed`
 * people of each campaign; `full` reads everyone (once a day, in case the status changes).
 */
export async function collectStatuses(client: OrigamiClient, campaigns: Campaign[], now: Date, full = true): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const c of campaigns) {
    const rows = full ? await client.people(c.id) : [...await client.people(c.id, { status: "replied" }), ...await client.people(c.id, { status: "unsubscribed" })];
    for (const p of rows) {
      const seq = uuid(p.sequence_id);
      if (seq && unsubscribedStatus(p)) evidence.push({ kind: "unsubscribed_status", source: "status_scan", sequence_id: seq, campaign_id: c.id.toLowerCase(), channel: null, received_at: now.toISOString(), origami_reply_id: null });
    }
  }
  return evidence;
}

/** Lead replies since `since` and every sequence Origami marked unsubscribed, as evidence. Read-only. */
export async function collect(client: OrigamiClient, opts: { since?: string; now: Date }): Promise<{ evidence: Evidence[]; newest: string | null; campaigns: Campaign[] }> {
  const { evidence, newest } = await collectReplies(client, opts.since);
  const campaigns = await client.campaigns();
  evidence.push(...await collectStatuses(client, campaigns, opts.now, true));
  return { evidence, newest, campaigns };
}

/** Whether the reply received at `receivedAt` is the person's first on the sequence; null when the replies are unknown. */
export function firstReply(d: Pick<PersonDetail, "replies">, receivedAt: string): boolean | null {
  // Unknown unless the replies say who sent them: without `from`, a later "no" must not read as the first one.
  if (!Array.isArray(d.replies) || (d.replies.length && !d.replies.some((r) => typeof r.from === "string"))) return null;
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
    const hits = await emailOwners(reader, id.email);
    if (hits.length > 1) return { match: "ambiguous", person_id: null };
    if (hits.length === 1) return { match: "matched", person_id: hits[0].id, consent: hits[0].gtmMarketingConsent ?? null };
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

/** The plain evidence line an applied opt-out appends to the person's consent evidence: ids and dates only. A status
 *  is dated when the scan saw it, so it says "observed", not "received". Pure. */
export const evidenceRef = (r: Pick<EvidenceRow, "kind" | "channel" | "campaign_id" | "sequence_id" | "received_at">) =>
  `an Origami ${r.channel ? `${r.channel} ` : ""}${r.kind === "reply" ? "reply received" : "unsubscribe observed"} ${iso(r.received_at)} (campaign ${r.campaign_id ?? "unknown"}, sequence ${r.sequence_id}, rule ${RULE_VERSION})`;

/**
 * What one piece of actionable evidence implies. Pure: the same evidence always gives the same keys. Every key carries the
 * evidence id, so a new opt-out after a correction (consent reset in Twenty, a sequence resumed) is a new operation and is
 * applied; the writers make a repeat a no-op (already UNSUBSCRIBED, already stopped).
 */
export function proposeOrigamiOps(r: EvidenceRow, m: Match, seqs: Seq[], labelId: number, now: Date): OpRow[] {
  const confirmed = r.classification === "confirmed";
  const base = { address_hash: null, label_id: labelId, evidence_event_id: null, policy_version: RULE_VERSION, evidence_ref: evidenceRef(r), observed_at: iso(r.received_at), last_error: null } as const;
  const auto = { state: "approved", approved_at: now.toISOString(), approval_ref: APPROVAL_REF } as const;
  const out: OpRow[] = [];
  for (const s of seqs) {
    if (!s.live) continue;
    out.push({ ...base, ...auto, op_key: `stop:${s.campaign_id}:${s.sequence_id}:${r.id}`, destination: "origami", action: "sequence_stop", person_id: m.person_id,
      reason: confirmed ? "UNSUBSCRIBED" : "OPT_OUT_REVIEW", origami_campaign_id: s.campaign_id, origami_sequence_id: s.sequence_id });
  }
  if (m.match === "matched" && m.person_id) {
    if (confirmed) out.push({ ...base, ...auto, op_key: `person:${m.person_id}:optout:origami:${r.id}`, destination: "twenty", action: "person_opt_out", person_id: m.person_id, reason: "UNSUBSCRIBED", origami_campaign_id: null, origami_sequence_id: null });
    // A possible opt-out is a person's review, keyed by its decision (like a Gmail one): never approved here. It is resolved
    // with `gtm suppression origami-reviewed` (resolveOrigamiReviews).
    else out.push({ ...base, op_key: `review:${m.person_id}:origami:${labelId}`, destination: "twenty", action: "person_opt_out", person_id: m.person_id, reason: "OPT_OUT_REVIEW",
      state: "pending_review", approved_at: null, approval_ref: null, origami_campaign_id: null, origami_sequence_id: null });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ recording */

export type IngestResult = { recorded: number; duplicate: number; failed: number; deferred: number; confirmed: number; possible: number; none: number; ids: number[] };

/**
 * Records each piece of evidence once, judged by the rule. A second sight of the same evidence (webhook then poll, a
 * redelivery, an overlapping poll) changes nothing except filling in what the first path did not carry. `ids` are the
 * evidence rows, new or already there, in the order given. The run's deadline defers the rest (not a failure).
 */
export async function ingest(db: SupabaseClient, client: OrigamiClient, items: Evidence[]): Promise<IngestResult> {
  const out: IngestResult = { recorded: 0, duplicate: 0, failed: 0, deferred: 0, confirmed: 0, possible: 0, none: 0, ids: [] };
  for (const [i, e] of items.entries()) {
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
        out.duplicate++; out.ids.push(prior.id);
        continue;
      }
      const j = await judge(client, e);
      const row = {
        evidence_key: key, kind: e.kind, source: e.source, origami_reply_id: e.origami_reply_id, sequence_id: e.sequence_id, campaign_id: e.campaign_id, channel: e.channel,
        received_at: iso(e.received_at), body_hash: e.body != null ? replyHash(e.body) : null, rule_version: RULE_VERSION, classification: j.classification, reason: j.reason,
        first_on_sequence: j.first, match: j.classification === "none" ? "not_needed" : "pending",
      };
      must(await db.from("gtm_origami_replies").upsert(row, { onConflict: "evidence_key", ignoreDuplicates: true }), "record origami evidence");
      const id = (must(await db.from("gtm_origami_replies").select("id").eq("evidence_key", key).single(), "recorded origami evidence") as { id: number }).id;
      out.recorded++; out[j.classification]++; out.ids.push(id);
    } catch (err) {
      if (isDeadline(err)) { out.deferred += items.length - i; break; }
      out.failed++;
    }
  }
  return out;
}

async function ensureLabel(db: SupabaseClient, r: EvidenceRow, m: Match, now: Date): Promise<number> {
  const source = r.kind === "unsubscribed_status" ? "provider" : "deterministic";
  const current = must(await db.from("gtm_email_reply_labels").select("id,person_id").eq("origami_reply_id", r.id).eq("source", source).is("superseded_at", null).maybeSingle(), "origami decision") as { id: number; person_id: string | null } | null;
  // The classification belongs to the evidence, not the CRM match. Retain it if the CRM recovers later;
  // superseding it would invalidate outstanding stops. The matched person is stored on the evidence and operations.
  if (current) return current.id;
  const confirmed = r.classification === "confirmed";
  const row = must(await db.from("gtm_email_reply_labels").insert({ origami_reply_id: r.id, person_id: m.person_id, source, intent: confirmed ? "not_interested" : "uncertain",
    opt_out: confirmed ? "person" : "uncertain", decision_version: 1, labeled_at: now.toISOString() }).select("id").single(), "record origami decision") as { id: number };
  return row.id;
}

/** Writes new operations once; an existing one keeps its state and history. */
async function recordOps(db: SupabaseClient, ops: OpRow[]) {
  if (!ops.length) return;
  must(await db.from("gtm_email_sync_ops").upsert(ops, { onConflict: "op_key,destination", ignoreDuplicates: true }), "record origami operations");
}

type SequenceScan = { campaigns: string[]; campaign: number; term: number; cursor: string | null; found: string[]; done: boolean; seen?: string[];
  page?: { rows: Array<Pick<PersonRow, "sequence_id" | "status" | "stop_reason">>; next: string | null; index: number } };

/** Save each stop as it is found and checkpoint only after an entire search page has been recorded. */
async function scanSequences(db: SupabaseClient, client: OrigamiClient, r: EvidenceRow, id: Identity, detail: PersonDetail,
  campaigns: Campaign[], labelId: number, now: Date): Promise<{ done: boolean; count: number; proposed: number }> {
  const key = `origami.sequence.scan.${r.id}`;
  const state = await readState<SequenceScan>(db, key) ?? { campaigns: campaigns.map((c) => c.id.toLowerCase()), campaign: 0, term: 0, cursor: null, found: [], done: false };
  const unknown: Match = { match: "unmatched", person_id: null };
  let proposed = 0;
  const record = async (campaign: string, sequence: string, live: boolean) => {
    const k = `${campaign}:${sequence}`;
    if (!state.found.includes(k)) state.found.push(k);
    const ops = proposeOrigamiOps(r, unknown, [{ campaign_id: campaign, sequence_id: sequence, live }], labelId, now);
    await recordOps(db, ops);
    proposed += ops.length;
  };
  if (r.campaign_id) await record(r.campaign_id, r.sequence_id, !settled(detail));
  const terms = [id.email, id.slug].filter((v): v is string => !!v);
  let pages = 0, rows = 0;
  while (!state.done && pages < 3 && rows < 8) {
    if (state.campaign >= state.campaigns.length || !terms.length) { state.done = true; break; }
    const campaign = state.campaigns[state.campaign];
    if (!state.page) {
      const page = await client.peoplePage(campaign, { search: terms[state.term] }, state.cursor);
      if (page.next_cursor && (page.next_cursor === state.cursor || state.seen?.includes(page.next_cursor))) throw new Error("Origami people: pagination cursor repeated");
      if (page.items.some((row) => !uuid(row.sequence_id) || typeof row.status !== "string" || (row.stop_reason != null && typeof row.stop_reason !== "string"))) throw new Error("Origami people: malformed sequence; page was not acknowledged");
      // Snapshot only provider IDs and state, never search terms or identity, so a changing page cannot shift our offset.
      state.page = { rows: page.items.map((r) => ({ sequence_id: r.sequence_id, status: r.status, stop_reason: r.stop_reason })), next: page.next_cursor || null, index: 0 };
      await saveState(db, key, state, now);
    }
    while (state.page.index < state.page.rows.length && rows < 8) {
      const row = state.page.rows[state.page.index];
      const seq = uuid(row.sequence_id);
      if (!seq || typeof row.status !== "string") throw new Error("Origami people: malformed sequence; page was not acknowledged");
      if (!settledRow(row)) {
        const person = campaign === r.campaign_id && seq === r.sequence_id ? detail : await client.person(campaign, seq);
        if (sameIdentity(person, id)) await record(campaign, seq, !settled(person));
      }
      state.page.index++; rows++;
      await saveState(db, key, state, now);
    }
    if (state.page.index < state.page.rows.length) break;
    state.cursor = state.page.next;
    delete state.page;
    pages++;
    if (state.cursor) state.seen = [...(state.seen ?? []), state.cursor];
    if (!state.cursor) {
      state.seen = [];
      state.term++;
      if (state.term >= terms.length) { state.term = 0; state.campaign++; }
      if (state.campaign >= state.campaigns.length) state.done = true;
    }
    await saveState(db, key, state, now);
  }
  if (state.done) await saveState(db, key, state, now);
  return { done: state.done, count: state.found.length, proposed };
}

async function takeLease(db: SupabaseClient, job: string, holder: string, waitMs = 0) {
  const until = Date.now() + waitMs;
  for (;;) {
    const lease = await db.rpc("gtm_take_lease", { p_job: job, p_holder: holder, p_seconds: 600 });
    if (!lease.error && lease.data === true) return true;
    if (Date.now() + 3_000 > until) return false;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export type ProcessResult = { processed: number; failed: number; deferred: number; matched: number; ambiguous: number; unmatched: number; stopsProposed: number; labels: number[]; skipped?: string };

/**
 * Identity, Twenty match, the person's sequences everywhere, the decision and the operations, for recorded evidence.
 * `first` (evidence ids) goes before the backlog: the webhook's own reply is never stuck behind older rows. When the run's
 * time is up the rest is deferred, never counted as a failed attempt.
 */
export async function processPending(db: SupabaseClient, client: OrigamiClient, reader: TwentyReader, now: Date,
  opts: { campaigns?: Campaign[]; limit?: number; first?: number[]; waitForLeaseMs?: number; stage?: "matching" | "sequences" } = {}): Promise<ProcessResult> {
  const out: ProcessResult = { processed: 0, failed: 0, deferred: 0, matched: 0, ambiguous: 0, unmatched: 0, stopsProposed: 0, labels: [] };
  const holder = `process-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await takeLease(db, "origami.optouts.process", holder, opts.waitForLeaseMs))) return { ...out, skipped: "another run is processing Origami evidence" };
  try {
    type Pending = EvidenceRow & { attempts: number; match: Match["match"] | "pending"; person_id: string | null };
    const cols = "id,kind,channel,campaign_id,sequence_id,received_at,classification,attempts,match,person_id";
    const pending = () => {
      let q = db.from("gtm_origami_replies").select(cols).is("processed_at", null).neq("classification", "none");
      if (opts.stage === "matching") q = q.eq("match", "pending");
      return q;
    };
    const first = opts.first?.length ? must(await pending().in("id", opts.first).order("id"), "this delivery's evidence") as Pending[] : [];
    const rest = must(await pending().order("updated_at").order("id").limit(opts.limit ?? 25), "pending origami evidence") as Pending[];
    const rows = [...first, ...rest.filter((r) => !first.some((f) => f.id === r.id))];
    if (!rows.length) return out;
    let campaigns = opts.campaigns;
    for (const [i, r] of rows.entries()) {
      try {
        if (opts.stage !== "matching") campaigns ??= await client.campaigns();
        if (!r.campaign_id) throw new Error("the sequence's campaign is not known yet (the hourly poll fills it in)");
        const detail = await client.person(r.campaign_id, r.sequence_id);
        const id = await identityOf(client, { campaign_id: r.campaign_id, sequence_id: r.sequence_id }, detail);
        if (!id.email && !id.slug) throw new Error("Origami has no address or LinkedIn profile for the sequence");
        const unknown: Match = { match: "unmatched", person_id: null };
        const labelId = await ensureLabel(db, r, unknown, now);
        out.labels.push(labelId);
        const scan = opts.stage === "matching" ? await readState<SequenceScan>(db, `origami.sequence.scan.${r.id}`) :
          await scanSequences(db, client, r, id, detail, campaigns!, labelId, now);
        if (scan && "proposed" in scan) out.stopsProposed += scan.proposed;
        let m: Match | null = r.match === "pending" ? null : { match: r.match, person_id: r.person_id };
        if (!m && opts.stage !== "sequences") {
          m = await matchTwenty(reader, id);
          await recordOps(db, proposeOrigamiOps(r, m, [], labelId, now));
        }
        const done = !!scan?.done && !!m;
        const count = scan && "count" in scan ? scan.count : scan?.found.length ?? 0;
        must(await db.from("gtm_origami_replies").update({ ...(done ? { processed_at: now.toISOString() } : {}), ...(m ? { match: m.match, person_id: m.person_id } : {}), sequences_found: count,
          recipient_hash: id.email ? addressHash(id.email) : null, linkedin_hash: id.slug ? linkedinHash(id.slug) : null, last_error: null, updated_at: now.toISOString() }).eq("id", r.id), "origami evidence progress");
        if (done && m) { out.processed++; out[m.match]++; }
        else out.deferred++;
      } catch (e) {
        if (isDeadline(e)) {
          must(await db.from("gtm_origami_replies").update({ updated_at: new Date().toISOString() }).eq("id", r.id), "defer processing");
          out.deferred += rows.length - i; break;
        }
        out.failed++;
        must(await db.from("gtm_origami_replies").update({ attempts: Math.min(r.attempts + 1, 2147483647), last_error: errorText(e), updated_at: new Date().toISOString() }).eq("id", r.id), "record processing failure");
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
 * (404) sends nothing. When the run's time is up the operation goes back as it was, with no attempt counted. Stops for
 * the decisions in `firstLabels` go first. Only with ORIGAMI_OPTOUT_APPLY=1.
 */
export async function applyOrigamiStops(db: SupabaseClient, client: OrigamiClient, now: Date, opts: { limit?: number; firstLabels?: number[] } = {}) {
  if (!origamiApplyEnabled()) return { skipped: "ORIGAMI_OPTOUT_APPLY is not 1" };
  const holder = `stop-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await takeLease(db, "origami.stop.apply", holder))) return { skipped: "another apply holds the lease, or it could not be taken" };
  try {
    const open = () => db.from("gtm_email_sync_ops").select("id,state,attempts,label_id,origami_campaign_id,origami_sequence_id,applied_at").eq("destination", "origami").eq("action", "sequence_stop")
      .in("state", ["approved", "failed", "queued", "applied"]).not("approved_at", "is", null);
    const first = opts.firstLabels?.length ? must(await open().in("label_id", opts.firstLabels).order("id"), "this delivery's stops") as StopOp[] : [];
    const rest = must(await open().order("updated_at").order("id").limit(opts.limit ?? 50), "approved stops") as StopOp[];
    const ops = [...first, ...rest.filter((o) => !first.some((f) => f.id === o.id))];
    const out = { stopped: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0, deferred: 0 };
    for (const [i, op] of ops.entries()) {
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
        if (isDeadline(e)) {
          // Back as it was (an applied one stays applied and is read back next run); no attempt is counted.
          await move(["queued"], { state: op.state === "queued" ? "approved" : op.state }).catch(() => false);
          out.deferred += ops.length - i;
          break;
        }
        out.failed++;
        await move(["queued", "applied"], { state: "failed", attempts: Math.min(op.attempts + 1, 2147483647), last_error: errorText(e) }).catch(() => false);
      }
    }
    return out;
  } finally { await db.rpc("gtm_release_lease", { p_job: "origami.stop.apply", p_holder: holder }); }
}

/* ------------------------------------------------------------------------------------------------ resolving reviews */

export type ReviewDecision = "opt_out" | "not_opt_out" | "handled";

/**
 * A person's decision on Origami evidence (`gtm suppression origami-reviewed`). For a possible opt-out matched to one
 * Twenty person, `opt_out` or `not_opt_out` is required; for evidence no single Twenty person matched, `handled` records
 * that a person dealt with it in Twenty. The rule's decision is superseded by the person's (a `human` decision). Its
 * OPT_OUT_REVIEW hold is canceled, which releases the desk. `opt_out` adds the consent write (approved by this decision)
 * and keeps the stops; `not_opt_out` cancels stops not yet made (a sequence already stopped is resumed in Origami by hand)
 * and any consent write not yet made. What was already written to Twenty is not undone here.
 */
export async function resolveOrigamiReviews(db: SupabaseClient, ids: number[], decision: ReviewDecision, by: string, now: Date) {
  if (!/^.{2,254}$/.test(by)) throw new Error("--by names who decided (2 to 254 characters)");
  // Serialize decisions with the processors and both writers: they snapshot evidence before applying it.
  const holder = `review-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const leases: string[] = [];
  try {
  for (const job of ["origami.optouts.process", "origami.stop.apply", "email.suppression.apply"]) {
    if (!(await takeLease(db, job, holder))) throw new Error(`review cannot start while ${job} is running; retry`);
    leases.push(job);
  }
  type Row = EvidenceRow & { match: string; person_id: string | null; reviewed_at: string | null; processed_at: string | null };
  const rows = must(await db.from("gtm_origami_replies").select("id,kind,channel,campaign_id,sequence_id,received_at,classification,match,person_id,reviewed_at,processed_at").in("id", ids), "origami evidence") as Row[];
  const out = { resolved: 0, skipped: [] as { id: number; why: string }[], consentWrites: 0, holdsReleased: 0, stopsCanceled: 0 };
  for (const r of rows) {
    const matched = r.match === "matched" && !!r.person_id;
    const why = r.reviewed_at ? "already reviewed" : r.classification === "none" ? "not an opt-out" : !r.processed_at ? "not processed yet" :
      matched && decision === "handled" ? "matched: decide --opt-out or --not" : !matched && decision === "opt_out" ? "no single Twenty person: set the opt-out in Twenty, then --handled" : null;
    if (why) { out.skipped.push({ id: r.id, why }); continue; }
    const old = must(await db.from("gtm_email_reply_labels").select("id,source,opt_out,labeled_by").eq("origami_reply_id", r.id).is("superseded_at", null), "current decisions") as { id: number; source: string; opt_out: string; labeled_by: string | null }[];
    const oldIds = old.filter((l) => l.source !== "human").map((l) => l.id);
    const desired = decision === "opt_out" ? "person" : decision === "handled" ? "uncertain" : "none";
    let human = old.find((l) => l.source === "human");
    if (human && (human.opt_out !== desired || human.labeled_by !== by)) throw new Error("a different human decision is already in progress");
    human ??= must(await db.from("gtm_email_reply_labels").insert({ origami_reply_id: r.id, person_id: r.person_id, source: "human", labeled_by: by, decision_version: 1, labeled_at: now.toISOString(),
      intent: decision === "opt_out" ? "not_interested" : decision === "handled" ? "uncertain" : "neutral", opt_out: desired }).select("id,source,opt_out,labeled_by").single(), "record decision") as { id: number; source: string; opt_out: string; labeled_by: string | null };
    const stamp = { updated_at: now.toISOString() };
    if (oldIds.length) {
      const held = must(await db.from("gtm_email_sync_ops").update({ ...stamp, state: "canceled", last_error: "resolved by a person's review" }).in("label_id", oldIds).eq("destination", "twenty")
        .eq("reason", "OPT_OUT_REVIEW").in("state", ["pending_review", "approved", "failed", "held"]).select("id"), "release the review") as unknown[];
      out.holdsReleased += held.length;
      if (decision !== "not_opt_out") {
        // The stops carry on under the person's decision (a superseded decision would cancel them).
        must(await db.from("gtm_email_sync_ops").update({ ...stamp, label_id: human.id, ...(decision === "opt_out" ? { reason: "UNSUBSCRIBED" } : {}) }).in("label_id", oldIds).eq("destination", "origami").in("state", ["approved", "failed", "queued", "applied"]), "keep the stops");
        if (decision === "opt_out") must(await db.from("gtm_email_sync_ops").update({ ...stamp, label_id: human.id }).in("label_id", oldIds).eq("destination", "twenty").eq("reason", "UNSUBSCRIBED").in("state", ["approved", "failed", "queued", "applied"]), "keep the consent write");
      } else {
        const stops = must(await db.from("gtm_email_sync_ops").update({ ...stamp, state: "canceled", last_error: "not an opt-out (a person's review)" }).in("label_id", oldIds).in("state", ["approved", "failed", "pending_review"]).select("id"), "cancel the rest") as unknown[];
        out.stopsCanceled += stops.length;
      }
      for (const id of oldIds) must(await db.from("gtm_email_reply_labels").update({ superseded_at: now.toISOString() }).eq("id", id), "supersede decision");
    }
    if (decision === "opt_out" && matched) {
      must(await db.from("gtm_email_sync_ops").upsert({ op_key: `person:${r.person_id}:optout:origami:${r.id}`, destination: "twenty", action: "person_opt_out", person_id: r.person_id, address_hash: null,
        reason: "UNSUBSCRIBED", label_id: human.id, evidence_event_id: null, policy_version: RULE_VERSION, evidence_ref: evidenceRef(r), observed_at: iso(r.received_at),
        state: "approved", approved_at: now.toISOString(), approval_ref: `human review (VIB-521): ${by}`.slice(0, 200) }, { onConflict: "op_key,destination", ignoreDuplicates: true }), "consent write");
      out.consentWrites++;
    }
    must(await db.from("gtm_origami_replies").update({ reviewed_at: now.toISOString(), reviewed_by: by, ...stamp }).eq("id", r.id).is("reviewed_at", null), "mark reviewed");
    out.resolved++;
  }
  for (const id of ids) if (!rows.some((r) => r.id === id)) out.skipped.push({ id, why: "no such evidence" });
  return out;
  } finally {
    for (const job of leases.reverse()) await db.rpc("gtm_release_lease", { p_job: job, p_holder: holder });
  }
}

/* ------------------------------------------------------------------------------------------------ the hourly step */

/**
 * `lastOkAt`: the last run that finished every stage with nothing left over (a full pass). `lastProgressAt`: the last run
 * with no error that read and recorded the newest replies, while older scans may still be carried to the next run.
 * `firstAt`: when this state was first written, the reference for a full pass that has never happened.
 */
export type RunState = { at: string; ok: boolean; error: string | null; lastOkAt: string | null; deferred?: boolean; lastProgressAt?: string | null; firstAt?: string };
type ReplyCursor = { since?: string; scanSince?: string | null; nextCursor?: string | null; newest?: string | null; seen?: string[] };
const readState = async <T>(db: SupabaseClient, key: string) => (must(await db.from("gtm_sync_state").select("value").eq("key", key).maybeSingle(), `read ${key}`) as { value: T } | null)?.value ?? null;
const saveState = async (db: SupabaseClient, key: string, value: unknown, now: Date) =>
  must(await db.from("gtm_sync_state").upsert({ key, value, updated_at: now.toISOString() }, { onConflict: "key" }), `save ${key}`);

async function pollPages(db: SupabaseClient, client: OrigamiClient, key: string, now: Date, initialSince?: string) {
  const cursor = await readState<ReplyCursor>(db, key);
  const since = cursor?.nextCursor ? cursor.scanSince ?? undefined : cursor?.since ? new Date(Date.parse(cursor.since) - LOOKBACK_MS).toISOString() : initialSince;
  let pageCursor = cursor?.nextCursor ?? null, newest = cursor?.nextCursor ? cursor.newest ?? null : null;
  const seen = new Set(cursor?.nextCursor ? cursor.seen ?? [cursor.nextCursor] : []);
  let read = 0, recorded = 0;
  for (let page = 0; page < 3; page++) {
    const result = await client.repliesPage(since, pageCursor);
    if (result.next_cursor && (result.next_cursor === pageCursor || seen.has(result.next_cursor))) throw new Error("Origami replies: pagination cursor repeated");
    const parsed = replyEvidence(result.items ?? []);
    const saved = await ingest(db, client, parsed.evidence);
    read += parsed.evidence.length; recorded += saved.recorded;
    if (saved.failed) throw new Error("Origami replies: evidence could not be recorded; page will be retried");
    if (saved.deferred) return { read, recorded, deferred: 1 };
    if (parsed.newest && (!newest || parsed.newest > newest)) newest = parsed.newest;
    pageCursor = result.next_cursor || null;
    if (pageCursor) { seen.add(pageCursor); await saveState(db, key, { since: cursor?.since, scanSince: since ?? null, nextCursor: pageCursor, newest, seen: [...seen] }, now); }
    else {
      const next = [cursor?.since, newest].filter((x): x is string => !!x).sort().pop();
      await saveState(db, key, { since: next ?? null }, now);
      return { read, recorded, deferred: 0 };
    }
  }
  return { read, recorded, deferred: 1 };
}

type StatusScan = { campaigns: string[]; full: boolean; campaign: number; filter: number; cursor: string | null; seen?: string[] };
async function scanCampaignPages(db: SupabaseClient, client: OrigamiClient, now: Date) {
  const key = "origami.campaigns.scan";
  const state = await readState<{ cursor: string | null; campaigns: Campaign[]; seen?: string[] }>(db, key) ?? { cursor: null, campaigns: [], seen: [] as string[] };
  for (let i = 0; i < 3; i++) {
    const page = await client.campaignsPage(state.cursor);
    if (page.next_cursor && (page.next_cursor === state.cursor || state.seen?.includes(page.next_cursor))) throw new Error("Origami campaigns: pagination cursor repeated");
    for (const c of page.items ?? []) {
      if (!uuid(c.id)) throw new Error("Origami campaigns: malformed campaign; page was not acknowledged");
      if (!state.campaigns.some((x) => x.id === c.id)) state.campaigns.push({ id: c.id.toLowerCase(), status: c.status });
    }
    state.cursor = page.next_cursor || null;
    if (state.cursor) state.seen = [...(state.seen ?? []), state.cursor];
    if (!state.cursor) {
      must(await db.from("gtm_sync_state").delete().eq("key", key), "finish campaigns scan");
      return { campaigns: state.campaigns, deferred: 0 };
    }
    await saveState(db, key, state, now);
  }
  return { campaigns: [] as Campaign[], deferred: 1 };
}
async function scanStatusPages(db: SupabaseClient, client: OrigamiClient, campaigns: Campaign[], now: Date) {
  const key = "origami.status.scan";
  const prior = await readState<StatusScan>(db, key);
  const full = await readState<{ at?: string }>(db, STATUS_FULL_KEY);
  const state: StatusScan = prior ?? { campaigns: campaigns.map((c) => c.id.toLowerCase()), full: !full?.at || now.getTime() - Date.parse(full.at) > 20 * 3_600_000, campaign: 0, filter: 0, cursor: null };
  let recorded = 0;
  // Up to STATUS_PAGES_PER_RUN pages, still bounded by the stage's time slice; each page is checkpointed. At 3 pages a
  // pass over 8 campaigns (two filters each) took about 10 hourly runs.
  for (let pages = 0; pages < STATUS_PAGES_PER_RUN && state.campaign < state.campaigns.length; pages++) {
    const campaign = state.campaigns[state.campaign];
    const filter = state.full ? {} : { status: ["replied", "unsubscribed"][state.filter] };
    const page = await client.peoplePage(campaign, filter, state.cursor);
    if (page.next_cursor && (page.next_cursor === state.cursor || state.seen?.includes(page.next_cursor))) throw new Error("Origami statuses: pagination cursor repeated");
    const evidence: Evidence[] = [];
    for (const p of page.items ?? []) {
      if (!uuid(p.sequence_id) || typeof p.status !== "string" || (p.stop_reason != null && typeof p.stop_reason !== "string")) throw new Error("Origami statuses: malformed sequence; page was not acknowledged");
      if (unsubscribedStatus(p)) evidence.push({ kind: "unsubscribed_status", source: "status_scan", sequence_id: p.sequence_id.toLowerCase(), campaign_id: campaign, channel: null, received_at: now.toISOString(), origami_reply_id: null });
    }
    const saved = await ingest(db, client, evidence);
    recorded += saved.recorded;
    if (saved.failed) throw new Error("Origami statuses: evidence could not be recorded; page will be retried");
    if (saved.deferred) return { recorded, deferred: 1 };
    state.cursor = page.next_cursor || null;
    if (state.cursor) state.seen = [...(state.seen ?? []), state.cursor];
    else state.seen = [];
    if (!state.cursor && (state.full || ++state.filter >= 2)) { state.filter = 0; state.campaign++; }
    await saveState(db, key, state, now);
  }
  if (state.campaign < state.campaigns.length) return { recorded, deferred: 1 };
  if (state.full) await saveState(db, STATUS_FULL_KEY, { at: now.toISOString() }, now);
  must(await db.from("gtm_sync_state").delete().eq("key", key), "finish status scan");
  return { recorded, deferred: 0 };
}

/**
 * The team cron's Origami step, off unless ORIGAMI_OPTOUT_APPLY=1. In order: stops already approved; replies (the last 72
 * hours past the cursor), recorded, processed and stopped; then Origami's own unsubscribes (`replied` and `unsubscribed`
 * people hourly, everyone daily), the same way. Running out of time defers work to the next run. The outcome is saved
 * (`origami.optouts.run`) for the health check, which raises an incident when the step fails.
 */
export async function runOrigamiOptouts(db: SupabaseClient, reader: TwentyReader, now: Date, opts: { deadline: number; client?: OrigamiClient }) {
  if (!origamiConfigured()) return { skipped: "ORIGAMI_API_KEY is not set" };
  if (!origamiApplyEnabled()) return { skipped: "ORIGAMI_OPTOUT_APPLY is not 1 (dry run: gtm suppression origami-plan)" };
  const client = opts.client ?? new OrigamiClient({ deadline: opts.deadline });
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  let deferred = false;
  // Each stage has a separate time slice, so a slow provider cannot consume the whole hourly run.
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (Date.now() >= opts.deadline) { deferred = true; return undefined; }
    const end = Math.min(opts.deadline, Date.now() + 9_000);
    client.setDeadline(end); reader.setDeadline(end);
    try {
      const result = await fn();
      out[name] = result;
      if (result && typeof result === "object" && Number((result as { deferred?: number }).deferred ?? 0) > 0) deferred = true;
      return result;
    } catch (e) {
      if (isDeadline(e)) deferred = true; else errors.push(`${name}: ${errorText(e)}`);
      return undefined;
    }
  };
  await phase("stopsFirst", () => applyOrigamiStops(db, client, now));
  // Always inspect the newest page, even while either checkpointed scan is working through an older backlog.
  const fresh = await phase("freshHead", async () => {
    const page = await client.repliesPage(new Date(now.getTime() - LOOKBACK_MS).toISOString());
    const parsed = replyEvidence(page.items ?? []);
    const saved = await ingest(db, client, parsed.evidence);
    if (saved.failed) throw new Error("fresh reply evidence could not be recorded");
    return { read: parsed.evidence.length, recorded: saved.recorded, deferred: saved.deferred };
  });
  await phase("freshReplies", () => pollPages(db, client, "origami.replies.fresh", now, new Date(now.getTime() - LOOKBACK_MS).toISOString()));
  await phase("replies", () => pollPages(db, client, CURSOR_KEY, now));
  const campaignScan = await phase("campaigns", () => scanCampaignPages(db, client, now));
  if (campaignScan && !campaignScan.deferred) {
    await phase("statuses", () => scanStatusPages(db, client, campaignScan.campaigns, now));
    await phase("sequences", async () => ({ ...await processPending(db, client, reader, now, { campaigns: campaignScan.campaigns, stage: "sequences" }), labels: undefined }));
  }
  await phase("matching", async () => ({ ...await processPending(db, client, reader, now, { stage: "matching" }), labels: undefined }));
  delete out.campaigns;
  await phase("stops", () => applyOrigamiStops(db, client, now));
  client.setDeadline(opts.deadline); reader.setDeadline(opts.deadline);
  const error = errors.length ? errors.join("; ").slice(0, 280) : null;
  const prev = await readState<RunState>(db, RUN_KEY).catch(() => null);
  // Progress: no stage failed and the newest replies were read and recorded. Deferred backlog alone is not a failure.
  const progressed = !error && !!fresh && !fresh.deferred;
  const state: RunState = { at: now.toISOString(), ok: !error && !deferred, error, lastOkAt: error || deferred ? prev?.lastOkAt ?? null : now.toISOString(), deferred,
    lastProgressAt: progressed ? now.toISOString() : prev?.lastProgressAt ?? null, firstAt: prev?.firstAt ?? prev?.at ?? now.toISOString() };
  await saveState(db, RUN_KEY, state, now).catch(() => undefined);
  return { ...out, ...(error ? { error } : {}), deferred, requests: client.requests.count };
}

/** The webhook's work, after the 2xx: this reply first, then its stops, then the Twenty write, at once. */
export async function handleWebhookReply(db: SupabaseClient, reader: TwentyReader, client: OrigamiClient, e: Evidence, now: Date) {
  const ingested = await ingest(db, client, [e]);
  // Waits briefly for the hourly run's lease rather than leave this reply to the next hour.
  const processed = await processPending(db, client, reader, now, { first: ingested.ids, limit: 5, waitForLeaseMs: 30_000 });
  const stops = await applyOrigamiStops(db, client, now, { limit: 25, firstLabels: processed.labels });
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
