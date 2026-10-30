import Link from "next/link";
import { Shell } from "@/components/shell";
import { AddIdeaForm } from "@/components/ideas/add-form";
import { IdeaCard } from "@/components/ideas/idea-card";
import { Card } from "@/components/ui/card";
import { defaultWeekStart } from "@/lib/candidates/select";
import { groupByStatus, IDEA_COLUMNS, IDEA_KINDS, IDEA_PILLARS, KIND_LABEL, type Idea } from "@/lib/ideas/model";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Filter = { kind?: string; pillar?: string; tag?: string };

function href(current: Filter, change: Filter) {
  const next = { ...current, ...change };
  const query = new URLSearchParams(Object.entries(next).filter(([, value]) => value) as [string, string][]).toString();
  return query ? `/ideas?${query}` : "/ideas";
}

// Ideas still moving sit side by side; shipped and parked ones are history, shown below.
const ACTIVE = ["idea", "shortlisted", "in_production"];

export const metadata = { title: "Ideas" };

export default async function IdeasPage({ searchParams }: { searchParams: Promise<Filter> }) {
  const raw = await searchParams;
  const filter: Filter = {
    kind: (IDEA_KINDS as readonly string[]).includes(raw.kind ?? "") ? raw.kind : undefined,
    pillar: (IDEA_PILLARS as readonly string[]).includes(raw.pillar ?? "") ? raw.pillar : undefined,
    tag: raw.tag && /^[a-z0-9-]{1,40}$/.test(raw.tag) ? raw.tag : undefined,
  };
  const db = await sessionDb(); // RLS: only the owner reads gtm_ideas
  const { data, error } = await db.from("gtm_ideas").select(IDEA_COLUMNS).order("updated_at", { ascending: false }).limit(500);
  const all = (data ?? []) as unknown as Idea[];
  const shown = all.filter((i) => (!filter.kind || i.kind === filter.kind) && (!filter.pillar || i.pillar === filter.pillar) && (!filter.tag || i.tags.includes(filter.tag)));
  const promotedIds = shown.map((i) => i.promoted_candidate_id).filter((id): id is string => !!id);
  const { data: weeks } = promotedIds.length ? await db.from("gtm_content_candidates").select("id,week_start").in("id", promotedIds) : { data: [] };
  const weekOf = new Map((weeks ?? []).map((w) => [String(w.id), String(w.week_start)]));
  const tags = [...new Set(all.flatMap((i) => i.tags))].sort();
  const groups = groupByStatus(shown);
  const nextWeek = defaultWeekStart();
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;
  const column = (g: (typeof groups)[number]) => (
    <section key={g.status} className="space-y-3" data-testid={`ideas-${g.status}`} aria-label={g.label}>
      <h2 className="flex items-baseline justify-between font-display text-sm font-semibold uppercase tracking-wide text-ink-2">
        {g.label}<span className="font-mono text-xs text-ink-3">{g.ideas.length}</span>
      </h2>
      {g.ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} defaultWeek={nextWeek} candidateWeek={idea.promoted_candidate_id ? weekOf.get(idea.promoted_candidate_id) ?? null : null} />)}
      {!g.ideas.length && <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-3">Nothing here</p>}
    </section>
  );

  return (
    <Shell title="Ideas" active="/ideas" wide>
      <div className="mx-auto max-w-7xl space-y-5">
        <p className="text-sm text-ink-2">
          The Brainstorming Backlog: ideas for content, engagement experiments and lead magnets, before they are anything else.
          Shortlist the good ones; Promote puts a content idea in the Sunday candidates as a brief to write up. Nothing is approved or scheduled from here.
        </p>
        <AddIdeaForm />
        {error && <p className="text-sm text-red-strong">Ideas could not load: {error.message}</p>}
        <nav className="flex flex-wrap items-center gap-2" aria-label="Filters">
          <Link href={href(filter, { kind: undefined })} className={chip(!filter.kind)}>All kinds</Link>
          {IDEA_KINDS.map((kind) => <Link key={kind} href={href(filter, { kind })} className={chip(filter.kind === kind)}>{KIND_LABEL[kind]}</Link>)}
          <span className="mx-2 h-4 w-px bg-line" />
          {IDEA_PILLARS.map((pillar) => <Link key={pillar} href={href(filter, { pillar: filter.pillar === pillar ? undefined : pillar })} className={chip(filter.pillar === pillar)}>{pillar}</Link>)}
          {tags.length > 0 && <span className="mx-2 h-4 w-px bg-line" />}
          {tags.map((tag) => <Link key={tag} href={href(filter, { tag: filter.tag === tag ? undefined : tag })} className={chip(filter.tag === tag)}>#{tag}</Link>)}
        </nav>
        <p className="text-sm text-ink-2" data-testid="ideas-summary">{shown.length} of {all.length}</p>
        {all.length === 0 && !error && <Card glow={false} className="p-8 text-center text-ink-2">No ideas yet. Add one above, or run <code>gtm idea add &quot;...&quot;</code> or <code>gtm idea seed config/ideas-seed.json</code>.</Card>}
        <div className="grid gap-5 lg:grid-cols-3">{groups.filter((g) => ACTIVE.includes(g.status)).map(column)}</div>
        <div className="grid gap-5 border-t border-line pt-5 lg:grid-cols-2">{groups.filter((g) => !ACTIVE.includes(g.status)).map(column)}</div>
      </div>
    </Shell>
  );
}
