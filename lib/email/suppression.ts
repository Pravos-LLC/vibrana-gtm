// Email suppression (email contract v1, Linear VIB-497; this slice VIB-513). Confirmed outcomes become restriction
// operations, one per destination, each with its own state (gtm_email_sync_ops): pending review -> approved -> applied ->
// read-back confirmed, or failed/held. Nothing reaches Twenty or Origami without an approval recorded on the operation,
// and the writer runs only with EMAIL_SUPPRESSION_APPLY=1. The first production apply needs Abe's or John's approval of a
// dry-run report (`gtm suppression plan`); the first Origami exclusion push also needs the provider's scope verified, so
// every Origami operation is held until then.
//
// What each outcome becomes (VIB-497 section 2):
// - A permanently invalid address (failed_invalid_address on an attempt): an address restriction on that person, that
//   address only. Never person-wide INVALID, never another address.
// - A person-level opt-out from a person or the provider: gtmMarketingConsent=UNSUBSCRIBED, which keeps its existing,
//   broader effect (protected(): meeting capture and enrichment hold the person). The dry run counts those people.
// - An address-scoped opt-out: an address restriction with that reason.
// - A possible opt-out (the rules or a model): a review operation. It is not applied; it holds email on the desk.
// - Temporary failures, policy/authentication failures, untyped failures, replies and silence: nothing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TwentyReader } from "../twenty";
import { addressHash } from "../team/crypto";
import { selectAll } from "../team/mailbox";
import { emailRefusals, personEmails, readRestrictions, RESTRICTIONS_FIELD, UNREADABLE } from "../team/restrictions";

export const POLICY_VERSION = "suppression-v1";
export const ORIGAMI_HELD = "Origami exclusion scope and queued-send behavior not verified yet (VIB-513, AC497-05)";

export type Op = {
  op_key: string; destination: "twenty" | "origami"; action: "person_opt_out" | "address_restrict" | "address_opt_out" | "exclusion_upsert";
  person_id: string; address_hash: string | null; reason: string; evidence_event_id: number | null; label_id: number | null;
  policy_version: string; state: "pending_review" | "held"; last_error: string | null; observed_at: string;
};
type AttemptIn = { event_id: number; person_id: string | null; recipient_hash: string; delivery: string; delivery_at: string | null; delivery_event_id: number | null };
type LabelIn = { id: number; event_id: number | null; person_id: string | null; source: string; opt_out: string; superseded_at: string | null; labeled_at: string };

const both = (o: Omit<Op, "destination" | "state" | "last_error" | "policy_version">, twentyState: Op["state"] = "pending_review"): Op[] => [
  { ...o, destination: "twenty", state: twentyState, last_error: null, policy_version: POLICY_VERSION },
  { ...o, destination: "origami", action: "exclusion_upsert", state: "held", last_error: ORIGAMI_HELD, policy_version: POLICY_VERSION },
];

/** The operations the evidence implies. Pure; the same evidence always gives the same op keys. */
export function proposeOps(attempts: AttemptIn[], labels: LabelIn[], replySender: Map<number, string>): Op[] {
  const out: Op[] = [];
  for (const a of attempts) {
    if (a.delivery !== "failed_invalid_address" || !a.person_id) continue;
    out.push(...both({ op_key: `addr:${a.person_id}:${a.recipient_hash}:bounce`.toLowerCase(), action: "address_restrict", person_id: a.person_id, address_hash: a.recipient_hash,
      reason: "EMAIL_BOUNCED", evidence_event_id: a.delivery_event_id ?? a.event_id, label_id: null, observed_at: a.delivery_at ?? new Date(0).toISOString() }));
  }
  for (const l of labels) {
    if (l.superseded_at || !l.person_id || l.opt_out === "none") continue;
    const confirmed = l.source === "human" || l.source === "provider";
    if (l.opt_out === "person" && confirmed) {
      out.push(...both({ op_key: `person:${l.person_id}:optout:${l.id}`, action: "person_opt_out", person_id: l.person_id, address_hash: null, reason: "UNSUBSCRIBED", evidence_event_id: l.event_id, label_id: l.id, observed_at: l.labeled_at }));
    } else if (l.opt_out === "address" && confirmed && l.event_id != null && replySender.get(l.event_id)) {
      const h = replySender.get(l.event_id)!;
      out.push(...both({ op_key: `addr:${l.person_id}:${h}:optout:${l.id}`.toLowerCase(), action: "address_opt_out", person_id: l.person_id, address_hash: h, reason: "ADDRESS_OPT_OUT", evidence_event_id: l.event_id, label_id: l.id, observed_at: l.labeled_at }));
    } else {
      // A possible opt-out, or one whose scope is unclear: a person decides. Only the review exists, never an apply.
      // Keyed by the label: a renewed possible opt-out after a correction is a new review, never the canceled one (finding 3).
      out.push({ op_key: `review:${l.person_id}:${l.event_id ?? "none"}:${l.id}`, destination: "twenty", action: "person_opt_out", person_id: l.person_id, address_hash: null, reason: "OPT_OUT_REVIEW",
        evidence_event_id: l.event_id, label_id: l.id, policy_version: POLICY_VERSION, state: "pending_review", last_error: null, observed_at: l.labeled_at });
    }
  }
  return out;
}

