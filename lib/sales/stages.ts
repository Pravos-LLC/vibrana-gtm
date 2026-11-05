// Stage history for win rate and cycle time: the first time each opportunity was seen at each stage
// (gtm_deal_stage_history). A deal the history has never seen gets its current stage dated at its last change in Twenty
// (close date for a closed deal, else creation), not today, so the first run does not make every existing deal look as
// if it moved this week.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { selectAll } from "../team/mailbox";
import type { SalesDeal } from "./deals";

export type StageRow = { opportunity_id: string; stage: string; first_seen_at: string };

/**
 * When a deal the history has never seen reached its current stage, as best Twenty can say: a closed deal at its close
 * date, anything else at its creation. Never updatedAt: any edit (an owner filled in) moves it, which made every
 * existing deal look as if it qualified the day the fields were backfilled (found on production, 2026-11-05).
 */
export const firstSeenFor = (d: Pick<SalesDeal, "stage" | "closeDate" | "createdAt">) =>
  (d.stage === "SIGNED" || d.stage === "LOST") && d.closeDate ? d.closeDate : d.createdAt;

export function newStageRows(deals: Pick<SalesDeal, "id" | "stage" | "updatedAt" | "createdAt" | "closeDate">[], history: StageRow[], now: Date): StageRow[] {
  const known = new Map<string, Set<string>>();
  for (const h of history) known.set(h.opportunity_id, (known.get(h.opportunity_id) ?? new Set()).add(h.stage));
  const out: StageRow[] = [];
  for (const d of deals) {
    const stages = known.get(d.id);
    if (stages?.has(d.stage)) continue;
    out.push({ opportunity_id: d.id, stage: d.stage, first_seen_at: stages ? now.toISOString() : firstSeenFor(d) });
  }
  return out;
}

export async function loadStageHistory(db: SupabaseClient): Promise<StageRow[]> {
  return selectAll<StageRow>((from, to) => db.from("gtm_deal_stage_history").select("opportunity_id,stage,first_seen_at").order("opportunity_id").order("stage").range(from, to), "stage history");
}

export async function recordStages(db: SupabaseClient, deals: SalesDeal[], now: Date): Promise<number> {
  const rows = newStageRows(deals, await loadStageHistory(db), now);
  if (rows.length) must(await db.from("gtm_deal_stage_history").upsert(rows, { onConflict: "opportunity_id,stage", ignoreDuplicates: true }), "save stage history");
  return rows.length;
}
