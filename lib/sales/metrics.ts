// The pipeline dashboard's numbers, from rows the pages read. Pure: no database, no network, no React.
// Definitions: hub gtm/strategy/pipeline-metrics.md. A number with no source says so (null), never 0.
import { averageShare, requiredFeeUsd, takeHomeShare, toUsd, type Milestone } from "./economics";
import { OPEN_STAGES, MIN_MEASURED, type OpenStage, type SalesSettings } from "./settings";
import { isPositive, MATURE_DAYS } from "../email/metrics";
import type { Owner, SalesDeal, Source } from "./deals";

const DAY = 86_400_000;
export type Window = { start: Date; end: Date; days: number };
export const PERIODS = { "30": 30, "90": 90 } as const;
export type PeriodKey = "30" | "90" | "qtd";

export function windowFor(period: PeriodKey, now: Date): Window {
  if (period === "qtd") {
    const q = Math.floor(now.getUTCMonth() / 3) * 3;
    const start = new Date(Date.UTC(now.getUTCFullYear(), q, 1));
    return { start, end: now, days: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY)) };
  }
  const days = PERIODS[period];
  return { start: new Date(now.getTime() - days * DAY), end: now, days };
}
const inWindow = (iso: string | null | undefined, w: Window) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= w.start.getTime() && t <= w.end.getTime();
};
export const isOpen = (d: SalesDeal) => (OPEN_STAGES as readonly string[]).includes(d.stage);
export const ownerFilter = (owner: Owner | null) => <T extends { owner: Owner | null }>(rows: T[]) => (owner ? rows.filter((r) => r.owner === owner) : rows);

/* ------------------------------------------------------------------------------------------------ deals */

export type Measured = { value: number; n: number; measured: boolean };
/** A measured rate replaces the planning one only with at least MIN_MEASURED observations. */
const pick = (hits: number, n: number, planning: number): Measured => (n >= MIN_MEASURED ? { value: hits / n, n, measured: true } : { value: planning, n, measured: false });
/**
 * A measured rate the funnel can divide by. Zero conversions so far falls back to the planning rate (still showing how
 * many were measured); a ratio over 1 (two populations that only partly overlap) is capped at 100%.
 */
export const usable = (m: Measured | undefined, planning: number): Measured =>
  !m || !m.measured || !(m.value > 0) ? { value: planning, n: m?.n ?? 0, measured: false } : { ...m, value: Math.min(1, m.value) };

/**
 * `history` (gtm_deal_stage_history) decides which lost deals count against the win rate: only those that reached
 * QUALIFIED or PROPOSAL. A lead dropped at IDENTIFIED is not a lost sale, and counting it would understate the rate.
 */
