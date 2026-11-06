// The canonical email numbers (email contract v1, Linear VIB-496), from the team mailboxes' events and attempts
// (lib/team/mailbox.ts). Pure, so every rule is unit tested. Definitions live in hub gtm/strategy/pipeline-metrics.md.
//
// - Messages: outreach messages sent, once per Message-ID however many mailboxes saw a copy.
// - Attempts: one per message and external recipient; the bounce denominator.
// - Efforts (episodes): one person's outreach effort, across threads and mailboxes. Its first touch is its earliest send.
//   Reply rates are over efforts whose first touch is in the window and at least 7 days old; a rate is hidden below 10.
//   An effort is left out only when its first touch has a confirmed terminal failure and no reply; a failed follow-up
//   never removes an earlier exchange. A failure report without a type (metadata only) is not confirmed.
// - Bounce rate: failed attempts over attempts sent in the window, no minimum n (the alert is about a handful of sends).
// - Coverage: ambiguous and unmatched recipients, efforts without a resolved episode, and the calculation version mix.
// - A source that was not read is null, never 0. Dates are UTC; windows are half-open [from, to).

export const DAY = 86_400_000;
export const MATURE_DAYS = 7;
export const MIN_N = 10;
export const BOUNCE_ALERT = 0.02;

export type EmailEvent = { id: number; kind: "outreach" | "other_crm" | "reply" | "bounce"; at: string; thread_id: string; person_ids: string[]; message_key?: string | null; calc_version?: number };
export type EmailAttempt = {
  event_id: number; person_id: string | null; match: "matched" | "ambiguous" | "unmatched"; stream: "cold" | "other_crm" | "unknown";
  episode_id: string | null; delivery: string; verification?: string; policy_flags?: string[];
};
/** Positive/negative reply decisions per reply event (latest current decision, human over model). */
export type ReplyDecision = { event_id: number; intent: string };

export const CONFIRMED_FAILURE = new Set(["failed_invalid_address", "failed_policy"]);
export const ANY_FAILURE = new Set(["failed_invalid_address", "failed_policy", "failed_unclassified"]);

/** Legacy desk labels in the contract's words: positive is interested, negative is not interested. */
export const intentOf = (label: string | null | undefined) =>
  label === "positive" ? "interested" : label === "negative" ? "not_interested" : label === "unsubscribe" ? "not_interested" : label ?? null;
export const isPositive = (label: string | null | undefined) => intentOf(label) === "interested";

const ms = (iso: string) => Date.parse(iso);
const inWin = (t: number, from: number, to: number) => t >= from && t < to;
export type Rate = { rate: number | null; num: number; n: number };
const rate = (num: number, n: number, min = MIN_N): Rate => ({ rate: n >= min && n > 0 ? num / n : null, num, n });

export type Effort = { id: string; person: string; first: number; firstEventId: number; firstFailed: boolean; firstConfirmedFailure: boolean; replied: boolean; positive: boolean; sends: number };

/** Every effort with its first touch and outcome. Attempts without an episode are not efforts (counted in coverage). */
export function efforts(events: EmailEvent[], attempts: EmailAttempt[], decisions: ReplyDecision[] = []): Effort[] {
  const at = new Map(events.map((e) => [e.id, ms(e.at)]));
  const intent = new Map(decisions.map((d) => [d.event_id, d.intent]));
  const by = new Map<string, Effort>();
  for (const a of attempts) {
    if (a.stream !== "cold" || !a.episode_id || !a.person_id) continue;
    const t = at.get(a.event_id);
    if (t == null || !Number.isFinite(t)) continue;
    const e = by.get(a.episode_id) ?? { id: a.episode_id, person: a.person_id, first: Infinity, firstEventId: -1, firstFailed: false, firstConfirmedFailure: false, replied: false, positive: false, sends: 0 };
    e.sends++;
    if (t < e.first) { e.first = t; e.firstEventId = a.event_id; e.firstFailed = ANY_FAILURE.has(a.delivery); e.firstConfirmedFailure = CONFIRMED_FAILURE.has(a.delivery); }
    by.set(a.episode_id, e);
  }
  // A reply belongs to the person's effort whose first touch is the latest one before the reply.
  const byPerson = new Map<string, Effort[]>();
  for (const e of by.values()) byPerson.set(e.person, [...(byPerson.get(e.person) ?? []), e]);
  for (const r of events) {
    if (r.kind !== "reply") continue;
    for (const p of r.person_ids) {
      const target = (byPerson.get(p) ?? []).filter((e) => e.first < ms(r.at)).sort((a, b) => b.first - a.first)[0];
      if (!target) continue;
      target.replied = true;
      if (intent.get(r.id) === "interested") target.positive = true;
    }
  }
  return [...by.values()];
}

