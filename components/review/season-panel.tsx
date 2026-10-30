"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Check, SeasonAnalysis, SeasonRecord, WeekCadence } from "@/lib/season-analysis";
import { findingHref } from "@/lib/finding-link";

export type SeasonSave = (input: { id: string; title: string; description: string; startsOn: string; endsOn: string; pillars: string[] }) => Promise<{ ok: true } | { ok: false; error: string }>;

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const weekTone: Record<WeekCadence["status"], string> = {
  gap: "bg-red-strong/50",
  under: "bg-amber-strong/70",
  "on-target": "bg-[image:var(--gradient-prism)]",
  over: "bg-violet-strong/80",
};

function Cadence({ a }: { a: SeasonAnalysis }) {
  const c = a.cadence;
  const max = Math.max(c.targetPerWeek, ...c.weeks.map((w) => w.socialPieces), 1);
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">Posts per week, target {c.targetPerWeek}</h3>
      <div className="mt-3 flex h-20 gap-1.5" role="list" aria-label="Posts per week">
        {c.weeks.map((w) => (
          <div key={w.index} role="listitem" aria-label={`Week ${w.index}: ${w.socialPieces} of ${w.target} posts`} className="flex h-full flex-1 flex-col items-center gap-1" title={`Week ${w.index} (${day(w.start)}): ${w.socialPieces} of ${w.target}, ${w.status.replace("-", " ")}`}>
            <div className="flex w-full flex-1 items-end">
              <div className={`w-full rounded-sm ${weekTone[w.status]} ${a.dateRange.currentWeek === w.index ? "ring-2 ring-violet-strong/40 ring-offset-1" : ""}`}
                style={{ height: w.socialPieces ? `${Math.max(w.socialPieces / max, 0.1) * 100}%` : "3px" }} />
            </div>
            <span className={`text-[10px] tabular-nums ${a.dateRange.currentWeek === w.index ? "font-semibold text-ink" : "text-ink-3"}`}>W{w.index}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-2">
        {c.plannedSlots} of {c.targetSlots} slots planned{c.gaps.length ? `; nothing in week ${c.gaps.join(", ")}` : ""}.
      </p>
    </div>
  );
}

function Pillars({ a }: { a: SeasonAnalysis }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">Pillar mix against the guide</h3>
      <ul className="mt-3 space-y-2">
        {a.pillars.rows.map((r) => (
          <li key={r.slug} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className={r.selected ? "text-ink" : "text-ink-3"}>{r.name}</span>
              <span className="tabular-nums text-ink-2">
                {r.count} · {r.share}% <span className="text-ink-3">of {r.target}%</span>
                {r.selected && r.status !== "on-target" && <span className={r.status === "over" ? " text-violet-strong" : " text-amber-strong"}> {r.delta > 0 ? "+" : ""}{r.delta}</span>}
              </span>
            </div>
            <div className="relative mt-1 h-1 rounded-full bg-surface-overlay">
              <div className="h-full rounded-full bg-[image:var(--gradient-prism)]" style={{ width: `${Math.min(r.share, 100)}%` }} />
              <div className="absolute -top-0.5 h-2 w-px bg-ink-2" style={{ left: `${Math.min(r.target, 100)}%` }} aria-hidden />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const sevTone: Record<Check["severity"], string> = { block: "bg-red-strong/10 text-red-strong", warn: "bg-amber-strong/10 text-amber-strong", info: "bg-surface-overlay text-ink-2" };

function FindingRow({ c, path }: { c: Check; path?: string }) {
  const href = findingHref(c, path);
  const badge = <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${sevTone[c.severity]}`}>{c.status === "review" ? "review" : c.severity}</span>;
  return (
    <li className="text-xs leading-snug">
      {href
        ? <a href={href} className="group flex gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{badge}<span className="text-ink-2 underline-offset-2 group-hover:text-ink group-hover:underline">{c.message}</span></a>
        : <span className="flex gap-2">{badge}<span className="text-ink-2">{c.message}</span></span>}
    </li>
  );
}

function Findings({ a, path }: { a: SeasonAnalysis; path?: string }) {
  const order = { block: 0, warn: 1, info: 2 };
  const checks = [...a.checks].sort((x, y) => order[x.severity] - order[y.severity]);
  const first = checks.filter((c) => c.severity !== "info").slice(0, 4);
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
        Findings: {a.summary.block} block, {a.summary.warn} warn, {a.summary.info} info
      </h3>
      <ul className="mt-3 space-y-1.5">{first.map((c, i) => <FindingRow key={i} c={c} path={path} />)}</ul>
      {checks.length > first.length && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-violet-strong">All {checks.length} findings</summary>
          <ul className="mt-2 max-h-72 space-y-1.5 overflow-auto pr-1">{checks.map((c, i) => <FindingRow key={i} c={c} path={path} />)}</ul>
        </details>
      )}
    </div>
  );
}

function SeasonForm({ season, pillarOptions, save, onDone }: { season: SeasonRecord; pillarOptions: { slug: string; name: string }[]; save: SeasonSave; onDone: () => void }) {
  const [title, setTitle] = useState(season.title);
  const [description, setDescription] = useState(season.description);
  const [startsOn, setStartsOn] = useState(season.starts_on);
  const [endsOn, setEndsOn] = useState(season.ends_on);
  const [pillars, setPillars] = useState<string[]>(season.pillars);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const submit = () => start(async () => {
    setError(null);
    const r = await save({ id: season.id, title, description, startsOn, endsOn, pillars });
    if (!r.ok) { setError(r.error); return; }
    onDone();
    router.refresh();
  });
  const label = "text-xs font-medium text-ink-2";
  return (
    <form className="mt-4 grid gap-3 border-t border-line pt-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Edit season">
      <label className="space-y-1 md:col-span-2"><span className={label}>Title</span><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
      <label className="space-y-1 md:col-span-2"><span className={label}>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          className="w-full rounded-md border border-input bg-[color:var(--surface-inset)] px-3 py-2 text-sm text-ink focus-visible:border-violet focus-visible:outline-none" />
      </label>
      <label className="space-y-1"><span className={label}>Starts</span><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required /></label>
      <label className="space-y-1"><span className={label}>Ends</span><Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required /></label>
      <fieldset className="md:col-span-2"><legend className={label}>Pillars in play</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {pillarOptions.map((p) => (
            <label key={p.slug} className="flex items-center gap-1.5 text-sm text-ink">
              <input type="checkbox" checked={pillars.includes(p.slug)} onChange={(e) => setPillars(e.target.checked ? [...pillars, p.slug] : pillars.filter((x) => x !== p.slug))} />
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-strong md:col-span-2">{error}</p>}
      <div className="flex gap-2 md:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving..." : "Save season"}</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onDone} disabled={pending}>Cancel</Button>
      </div>
    </form>
  );
}

/** The season under the overview numbers: what it is, its weekly cadence, pillar mix and the analysis findings, with an editor. */
export function SeasonPanel({ season, analysis, pillarOptions, save, path }: { season: SeasonRecord; analysis: SeasonAnalysis; pillarOptions: { slug: string; name: string }[]; save: SeasonSave; path?: string }) {
  const [editing, setEditing] = useState(false);
  const names = new Map(pillarOptions.map((p) => [p.slug, p.name]));
  const week = analysis.dateRange.currentWeek;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-ink">{season.title}</h2>
          <p className="mt-0.5 text-xs text-ink-2">
            {day(season.starts_on)} to {day(season.ends_on)} · {analysis.dateRange.weeks} weeks
            {week ? ` · now week ${week}` : analysis.dateRange.phase === "before" ? " · not started" : analysis.dateRange.phase === "after" ? " · finished" : ""}
            {" · "}{season.pillars.map((s) => names.get(s) ?? s).join(", ") || "no pillars selected"}
          </p>
        </div>
        {!editing && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit season</Button>}
      </div>
      {editing
        ? <SeasonForm season={season} pillarOptions={pillarOptions} save={save} onDone={() => setEditing(false)} />
        : (
          <div className="mt-4 grid gap-6 md:grid-cols-3">
            <Cadence a={analysis} />
            <Pillars a={analysis} />
            <Findings a={analysis} path={path} />
          </div>
        )}
    </div>
  );
}
