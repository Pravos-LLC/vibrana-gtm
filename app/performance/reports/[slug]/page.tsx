import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Shell } from "@/components/shell";
import { Eyebrow } from "@/components/brand";
import { anchorId, ReportBlock, SourceList } from "@/components/analytics-report/blocks";
import { sessionDb } from "@/lib/supabase/server";
import { getReport, listReports, reportPath } from "@/lib/analytics-reports/store";
import { periodLabel } from "@/lib/analytics-reports/email";
import { validateReportDoc } from "@/lib/analytics-reports/doc";

export const dynamic = "force-dynamic";

/** "Report Oct 26" from weekly-2026-10-26, without a database read. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const m = /(\d{4}-\d{2}-\d{2})$/.exec((await params).slug);
  const when = m ? new Date(`${m[1]}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return { title: when ? `Report ${when}` : "Report" };
}

export default async function ReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(slug)) notFound();
  const db = await sessionDb();
  const [rep, all] = await Promise.all([getReport(db, slug), listReports(db, 104).catch(() => [])]);
  if (!rep) notFound();
  const problems = validateReportDoc(rep.doc);
  const d = rep.doc;
  const at = all.findIndex((r) => r.slug === slug);
  const newer = at > 0 ? all[at - 1] : null;
  const older = at >= 0 && at < all.length - 1 ? all[at + 1] : null;

  const toc = (
    <aside className="hidden xl:block">
      <nav className="sticky top-24 space-y-1 text-sm" aria-label="On this page">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-ink-3">On this page</p>
        {d.blocks?.map((b, i) => <a key={i} href={`#${anchorId(b.title, i)}`} className="block truncate rounded px-1 py-0.5 text-ink-2 hover:text-ink">{b.title}</a>)}
        <a href="#sources" className="block rounded px-1 py-0.5 text-ink-2 hover:text-ink">Sources</a>
      </nav>
    </aside>
  );

  return (
    <Shell title={rep.title} active="/performance/reports" updated={rep.updated_at}>
      <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_13rem]">
        <article className="min-w-0">
          <Link href="/performance/reports" prefetch={false} className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft aria-hidden className="size-3.5" />All reports</Link>
          <Eyebrow className="mt-4">{rep.title} · {periodLabel(rep.period_start, rep.period_end)}</Eyebrow>
          <h1 className="mt-3 max-w-[30ch] font-display text-pl-3xl font-semibold leading-tight tracking-tight text-ink">{rep.headline}</h1>
          {problems.length > 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-line px-5 py-6 text-sm text-ink-3">This report&apos;s document no longer matches the report format, so it cannot be shown. Republish it with <code className="font-mono">gtm analytics publish</code>.</p>
          ) : (
            <>
              <ul className="mt-6 max-w-[68ch] space-y-2 text-pl-base leading-relaxed text-ink-2">
                {d.summary.map((s) => <li key={s} className="flex gap-3"><span aria-hidden className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-[color:var(--viz-1)]" />{s}</li>)}
              </ul>
              <p className="mt-4 text-xs text-ink-3">Published {new Date(rep.published_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}{d.author ? ` by ${d.author}` : ""}{rep.emailed_at ? ", emailed" : ""}.</p>
              <div className="mt-8">
                {d.blocks.map((b, i) => <ReportBlock key={i} block={b} index={i} />)}
                <section id="sources" className="scroll-mt-24 border-t border-line py-8">
                  <h2 className="mb-4 font-display text-pl-lg font-semibold tracking-tight text-ink">Sources</h2>
                  <SourceList sources={d.sources} />
                </section>
              </div>
            </>
          )}
          <nav className="mt-4 flex items-center justify-between gap-4 border-t border-line pt-6 text-sm" aria-label="Other reports">
            {older ? <Link href={reportPath(older.slug)} prefetch={false} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink"><ChevronLeft aria-hidden className="size-4" />{periodLabel(older.period_start, older.period_end)}</Link> : <span />}
            {newer ? <Link href={reportPath(newer.slug)} prefetch={false} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">{periodLabel(newer.period_start, newer.period_end)}<ChevronRight aria-hidden className="size-4" /></Link> : <span />}
          </nav>
        </article>
        {toc}
      </div>
    </Shell>
  );
}