export type EmailStats = {
  messages: number; attempts: number; people: number; newEfforts: number; replies: number;
  replyRate: Rate; positiveRate: Rate; bounce: Rate;
  coverage: { ambiguous: number; unmatched: number; noEpisode: number; legacyRows: number; policyFlagged: number; unverified: number };
};

/**
 * The numbers for one window. `now` sets maturity: efforts younger than 7 days are counted as new but are not in a rate yet.
 * Replies are counted when they arrive (an activity count); reply rates are by the cohort of first touches.
 */
export function emailStats(events: EmailEvent[], attempts: EmailAttempt[], decisions: ReplyDecision[], from: number, to: number, now: number): EmailStats {
  const outreach = events.filter((e) => e.kind === "outreach" && inWin(ms(e.at), from, to));
  const keys = new Set<string>();
  let messages = 0;
  for (const e of outreach) { const k = e.message_key ?? `id:${e.id}`; if (!keys.has(k)) { keys.add(k); messages++; } }
  const inWindowIds = new Set(outreach.map((e) => e.id));
  // A copy of one message in a second mailbox is not a second attempt either.
  const firstCopy = new Map<string, number>();
  for (const e of outreach) { const k = e.message_key ?? `id:${e.id}`; if (!firstCopy.has(k)) firstCopy.set(k, e.id); }
  const counted = new Set(firstCopy.values());
  const att = attempts.filter((a) => inWindowIds.has(a.event_id) && counted.has(a.event_id));
  const cold = att.filter((a) => a.stream === "cold");
  const all = efforts(events, attempts, decisions);
  const cohort = all.filter((e) => inWin(e.first, from, to));
  const mature = cohort.filter((e) => e.first <= now - MATURE_DAYS * DAY && !(e.firstConfirmedFailure && !e.replied));
  return {
    messages, attempts: cold.length, people: new Set(cold.map((a) => a.person_id)).size, newEfforts: cohort.length,
    replies: events.filter((e) => e.kind === "reply" && inWin(ms(e.at), from, to)).length,
    replyRate: rate(mature.filter((e) => e.replied).length, mature.length),
    positiveRate: rate(mature.filter((e) => e.positive).length, mature.length),
    bounce: rate(cold.filter((a) => ANY_FAILURE.has(a.delivery)).length, cold.length, 1),
    coverage: {
      ambiguous: att.filter((a) => a.match === "ambiguous").length, unmatched: att.filter((a) => a.match === "unmatched").length,
      noEpisode: cold.filter((a) => !a.episode_id).length, legacyRows: outreach.filter((e) => (e.calc_version ?? 1) < 2).length,
      policyFlagged: cold.filter((a) => (a.policy_flags ?? []).length > 0).length, unverified: cold.filter((a) => a.verification !== "verified").length,
    },
  };
}

/** The rolling 7-day bounce check: failed over attempts sent in the last 7 days, alerting above 2% at any n. */
export function bounceCheck(events: EmailEvent[], attempts: EmailAttempt[], now: number): Rate & { alert: boolean } {
  const s = emailStats(events, attempts, [], now - 7 * DAY, now, now).bounce;
  return { ...s, alert: s.n > 0 && s.num / s.n > BOUNCE_ALERT };
}
