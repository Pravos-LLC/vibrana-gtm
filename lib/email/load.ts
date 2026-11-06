// Server-side reads for the canonical email numbers (lib/email/metrics.ts). Every page of every table is read (PostgREST
// caps a response at 1000 rows), and attempts and decisions are read for the member's own events only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../team/mailbox";
import type { EffortDecision, EmailAttempt, EmailEvent, ReplyDecision } from "./metrics";

/** The switch to the canonical readers (VIB-498 rollout step 4): on only after the shadow reconciliation is reviewed. */
export const outcomesV2 = (env: Record<string, string | undefined> = process.env) => env.EMAIL_OUTCOMES_V2 === "1";

/** Current decisions per reply: a human's outranks a model's; anything else stands below both. */
export function currentDecisions(rows: { event_id: number | null; source: string; intent: string; superseded_at: string | null; opt_out?: string }[]): ReplyDecision[] {
  const rank = (s: string) => (s === "human" ? 3 : s === "deterministic" || s === "provider" ? 2 : s === "model" ? 1 : 0);
  const best = new Map<number, { rank: number; intent: string }>();
  for (const r of rows) {
    if (r.event_id == null || r.superseded_at) continue;
    // A rule decision that found nothing (the completion record of a checked reply) says nothing: it never outranks a model.
    if (r.source === "deterministic" && r.intent === "uncertain" && (r.opt_out ?? "none") === "none") continue;
    const k = rank(r.source), cur = best.get(r.event_id);
    if (!cur || k > cur.rank) best.set(r.event_id, { rank: k, intent: r.intent });
  }
  return [...best].map(([event_id, v]) => ({ event_id, intent: v.intent }));
}

export type Outcomes = { member: string; events: EmailEvent[]; attempts: EmailAttempt[]; decisions: ReplyDecision[]; effortDecisions: EffortDecision[] };

/**
 * Every team mailbox's events (efforts span mailboxes and members, review of #31 B1), their attempts and reply decisions,
 * and the people's own desk labels mapped onto the efforts of those drafts (B4). `member` is whose activity is shown.
 */
export async function loadOutcomes(db: SupabaseClient, member: string): Promise<Outcomes> {
  const events = await selectAll<EmailEvent & { draft_id: string | null }>((from, to) => db.from("gtm_team_mail_events")
    .select("id,kind,at,thread_id,person_ids,message_key,calc_version,member,mailbox,draft_id").order("id").range(from, to), "mail events");
  const ids = events.map((e) => e.id), attempts: EmailAttempt[] = [], labels: Parameters<typeof currentDecisions>[0] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    attempts.push(...await selectAll<EmailAttempt>((from, to) => db.from("gtm_email_attempts").select("event_id,person_id,match,stream,episode_id,delivery,verification,policy_flags")
      .in("event_id", chunk).order("id").range(from, to), "attempts"));
    labels.push(...await selectAll<Parameters<typeof currentDecisions>[0][number]>((from, to) => db.from("gtm_email_reply_labels").select("event_id,source,intent,superseded_at,opt_out")
      .in("event_id", chunk).order("id").range(from, to), "reply decisions"));
  }
  // The inbox label is a person's decision on a desk draft. It reaches the efforts whose sends link to that draft.
  const drafts = await selectAll<{ id: string; reply_sentiment: string; reply_label_source: string | null }>((from, to) => db.from("gtm_outreach_drafts")
    .select("id,reply_sentiment,reply_label_source").not("reply_sentiment", "is", null).order("id").range(from, to), "desk labels");
  const label = new Map(drafts.filter((d) => d.reply_label_source !== "model").map((d) => [d.id, d.reply_sentiment]));
  const episodeOf = new Map<number, string>();
  for (const a of attempts) if (a.episode_id && a.stream === "cold") episodeOf.set(a.event_id, a.episode_id);
  const effortDecisions: EffortDecision[] = [];
  for (const e of events) {
    const intent = e.draft_id ? label.get(e.draft_id) : undefined, episode = episodeOf.get(e.id);
    if (intent && episode) effortDecisions.push({ episode_id: episode, intent });
  }
  return { member, events, attempts, decisions: currentDecisions(labels), effortDecisions };
}