export function pipelineHealth(deals: SalesDeal[], s: SalesSettings, now: Date, history: { opportunity_id: string; stage: string }[] = []) {
  const open = deals.filter(isOpen);
  const usd = (d: SalesDeal) => toUsd(d.fee, s.fx);
  const weighted = open.reduce((a, d) => a + (usd(d) ?? 0) * s.stageWeights[d.stage as OpenStage], 0);
  const unpriced = open.filter((d) => usd(d) == null).length;
  // The same cohort on both sides: only deals the history saw qualified before they closed. Deals that closed before the
  // history began are unknown either way, so they count neither as wins nor as losses.
  const qualifiedBefore = new Set(history.filter((h) => h.stage === "QUALIFIED" || h.stage === "PROPOSAL").map((h) => h.opportunity_id));
  const won = deals.filter((d) => d.stage === "SIGNED"), lost = deals.filter((d) => d.stage === "LOST");
  const wonQ = won.filter((d) => qualifiedBefore.has(d.id)), lostQ = lost.filter((d) => qualifiedBefore.has(d.id));
  const winRate = usable(pick(wonQ.length, wonQ.length + lostQ.length, s.rates.winFromQualified), s.rates.winFromQualified);
  // The typical won deal is the median: one large transformation engagement would otherwise make the goal look like it
  // needs a fraction of a deal a month, when the work that pays the bills is the sprint.
  const wonFees = won.map(usd).filter((v): v is number => v != null).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  const avgDeal = wonFees.length >= 3 ? median(wonFees) : s.plannedDealUsd;
  const cycles = won.filter((d) => d.closeDate).map((d) => (Date.parse(d.closeDate!) - Date.parse(d.createdAt)) / DAY).filter((x) => x >= 0).sort((a, b) => a - b);
  const share = averageShare(deals, s.fx);
  const required = requiredFeeUsd(s, share);
  const coverageNeed = required * s.coverageMonths;
  return {
    openCount: open.length, qualifiedCount: open.filter((d) => d.stage === "QUALIFIED" || d.stage === "PROPOSAL").length,
    weightedUsd: weighted, unpriced,
    coverage: coverageNeed ? weighted / coverageNeed : null, coverageNeedUsd: coverageNeed,
    winRate, avgDealUsd: avgDeal, avgDealMeasured: wonFees.length >= 3,
    medianCycleDays: cycles.length ? cycles[Math.floor(cycles.length / 2)] : null,
    requiredFeeUsd: required, share,
    byStage: OPEN_STAGES.map((st) => ({ stage: st, count: open.filter((d) => d.stage === st).length, usd: open.filter((d) => d.stage === st).reduce((a, d) => a + (usd(d) ?? 0), 0) })),
    bySource: sourceMix(deals, s, now),
  };
}

function sourceMix(deals: SalesDeal[], s: SalesSettings, _now: Date) {
  const rows = new Map<Source | "UNSET", { open: number; won: number; wonUsd: number; openUsd: number }>();
  for (const d of deals) {
    if (d.stage === "LOST") continue;
    const k = d.source ?? "UNSET";
    const r = rows.get(k) ?? { open: 0, won: 0, wonUsd: 0, openUsd: 0 };
    const v = toUsd(d.fee, s.fx) ?? 0;
    if (d.stage === "SIGNED") { r.won++; r.wonUsd += v; } else { r.open++; r.openUsd += v; }
    rows.set(k, r);
  }
  return [...rows].map(([source, r]) => ({ source, ...r })).sort((a, b) => b.wonUsd + b.openUsd - (a.wonUsd + a.openUsd));
}

export type Action = { key: string; dealId?: string; text: string; detail?: string; href?: string; tone: "warn" | "bad" };

/** What needs doing this week, worst first. Each item names the deal and the fix. */
export function needsAction(deals: SalesDeal[], milestones: Milestone[], now: Date, extra: Action[] = []): Action[] {
  const out: Action[] = [];
  const today = now.toISOString().slice(0, 10);
  const byDeal = new Map<string, Milestone[]>();
  for (const m of milestones) byDeal.set(m.opportunity_id, [...(byDeal.get(m.opportunity_id) ?? []), m]);
  for (const m of milestones) {
    const d = deals.find((x) => x.id === m.opportunity_id);
    // Only a signed deal's payment can be late; a proposal's planned milestones are not owed yet.
    if (!m.paid_at && m.due_on && m.due_on < today && d?.stage === "SIGNED") {
      out.push({ key: `overdue-pay:${m.id}`, dealId: m.opportunity_id, tone: "bad", text: `${d?.name ?? "A deal"}: ${m.label} was due ${m.due_on}`, detail: "Chase the payment or move the due date." });
    }
  }
  for (const d of deals) {
    if (isOpen(d)) {
      if (!d.nextStep) out.push({ key: `no-step:${d.id}`, dealId: d.id, tone: "warn", text: `${d.name}: no next step`, detail: "Add oppNextStep and a date in Twenty.", href: d.url });
      else if (d.nextStepAt && d.nextStepAt.slice(0, 10) < today) {
        const late = Math.max(1, Math.floor((now.getTime() - Date.parse(d.nextStepAt)) / DAY));
        out.push({ key: `late-step:${d.id}`, dealId: d.id, tone: late > 7 ? "bad" : "warn", text: `${d.name}: "${d.nextStep}" is ${late} ${late === 1 ? "day" : "days"} late`, href: d.url });
      }
      if (!d.owner) out.push({ key: `no-owner:${d.id}`, dealId: d.id, tone: "warn", text: `${d.name}: no owner`, detail: "Set oppOwner to John or Abe.", href: d.url });
      if (!d.source) out.push({ key: `no-source:${d.id}`, dealId: d.id, tone: "warn", text: `${d.name}: no source`, detail: "Set where the deal came from (oppSource).", href: d.url });
    }
    if (d.stage === "SIGNED") {
      if (!d.fee) out.push({ key: `no-fee:${d.id}`, dealId: d.id, tone: "bad", text: `${d.name}: won, but no amount`, detail: "Add the invoiced amount so it counts toward the goal.", href: d.url });
      const recent = !d.closeDate || now.getTime() - Date.parse(d.closeDate) < 120 * DAY;
      if (recent && !byDeal.get(d.id)?.length) out.push({ key: `no-milestones:${d.id}`, dealId: d.id, tone: "warn", text: `${d.name}: no payment milestones`, detail: d.closeDate ? "Add the deposit and later payments." : "Add the close date and payment milestones." });
    }
  }
  out.push(...extra);
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
}

