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
import { conversations } from "../team/conversations";

export const DAY = 86_400_000;
export const MATURE_DAYS = 7;
export const MIN_N = 10;
export const BOUNCE_ALERT = 0.02;

export type EmailEvent = { id: number; kind: "outreach" | "other_crm" | "reply" | "bounce"; at: string; thread_id: string; person_ids: string[]; message_key?: string | null; calc_version?: number;
  /** The team member and mailbox that observed it. Efforts are built across every mailbox; activity is per member. */
  member?: string; mailbox?: string | null };
export type EmailAttempt = {
  event_id: number; person_id: string | null; match: "matched" | "ambiguous" | "unmatched"; stream: "cold" | "other_crm" | "unknown";
  episode_id: string | null; delivery: string; verification?: string; policy_flags?: string[];
};
/** Positive/negative reply decisions per reply event (latest current decision, human over model). */
export type ReplyDecision = { event_id: number; intent: string };
/** A person's decision recorded on a desk draft (the inbox label), applied to that draft's effort; it outranks any model. */
export type EffortDecision = { episode_id: string; intent: string };

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

export type Effort = { id: string; person: string; first: number; firstEventId: number; firstMember: string | null; firstFailed: boolean; firstConfirmedFailure: boolean; replied: boolean; positive: boolean; sends: number;
  /** Each send's mailbox thread and time: a reply is matched against sends made before it, never later ones. */
  sent: { thread: string; at: number }[] };


/**
 * Every effort with its first touch and outcome, across all mailboxes. Attempts without an episode are not efforts
 * (counted in coverage). A reply goes to the effort whose latest send into the reply's thread, before the reply, is the
 * most recent; a later send never moves an earlier reply. With no such send it goes to the only earlier effort, and
 * when several could be meant it is not credited to any (review of #31, B3, R1). A person's desk decision on an effort
 * outranks the reply decisions (B4).
 */
export function efforts(events: EmailEvent[], attempts: EmailAttempt[], decisions: ReplyDecision[] = [], effortDecisions: EffortDecision[] = []): Effort[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const intent = new Map(decisions.map((d) => [d.event_id, d.intent]));
  // Threads that share any keyed send are one conversation, across chains of mailboxes (lib/team/conversations.ts): a
  // reply in a copy's thread matches the sends of the conversation it belongs to.
  const convo = conversations(events);
  const by = new Map<string, Effort>();
  for (const a of attempts) {
    if (a.stream !== "cold" || !a.episode_id || !a.person_id) continue;
    const ev = byId.get(a.event_id);
    const t = ev ? ms(ev.at) : NaN;
    if (!ev || !Number.isFinite(t)) continue;
    const e = by.get(a.episode_id) ?? { id: a.episode_id, person: a.person_id, first: Infinity, firstEventId: -1, firstMember: null, firstFailed: false, firstConfirmedFailure: false, replied: false, positive: false, sends: 0, sent: [] };
    e.sends++;
    e.sent.push({ thread: convo(ev), at: t });
    if (t < e.first) { e.first = t; e.firstEventId = a.event_id; e.firstMember = ev.member ?? null; e.firstFailed = ANY_FAILURE.has(a.delivery); e.firstConfirmedFailure = CONFIRMED_FAILURE.has(a.delivery); }
    by.set(a.episode_id, e);
  }
  const byPerson = new Map<string, Effort[]>();
  for (const e of by.values()) byPerson.set(e.person, [...(byPerson.get(e.person) ?? []), e]);
  for (const r of events) {
    if (r.kind !== "reply") continue;
    for (const p of r.person_ids) {
      const at = ms(r.at), key = convo(r);
      const earlier = (byPerson.get(p) ?? []).filter((e) => e.first < at);
      const lastInThread = (e: Effort) => Math.max(-Infinity, ...e.sent.filter((x) => x.thread === key && x.at < at).map((x) => x.at));
      const inThread = earlier.filter((e) => lastInThread(e) > -Infinity).sort((a, b) => lastInThread(b) - lastInThread(a));
      const target = inThread[0] ?? (earlier.length === 1 ? earlier[0] : undefined);
      if (!target) continue;
      target.replied = true;
      if (intent.get(r.id) === "interested") target.positive = true;
    }
  }
  for (const d of effortDecisions) {
    const e = by.get(d.episode_id);
    if (!e) continue;
    e.replied = true;   // a person labeled the reply
    e.positive = intentOf(d.intent) === "interested";
  }
  return [...by.values()];
}

export type EmailStats = {
  messages: number; attempts: number; people: number; newEfforts: number; replies: number;
  replyRate: Rate; positiveRate: Rate; bounce: Rate;
  /** False when some outreach in the window has no attempt rows (written by the older sync, or not yet reconciled), or when
   *  collection itself is incomplete (a team mailbox backfilling, failing or stale): rates are then withheld (null) rather
   *  than shown as measured; observed failures still count toward the alert (B6, R2). */
  complete: boolean;
  /** While the reply rate is hidden for want of mature first touches: the earliest time a window of the same length would
   *  hold MIN_N of them from the sends already made (no new sends assumed), else null. */
  replyRateReadyAt: number | null;
  coverage: { ambiguous: number; unmatched: number; noEpisode: number; legacyRows: number; withoutAttempts: number; policyFlagged: number; unverified: number };
};

