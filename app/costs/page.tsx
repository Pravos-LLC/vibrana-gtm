import { StatTile } from "@/components/stat-tile";
import { sessionDb } from "@/lib/supabase/server";
import { Bar, Section, Shell, Table, eur } from "@/components/shell";

export const dynamic = "force-dynamic";

type S = { id: string; date: string; currency: string; amount: number; amount_eur: number | null; merchant: string; vendor: string | null; category: string; gtm: boolean };

export const metadata = { title: "Costs" };

export default async function Costs() {
  const db = await sessionDb();
  const { data } = await db.from("gtm_spend").select("*").order("date", { ascending: false });
  const rows = (data ?? []) as S[];
  const { data: motionRows } = await db.from("gtm_storyboard_spend").select("storyboard_id,version,kind,credits,balance_after,job_id,at").order("at", { ascending: false }).limit(60);
  type M = { storyboard_id: string; version: number; kind: "authorized" | "spent"; credits: number; balance_after: number | null; job_id: string | null; at: string };
  const motion = (motionRows ?? []) as M[];
  const e = (r: S) => Number(r.amount_eur ?? r.amount);
  const month = (d: string) => d.slice(0, 7);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const last30 = rows.filter((r) => r.date >= cutoff);
  const sum = (xs: S[]) => xs.reduce((s, r) => s + e(r), 0);

  // Monthly totals split GTM vs other.
  const months = [...new Set(rows.map((r) => month(r.date)))].sort();
  const byMonth = months.map((mo) => {
    const xs = rows.filter((r) => month(r.date) === mo);
    return { mo, total: sum(xs), gtm: sum(xs.filter((r) => r.gtm)) };
  });
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.total));

  // Vendors: last-30-day run rate, last charge, active if charged in the last 45 days.
  const vendors = new Map<string, { vendor: string; category: string; gtm: boolean; last30: number; total: number; last: string; n: number }>();
  for (const r of rows) {
    const k = r.vendor ?? `? ${r.merchant}`;
    const v = vendors.get(k) ?? { vendor: k, category: r.category, gtm: r.gtm, last30: 0, total: 0, last: r.date, n: 0 };
    v.total += e(r); v.n++;
    if (r.date >= cutoff) v.last30 += e(r);
    if (r.date > v.last) v.last = r.date;
    vendors.set(k, v);
  }
  const active = [...vendors.values()].filter((v) => v.last >= new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10)).sort((a, b) => b.last30 - a.last30);
  const lapsed = [...vendors.values()].filter((v) => !active.includes(v)).sort((a, b) => b.total - a.total);
  const cats = new Map<string, number>();
  for (const r of last30) cats.set(r.category, (cats.get(r.category) ?? 0) + e(r));
  const maxCat = Math.max(1, ...cats.values());
  const unclassified = rows.filter((r) => !r.vendor);

  return (
    <Shell title="Costs" active="/costs" updated={rows[0]?.date}>
      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Last 30 days, all tools" value={eur(sum(last30))} />
        <StatTile label="Last 30 days, GTM + content" value={eur(sum(last30.filter((r) => r.gtm)))} />
        <StatTile label={`${thisMonth} so far`} value={eur(sum(rows.filter((r) => month(r.date) === thisMonth)))} />
        <StatTile label="Active vendors" value={String(active.length)} />
      </div>

      <Section title="Monthly spend" note="bar = total · second figure = GTM + content share">
        {byMonth.map((m) => (
          <Bar key={m.mo} label={m.mo} value={m.total} max={maxMonth} display={`${eur(m.total)} · ${eur(m.gtm)}`} />
        ))}
      </Section>

      <Section title="Last 30 days by category">
        {[...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => (
          <Bar key={c} label={c} value={v} max={maxCat} display={eur(v)} />
        ))}
      </Section>

      <Section title="Active subscriptions" note="charged in the last 45 days">
        <Table
          head={["Vendor", "Category", "GTM", "Last 30 days", "Last charge", "Charges"]}
          align={["l", "l", "l", "r", "l", "r"]}
          rows={active.map((v) => [v.vendor, v.category, v.gtm ? "yes" : "", eur(v.last30), v.last, v.n])}
        />
      </Section>

      <Section title="Lapsed or one-off" note="no charge in 45 days">
        <Table head={["Vendor", "Category", "Total", "Last charge"]} align={["l", "l", "r", "l"]} rows={lapsed.map((v) => [v.vendor, v.category, eur(v.total), v.last])} />
      </Section>

      <Section title="Motion credits" note="Motion.so credits recorded while the Storyboard Studio ran (retired 2026-10-28); new creates are capped per piece in the vibrana-motion skill">
        <Table head={["When", "Storyboard", "Kind", "Credits", "Balance after", "Job"]} align={["l", "l", "l", "r", "r", "l"]}
          rows={motion.length ? motion.map((m) => [m.at.slice(0, 16).replace("T", " "), `${m.storyboard_id.replace(/^sb-/, "")} v${m.version}`, m.kind, String(Number(m.credits)), m.balance_after == null ? "" : String(Number(m.balance_after)), m.job_id ?? ""]) : [["", "No Motion spend recorded yet", "", "", "", ""]]} />
      </Section>

      {unclassified.length > 0 && (
        <Section title="Unclassified software charges" note="add a match to config/vendors.yaml">
          <Table head={["Date", "Merchant", "Amount"]} align={["l", "l", "r"]} rows={unclassified.map((r) => [r.date, r.merchant, `${r.amount} ${r.currency}`])} />
        </Section>
      )}
      <p className="text-xs text-ink-3">
        Source: Wise card charges only. Anything billed to another card will not appear here. Non-EUR charges are converted at the rate on the day of sync.
      </p>
    </Shell>
  );
}
