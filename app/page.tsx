import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/stat-tile";
import { latestReport, waitingCandidates } from "@/lib/analytics/load";
import { PostThumb, StatusBadge, channelLabel } from "@/components/content/post-card";
import { ConversationList, CrmError, DealBoard, TwentyLink } from "@/components/crm/people";
import { Section, Shell } from "@/components/shell";
import { DONE, reviewHref, type Post } from "@/lib/posts";
import { loadPosts, todayIn } from "@/lib/posts-db";
import { reviewSummary } from "@/lib/review-summary";
import { crmRead, opportunities, recentConversations } from "@/lib/twenty";
import { addDays } from "@/lib/week";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Tiles fill one row on desktop however many are showing (the report and candidates tiles are optional).
const GRID: Record<number, string> = { 4: "md:grid-cols-4", 5: "md:grid-cols-3 xl:grid-cols-5", 6: "md:grid-cols-3 xl:grid-cols-6" };

export const metadata = { title: "Today" };

/** Today: what needs John, what goes out this week, and who he is talking to. Everything links to its home screen. */
export default async function Today() {
  const db = await sessionDb();
  const today = todayIn();
  const [{ posts, error }, review, people, deals, report, candidates] = await Promise.all([
    loadPosts(db, { to: addDays(today, 7) }),
    reviewSummary(db),
    crmRead(() => recentConversations(8)),
    crmRead(() => opportunities()),
    latestReport(db),
    waitingCandidates(db),
  ]);
  const overdue = posts.filter((p) => p.date < today && !DONE.includes(p.status));
  const next7 = posts.filter((p) => p.date >= today && p.status !== "skipped");
  const blocked = next7.filter((p) => p.linkProblems.length > 0 || ["idea", "drafted"].includes(p.status));
  const live = posts.filter((p) => p.status === "published" && p.date >= addDays(today, -14)).reverse();
  const openDeals = (deals.data ?? []).filter((d) => d.stage !== "LOST" && d.stage !== "SIGNED").length;

  return (
    <Shell title="Today" active="/">
      {error && <p className="mb-4 text-sm text-red-strong">The calendar could not load: {error}</p>}
      <div className={`mb-10 grid grid-cols-2 gap-4 ${GRID[4 + (report ? 1 : 0) + (candidates ? 1 : 0)]}`}>
        <StatTile href="/content" label="Awaiting your review" value={String(review.awaiting)} note={`${review.percent}% of the season approved`} />
        <StatTile href="/content" label="Open notes" value={String(review.openNotes)} note={`${review.needsChanges} sent back for changes`} />
        <StatTile href="/calendar?view=list" label="Overdue posts" value={String(overdue.length)} note="dated in the past, not out yet" tone={overdue.length ? "bad" : undefined} />
        <StatTile href="/calendar" label="Not ready, next 7 days" value={String(blocked.length)} note={`of ${next7.length} going out`} tone={blocked.length ? "warn" : undefined} />
        {report && (
          <StatTile href={`/performance/report/${report.week}${report.toDecide ? "#changes" : ""}`} label={`Report: ${report.toDecide === 1 ? "change" : "changes"} to decide`} value={String(report.toDecide)}
            note={`Week ${report.week}${report.headline ? `: ${report.headline}` : ""}`} />
        )}
        {candidates && <StatTile href="/signals?view=candidates" label="Candidates waiting" value={String(candidates)} note="drafted from the Signal Desk" />}
      </div>

      {overdue.length > 0 && (
        <Section title="Overdue" note="dated in the past and not published">
          <Strip posts={overdue} />
        </Section>
      )}
      <Section title="Going out in the next 7 days" note={`${next7.length} ${next7.length === 1 ? "post" : "posts"}`}>
        {next7.length ? <Strip posts={next7} /> : <p className="text-sm text-ink-3">Nothing on the calendar for the next 7 days.</p>}
        <More href="/calendar">Open the calendar</More>
      </Section>

      <div className="mb-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">In conversation</h2>
            <TwentyLink path="/objects/people" />
          </div>
          <Card glow={false} className="px-4 py-1">
            {people.error ? <div className="py-3"><CrmError message={people.error} /></div> : <ConversationList contacts={people.data ?? []} />}
          </Card>
          <More href="/funnel">CRM and funnel</More>
        </section>
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">Went out, last 14 days</h2>
            <Link href="/performance" className="text-xs text-violet-strong underline-offset-2 hover:underline">Performance</Link>
          </div>
          <Card glow={false} className="divide-y divide-[color:var(--border-default)] px-4 py-1">
            {live.length === 0 && <p className="py-3 text-sm text-ink-3">Nothing published in the last 14 days.</p>}
            {live.map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-2.5">
                <PostThumb post={p} className="size-12" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{p.title}</div>
                  <div className="text-xs text-ink-3">{p.date} · {p.channels.map(channelLabel).join(", ")}</div>
                </div>
                {Object.entries(p.urls).slice(0, 1).map(([c, u]) => (
                  <a key={c} href={u} target="_blank" rel="noreferrer" className="text-xs text-violet-strong underline-offset-2 hover:underline">View</a>
                ))}
              </div>
            ))}
          </Card>
        </section>
      </div>

      <Section title="Opportunities" note={deals.data ? `${openDeals} open` : undefined}>
        {deals.error ? <CrmError message={deals.error} /> : <DealBoard deals={deals.data ?? []} />}
      </Section>
    </Shell>
  );
}

/** Posts as a horizontal row of cards: thumbnail, platform, when, title and status. */
function Strip({ posts }: { posts: Post[] }) {
  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {posts.map((p) => {
        const href = reviewHref(p) ?? `/calendar?week=${p.date}`;
        return (
          <Link key={p.id} href={href} className="group w-44 shrink-0">
            <PostThumb post={p} className="aspect-[4/5] w-full transition-transform group-hover:scale-[1.01]" text />
            <div className="mt-2 text-xs tabular-nums text-ink-3">{p.date.slice(5)} {p.time ?? ""} · {p.channels.map(channelLabel).join(", ")}</div>
            <div className="mt-0.5 line-clamp-2 text-sm font-medium text-ink">{p.title}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <StatusBadge status={p.status} />
              {p.linkProblems.length > 0 && <span className="text-xs text-red-strong">breaks a channel rule</span>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function More({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="mt-3 inline-flex items-center gap-1 text-sm text-violet-strong underline-offset-2 hover:underline">
      {children} <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}