/** Writes new proposals once; an existing operation keeps its state and history. */
export async function recordProposals(db: SupabaseClient, ops: Op[]) {
  if (!ops.length) return 0;
  must(await db.from("gtm_email_sync_ops").upsert(ops, { onConflict: "op_key,destination", ignoreDuplicates: true }), "record proposals");
  return ops.length;
}

export async function detect(db: SupabaseClient) {
  type A = AttemptIn & { id: number };
  const attempts = await selectAll<A>((f, t) => db.from("gtm_email_attempts").select("id,event_id,person_id,recipient_hash,delivery,delivery_at,delivery_event_id").eq("delivery", "failed_invalid_address").order("id").range(f, t), "failed attempts");
  const labels = await selectAll<LabelIn>((f, t) => db.from("gtm_email_reply_labels").select("id,event_id,person_id,source,opt_out,superseded_at,labeled_at").neq("opt_out", "none").is("superseded_at", null).order("id").range(f, t), "opt-out decisions");
  const replyIds = [...new Set(labels.map((l) => l.event_id).filter((x): x is number => x != null))];
  const sender = new Map<number, string>();
  for (let i = 0; i < replyIds.length; i += 200) {
    for (const e of must(await db.from("gtm_team_mail_events").select("id,recipient_hashes").in("id", replyIds.slice(i, i + 200)), "reply senders") as { id: number; recipient_hashes: string[] }[]) {
      if (e.recipient_hashes?.length === 1) sender.set(e.id, e.recipient_hashes[0]);
    }
  }
  const ops = proposeOps(attempts, labels, sender);
  await recordProposals(db, ops);
  // Operations whose evidence is no longer current (a decision corrected or superseded, a review resolved) are canceled
  // before anything is applied; a new decision is a new operation needing its own approval (review of #33, finding 3).
  // Written history (applied, confirmed) is never undone here.
  const current = new Set(ops.map((o) => `${o.op_key}|${o.destination}`));
  const open = must(await db.from("gtm_email_sync_ops").select("id,op_key,destination").in("state", ["pending_review", "approved", "failed", "held"]), "open operations") as { id: number; op_key: string; destination: string }[];
  const stale = open.filter((o) => !current.has(`${o.op_key}|${o.destination}`)).map((o) => o.id);
  for (let i = 0; i < stale.length; i += 200) {
    must(await db.from("gtm_email_sync_ops").update({ state: "canceled", last_error: "evidence no longer current", updated_at: new Date().toISOString() }).in("id", stale.slice(i, i + 200)).in("state", ["pending_review", "approved", "failed", "held"]), "cancel stale operations");
  }
  return ops;
}

/* ------------------------------------------------------------------------------------------------ dry run */

export type StoredOp = Omit<Op, "state"> & { state: string; id: number; approved_at: string | null; approval_ref: string | null; applied_at: string | null; confirmed_at: string | null; attempts: number; created_at: string };

