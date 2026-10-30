import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/shell";
import { CandidateCard, type CandidateView } from "@/components/signals/candidate-card";
import { StoryActions } from "@/components/signals/story-actions";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CANDIDATE_COLUMNS, type CandidateRow } from "@/lib/candidates/store";
import { adminDb } from "@/lib/db";
import { signalsViewer } from "@/lib/signals/access";
import { signalsConfig, type SignalStory } from "@/lib/signals/config";
import { storyItems } from "@/lib/signals/pipeline";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Inbox holds what still needs a decision; the other views are where decided stories go.
const VIEWS = {
  inbox: { label: "Inbox", statuses: ["new", "saved"] },
  queued: { label: "Queued", statuses: ["queued"] },
  drafted: { label: "Drafted", statuses: ["drafted"] },
  dismissed: { label: "Dismissed", statuses: ["dismissed"] },
  // Sunday candidates (VIB-420): drafted pieces waiting for John. Owner only; not signal statuses.
  candidates: { label: "Candidates", statuses: [] },
} as const;
type View = keyof typeof VIEWS;
type Filter = { view?: string; lane?: string; week?: string };

function href(current: { view: View; lane?: string }, change: Partial<{ view: View; lane: string | undefined }>) {
  const next = { ...current, ...change };
  const query = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === "view" && v === "inbox")) as [string, string][]).toString();
  return query ? `/signals?${query}` : "/signals";
}

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

export const metadata = { title: "Signals" };

export default async function SignalsPage({ searchParams }: { searchParams: Promise<Filter> }) {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  const viewer = signalsViewer(claims?.claims as Record<string, unknown> | undefined);
  if (!viewer) redirect("/login");

  const cfg = signalsConfig();
  const raw = await searchParams;
  const requested: View = raw.view && Object.hasOwn(VIEWS, raw.view) ? (raw.view as View) : "inbox";
  // Candidates are decided by the owner; a team member stays on the signal views.
  const view: View = requested === "candidates" && viewer.role !== "owner" ? "inbox" : requested;
  if (view === "candidates") return <CandidatesView week={raw.week} team={false} />;
  const lane = cfg.lanes.some((l) => l.slug === raw.lane) ? raw.lane : undefined;
  const laneName = (slug: string) => cfg.lanes.find((l) => l.slug === slug)?.name ?? slug;

  // The claim is checked above; the service client reads because a gtm_team member has no RLS read.
  const db = adminDb();
  const since = new Date(Date.now() - (view === "inbox" ? cfg.ranking.window_hours : 24 * 30) * 3600_000).toISOString();
  let query = db.from("gtm_signal_stories")
    .select("id,title,lanes,score,velocity,source_count,item_count,first_seen,last_seen,brief,briefed_at,status,requested_format,gtm_story_id,acted_by,acted_at")
    .in("status", [...VIEWS[view].statuses]).gte("last_seen", since)
    .order(view === "inbox" ? "score" : "acted_at", { ascending: false }).limit(40);
  if (lane) query = query.contains("lanes", [lane]);
  const [{ data, error }, { data: runs }] = await Promise.all([
    query,
    db.from("gtm_signal_runs").select("kind,started_at,finished_at,stats,errors").order("started_at", { ascending: false }).limit(30),
  ]);
  const stories = (data ?? []) as SignalStory[];
  const items = await storyItems(db, stories.map((s) => s.id));
  const latest = (kind: string) => (runs ?? []).find((r) => r.kind === kind) as { started_at: string; finished_at: string | null; stats: { inserted?: number }; errors: unknown[] } | undefined;
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;

  return (
    <Shell title="Signals" active="/signals" wide team={viewer.role === "team"}>
      <div className="mx-auto max-w-5xl space-y-5">
        <p className="text-sm text-ink-2">
          Timely AI stories from the web, Bluesky and John&apos;s X, classified by a decision model and ranked by fit, spread and taste.
          Queue one to have the writers-room draft it; nothing is posted without approval in Review.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3" data-testid="signal-runs">
          {[["collect", "Web"], ["collect_x", "X (Mac)"], ["digest", "Digest"]].map(([kind, label]) => {
            const r = latest(kind);
            return <span key={kind}>{label}: {r ? `${ago(r.started_at)}${r.finished_at ? "" : " (did not finish)"}${kind === "digest" ? "" : `, ${r.stats.inserted ?? 0} new`}${r.errors.length ? `, ${r.errors.length} source errors` : ""}` : "never"}</span>;
          })}
        </div>
        <nav className="flex flex-wrap items-center gap-2" aria-label="Filters">
          {(Object.keys(VIEWS) as View[]).filter((v) => v !== "candidates" || viewer.role === "owner").map((v) => <Link key={v} href={href({ view, lane }, { view: v })} className={chip(view === v)}>{VIEWS[v].label}</Link>)}
          <span className="mx-2 h-4 w-px bg-line" />
          <Link href={href({ view, lane }, { lane: undefined })} className={chip(!lane)}>All lanes</Link>
          {cfg.lanes.map((l) => <Link key={l.slug} href={href({ view, lane }, { lane: lane === l.slug ? undefined : l.slug })} className={chip(lane === l.slug)}>{l.name}</Link>)}
        </nav>
        {error && <p className="text-sm text-red-strong">Signals could not load: {error.message}</p>}
        <div className="space-y-4" data-testid="signal-stories">
          {stories.map((s) => {
            const b = s.brief;
            const sources = items.filter((i) => i.story_id === s.id);
            return (
              <Card key={s.id} glow={false} className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="font-mono text-ink-2" title="Score: lane fit, substance, spread, velocity, taste; decays over a day">{s.score.toFixed(0)}</span>
                  {s.lanes.map((l) => <Badge key={l} variant="info">{laneName(l)}</Badge>)}
                  <span>{s.source_count} source{s.source_count === 1 ? "" : "s"}</span>
                  <span>first seen {ago(s.first_seen)}</span>
                  {s.acted_by && view !== "inbox" && <span>by {s.acted_by}</span>}
                </div>
                {b
                  ? <h2 className="font-display text-pl-lg font-semibold leading-snug tracking-tight text-ink">{b.headline}</h2>
                  : <h2 className="line-clamp-2 font-display text-base font-semibold leading-snug text-ink" title={s.title}>{s.title}</h2>}
                {b ? (
                  <div className="space-y-2 text-sm text-ink-2">
                    <p><span className="font-medium text-ink">What happened.</span> {b.what_happened}</p>
                    <p><span className="font-medium text-ink">Why it matters.</span> {b.why_it_matters}</p>
                    <p><span className="font-medium text-ink">The tension.</span> {b.tension}</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      <li><span className="text-ink">LinkedIn take:</span> {b.angles.linkedin_take}</li>
                      <li><span className="text-ink">Story:</span> {b.angles.story}</li>
                      <li><span className="text-ink">Video:</span> {b.angles.video}</li>
                    </ul>
                  </div>
                ) : <p className="text-xs text-ink-3">No brief yet: the top stories are briefed each morning.</p>}
                <ul className="space-y-1 text-sm">
                  {sources.slice(0, 6).map((i) => (
                    <li key={i.url} className="truncate">
                      <a href={i.url} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">{i.title}</a>
                      <span className="text-ink-3"> · {i.source}{i.author && !i.source.includes(i.author) ? ` · ${i.author}` : ""}</span>
                    </li>
                  ))}
                  {sources.length > 6 && <li className="text-xs text-ink-3">and {sources.length - 6} more (gtm signals show {s.id})</li>}
                </ul>
                <StoryActions id={s.id} status={s.status} format={s.requested_format} />
              </Card>
            );
          })}
          {!stories.length && <Card glow={false} className="p-8 text-center text-ink-2">Nothing here yet. The web is collected every two hours; run <code>gtm signals run</code> to fetch now.</Card>}
        </div>
      </div>
    </Shell>
  );
}