/* ------------------------------------------------------------------------------------------------ outreach */

export type DeskRow = {
  track: string | null; route: string | null; email_sent_at: string | null; email_sent_by: string | null; follow_up_sent_at: string | null;
  email_replied_at: string | null; email_bounced_at: string | null; reply_sentiment: string | null;
  linkedin_sent_at: string | null; linkedin_sent_by: string | null; linkedin_status: string | null;
};
export type ChannelStats = {
  firstTouches: number; followUps: number; replies: number; positive: number; bounces: number;
  /** Replies ÷ first touches sent in the window; null below MIN_MEASURED touches. */
  replyRate: number | null; positiveRate: number | null; bounceRate: number | null;
  linkedinNotes: number; linkedinAccepted: number; acceptRate: number | null; unlabeled: number;
};

/**
 * `ownerOf` maps the address that marked a send to an owner code (the desk records who clicked "Mark sent"); an address it
 * does not know is unattributed (null): counted in the all-owners view, in nobody's own.
 * Email contract v1 (VIB-496/VIB-512): counts are activity in the window; rates are by the cohort of first touches sent in
 * the window and at least 7 days old, hidden below MIN_MEASURED. "Positive" includes the contract's "interested".
 */
export function deskStats(rows: DeskRow[], w: Window, ownerOf: (by: string | null) => Owner | null, owner: Owner | null, track?: string): ChannelStats {
  const mine = rows.filter((r) => (!track || (r.track ?? "client") === track));
  const email = mine.filter((r) => !owner || ownerOf(r.email_sent_by) === owner);
  const li = mine.filter((r) => !owner || ownerOf(r.linkedin_sent_by) === owner);
  const touches = email.filter((r) => inWindow(r.email_sent_at, w));
  const replies = email.filter((r) => inWindow(r.email_replied_at, w));
  const mature = touches.filter((r) => Date.parse(r.email_sent_at!) <= w.end.getTime() - MATURE_DAYS * 86_400_000);
  const repliedTouches = mature.filter((r) => r.email_replied_at).length;
  const bounces = touches.filter((r) => r.email_bounced_at).length;
  const positive = replies.filter((r) => isPositive(r.reply_sentiment)).length;
  const notes = li.filter((r) => inWindow(r.linkedin_sent_at, w));
  const accepted = notes.filter((r) => r.linkedin_status === "connected").length;
  const n = mature.length;
  return {
    firstTouches: touches.length, followUps: email.filter((r) => inWindow(r.follow_up_sent_at, w)).length,
    replies: replies.length, positive, bounces,
    replyRate: n >= MIN_MEASURED ? repliedTouches / n : null,
    positiveRate: n >= MIN_MEASURED ? mature.filter((r) => isPositive(r.reply_sentiment)).length / n : null,
    bounceRate: touches.length >= MIN_MEASURED ? bounces / touches.length : null,
    linkedinNotes: notes.length, linkedinAccepted: accepted, acceptRate: notes.length >= MIN_MEASURED ? accepted / notes.length : null,
    unlabeled: replies.filter((r) => !r.reply_sentiment).length,
  };
}

