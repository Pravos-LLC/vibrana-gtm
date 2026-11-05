// Stage history for win rate and cycle time: the first time each opportunity was seen at each stage
// (gtm_deal_stage_history). A deal the history has never seen gets its current stage dated at its last change in Twenty
// (updatedAt), not today, so the first run does not make every existing deal look as if it moved this week.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { selectAll } from "../team/mailbox";
import type { SalesDeal } from "./deals";

export type StageRow = { opportunity_id: string; stage: string; first_seen_at: string };

export function newStageRows(deals: Pick<SalesDeal, "id" | "stage" | "updatedAt" | "createdAt">[], history: StageRow[], now: Date): StageRow[] {
  const known = new Map<string, Set<string>>();
  for (const h of history) known.set(h.opportunity_id, (known.get(h.opportunity_id) ?? new Set()).add(h.stage));
  const out: StageRow[] = [];
  for (const d of deals) {
    const stages = known.get(d.id);
    if (stages?.has(d.stage)) continue;
    out.push({ opportunity_id: d.id, stage: d.stage, first_seen_at: stages ? now.toISOString() : d.updatedAt ?? d.createdAt });
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