/** The dry-run report: counts only, no person, no address. Includes what a person opt-out also does elsewhere. */
export function planReport(ops: StoredOp[]) {
  const by = (k: (o: StoredOp) => string) => ops.reduce<Record<string, number>>((m, o) => ((m[k(o)] = (m[k(o)] ?? 0) + 1), m), {});
  const people = new Set(ops.map((o) => o.person_id));
  const optOutPeople = new Set(ops.filter((o) => o.destination === "twenty" && o.action === "person_opt_out" && o.reason === "UNSUBSCRIBED").map((o) => o.person_id));
  return {
    policyVersion: POLICY_VERSION, operations: ops.length, people: people.size,
    byDestinationAndState: by((o) => `${o.destination}:${o.state}`), byActionAndReason: by((o) => `${o.destination}:${o.action}:${o.reason}`),
    downstream: {
      personOptOuts: optOutPeople.size,
      note: "A person opt-out sets gtmMarketingConsent=UNSUBSCRIBED: the existing protected() rule then also holds that person's future meeting capture and enrichment. Address restrictions change email only.",
    },
    origami: { held: ops.filter((o) => o.destination === "origami" && o.state === "held").length, reason: ORIGAMI_HELD },
    reviewsWaiting: ops.filter((o) => o.reason === "OPT_OUT_REVIEW" && o.state === "pending_review").length,
  };
}

/** Approve the listed pending Twenty operations against a recorded dry run. Reviews (OPT_OUT_REVIEW) are never approvable. */
export async function approve(db: SupabaseClient, ids: number[], ref: string, now: Date) {
  if (!/^.{8,200}$/.test(ref)) throw new Error("--ref names the dry run and who approved it (8 to 200 characters)");
  const rows = must(await db.from("gtm_email_sync_ops").update({ state: "approved", approved_at: now.toISOString(), approval_ref: ref, updated_at: now.toISOString() })
    .in("id", ids).eq("destination", "twenty").eq("state", "pending_review").neq("reason", "OPT_OUT_REVIEW").select("id"), "approve") as { id: number }[];
  return rows.length;
}

/* ------------------------------------------------------------------------------------------------ the Twenty writer */

type Live = { id: string; updatedAt: string; emails: { primaryEmail: string | null; additionalEmails?: unknown } | null; gtmMarketingConsent: string | null; gtmConsentEvidence: string | null; gtmEmailRestrictions?: unknown };
const READ = `id updatedAt emails { primaryEmail additionalEmails } gtmMarketingConsent gtmConsentEvidence ${RESTRICTIONS_FIELD}`;

/** The change one approved operation makes, from the live person; null when it is already in place. Pure. */
export function changeFor(op: StoredOp, p: Live, now: Date): { data: Record<string, unknown> } | { error: string } | null {
  if (op.action === "person_opt_out") {
    if (p.gtmMarketingConsent === "UNSUBSCRIBED") return null;
    const line = `UNSUBSCRIBED from an email reply on ${op.observed_at.slice(0, 10)} (cockpit gtm:op:${op.id}).`;
    // Existing evidence is kept whole; the opt-out line is appended, never at the cost of earlier proof (Twenty TEXT has no
    // length limit).
    return { data: { gtmMarketingConsent: "UNSUBSCRIBED", gtmConsentEvidence: [p.gtmConsentEvidence, line].filter(Boolean).join("\n") } };
  }
  const r = readRestrictions(p);
  if (!r.ok) return { error: "the person's gtmEmailRestrictions is unreadable; fix it in Twenty first" };
  const address = personEmails(p).find((e) => addressHash(e) === op.address_hash);
  if (!address) return { error: "the address is no longer on the person" };
  if (r.addresses.has(address)) return null;
  // The stored value may be an object or its JSON text; merge from exactly what was read (review of #33, finding 2).
  // "" is the CRM's empty value (lib/team/restrictions.ts), not malformed JSON.
  const parsed = typeof p.gtmEmailRestrictions === "string" ? (p.gtmEmailRestrictions.trim() ? JSON.parse(p.gtmEmailRestrictions) : {}) : p.gtmEmailRestrictions;
  const raw = (parsed && typeof parsed === "object") ? parsed as { addresses?: Record<string, unknown>; holds?: unknown[] } : {};
  return { data: { [RESTRICTIONS_FIELD]: { version: 1, holds: raw.holds ?? [], addresses: { ...(raw.addresses ?? {}),
    [address]: { reason: op.reason, source: "gtm", sourceRef: `gtm:op:${op.id}`, observedAt: op.observed_at, recordedAt: now.toISOString() } } } } };
}

