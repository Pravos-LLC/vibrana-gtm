import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { Shell } from "@/components/shell";
import { Eyebrow } from "@/components/brand";
import { Card } from "@/components/ui/card";
import { sessionDb } from "@/lib/supabase/server";
import { listReports, reportPath } from "@/lib/analytics-reports/store";
import { periodLabel } from "@/lib/analytics-reports/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

// Analytics > Reports: every weekly review, newest first, to look back on. The weekly-report skill writes them
// (gtm analytics publish) and the hourly cron emails John the link.
export default async function ReportsPage() {
  const rows = await listReports(await sessionDb()).catch(() => []);
  return (
    <Shell title="Reports" active="/performance/reports">
      <Eyebrow>Analytics</Eyebrow>
      <h1 className="mt-3 font-display text-pl-3xl font-semibold tracking-tight text-ink">Weekly reports</h1>
      <p className="mt-3 max-w-[62ch] text-pl-base leading-relaxed text-ink-2">
        What did well on which channel, what didn&apos;t, what to change next week and how sure we are, with the news worth posting on. One report a week, emailed as a link on Monday.
      </p>
      {rows.length === 0 ? (
        <p className="mt-10 rounded-xl border border-dashed border-line px-5 py-8 text-sm text-ink-3">No reports yet. The weekly-report skill publishes one each Monday with <code className="font-mono">gtm analytics publish</code>.</p>
      ) : (
        <ol className="mt-10 space-y-3">
          {rows.map((r, i) => (
            <li key={r.id}>
              <Link href={reportPath(r.slug)} prefetch={false} className="group block rounded-xl">
                <Card glow={false} className="flex items-center gap-4 p-5 transition-colors group-hover:border-[color:var(--border-strong)]">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span className="font-medium uppercase tracking-[0.08em]">{periodLabel(r.period_start, r.period_end)}</span>
                      <span>{r.title}</span>
                      {i === 0 && <span className="rounded-full bg-violet/10 px-2 py-0.5 font-medium text-violet-strong">Latest</span>}
                      {r.emailed_at && <span className="inline-flex items-center gap-1"><Mail aria-hidden className="size-3" />Emailed</span>}
                    </p>
                    <p className="mt-1.5 font-medium leading-snug text-ink">{r.headline}</p>
                  </div>
                  <ArrowRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                </Card>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Shell>
  );
}
