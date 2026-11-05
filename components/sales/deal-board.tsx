// Opportunities in stage columns with what the pipeline needs to see on each card: owner, source, value (native and USD)
// and the next step, late ones flagged. LOST sits last and dimmed: it is history, not pipeline.
import { Badge } from "@/components/ui/badge";
import { CompanyMark } from "@/components/crm/people";
import { OFFER_LABELS, SOURCE_LABELS, type SalesDeal } from "@/lib/sales/deals";
import { toUsd } from "@/lib/sales/economics";
import { cn } from "@/lib/ui/cn";
import { native, usd } from "./nav";

export const BOARD_STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL", "SIGNED", "LOST"] as const;
const OWNER: Record<string, string> = { JOHN: "John", ABE: "Abe" };

export function SalesDealBoard({ deals, fx, now }: { deals: SalesDeal[]; fx: Record<string, number>; now: Date }) {
  const today = now.toISOString().slice(0, 10);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" data-testid="deal-board">
      {BOARD_STAGES.map((stage) => {
        const list = deals.filter((d) => d.stage === stage);
        const total = list.reduce((a, d) => a + (toUsd(d.fee, fx) ?? 0), 0);
        return (
          <section key={stage} aria-label={stage.toLowerCase()} className={cn("rounded-lg border border-line bg-[color:var(--surface-frost)] p-2", stage === "LOST" && "opacity-70")}>
            <h3 className="mb-2 flex items-baseline justify-between px-1 text-xs font-medium uppercase tracking-wide text-ink-2">
              {stage.toLowerCase()} <span className="tabular-nums normal-case text-ink-3">{list.length}{total ? ` · ${usd(total)}` : ""}</span>
            </h3>
            <div className="space-y-2">
              {list.map((d) => {
                const late = d.nextStepAt && d.nextStepAt.slice(0, 10) < today && stage !== "SIGNED" && stage !== "LOST";
                return (
                  <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="block rounded-md border border-line bg-[color:var(--surface-card)] p-2 text-sm hover:border-[color:var(--border-strong)]">
                    <div className="flex items-center gap-2">
                      <CompanyMark domain={d.domain} />
                      <span className="truncate font-medium text-ink">{d.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant={d.owner ? "outline" : "warning"}>{d.owner ? OWNER[d.owner] : "no owner"}</Badge>
                      {d.source && <Badge variant="outline">{SOURCE_LABELS[d.source]}</Badge>}
                      {d.offer && <Badge variant="outline">{OFFER_LABELS[d.offer] ?? d.offer.toLowerCase()}</Badge>}
                    </div>
                    <div className="mt-1 flex justify-between gap-2 text-xs text-ink-3">
                      <span className="truncate">{d.partner ? `via ${d.partner}` : d.contact ?? ""}</span>
                      {d.fee && <span className="tabular-nums text-ink-2" title={usd(toUsd(d.fee, fx)) ?? undefined}>{native(d.fee)}{d.upside ? ` (up to ${native(d.upside)})` : ""}</span>}
                    </div>
                    {d.nextStep && stage !== "SIGNED" && stage !== "LOST" && (
                      <div className={cn("mt-1 truncate text-xs", late ? "text-amber-strong" : "text-ink-2")}>Next: {d.nextStep}{d.nextStepAt ? ` · ${d.nextStepAt.slice(0, 10)}` : ""}</div>
                    )}
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
