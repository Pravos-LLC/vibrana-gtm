// Money for the pipeline dashboard: what a deal is worth to John, and how much take-home a month produced. Pure.
//
// - A deal's contribution is its fee minus the external delivery cost and the partner referral fee Vibrana pays; its
//   take-home share is contribution ÷ fee (1 when no costs are recorded).
// - Cash is counted when it arrives (gtm_deal_milestones.paid_at), at the deal's share.
// - Monthly take-home = (contribution collected − overhead) × (1 − tax reserve). It can be negative: a month with
//   overhead and no cash is a month below zero, and the page says so rather than showing 0.
// Months are calendar months in UTC (YYYY-MM).
import type { Money, SalesDeal } from "./deals";
import type { SalesSettings } from "./settings";

export type Milestone = {
  id: number; opportunity_id: string; label: string; amount: number; currency: string; due_on: string | null;
  invoiced_at: string | null; paid_at: string | null; paid_amount: number | null; payment_ref: string | null; note: string | null;
};

/** USD for an amount, or null when the currency has no FX rate (the page lists those rather than guessing). */
export const toUsd = (m: Money | { amount: number; currency: string } | null | undefined, fx: Record<string, number>): number | null => {
  if (!m) return null;
  const rate = fx[m.currency.toUpperCase()];
  // To the cent: binary floating point would otherwise turn £6,000 × 1.35 into 8,100.000000000001.
  return rate ? Math.round(m.amount * rate * 100) / 100 : null;
};

/** Share of a deal's fee that reaches John: (fee − delivery − referral) ÷ fee, floored at 0; 1 when nothing is recorded. */
export function takeHomeShare(deal: Pick<SalesDeal, "fee" | "deliveryCost" | "referralFee">, fx: Record<string, number>): number {
  const fee = toUsd(deal.fee, fx);
  if (!fee) return 1;
  const costs = (toUsd(deal.deliveryCost, fx) ?? 0) + (toUsd(deal.referralFee, fx) ?? 0);
  return Math.max(0, Math.min(1, (fee - costs) / fee));
}

export const monthOf = (iso: string) => iso.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export type MonthMoney = {
  month: string;
  /** Cash received, USD. */
  cashUsd: number;
  /** Cash received × each deal's share, USD. */
  contributionUsd: number;
  /** (contribution − overhead) × (1 − tax reserve), USD. */
  takeHomeUsd: number;
  /** Fee of deals signed in the month (stage SIGNED, closeDate in the month), USD. */
  signedUsd: number;
  /** Unpaid milestones of signed deals due in the month × share, USD: what the month brings if they pay on time. */
  scheduledContributionUsd: number;
  /** Currencies seen without an FX rate; their amounts are left out. */
  unconverted: string[];
};

export function monthMoney(month: string, deals: SalesDeal[], milestones: Milestone[], s: SalesSettings): MonthMoney {
  const byId = new Map(deals.map((d) => [d.id, d]));
  const unconverted = new Set<string>();
  const usd = (m: { amount: number; currency: string } | null) => {
    if (!m) return 0;
    const v = toUsd(m, s.fx);
    if (v == null) { unconverted.add(m.currency); return 0; }
    return v;
  };
  let cash = 0, contribution = 0, scheduled = 0;
  for (const m of milestones) {
    const deal = byId.get(m.opportunity_id);
    const share = deal ? takeHomeShare(deal, s.fx) : 1;
    if (m.paid_at && monthOf(m.paid_at) === month) {
      const v = usd({ amount: m.paid_amount ?? m.amount, currency: m.currency });
      cash += v; contribution += v * share;
    } else if (!m.paid_at && m.due_on && monthOf(m.due_on) === month && deal?.stage === "SIGNED") {
      // Only a signed deal's milestones are scheduled cash; a proposal's planned payments are pipeline, not a forecast.
      scheduled += usd({ amount: m.amount, currency: m.currency }) * share;
    }
  }
  const signed = deals.filter((d) => d.stage === "SIGNED" && d.closeDate && monthOf(d.closeDate) === month).reduce((a, d) => a + usd(d.fee), 0);
  const cents = (n: number) => Math.round(n * 100) / 100;
  return {
    month, cashUsd: cents(cash), contributionUsd: cents(contribution), takeHomeUsd: cents(takeHome(contribution, s)),
    signedUsd: cents(signed), scheduledContributionUsd: cents(scheduled), unconverted: [...unconverted].sort(),
  };
}

export const takeHome = (contributionUsd: number, s: Pick<SalesSettings, "overheadUsd" | "taxReserve">) =>
  (contributionUsd - s.overheadUsd) * (contributionUsd - s.overheadUsd > 0 ? 1 - s.taxReserve : 1);

/**
 * The goal view: this month so far, the last three complete months' average, and next month as scheduled (unpaid
 * milestones due then). `share` is the average take-home share used to turn the goal into a required fee per month.
 */
export function goalView(deals: SalesDeal[], milestones: Milestone[], s: SalesSettings, now: Date) {
  const thisMonth = now.toISOString().slice(0, 7);
  const months = [-3, -2, -1].map((n) => monthMoney(addMonths(thisMonth, n), deals, milestones, s));
  const current = monthMoney(thisMonth, deals, milestones, s);
  const next = monthMoney(addMonths(thisMonth, 1), deals, milestones, s);
  const nextTakeHome = takeHome(next.scheduledContributionUsd, s);
  // Remaining this month: what is already in plus what is due before the month ends.
  const projected = takeHome(current.contributionUsd + current.scheduledContributionUsd, s);
  return {
    current, months, next, nextTakeHomeUsd: nextTakeHome, projectedThisMonthUsd: projected,
    trailingAvgUsd: months.reduce((a, m) => a + m.takeHomeUsd, 0) / months.length,
    gapThisMonthUsd: Math.max(0, s.goalUsd - projected),
  };
}

/** The share across won deals with a fee (falls back to 1): how much of a typical fee becomes contribution. */
export function averageShare(deals: SalesDeal[], fx: Record<string, number>): number {
  const won = deals.filter((d) => d.stage === "SIGNED" && toUsd(d.fee, fx));
  if (!won.length) return 1;
  const fees = won.reduce((a, d) => a + toUsd(d.fee, fx)!, 0);
  const contrib = won.reduce((a, d) => a + toUsd(d.fee, fx)! * takeHomeShare(d, fx), 0);
  return fees ? contrib / fees : 1;
}

/** Fee per month needed for the goal: take-home is (contribution − overhead) × (1 − tax), contribution = fee × share. */
export function requiredFeeUsd(s: SalesSettings, share: number): number {
  const contribution = s.goalUsd / (1 - s.taxReserve) + s.overheadUsd;
  return contribution / Math.max(0.05, share);
}
