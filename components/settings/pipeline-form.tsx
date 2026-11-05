"use client";
// The pipeline's goal and assumptions, edited on screen (app/settings#pipeline): the take-home goal, what sits between
// cash and take-home (overhead, tax reserve), FX planning rates, the planning rates and stage weights the reverse funnel
// uses until enough deals are measured, and the pages that count as buying intent per site.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SalesSettings } from "@/lib/sales/settings";

type Result = { ok: true } | { ok: false; error: string };
const STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL"] as const;
const RATES: { key: keyof SalesSettings["rates"]; label: string }[] = [
  { key: "winFromQualified", label: "Won from qualified" }, { key: "qualifiedFromMeeting", label: "Qualified from discovery meeting" },
  { key: "meetingFromPositive", label: "Meeting from positive conversation" }, { key: "positiveFromTouch", label: "Positive reply from first touch" },
];

function Num({ label, value, onChange, suffix, step = "any" }: { label: string; value: number; onChange: (n: number) => void; suffix?: string; step?: string }) {
  return (
    <label className="grid gap-1 text-xs text-ink-3">{label}
      <span className="flex items-center gap-1"><Input type="number" step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number(e.target.value))} className="h-9" />{suffix && <span className="text-ink-3">{suffix}</span>}</span>
    </label>
  );
}

export function PipelineForm({ initial, source, save }: { initial: SalesSettings; source: "saved" | "default"; save: (v: SalesSettings) => Promise<Result> }) {
  const [v, setV] = useState<SalesSettings>(initial);
  const [paths, setPaths] = useState(Object.fromEntries(Object.entries(initial.highIntentPaths).map(([k, p]) => [k, p.join(", ")])));
  const [busy, start] = useTransition();
  const [newCode, setNewCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const submit = () => start(async () => {
    setMsg(null);
    const highIntentPaths = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, p.split(",").map((x) => x.trim()).filter(Boolean)]));
    const r = await save({ ...v, highIntentPaths });
    setMsg(r.ok ? "Saved. The pipeline uses these from now on." : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <p className="text-sm text-ink-2">{source === "saved" ? "These are the assumptions you saved." : "These are the defaults. Saving makes them yours to change."}</p>
      <fieldset className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <legend className="mb-2 text-sm font-medium text-ink">Goal and costs</legend>
        <Num label="Take-home goal a month" value={v.goalUsd} onChange={(n) => setV({ ...v, goalUsd: n })} suffix="USD" />
        <Num label="Overhead a month" value={v.overheadUsd} onChange={(n) => setV({ ...v, overheadUsd: n })} suffix="USD" />
        <Num label="Tax reserve" value={pct(v.taxReserve)} onChange={(n) => setV({ ...v, taxReserve: n / 100 })} suffix="%" />
        <Num label="Planned deal size" value={v.plannedDealUsd} onChange={(n) => setV({ ...v, plannedDealUsd: n })} suffix="USD" />
        <Num label="Coverage" value={v.coverageMonths} onChange={(n) => setV({ ...v, coverageMonths: n })} suffix="months" step="1" />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <legend className="mb-2 text-sm font-medium text-ink">FX planning rates (USD per unit)</legend>
        {Object.keys(v.fx).filter((c) => c !== "USD").map((c) => (
          <Num key={c} label={c} value={v.fx[c]} onChange={(n) => setV({ ...v, fx: { ...v.fx, [c]: n } })} />
        ))}
        <label className="grid gap-1 text-xs text-ink-3">Add a currency
          <span className="flex items-center gap-1">
            <Input value={newCode} maxLength={3} placeholder="CHF" onChange={(e) => setNewCode(e.target.value.toUpperCase())} className="h-9 w-20" />
            <Button type="button" variant="ghost" size="sm" disabled={!/^[A-Z]{3}$/.test(newCode) || newCode in v.fx}
              onClick={() => { setV({ ...v, fx: { ...v.fx, [newCode]: 1 } }); setNewCode(""); }}>Add</Button>
          </span>
        </label>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-medium text-ink">Planning rates (until 10 measured)</legend>
        {RATES.map((r) => <Num key={r.key} label={r.label} value={pct(v.rates[r.key])} onChange={(n) => setV({ ...v, rates: { ...v.rates, [r.key]: n / 100 } })} suffix="%" />)}
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-medium text-ink">Stage weights for weighted pipeline</legend>
        {STAGES.map((st) => <Num key={st} label={st.toLowerCase()} value={pct(v.stageWeights[st])} onChange={(n) => setV({ ...v, stageWeights: { ...v.stageWeights, [st]: n / 100 } })} suffix="%" />)}
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-medium text-ink">High-intent pages, comma separated</legend>
        {Object.keys(paths).map((site) => (
          <label key={site} className="grid gap-1 text-xs text-ink-3">{site}<Input value={paths[site]} onChange={(e) => setPaths({ ...paths, [site]: e.target.value })} /></label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>Save assumptions</Button>
        {msg && <p role="status" className="text-sm text-ink-2">{msg}</p>}
      </div>
    </form>
  );
}
