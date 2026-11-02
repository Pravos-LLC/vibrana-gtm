// Renders an analytics report document (lib/analytics-reports/doc.ts) block by block. Server components except
// the line chart. Every block is plain data from the document, rendered as text: nothing is injected as HTML.
import { AlertTriangle, ArrowUpRight, CircleCheck, CircleX, Info, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/stat-tile";
import { SocialMark } from "@/components/guide/social-mark";
import { cn } from "@/lib/ui/cn";
import type { Block, Cell, Confidence, Kpi, Link, Tone } from "@/lib/analytics-reports/doc";
import { LineBlock } from "./line-block";

const TONE_TEXT: Record<Tone, string> = { good: "text-emerald-strong", bad: "text-red-strong", warn: "text-amber-strong", info: "text-blue-strong", neutral: "text-ink-2" };
const TONE_BAR: Record<Tone, string> = { good: "bg-[color:var(--emerald)]", bad: "bg-[color:var(--red,var(--destructive))]", warn: "bg-[color:var(--amber)]", info: "bg-[color:var(--blue)]", neutral: "bg-[color:var(--viz-1)]" };
const TONE_ICON = { good: CircleCheck, bad: CircleX, warn: AlertTriangle, info: Info, neutral: Info } as const;
const CONF: Record<Confidence, { label: string; variant: "success" | "warning" | "outline" }> = {
  high: { label: "High confidence", variant: "success" },
  medium: { label: "Medium confidence", variant: "warning" },
  low: { label: "Low confidence", variant: "outline" },
};
const KIND: Record<string, string> = { new: "New", drop: "Drop", keep: "Keep", order: "Order", frequency: "Frequency", format: "Format", fix: "Fix" };
const STATUS: Record<string, { label: string; variant: "default" | "success" | "warning" | "outline" | "info" }> = {
  planned: { label: "Planned", variant: "success" }, open: { label: "Open slot", variant: "warning" },
  suggested: { label: "Suggested", variant: "info" }, skip: { label: "Skip", variant: "outline" },
};

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const num = (v: number) => v.toLocaleString("en-US");

export function anchorId(title: string, i: number) {
  return `b${i}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
}

function ExtLink({ l, className }: { l: Link; className?: string }) {
  return (
    <a href={l.url} target="_blank" rel="noreferrer noopener" className={cn("inline-flex items-baseline gap-0.5 text-violet-strong underline-offset-4 hover:underline", className)}>
      {l.label}<ArrowUpRight aria-hidden className="size-3 shrink-0 translate-y-0.5" />
    </a>
  );
}

function Kpis({ items }: { items: Kpi[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((k) => {
        const value = k.value == null ? null : typeof k.value === "number" ? `${num(k.value)}${k.unit ? ` ${k.unit}` : ""}` : k.value;
        return (
          <StatTile key={k.label} label={k.label} value={value} missing={k.note} note={k.value == null ? undefined : k.note}
            tone={k.tone === "bad" ? "bad" : k.tone === "warn" ? "warn" : undefined} spark={k.spark}
            delta={k.delta ? { value: k.delta.value, label: k.delta.label, goodWhen: k.delta.good, format: (n) => `${n > 0 ? "+" : ""}${num(n)}${k.delta?.unit ?? ""}` } : null} />
        );
      })}
    </div>
  );
}

function Bars({ items, unit }: { items: { label: string; value: number; group?: string; tone?: Tone }[]; unit?: string }) {
  const max = Math.max(...items.map((x) => Math.abs(x.value)), 1);
  const groups = [...new Set(items.map((x) => x.group ?? ""))];
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g || "all"}>
          {g && <p className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-ink-3">{g}</p>}
          <ul className="space-y-2">
            {items.filter((x) => (x.group ?? "") === g).map((x) => (
              <li key={`${g}-${x.label}`} className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate text-ink-2" title={x.label}>{x.label}</span>
                <span className="h-2.5 rounded-full bg-[color:var(--viz-grid)]" aria-hidden>
                  <span className={cn("block h-full rounded-full", TONE_BAR[x.tone ?? "neutral"])} style={{ width: `${Math.max(2, (Math.abs(x.value) / max) * 100)}%` }} />
                </span>
                <span className="tabular-nums text-ink">{num(x.value)}{unit ? <span className="text-ink-3"> {unit}</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CellView({ c }: { c: Cell }) {
  if (c == null) return <span className="text-ink-3">—</span>;
  if (typeof c === "number") return <span className="tabular-nums">{num(c)}</span>;
  if (typeof c === "string") return <>{c}</>;
  const body = <span className={c.tone ? TONE_TEXT[c.tone] : undefined}>{c.text}</span>;
  return c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline-offset-4 hover:underline">{body}</a> : body;
}

function TableBlock({ columns, rows }: { columns: { label: string; align?: "l" | "r" }[]; rows: Cell[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-surface-raised text-xs text-ink-3">
          <tr>{columns.map((c) => <th key={c.label} scope="col" className={cn("px-3 py-2 font-medium", c.align === "r" ? "text-right" : "text-left")}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => <td key={j} className={cn("px-3 py-2 align-top text-ink-2", columns[j]?.align === "r" && "text-right", j === 0 && "text-ink")}><CellView c={c} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Paragraphs({ text, className }: { text: string; className?: string }) {
  return <>{text.split(/\n{2,}/).map((p, i) => <p key={i} className={className}>{p}</p>)}</>;
}

export function ReportBlock({ block, index }: { block: Block; index: number }) {
  const b = block;
  return (
    <section id={anchorId(b.title, index)} className="scroll-mt-24 border-t border-line py-8">
      <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">{b.title}</h2>
        {"note" in b && b.note && <p className="max-w-[52ch] text-xs text-ink-3 sm:text-right">{b.note}</p>}
      </div>
      {b.type === "kpis" && <Kpis items={b.items} />}
      {b.type === "bars" && <Bars items={b.items} unit={b.unit} />}
      {b.type === "line" && <LineBlock title={b.title} unit={b.unit} x={b.x} series={b.series} />}
      {b.type === "table" && <TableBlock columns={b.columns} rows={b.rows} />}
      {b.type === "text" && <div className="max-w-[68ch] space-y-3 text-pl-base leading-relaxed text-ink-2"><Paragraphs text={b.body} /></div>}
      {b.type === "callout" && (() => {
        const Icon = TONE_ICON[b.tone];
        return (
          <Card glow={false} className="flex gap-3 p-5">
            <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", TONE_TEXT[b.tone])} />
            <div className="max-w-[68ch] space-y-2 text-sm leading-relaxed text-ink-2">
              <Paragraphs text={b.body} />
              {b.items?.length ? <ul className="list-disc space-y-1 pl-5">{b.items.map((x) => <li key={x}>{x}</li>)}</ul> : null}
            </div>
          </Card>
        );
      })()}
      {b.type === "findings" && (
        <div className="grid gap-4 md:grid-cols-2">
          {b.items.map((x) => {
            const Icon = TONE_ICON[b.tone];
            return (
              <Card key={x.title} glow={false} className="p-5">
                <div className="flex items-start gap-2.5">
                  {x.channel ? <SocialMark channel={x.channel} className="mt-0.5 size-4 shrink-0" /> : <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[b.tone])} />}
                  <h3 className="font-medium leading-snug text-ink">{x.url ? <a href={x.url} target="_blank" rel="noreferrer noopener" className="underline-offset-4 hover:underline">{x.title}</a> : x.title}</h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{x.body}</p>
                {x.metrics?.length ? <p className="mt-3 flex flex-wrap gap-1.5">{x.metrics.map((m) => <span key={m} className="rounded-md bg-surface-raised px-2 py-0.5 font-mono text-[0.7rem] text-ink-2">{m}</span>)}</p> : null}
              </Card>
            );
          })}
        </div>
      )}
      {b.type === "recommendations" && (
        <ol className="space-y-4">
          {b.items.map((x, i) => (
            <li key={x.title}>
              <Card glow={false} className="grid gap-3 p-5 sm:grid-cols-[2rem_1fr]">
                <span className="font-display text-pl-lg font-semibold tabular-nums text-ink-3" aria-hidden>{i + 1}</span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium leading-snug text-ink">{x.title}</h3>
                    <Badge variant={CONF[x.confidence].variant}>{CONF[x.confidence].label}</Badge>
                    {x.kind && <Badge variant="outline">{KIND[x.kind]}</Badge>}
                  </div>
                  <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-ink-2">{x.body}</p>
                  {x.why_confidence && <p className="mt-2 flex gap-1.5 text-xs text-ink-3"><Lightbulb aria-hidden className="size-3.5 shrink-0 translate-y-px" />{x.why_confidence}</p>}
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}
      {b.type === "plan" && (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {b.items.map((x) => (
            <li key={`${x.date}-${x.title}`} className="relative">
              <span aria-hidden className={cn("absolute -left-[1.6rem] top-2 size-2.5 rounded-full border-2 border-[color:var(--surface-base)]", x.status === "planned" ? "bg-[color:var(--emerald)]" : x.status === "open" ? "bg-[color:var(--amber)]" : x.status === "suggested" ? "bg-[color:var(--blue)]" : "bg-[color:var(--text-tertiary)]")} />
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-[0.08em] text-ink-3">{day(x.date)}</span>
                <span className="font-medium text-ink">{x.title}</span>
                <Badge variant={STATUS[x.status].variant}>{STATUS[x.status].label}</Badge>
                {x.format && <span className="text-xs text-ink-3">{x.format}</span>}
                {x.channels?.length ? <span className="inline-flex gap-1">{x.channels.map((c) => <SocialMark key={c} channel={c} className="size-3.5" />)}</span> : null}
              </div>
              {x.body && <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-ink-2 sm:pl-[6.75rem]">{x.body}</p>}
              {x.sources?.length ? <p className="mt-1 flex flex-wrap gap-x-3 text-xs sm:pl-[6.75rem]">{x.sources.map((s) => <ExtLink key={s.url} l={s} />)}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SourceList({ sources }: { sources: Link[] }) {
  return (
    <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {sources.map((s) => <li key={s.url} className="min-w-0 truncate"><ExtLink l={s} /></li>)}
    </ul>
  );
}
