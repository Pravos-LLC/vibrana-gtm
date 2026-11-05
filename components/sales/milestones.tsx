"use client";
// Payment milestones per deal (/pipeline/deals): the ledger take-home is computed from. Add a deposit or later payment,
// mark it invoiced or paid (with the amount that arrived), or remove it. Owner-only server actions do the writes.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Result = { ok: true } | { ok: false; error: string };
export type MilestoneRow = { id: number; dealName: string; label: string; amount: number; currency: string; due_on: string | null; invoiced_at: string | null; paid_at: string | null; paid_amount: number | null; stage: string };
export type DealOption = { id: string; name: string; currency: string | null; stage: string };

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number, c: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: 2 }).format(n);

export function MilestoneEditor({ deals, rows, add, mark, remove }: {
  deals: DealOption[]; rows: MilestoneRow[];
  add: (m: { opportunityId: string; label: string; amount: number; currency: string; dueOn: string | null; note?: string | null }) => Promise<Result>;
  mark: (m: { id: number; invoicedOn?: string | null; paidOn?: string | null; paidAmount?: number | null; ref?: string | null }) => Promise<Result>;
  remove: (id: number) => Promise<Result>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [deal, setDeal] = useState(deals.find((d) => d.stage === "SIGNED")?.id ?? deals[0]?.id ?? "");
  const [label, setLabel] = useState("Deposit");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(deals.find((d) => d.id === deal)?.currency ?? "GBP");
  const [due, setDue] = useState(today());
  const [paying, setPaying] = useState<number | null>(null);
  const [paidOn, setPaidOn] = useState(today());
  const [paidAmount, setPaidAmount] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const run = (call: () => Promise<Result>, done: string, after?: () => void) => start(async () => {
    setMsg(null);
    const r = await call();
    setMsg(r.ok ? done : r.error);
    if (r.ok) { after?.(); router.refresh(); }
  });

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm" data-testid="milestones">
          <thead><tr className="text-left text-xs text-ink-3"><th className="py-2 pr-3">Deal</th><th className="pr-3">Milestone</th><th className="pr-3 text-right">Amount</th><th className="pr-3">Due</th><th className="pr-3">Status</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-ink-3">No milestones yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="py-2.5 pr-3 text-ink">{r.dealName}{r.stage !== "SIGNED" && <span className="ml-1 text-xs text-ink-3">({r.stage.toLowerCase()}, not counted until signed)</span>}</td>
                <td className="py-2.5 pr-3">{r.label}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{fmt(r.amount, r.currency)}</td>
                <td className="py-2.5 pr-3 tabular-nums">{r.due_on ?? "-"}</td>
                <td className="py-2.5 pr-3">
                  {r.paid_at ? <span className="text-emerald-strong">paid {r.paid_at.slice(0, 10)}{r.paid_amount != null && r.paid_amount !== r.amount ? ` (${fmt(r.paid_amount, r.currency)})` : ""}</span>
                    : r.invoiced_at ? <span className="text-ink-2">invoiced {r.invoiced_at.slice(0, 10)}</span> : <span className="text-ink-3">not invoiced</span>}
                </td>
                <td className="py-2 text-right">
                  {paying === r.id ? (
                    <form className="flex flex-wrap justify-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => mark({ id: r.id, paidOn, paidAmount: Number(paidAmount || r.amount) }), "Marked paid.", () => setPaying(null)); }}>
                      <Input aria-label="Paid on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-8 w-36" />
                      <Input aria-label="Amount received" inputMode="decimal" placeholder={String(r.amount)} value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} className="h-8 w-28" />
                      <Button size="sm" type="submit" disabled={busy}>Save</Button>
                      <Button size="sm" variant="ghost" type="button" onClick={() => setPaying(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <div className="flex justify-end gap-1">
                      {!r.paid_at && !r.invoiced_at && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => mark({ id: r.id, invoicedOn: today() }), "Marked invoiced.")}>Invoiced</Button>}
                      {!r.paid_at && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPaying(r.id); setPaidAmount(""); }}>Paid</Button>}
                      {r.paid_at && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => mark({ id: r.id, paidOn: null }), "Payment undone.")}>Undo paid</Button>}
                      {removing === r.id
                        ? <Button size="sm" variant="ghost" disabled={busy} className="text-red-strong" onClick={() => run(() => remove(r.id), "Removed.", () => setRemoving(null))}>Confirm remove</Button>
                        : <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${r.label}`} onClick={() => setRemoving(r.id)}>Remove</Button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-[2fr_1.2fr_1fr_0.7fr_1fr_auto] sm:items-end"
        onSubmit={(e) => { e.preventDefault(); run(() => add({ opportunityId: deal, label, amount: Number(amount), currency: currency.toUpperCase(), dueOn: due || null }), "Milestone added.", () => setAmount("")); }}>
        <label className="grid gap-1 text-xs text-ink-3">Deal
          <select className="h-10 rounded-md border border-line bg-transparent px-2 text-sm text-ink" value={deal}
            onChange={(e) => { setDeal(e.target.value); const c = deals.find((d) => d.id === e.target.value)?.currency; if (c) setCurrency(c); }}>
            {deals.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.stage.toLowerCase()})</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-ink-3">Milestone<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Deposit (40%)" /></label>
        <label className="grid gap-1 text-xs text-ink-3">Amount<Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="6000" /></label>
        <label className="grid gap-1 text-xs text-ink-3">Currency<Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
        <label className="grid gap-1 text-xs text-ink-3">Due<Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <Button type="submit" disabled={busy || !deal}>Add</Button>
      </form>
      {msg && <p role="status" className="text-sm text-ink-2">{msg}</p>}
    </div>
  );
}