/**
 * The numbers for one window. `member` limits activity (messages, attempts, replies) to what that member's mailboxes saw;
 * efforts are always built from every mailbox and belong to the member who sent their first touch (B1). `now` sets
 * maturity: efforts younger than 7 days are counted as new but are not in a rate yet. Replies are counted when they arrive
 * (an activity count); reply rates are by the cohort of first touches.
 */
export function emailStats(events: EmailEvent[], attempts: EmailAttempt[], decisions: ReplyDecision[], from: number, to: number, now: number,
  opts: { member?: string; effortDecisions?: EffortDecision[]; collectionComplete?: boolean } = {}): EmailStats {
  const mine = (e: EmailEvent) => !opts.member || e.member === opts.member;
  const outreach = events.filter((e) => e.kind === "outreach" && mine(e) && inWin(ms(e.at), from, to));
  // A copy of one message in a second mailbox is one message and one set of attempts.
  const firstCopy = new Map<string, number>();
  for (const e of outreach) { const k = e.message_key ?? `id:${e.id}`; if (!firstCopy.has(k)) firstCopy.set(k, e.id); }
  const counted = new Set(firstCopy.values());
  const att = attempts.filter((a) => counted.has(a.event_id));
  const cold = att.filter((a) => a.stream === "cold");
  const withAttempts = new Set(attempts.map((a) => a.event_id));
  const withoutAttempts = [...counted].filter((id) => !withAttempts.has(id)).length;
  const legacyRows = outreach.filter((e) => (e.calc_version ?? 1) < 2).length;
  // Collection coverage is team-wide: an effort's sends and replies can sit in any mailbox.
  const complete = withoutAttempts === 0 && opts.collectionComplete !== false;
  const all = efforts(events, attempts, decisions, opts.effortDecisions);
  const cohort = all.filter((e) => inWin(e.first, from, to) && (!opts.member || e.firstMember === opts.member));
  const mature = cohort.filter((e) => e.first <= now - MATURE_DAYS * DAY && !(e.firstConfirmedFailure && !e.replied));
  const failed = cold.filter((a) => ANY_FAILURE.has(a.delivery)).length;
  const withheld = (r: Rate): Rate => (complete ? r : { ...r, rate: null });
  return {
    messages: firstCopy.size, attempts: cold.length, people: new Set(cold.map((a) => a.person_id)).size, newEfforts: cohort.length,
    replies: events.filter((e) => e.kind === "reply" && mine(e) && inWin(ms(e.at), from, to)).length,
    replyRate: withheld(rate(mature.filter((e) => e.replied).length, mature.length)),
    positiveRate: withheld(rate(mature.filter((e) => e.positive).length, mature.length)),
    bounce: withheld(rate(failed, cold.length, 1)),
    complete,
    replyRateReadyAt: mature.length >= MIN_N ? null : replyRateReadyAt(all.filter((e) => (!opts.member || e.firstMember === opts.member) && !(e.firstConfirmedFailure && !e.replied)).map((e) => e.first), to - from, now),
    coverage: {
      ambiguous: att.filter((a) => a.match === "ambiguous").length, unmatched: att.filter((a) => a.match === "unmatched").length,
      noEpisode: cold.filter((a) => !a.episode_id).length, legacyRows, withoutAttempts,
      policyFlagged: cold.filter((a) => (a.policy_flags ?? []).length > 0).length, unverified: cold.filter((a) => a.verification !== "verified").length,
    },
  };
}

/**
 * The earliest time after `now` at which a trailing window of `span` ms holds MIN_N first touches at least 7 days old,
 * from these first-touch times alone. Only a first touch maturing can raise the count, so the candidates are those
 * moments. Null when the window is too short to ever hold a mature first touch, or the sends made so far never get there.
 */
export function replyRateReadyAt(firsts: number[], span: number, now: number): number | null {
  const mature = MATURE_DAYS * DAY;
  if (span <= mature) return null;
  const candidates = firsts.map((f) => f + mature).filter((t) => t > now).sort((a, b) => a - b);
  for (const t of candidates) if (firsts.filter((f) => f >= t - span && f <= t - mature).length >= MIN_N) return t;
  return null;
}

/** The rolling 7-day bounce check: failed over attempts sent in the last 7 days, alerting above 2% at any n. With partial
 *  coverage the rate is withheld but observed failures still alert (over the attempts that are covered). */
export function bounceCheck(events: EmailEvent[], attempts: EmailAttempt[], now: number, member?: string, collectionComplete?: boolean): Rate & { alert: boolean; complete: boolean } {
  const s = emailStats(events, attempts, [], now - 7 * DAY, now, now, { member, collectionComplete });
  return { ...s.bounce, alert: s.bounce.n > 0 && s.bounce.num / s.bounce.n > BOUNCE_ALERT, complete: s.complete };
}
