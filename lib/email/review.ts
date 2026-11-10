// The owners' review of email replies (VIB-496): every reply the mailbox sync found, with the rule's and the model's
// decisions beside it, and the owners' own label, which outranks both (lib/email/load.ts currentDecisions; for suppression,
// lib/email/suppression.ts detect drops a model or rule opt-out on a reply a person has labeled). Also the open email
// incidents and the Twenty suppression operations waiting for approval. No reply text is stored, so none is shown: the
// owner reads the reply in their own inbox.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { selectAll } from "../team/mailbox";

export const HUMAN_INTENTS = ["interested", "not_interested", "not_now", "referral", "neutral", "auto_reply"] as const;
export const HUMAN_OPT_OUTS = ["none", "person", "address"] as const;
export type HumanIntent = (typeof HUMAN_INTENTS)[number];
export type HumanOptOut = (typeof HUMAN_OPT_OUTS)[number];

export type LabelRow = { id: number; event_id: number | null; person_id: string | null; source: string; intent: string; opt_out: string; model: string | null; labeled_by: string | null; labeled_at: string; superseded_at: string | null };
export type ReplyEvent = { id: number; member: string; at: string };
export type ReplyRow = { eventId: number; member: string; at: string; personId: string | null; rule: LabelRow | null; model: LabelRow | null; human: LabelRow | null; needsReview: boolean };
export type ReviewOp = { id: number; action: string; reason: string; state: string; person_id: string; observed_at: string; last_error: string | null };
export type Incident = { kind: string; severity: string; summary: string; opened_at: string; last_seen_at: string };

/** Why a human label cannot be saved; [] when it can. */
export function humanLabelProblems(intent: string, optOut: string): string[] {
  const out: string[] = [];
  if (!(HUMAN_INTENTS as readonly string[]).includes(intent)) out.push("Pick what the person wants.");
  if (!(HUMAN_OPT_OUTS as readonly string[]).includes(optOut)) out.push("Pick whether they asked to stop.");
  return out;
}

/**
 * One row per reply, newest first, with each source's current decision. A reply needs review when no person has labeled
 * it and the rules or the model saw a possible opt-out, or the model has not given a confident answer. Pure.
 */
export function replyRows(events: ReplyEvent[], labels: LabelRow[]): ReplyRow[] {
  const by = new Map<number, LabelRow[]>();
  for (const l of labels) if (l.event_id != null && !l.superseded_at) by.set(l.event_id, [...(by.get(l.event_id) ?? []), l]);
  return events.map((e) => {
    const ls = by.get(e.id) ?? [];
    const pick = (s: string) => ls.find((l) => l.source === s) ?? null;
    const rule = pick("deterministic"), model = pick("model"), human = pick("human");
    const optOut = [rule, model].some((l) => l && l.opt_out !== "none");
    const unsure = !model || model.intent === "uncertain" || (model.model ?? "").startsWith("none:");
    return { eventId: e.id, member: e.member, at: e.at, personId: ls.find((l) => l.person_id)?.person_id ?? null, rule, model, human,
      needsReview: !human && rule?.intent !== "auto_reply" && (optOut || unsure) };
  }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || Date.parse(b.at) - Date.parse(a.at));
}

export async function loadReview(db: SupabaseClient, now: Date, days = 90) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const events = await selectAll<ReplyEvent>((f, t) => db.from("gtm_team_mail_events").select("id,member,at").eq("kind", "reply").gte("at", since).order("id").range(f, t), "replies");
  const labels: LabelRow[] = [];
  for (let i = 0; i < events.length; i += 200) {
    labels.push(...await selectAll<LabelRow>((f, t) => db.from("gtm_email_reply_labels").select("id,event_id,person_id,source,intent,opt_out,model,labeled_by,labeled_at,superseded_at")
      .in("event_id", events.slice(i, i + 200).map((e) => e.id)).is("superseded_at", null).order("id").range(f, t), "reply labels"));
  }
  const ops = must(await db.from("gtm_email_sync_ops").select("id,action,reason,state,person_id,observed_at,last_error").eq("destination", "twenty")
    .in("state", ["pending_review", "approved", "queued", "applied", "failed"]).order("id", { ascending: false }).limit(200), "suppression operations") as ReviewOp[];
  const incidents = must(await db.from("gtm_email_incidents").select("kind,severity,summary,opened_at,last_seen_at").is("resolved_at", null).order("opened_at", { ascending: false }).limit(50), "incidents") as Incident[];
  return { replies: replyRows(events, labels), ops, incidents };
}