/** The view a candidate row is shown with: the client card gets plain, serializable data. */
function toView(c: CandidateRow): CandidateView {
  return {
    id: c.id, status: c.status, format: c.format, lens: c.lens, pillar: c.pillar, channels: c.channels, title: c.title, body: c.body,
    instagram: c.instagram, slides: c.slides as CandidateView["slides"], video: c.video as CandidateView["video"], sources: c.sources, score: c.score,
    rubric: (c.rubric ?? {}) as CandidateView["rubric"], reject_reason: c.reject_reason, reject_note: c.reject_note, gtm_story_id: c.gtm_story_id,
    decided_by: c.decided_by, decided_at: c.decided_at, updated_at: c.updated_at, edits: (c.edits ?? []).length,
  };
}

const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** /signals?view=candidates: the Sunday candidates for a week, waiting ones first. */
async function CandidatesView({ week, team }: { week?: string; team: boolean }) {
  const db = adminDb(); // the owner claim was checked by the page
  const { data: weekRows, error: weekError } = await db.from("gtm_content_candidates").select("week_start").order("week_start", { ascending: false }).limit(200);
  const weeks = [...new Set((weekRows ?? []).map((r) => String(r.week_start)))].slice(0, 6);
  const current = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : weeks[0];
  const { data, error } = current
    ? await db.from("gtm_content_candidates").select(CANDIDATE_COLUMNS).eq("week_start", current).order("position")
    : { data: [], error: null };
  const rows = ((data ?? []) as CandidateRow[]).sort((a, b) => Number(a.status !== "candidate") - Number(b.status !== "candidate") || a.position - b.position);
  const waiting = rows.filter((r) => r.status === "candidate").length;
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;
  return (
    <Shell title="Signals" active="/signals" wide team={team}>
      <div className="mx-auto max-w-5xl space-y-5">
        <p className="text-sm text-ink-2">
          Drafted every Sunday afternoon from the Signal Desk and the morning&apos;s report, in your voice, graded by the rubric judge.
          Send to Review puts one in Content review as drafted posts; nothing is approved or scheduled from here.
        </p>
        <nav className="flex flex-wrap items-center gap-2" aria-label="Filters">
          {(Object.keys(VIEWS) as View[]).map((v) => <Link key={v} href={v === "inbox" ? "/signals" : `/signals?view=${v}`} className={chip(v === "candidates")}>{VIEWS[v].label}</Link>)}
          {weeks.length > 1 && <span className="mx-2 h-4 w-px bg-line" />}
          {weeks.length > 1 && weeks.map((w) => <Link key={w} href={`/signals?view=candidates&week=${w}`} className={chip(w === current)}>Week of {weekLabel(w)}</Link>)}
        </nav>
        {(error || weekError) && <p className="text-sm text-red-strong">Candidates could not load: {(error ?? weekError)?.message}</p>}
        {current && <p className="text-xs text-ink-3" data-testid="candidates-summary">Week of {weekLabel(current)}: {rows.length} {rows.length === 1 ? "candidate" : "candidates"}, {waiting} waiting</p>}
        <div className="space-y-4" data-testid="candidates">
          {rows.map((c) => <CandidateCard key={c.id} c={toView(c)} />)}
          {!rows.length && <Card glow={false} className="p-8 text-center text-ink-2">No candidates yet. The Sunday routine drafts them at 15:00 Bali time (<code>gtm candidates select</code>, then <code>gtm candidates put</code>).</Card>}
        </div>
      </div>
    </Shell>
  );
}
