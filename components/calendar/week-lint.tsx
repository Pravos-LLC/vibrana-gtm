// The week's weekly-rhythm check, under the calendar's week range: the counts the rhythm watches (talking heads,
// voiceover reels, Prism Light pieces) and every house-rule issue, plus the weekdays still empty (lib/rhythm.ts,
// the same check as `gtm calendar lint`).
import type { WeekReport } from "@/lib/rhythm";
import { cn } from "@/lib/ui/cn";

export function WeekLint({ report, gaps }: { report: WeekReport; gaps: Array<{ date: string; day: string; wants: string }> }) {
  const { counts, issues } = report;
  const errors = issues.filter((i) => i.severity === "error").length;
  const count = (n: number, one: string, many: string, ok: boolean) => (
    <span className={cn(ok ? "text-ink-2" : "text-amber-strong")}>{n} {n === 1 ? one : many}</span>
  );
  const summary = issues.length || gaps.length
    ? [issues.length ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"}${errors ? ` (${errors} ${errors === 1 ? "error" : "errors"})` : ""}` : "", gaps.length ? `${gaps.length} empty ${gaps.length === 1 ? "day" : "days"}` : ""].filter(Boolean).join(" · ")
    : "fits the rhythm";
  return (
    <details className="mb-3 rounded-md border border-line bg-[color:var(--surface-frost)] px-3 py-2 text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-ink-3 marker:text-ink-3">
        <span className="font-medium text-ink-2">Weekly rhythm</span>
        {count(counts.talkingHeads, "talking head", "talking heads", counts.talkingHeads >= 1 && counts.talkingHeads <= 3)}
        {count(counts.voiceoverReels, "voiceover reel", "voiceover reels", counts.voiceoverReels <= 1)}
        {count(counts.prism, "Prism Light piece", "Prism Light pieces", counts.prism <= 2)}
        <span className={cn(errors ? "text-red-strong" : issues.length ? "text-amber-strong" : "text-ink-3")}>{summary}</span>
      </summary>
      {(issues.length > 0 || gaps.length > 0) && (
        <ul className="mt-2 space-y-1">
          {issues.map((i, n) => (
            <li key={n} className="flex gap-2">
              <span className={cn("w-10 shrink-0 font-medium", i.severity === "error" ? "text-red-strong" : "text-amber-strong")}>{i.severity === "error" ? "Error" : "Warn"}</span>
              <span className="text-ink-2">{i.message}</span>
            </li>
          ))}
          {gaps.map((g) => (
            <li key={g.date} className="flex gap-2">
              <span className="w-10 shrink-0 font-medium text-ink-3">Gap</span>
              <span className="text-ink-2">{g.day} is empty: wants {g.wants}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
