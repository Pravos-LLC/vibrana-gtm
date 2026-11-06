"use server";
// Writes from /pipeline: payment milestones (the ledger take-home is computed from), the pipeline settings and John's
// label on an outreach reply. Owner only; the service role writes after the owner check, as on /settings.
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { salesSettingsProblems, SALES_KEY, type SalesSettings } from "@/lib/sales/settings";
import { sessionDb } from "@/lib/supabase/server";

type Result = { ok: true } | { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SENTIMENTS = ["positive", "neutral", "negative", "not_now", "unsubscribe"] as const;

async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}
const refresh = () => { for (const p of ["/pipeline", "/pipeline/deals", "/"]) revalidatePath(p); };
const validDate = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

export type MilestoneInput = { opportunityId: string; label: string; amount: number; currency: string; dueOn: string | null; note?: string | null };

function milestoneProblems(m: MilestoneInput): string[] {
  const out: string[] = [];
  if (!UUID.test(m.opportunityId)) out.push("Pick a deal.");
  if (!m.label?.trim() || m.label.trim().length > 60) out.push("Name the milestone (up to 60 characters).");
  if (!(Number.isFinite(m.amount) && m.amount > 0 && m.amount < 10_000_000)) out.push("The amount must be positive.");
  if (!/^[A-Z]{3}$/.test(m.currency ?? "")) out.push("The currency is a three-letter code (GBP, USD, EUR).");
  if (m.dueOn && !validDate(m.dueOn)) out.push("The due date is not a date.");
  if (m.note && m.note.length > 500) out.push("The note is too long.");
  return out;
}

export async function addMilestone(m: MilestoneInput): Promise<Result> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  const problems = milestoneProblems(m);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  const { error } = await adminDb().from("gtm_deal_milestones").insert({
    opportunity_id: m.opportunityId, label: m.label.trim(), amount: Math.round(m.amount * 100) / 100, currency: m.currency, due_on: m.dueOn || null, note: m.note?.trim() || null,
  });
  if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? "That deal already has a milestone with this name." : error.message };
  refresh();
  return { ok: true };
}

export async function markMilestone(input: { id: number; invoicedOn?: string | null; paidOn?: string | null; paidAmount?: number | null; ref?: string | null }): Promise<Result> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  if (!Number.isInteger(input.id) || input.id <= 0) return { ok: false, error: "Unknown milestone." };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.invoicedOn !== undefined) {
    if (input.invoicedOn && !validDate(input.invoicedOn)) return { ok: false, error: "The invoice date is not a date." };
    patch.invoiced_at = input.invoicedOn ? `${input.invoicedOn}T12:00:00Z` : null;
  }
  if (input.paidOn !== undefined) {
    if (input.paidOn) {
      if (!validDate(input.paidOn)) return { ok: false, error: "The payment date is not a date." };
      if (!(input.paidAmount && input.paidAmount > 0)) return { ok: false, error: "Enter the amount received." };
      patch.paid_at = `${input.paidOn}T12:00:00Z`; patch.paid_amount = Math.round(input.paidAmount * 100) / 100;
      if (input.ref) patch.payment_ref = input.ref.slice(0, 120);
    } else { patch.paid_at = null; patch.paid_amount = null; }
  }
  const { error } = await adminDb().from("gtm_deal_milestones").update(patch).eq("id", input.id);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

export async function deleteMilestone(id: number): Promise<Result> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown milestone." };
  const { error } = await adminDb().from("gtm_deal_milestones").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

export async function saveSalesSettings(value: SalesSettings): Promise<Result> {
  const who = await owner();
  if (!who) return { ok: false, error: "Not signed in as the cockpit owner." };
  const problems = salesSettingsProblems(value);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  const { error } = await adminDb().from("gtm_settings").upsert({ key: SALES_KEY, value, updated_at: new Date().toISOString(), updated_by: who });
  if (error) return { ok: false, error: error.message };
  for (const p of ["/settings", "/pipeline", "/pipeline/deals"]) revalidatePath(p);
  return { ok: true };
}

/** John's call on a reply: positive replies are the conversations the funnel counts. */
export async function labelReply(draftId: string, sentiment: (typeof SENTIMENTS)[number] | null): Promise<Result> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  if (!UUID.test(draftId)) return { ok: false, error: "Unknown draft." };
  if (sentiment !== null && !(SENTIMENTS as readonly string[]).includes(sentiment)) return { ok: false, error: "Unknown label." };
  const now = new Date().toISOString();
  const db = adminDb();
  const { data, error } = await db.from("gtm_outreach_drafts").select("email_replied_at,email_status").eq("id", draftId).maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "Unknown draft." };
  // A label is John saying they replied: the draft becomes "replied" (so the desk stops offering a follow-up), dated now
  // until the hourly sync replaces it with Gmail's own reply time. Clearing a label never invents or removes a reply.
  // A click here is a human decision (reply_label_source), and outranks any model label (VIB-508/VIB-510).
  const patch: Record<string, unknown> = { reply_sentiment: sentiment, reply_labeled_at: sentiment ? now : null, reply_label_source: sentiment ? "human" : null };
  if (sentiment && !data.email_replied_at) { patch.email_replied_at = now; patch.email_replied_at_source = "label"; }
  if (sentiment && data.email_status === "sent") patch.email_status = "replied";
  const { error: e2 } = await db.from("gtm_outreach_drafts").update(patch).eq("id", draftId);
  if (e2) return { ok: false, error: e2.message };
  for (const p of ["/outreach/inbox", "/pipeline", "/pipeline/conversations"]) revalidatePath(p);
  return { ok: true };
}
