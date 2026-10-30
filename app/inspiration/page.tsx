import Link from "next/link";
import { Shell } from "@/components/shell";
import { AddInspirationForm } from "@/components/inspiration/add-form";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PILLARS } from "@/lib/calendar-db";
import { KINDS, type Inspiration } from "@/lib/inspiration";
import { BUCKET } from "@/lib/review";
import { sessionDb } from "@/lib/supabase/server";
import { signedUrls } from "@/lib/sign-urls";

export const dynamic = "force-dynamic";

type Filter = { kind?: string; tag?: string; pillar?: string };

function href(current: Filter, change: Filter) {
  const next = { ...current, ...change };
  const query = new URLSearchParams(Object.entries(next).filter(([, value]) => value) as [string, string][]).toString();
  return query ? `/inspiration?${query}` : "/inspiration";
}

export const metadata = { title: "Inspiration" };

export default async function InspirationPage({ searchParams }: { searchParams: Promise<Filter> }) {
  const raw = await searchParams;
  const filter: Filter = {
    kind: (KINDS as readonly string[]).includes(raw.kind ?? "") ? raw.kind : undefined,
    pillar: (PILLARS as readonly string[]).includes(raw.pillar ?? "") ? raw.pillar : undefined,
    tag: raw.tag && /^[a-z0-9-]{1,40}$/.test(raw.tag) ? raw.tag : undefined,
  };
  const db = await sessionDb();
  const { data, error } = await db.from("gtm_inspiration").select("*").order("created_at", { ascending: false });
  const all = (data ?? []) as Inspiration[];
  const shown = all.filter((item) => (!filter.kind || item.kind === filter.kind) && (!filter.pillar || item.pillar === filter.pillar) && (!filter.tag || item.tags.includes(filter.tag)));
  const tags = [...new Set(all.flatMap((item) => item.tags))].sort();
  const stored = shown.map((item) => item.thumbnail_path).filter((path): path is string => !!path && !/^https?:\/\//.test(path));
  const { data: signed } = await signedUrls(db, stored, 60 * 60, BUCKET);
  const thumbs = new Map((signed ?? []).map((entry) => [entry.path ?? "", entry.signedUrl]));
  const thumb = (path: string | null) => (!path ? null : /^https?:\/\//.test(path) ? path : thumbs.get(path) ?? null);
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;

  return (
    <Shell title="Inspiration" active="/inspiration" wide>
      <div className="mx-auto max-w-7xl space-y-5">
        <AddInspirationForm kinds={KINDS} pillars={PILLARS} />
        {error && <p className="text-sm text-red-strong">Inspiration could not load: {error.message}</p>}
        <nav className="flex flex-wrap items-center gap-2" aria-label="Filters">
          <Link href={href(filter, { kind: undefined })} className={chip(!filter.kind)}>All kinds</Link>
          {KINDS.map((kind) => <Link key={kind} href={href(filter, { kind })} className={chip(filter.kind === kind)}>{kind}</Link>)}
          <span className="mx-2 h-4 w-px bg-line" />
          {PILLARS.map((pillar) => <Link key={pillar} href={href(filter, { pillar: filter.pillar === pillar ? undefined : pillar })} className={chip(filter.pillar === pillar)}>{pillar}</Link>)}
          {tags.length > 0 && <span className="mx-2 h-4 w-px bg-line" />}
          {tags.map((tag) => <Link key={tag} href={href(filter, { tag: filter.tag === tag ? undefined : tag })} className={chip(filter.tag === tag)}>#{tag}</Link>)}
        </nav>
        <p className="text-sm text-ink-2">{shown.length} of {all.length}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="inspiration-grid">
          {shown.map((item) => {
            const src = thumb(item.thumbnail_path);
            return (
              <Card key={item.id} glow={false} className="overflow-hidden p-0">
                <a href={item.url} target="_blank" rel="noreferrer" className="block">
                  {src ? <img src={src} alt="" className="aspect-video w-full object-cover" referrerPolicy="no-referrer" /> : <div className="aspect-video w-full bg-[color:var(--surface-inset)]" />}
                </a>
                <div className="space-y-2 p-4">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="info">{item.kind}</Badge>
                    {item.pillar && <Badge variant="outline">{item.pillar}</Badge>}
                    {item.platform && <Badge variant="outline">{item.platform}</Badge>}
                  </div>
                  <a href={item.url} target="_blank" rel="noreferrer" className="block font-medium text-ink hover:underline">{item.title || item.url}</a>
                  {item.why_we_like && <p className="text-sm text-ink-2">{item.why_we_like}</p>}
                  {item.tags.length > 0 && <p className="text-xs text-ink-3">{item.tags.map((tag) => `#${tag}`).join(" ")}</p>}
                </div>
              </Card>
            );
          })}
          {!shown.length && <Card glow={false} className="p-8 text-center text-ink-2 sm:col-span-2 lg:col-span-3 xl:col-span-4">Nothing saved here yet. Add a URL above or run <code>gtm inspo add</code>.</Card>}
        </div>
      </div>
    </Shell>
  );
}