export type LinkedInConnection = { owner: string; connected_on: string; icp: boolean; person_id: string | null };
export type LinkedInThread = { owner: string; first_at: string; last_at: string; started_by_owner: boolean; two_way: boolean; icp: boolean; person_id: string | null };

export function linkedinStats(conns: LinkedInConnection[], threads: LinkedInThread[], w: Window, owner: Owner | null) {
  const c = conns.filter((x) => (!owner || x.owner === owner) && inWindow(x.connected_on + "T12:00:00Z", w));
  const t = threads.filter((x) => (!owner || x.owner === owner) && inWindow(x.first_at, w));
  return {
    connections: c.length, icpConnections: c.filter((x) => x.icp).length,
    conversations: t.length, twoWay: t.filter((x) => x.two_way).length, icpTwoWay: t.filter((x) => x.two_way && x.icp).length,
    inbound: t.filter((x) => !x.started_by_owner).length,
  };
}

/* ------------------------------------------------------------------------------------------------ meetings */

export const MEETING_KINDS = ["DISCOVERY", "CLIENT", "PARTNER", "OTHER", "INTERNAL"] as const;
export type Meeting = { id: string; name: string; at: string; owner: Owner | null; kind: string | null; company: string | null; opportunityId: string | null; opportunityStage: string | null; url: string };

export function meetingStats(meetings: Meeting[], w: Window, now: Date, owner: Owner | null) {
  const mine = meetings.filter((m) => !owner || m.owner === owner);
  const held = mine.filter((m) => inWindow(m.at, w) && Date.parse(m.at) <= now.getTime());
  const count = (k: string) => held.filter((m) => m.kind === k).length;
  return {
    held: held.length, discovery: count("DISCOVERY"), client: count("CLIENT"), partner: count("PARTNER"), other: count("OTHER"), internal: count("INTERNAL"),
    discoveryWithDeal: held.filter((m) => m.kind === "DISCOVERY" && m.opportunityId).length,
    upcoming: mine.filter((m) => Date.parse(m.at) > now.getTime()).sort((a, b) => a.at.localeCompare(b.at)),
    recent: held.sort((a, b) => b.at.localeCompare(a.at)),
  };
}

/* ------------------------------------------------------------------------------------------------ web */

export type WebDay = { site: string; day: string; visitors: number; pageviews: number; high_intent: number | null; paths: { key: string; n: number }[]; referrers: { key: string; n: number }[]; utm: { key: string; n: number }[] };

export function webStats(days: WebDay[], w: Window) {
  type Acc = { visitors: number; pageviews: number; highIntent: number | null; days: number; paths: Map<string, number>; referrers: Map<string, number>; utm: Map<string, number>; series: { day: string; visitors: number }[] };
  const sites = new Map<string, Acc>();
  for (const d of days) {
    if (!inWindow(d.day + "T12:00:00Z", w)) continue;
    const s: Acc = sites.get(d.site) ?? { visitors: 0, pageviews: 0, highIntent: null, days: 0, paths: new Map(), referrers: new Map(), utm: new Map(), series: [] };
    s.visitors += d.visitors; s.pageviews += d.pageviews; s.days++;
    if (d.high_intent != null) s.highIntent = (s.highIntent ?? 0) + d.high_intent;
    for (const [list, map] of [[d.paths, s.paths], [d.referrers, s.referrers], [d.utm, s.utm]] as const) for (const r of list ?? []) map.set(r.key, (map.get(r.key) ?? 0) + r.n);
    s.series.push({ day: d.day, visitors: d.visitors });
    sites.set(d.site, s);
  }
  const top = (m: Map<string, number>, n = 8) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, n]) => ({ key, n }));
  return [...sites].map(([site, s]) => ({ site, visitors: s.visitors, pageviews: s.pageviews, highIntent: s.highIntent, days: s.days,
    paths: top(s.paths), referrers: top(s.referrers), utm: top(s.utm), series: s.series.sort((a, b) => a.day.localeCompare(b.day)) }))
    .sort((a, b) => b.visitors - a.visitors);
}

