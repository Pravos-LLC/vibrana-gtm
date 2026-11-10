// The /pipeline sub-navigation: six tabs, then the owner and period filters every tab shares (kept across tabs in the URL).
import Link from "next/link";
import type { Owner } from "@/lib/sales/deals";
import type { PeriodKey } from "@/lib/sales/metrics";
import { cn } from "@/lib/ui/cn";

export const TABS = [
  { href: "/pipeline", label: "Overview" },
  { href: "/pipeline/deals", label: "Deals" },
  { href: "/pipeline/conversations", label: "Conversations" },
  { href: "/pipeline/replies", label: "Replies" },
  { href: "/pipeline/meetings", label: "Meetings" },
  { href: "/pipeline/traffic", label: "Traffic" },
  { href: "/pipeline/people", label: "People" },
] as const;

const OWNERS: { value: Owner | null; label: string }[] = [{ value: null, label: "Everyone" }, { value: "JOHN", label: "John" }, { value: "ABE", label: "Abe" }];
const PERIODS: { value: PeriodKey; label: string }[] = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "qtd", label: "Quarter to date" }];

const pill = (on: boolean) => cn("rounded-md border px-3 py-1 text-sm", on ? "border-[color:var(--border-strong)] bg-[color:var(--surface-card)] text-ink" : "border-line text-ink-3 hover:text-ink-2");

export function SalesNav({ active, owner, period, showOwner = true }: { active: string; owner: Owner | null; period: PeriodKey; showOwner?: boolean }) {
  const q = (o: Owner | null, p: PeriodKey) => {
    const s = new URLSearchParams();
    if (o) s.set("owner", o);
    if (p !== "30") s.set("period", p);
    const str = s.toString();
    return str ? `?${str}` : "";
  };
  return (
    <div className="mb-8 space-y-4">
      <nav aria-label="Pipeline sections" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.href} href={`${t.href}${q(owner, period)}`} aria-current={t.href === active ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", t.href === active ? "border-[color:var(--viz-1)] font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {showOwner && (
          <nav aria-label="Owner" className="flex gap-2">
            {OWNERS.map((o) => <Link key={o.label} href={`${active}${q(o.value, period)}`} aria-current={o.value === owner ? "page" : undefined} className={pill(o.value === owner)}>{o.label}</Link>)}
          </nav>
        )}
        <nav aria-label="Period" className="flex gap-2">
          {PERIODS.map((p) => <Link key={p.value} href={`${active}${q(owner, p.value)}`} aria-current={p.value === period ? "page" : undefined} className={pill(p.value === period)}>{p.label}</Link>)}
        </nav>
      </div>
    </div>
  );
}

export const usd = (n: number | null | undefined, digits = 0) =>
  n == null ? null : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(n);
export const native = (m: { amount: number; currency: string } | null) =>
  m ? new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, maximumFractionDigits: 0 }).format(m.amount) : null;
export const pct = (x: number | null | undefined) => (x == null ? null : `${Math.round(x * 100)}%`);
export const per = (n: number | null | undefined) => (n == null ? null : n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n).toLocaleString("en-US"));
