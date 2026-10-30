"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { GuideImage, GuideVideo } from "@/components/guide/media";
import type { Pillar } from "@/lib/guide/content";
import { PILLAR_TONE } from "@/lib/guide/presentation";
import type { SignedMedia } from "@/lib/guide/media";
import { cn } from "@/lib/ui/cn";

export function PillarTabs({ pillars, value, onChange, compact }: { pillars: Pillar[]; value: string; onChange: (slug: Pillar["slug"]) => void; compact?: boolean }) {
  return (
    <div role="tablist" aria-label="Pillar" className={cn("grid grid-cols-2 gap-2", !compact && "md:grid-cols-4")}>
      {pillars.map((x) => (
        <button key={x.slug} type="button" role="tab" aria-selected={x.slug === value} onClick={() => onChange(x.slug)}
          style={{ ["--tone" as string]: PILLAR_TONE[x.slug] }}
          className="rounded-xl border border-line px-4 py-3 text-left transition-[background-color,border-color,transform] duration-200 active:scale-[0.98] aria-selected:border-[color:var(--tone)] aria-selected:bg-[color:var(--surface-card-hover)]">
          <span className="block font-display text-pl-lg font-semibold text-ink">{x.name}</span>
          <span className="text-xs tabular-nums text-ink-3">{x.share}% of slots</span>
        </button>
      ))}
    </div>
  );
}

export function Dial({ pillar }: { pillar: Pillar }) {
  return (
    <div>
      <div className="flex items-center gap-3 text-xs text-ink-2">
        <span className="w-16">Operator</span>
        <div className="relative h-2 flex-1 rounded-full bg-surface-overlay" role="img" aria-label={`Voice dial: ${pillar.dial_label}`}>
          {pillar.dial && <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]" style={{ width: `${pillar.dial.operator}%`, background: PILLAR_TONE[pillar.slug] }} />}
        </div>
        <span className="w-10 text-right">Soul</span>
      </div>
      <p className="mt-2 font-display text-pl-xl font-semibold text-ink">{pillar.dial_label}</p>
    </div>
  );
}

/** The Pillars chapter: pick a pillar and everything below retunes to it. */
export function PillarConsole({ pillars, media }: { pillars: Pillar[]; media: Record<string, SignedMedia> }) {
  const [slug, setSlug] = useState(pillars[0].slug);
  const p = pillars.find((x) => x.slug === slug)!;
  const tone = PILLAR_TONE[p.slug];
  return (
    <div style={{ ["--tone" as string]: tone }}>
      <PillarTabs pillars={pillars} value={slug} onChange={setSlug} />
      <div key={p.slug} className="guide-rise mt-10">
        <div className="grid gap-10 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-8">
            <div>
              <p className="text-sm font-medium" style={{ color: tone }}>{p.role}</p>
              <p className="mt-2 max-w-[56ch] text-pl-base leading-relaxed text-ink-2">{p.purpose}</p>
            </div>
            <Dial pillar={p} />
            <p className="text-sm text-ink-2">Speaks as <strong className="font-medium text-ink">&ldquo;{p.speaks_as}&rdquo;</strong>. Opens on {p.opening.charAt(0).toLowerCase() + p.opening.slice(1)}.</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <Rules title="Do" items={p.dos} icon="check" />
              <Rules title="Don't" items={p.donts} icon="x" />
            </div>
            {p.notes.length > 0 && (
              <div className="rounded-xl bg-surface-overlay/60 p-4">
                <p className="mb-2 text-sm font-medium text-ink">Judgment calls</p>
                <ul className="space-y-2 text-sm leading-relaxed text-ink-2">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              </div>
            )}
            <div>
              <p className="mb-3 text-sm font-medium text-ink">Ships as</p>
              <div className="flex flex-wrap gap-2">{p.formats.map((f) => <span key={f} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2">{f}</span>)}</div>
            </div>
            {p.links?.length ? (
              <div>
                <p className="mb-2 text-sm font-medium text-ink">Links it can use</p>
                <ul className="space-y-1 text-sm">{p.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">{l.label}</a></li>)}</ul>
              </div>
            ) : null}
          </div>
          <div className="space-y-4">
            {p.contrasts.map((c, i) => (
              <div key={i} className="overflow-hidden rounded-2xl border border-line">
                <div className="border-b border-line bg-surface-overlay/60 p-5">
                  <p className="text-xs font-medium text-ink-3">Weak</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-3 line-through decoration-[color:var(--border-strong)]">{c.weak}</p>
                </div>
                <div className="p-5">
                  <p className="text-xs font-medium" style={{ color: tone }}>Great</p>
                  <p className="mt-1.5 font-display text-pl-lg font-medium leading-snug text-ink">{c.great.text}</p>
                  <p className="mt-3 text-xs text-ink-3">{c.why}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <h3 className="mt-14 font-display text-pl-xl font-semibold text-ink">{p.name}: real posts</h3>
        <div className={cn("mt-5 grid gap-5", p.examples.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2")}>
          {p.examples.map((e) => {
            const m = e.media ? media[e.media] : undefined;
            return (
              <article key={e.title} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-[color:var(--surface-frost)]">
                {m && (m.kind === "video" ? <GuideVideo media={m} label={e.title} className="aspect-[4/5]" /> : <GuideImage media={m} alt={`${e.title}, first slide`} className="aspect-[4/5]" />)}
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-xs text-ink-3">{e.channel}</p>
                  <p className="mt-2 font-display text-pl-lg font-medium leading-snug text-ink">{e.hook.text}</p>
                  {e.excerpt && <p className="mt-2 text-sm leading-relaxed text-ink-2">{e.excerpt.text}</p>}
                  <p className="mt-auto pt-4 text-xs text-ink-3"><span className="font-medium text-ink-2">Why it works:</span> {e.why}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Rules({ title, items, icon }: { title: string; items: string[]; icon: "check" | "x" }) {
  return (
    <div>
      <p className="mb-3 text-sm font-medium text-ink">{title}</p>
      <ul className="space-y-2 text-sm text-ink-2">
        {items.map((x) => (
          <li key={x} className="flex gap-2">
            {icon === "check" ? <Check className="mt-0.5 size-4 shrink-0" style={{ color: "var(--tone)" }} /> : <X className="mt-0.5 size-4 shrink-0 text-ink-3" />}
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}
