// Matching Wise credits to unpaid payment milestones (`gtm sales reconcile`, local only: Wise statements need SCA
// signing with John's private key, so this never runs in the cockpit). A credit matches a milestone in the same currency
// when it is between 95% and 100% of the amount (bank and transfer fees come off the top) and arrives no earlier than
// 10 days before the milestone was invoiced or fell due. Each credit and each milestone is used once, closest amount
// first, and a credit already recorded on a milestone (payment_ref wise:<id>) is never used again. Pure: the CLI prints
// the proposals and writes only with --apply.
import type { Milestone } from "./economics";

export type Credit = { id: string; date: string; currency: string; amount: number; description: string };
export type Match = { milestone: Milestone; credit: Credit; shortfall: number };

export function matchCredits(milestones: Milestone[], credits: Credit[]): { matches: Match[]; unmatched: Credit[] } {
  const open = milestones.filter((m) => !m.paid_at);
  // A credit an earlier run already recorded pays nothing else (the database refuses it too: one wise: reference per row).
  const recorded = new Set(milestones.map((m) => m.payment_ref).filter((r): r is string => !!r?.startsWith("wise:")).map((r) => r.slice(5)));
  const candidates: Match[] = [];
  for (const c of credits.filter((x) => x.amount > 0 && !recorded.has(x.id))) {
    for (const m of open) {
      if (m.currency.toUpperCase() !== c.currency.toUpperCase()) continue;
      if (c.amount > m.amount + 0.005 || c.amount < m.amount * 0.95) continue;
      const from = [m.invoiced_at?.slice(0, 10), m.due_on].filter((x): x is string => !!x).sort()[0];
      if (from && Date.parse(c.date) < Date.parse(from) - 10 * 86_400_000) continue;
      candidates.push({ milestone: m, credit: c, shortfall: Math.round((m.amount - c.amount) * 100) / 100 });
    }
  }
  candidates.sort((a, b) => a.shortfall - b.shortfall || a.credit.date.localeCompare(b.credit.date));
  const usedM = new Set<number>(), usedC = new Set<string>(), matches: Match[] = [];
  for (const x of candidates) {
    if (usedM.has(x.milestone.id) || usedC.has(x.credit.id)) continue;
    usedM.add(x.milestone.id); usedC.add(x.credit.id); matches.push(x);
  }
  return { matches, unmatched: credits.filter((c) => c.amount > 0 && !usedC.has(c.id) && !recorded.has(c.id)) };
}