/** Visitors on a path that marks intent (prefix match on the configured paths). */
export const isHighIntent = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"));

/* ------------------------------------------------------------------------------------------------ reverse funnel */

export type FunnelStep = { key: string; label: string; requiredPerMonth: number; actualPerMonth: number | null; rate: Measured | null; rateLabel: string | null };

/**
 * From the goal back to first touches: how many of each step a month the goal needs at the current rates, next to how
 * many happened (scaled to a 30-day month). Measured rates replace planning ones at MIN_MEASURED observations.
 */
export function reverseFunnel(input: {
  s: SalesSettings; health: ReturnType<typeof pipelineHealth>; w: Window;
  actual: { won: number | null; qualified: number | null; meetings: number | null; positive: number | null; touches: number | null };
  measured: { qualifiedFromMeeting?: Measured; meetingFromPositive?: Measured; positiveFromTouch?: Measured };
}): FunnelStep[] {
  const { s, health, w, actual, measured } = input;
  const per = (n: number | null) => (n == null ? null : (n * 30) / w.days);
  const wonNeeded = health.requiredFeeUsd / health.avgDealUsd;
  const win = health.winRate;
  const q = usable(measured.qualifiedFromMeeting, s.rates.qualifiedFromMeeting);
  const m = usable(measured.meetingFromPositive, s.rates.meetingFromPositive);
  const p = usable(measured.positiveFromTouch, s.rates.positiveFromTouch);
  const qualified = wonNeeded / win.value, meetings = qualified / q.value, positive = meetings / m.value, touches = positive / p.value;
  return [
    { key: "won", label: "Deals won", requiredPerMonth: wonNeeded, actualPerMonth: per(actual.won), rate: null, rateLabel: null },
    { key: "qualified", label: "Qualified opportunities", requiredPerMonth: qualified, actualPerMonth: per(actual.qualified), rate: win, rateLabel: "won from qualified" },
    { key: "meetings", label: "Discovery meetings held", requiredPerMonth: meetings, actualPerMonth: per(actual.meetings), rate: q, rateLabel: "qualified from meeting" },
    { key: "positive", label: "Positive conversations", requiredPerMonth: positive, actualPerMonth: per(actual.positive), rate: m, rateLabel: "meeting from positive conversation" },
    { key: "touches", label: "First touches (if all outbound)", requiredPerMonth: touches, actualPerMonth: per(actual.touches), rate: p, rateLabel: "positive from first touch" },
  ];
}

/** Deals that reached a stage in the window: the stage history first, then createdAt for deals created at or past it. */
export function reachedInWindow(deals: SalesDeal[], history: { opportunity_id: string; stage: string; first_seen_at: string }[], stages: string[], w: Window) {
  const seen = new Set(history.filter((h) => stages.includes(h.stage) && inWindow(h.first_seen_at, w)).map((h) => h.opportunity_id));
  const tracked = new Set(history.map((h) => h.opportunity_id));
  for (const d of deals) if (!tracked.has(d.id) && stages.includes(d.stage) && inWindow(d.createdAt, w)) seen.add(d.id);
  return seen;
}

export const wonInWindow = (deals: SalesDeal[], w: Window) => deals.filter((d) => d.stage === "SIGNED" && inWindow(d.closeDate, w));
export const shareOf = takeHomeShare;