export const applyEnabled = (env: Record<string, string | undefined> = process.env) => env.EMAIL_SUPPRESSION_APPLY === "1";

/** The version guard vibrana-crm uses (qualification/crm.py version_filter): Twenty returns updatedAt in milliseconds but
 *  stores microseconds, so an exact match would never hit; the read stamp's millisecond window is matched instead. */
export function versionFilter(id: string, updatedAt: string) {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) throw new Error("the person's updatedAt is unreadable");
  return { id: { eq: id }, updatedAt: { gte: new Date(at).toISOString(), lt: new Date(at + 1).toISOString() } };
}

/**
 * Applies approved Twenty operations one at a time through the paced reader, under the apply lease the cron and the CLI
 * share. Each write is conditional on the person's updatedAt as read (Twenty's filtered update: one server-side UPDATE
 * ... WHERE id AND updatedAt), so a concurrent human edit is never overwritten; the op retries next run (finding 1).
 * Only the owned fields are written, and an op is confirmed only on read-back. An op left `applied` by a crash is resumed:
 * read back first, written again only if the change is not there (finding 5). Origami operations are never touched here.
 */
export async function applyTwenty(db: SupabaseClient, reader: TwentyReader, now: Date, limit = 25) {
  if (!applyEnabled()) return { skipped: "EMAIL_SUPPRESSION_APPLY is not 1" };
  const holder = `apply-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = await db.rpc("gtm_take_lease", { p_job: "email.suppression.apply", p_holder: holder, p_seconds: 600 });
  if (lease.error || lease.data !== true) return { skipped: "another apply holds the lease, or it could not be taken" };
  try {
    // `queued` is only ever left by a crashed apply (this lease is exclusive), so it is resumed like `applied`.
    const ops = must(await db.from("gtm_email_sync_ops").select("*").eq("destination", "twenty").in("state", ["approved", "failed", "queued", "applied"]).not("approved_at", "is", null)
      .lt("attempts", 5).order("id").limit(limit), "approved operations") as StoredOp[];
    const out = { confirmed: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0 };
    const person = async (id: string) => (await reader.all<Live>("people", READ, { id: { eq: id } }, "PersonFilterInput", 1, 1))[0] ?? null;
    for (const op of ops) {
      // Every transition is conditional on the state this run holds, and must change exactly one row (finding 2).
      const move = async (from: string[], patch: Record<string, unknown>) => {
        const r = await db.from("gtm_email_sync_ops").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", op.id).in("state", from).select("id");
        if (r.error) throw new Error(`operation state: ${r.error.message}`);
        return (r.data ?? []).length === 1;
      };
      // Claim before any side effect: `queued` is outside what detect cancels, so a cancel either lands first (the claim
      // finds nothing) or not at all. Then the evidence is checked as it is now.
      if (!(await move([op.state], { state: "queued" }))) { out.lost++; continue; }
      try {
        if (!(await evidenceCurrent(db, op))) {
          if (await move(["queued"], { state: "canceled", last_error: "evidence no longer current" })) out.canceled++;
          continue;
        }
        const live = await person(op.person_id);
        if (!live) throw new Error("the person is not in Twenty");
        const c = changeFor(op, live, now);
        if (c && "error" in c) throw new Error(c.error);
        if (c) {
          const res = await reader.read<{ updatePeople: { id: string }[] }>("mutation($f:PersonFilterInput!,$d:PersonUpdateInput!){ updatePeople(filter:$f, data:$d) { id } }",
            { f: versionFilter(op.person_id, live.updatedAt), d: c.data });
          if (!res.updatePeople?.length) throw new Error("the person changed while applying; retried next run");
          if (!(await move(["queued"], { state: "applied", applied_at: now.toISOString() }))) throw new Error("the operation changed state while applying");
        }
        const back = await person(op.person_id);
        if (!back || changeFor(op, back, now) !== null) throw new Error("read-back does not show the change");
        if (!(await move(["queued", "applied"], { state: "confirmed", confirmed_at: new Date().toISOString(), last_error: null, applied_at: op.applied_at ?? now.toISOString() }))) {
          throw new Error("the operation changed state before it was confirmed");
        }
        if (c) out.confirmed++; else out.unchanged++;
      } catch (e) {
        out.failed++;
        await move(["queued", "applied"], { state: "failed", attempts: op.attempts + 1, last_error: (e as Error).message.slice(0, 300).replace(/[^\s@]+@[^\s@]+/g, "[address]") }).catch(() => false);
      }
    }
    return out;
  } finally { await db.rpc("gtm_release_lease", { p_job: "email.suppression.apply", p_holder: holder }); }
}

/** Whether an operation's evidence still stands: its label current and unchanged in scope, or the address failure still
 *  recorded as permanent. A correction since approval cancels the operation instead of writing it (finding 2). */
export async function evidenceCurrent(db: SupabaseClient, op: StoredOp): Promise<boolean> {
  if (op.label_id != null) {
    const r = await db.from("gtm_email_reply_labels").select("superseded_at,opt_out,source").eq("id", op.label_id).maybeSingle();
    if (r.error) throw new Error(`evidence: ${r.error.message}`);
    const l = r.data as { superseded_at: string | null; opt_out: string; source: string } | null;
    if (!l || l.superseded_at || (l.source !== "human" && l.source !== "provider")) return false;
    return op.action === "person_opt_out" ? l.opt_out === "person" : l.opt_out === "address";
  }
  if (op.action !== "address_restrict" || !op.address_hash) return false;
  const r = await db.from("gtm_email_attempts").select("id").eq("person_id", op.person_id).eq("recipient_hash", op.address_hash).eq("delivery", "failed_invalid_address").limit(1);
  if (r.error) throw new Error(`evidence: ${r.error.message}`);
  return (r.data ?? []).length > 0;
}

/* ------------------------------------------------------------------------------------------------ the desk guard */

/**
 * Why the desk must not mark an email sent to this person at this address: a confirmed or pending opt-out (including a
 * possible one under review), a restriction on the address, or a permanent failure already seen there. [] means no hold.
 * The desk cannot stop a send from Gmail itself; it refuses to record one and says why.
 */
export async function emailHolds(db: SupabaseClient, personId: string, address: string | null, reader?: TwentyReader): Promise<string[]> {
  const out: string[] = [];
  // Twenty's own state first: a restriction or opt-out a person set there has no local operation (review of #33,
  // finding 4). Fails closed: if Twenty cannot be read, the desk does not record the send.
  if (reader) {
    let live: Live | null;
    try { live = (await reader.all<Live>("people", READ, { id: { eq: personId } }, "PersonFilterInput", 1, 1))[0] ?? null; } catch {
      return ["the CRM could not be checked for email restrictions; try again"];
    }
    if (live) {
      if (live.gtmMarketingConsent === "UNSUBSCRIBED") out.push("they opted out");
      for (const r of emailRefusals(live, address)) {
        const why = r === UNREADABLE ? "the CRM's email restrictions are unreadable" : r.startsWith("email_hold_") ? "email is on hold in the CRM" : r.startsWith("address_") && r !== "address_not_on_person" ? "this address is restricted in the CRM" : null;
        if (why && !out.includes(why)) out.push(why);
      }
    }
  }
  const ops = must(await db.from("gtm_email_sync_ops").select("action,reason,state,address_hash").eq("person_id", personId).eq("destination", "twenty").neq("state", "canceled"), "holds") as { action: string; reason: string; state: string; address_hash: string | null }[];
  if (ops.some((o) => o.action === "person_opt_out")) { const why = ops.some((o) => o.reason === "UNSUBSCRIBED") ? "they opted out" : "a possible opt-out is waiting for review"; if (!out.includes(why)) out.push(why); }
  if (address) {
    const h = addressHash(address);
    if (ops.some((o) => o.address_hash === h)) { if (!out.includes("this address is restricted")) out.push("this address is restricted"); }
    else {
      const failed = must(await db.from("gtm_email_attempts").select("id").eq("recipient_hash", h).eq("delivery", "failed_invalid_address").limit(1), "failed address") as unknown[];
      if (failed.length) out.push("this address bounced as invalid");
    }
  }
  return out;
}
