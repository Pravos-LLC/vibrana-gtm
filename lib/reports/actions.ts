// Accepting or dismissing a weekly report's proposed calendar change (VIB-418). Accepting edits
// gtm_content_items only: a date, a slot swap, a format, or a new `idea` row. It never approves,
// schedules or publishes, and it refuses to touch anything already handed to Zernio, so John's approval
// gate and the scheduler stay exactly as they are.
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateItemDb } from "../calendar-db";
import { weekOfDate } from "../calendar";
import { must } from "../db";
import type { ActionType } from "./guard";
import { localDate } from "./week";

export type ActionRow = {
  id: string; report_id: string; position: number; type: ActionType; item_id: string | null; other_item_id: string | null;
  change: { date?: string; format?: string; title?: string; pillar?: string; channels?: string[]; signal_id?: string | null };
  proposal: string; rationale: string; evidence: { fact: string; value: number }[];
  status: "proposed" | "accepted" | "dismissed"; applied: unknown; decided_by: string | null; decided_at: string | null;
};
type Slot = { id: string; date: string; time: string | null; format: string; status: string; zernio_post_id: string | null; title: string; pillar: string; channels: string[] };

/** Statuses a report may still move around: nothing scheduled, published, failed or skipped. */
const MOVABLE = new Set(["idea", "drafted", "approved"]);

function assertMovable(slot: Slot | undefined, id: string | null): asserts slot is Slot {
  if (!slot) throw new Error(`calendar item ${id} no longer exists`);
  if (!MOVABLE.has(slot.status) || slot.zernio_post_id) {
    throw new Error(`${slot.id} is ${slot.status}${slot.zernio_post_id ? " and already in Zernio" : ""}; change it in Zernio or the calendar instead`);
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "idea";

/** Applies one accepted action. Returns the before and after of every row it touched. */
export async function applyAction(db: SupabaseClient, a: ActionRow, today = localDate(new Date())) {
  const ids = [a.item_id, a.other_item_id].filter(Boolean) as string[];
  const rows = ids.length ? must(await db.from("gtm_content_items").select("id,date,time,format,status,zernio_post_id,title,pillar,channels").in("id", ids), "items") as Slot[] : [];
  const get = (id: string | null) => rows.find((r) => r.id === id);
  const date = a.change.date;
  if ((a.type === "move" || a.type === "new_story") && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today)) throw new Error(`the new date ${date} is not a future date`);
  switch (a.type) {
    case "move": {
      const s = get(a.item_id); assertMovable(s, a.item_id);
      await updateItemDb(db, s.id, { date: date! });
      return { before: [{ id: s.id, date: s.date }], after: [{ id: s.id, date }] };
    }
    case "swap":
    case "replace": {
      const s = get(a.item_id); assertMovable(s, a.item_id);
      const o = get(a.other_item_id); assertMovable(o, a.other_item_id);
      // One statement in the database (gtm_swap_slots): both items trade date and time, or neither moves.
      must(await db.rpc("gtm_swap_slots", { p_a: s.id, p_b: o.id }), "swap slots");
      return { before: [{ id: s.id, date: s.date, time: s.time }, { id: o.id, date: o.date, time: o.time }], after: [{ id: s.id, date: o.date, time: o.time }, { id: o.id, date: s.date, time: s.time }] };
    }
    case "change_format": {
      const s = get(a.item_id); assertMovable(s, a.item_id);
      // An approved item was approved as the format it is; changing that is a new draft, so it must not be approved.
      if (s.status === "approved") throw new Error(`${s.id} is approved as a ${s.format}; change the format in the calendar so it goes back for approval`);
      await updateItemDb(db, s.id, { format: a.change.format! });
      return { before: [{ id: s.id, format: s.format }], after: [{ id: s.id, format: a.change.format }] };
    }
    case "new_story": {
      const base = `idea-${slug(a.change.title ?? "idea")}`;
      const taken = new Set(((await db.from("gtm_content_items").select("id").like("id", `${base}%`)).data ?? []).map((r: { id: string }) => r.id));
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const row = {
        id, date: date!, week: weekOfDate(date!), time: null, pillar: a.change.pillar!, title: a.change.title!, format: a.change.format!,
        channels: a.change.channels ?? [], status: "idea", urls: {}, updated_at: new Date().toISOString(),
      };
      must(await db.from("gtm_content_items").insert(row), "insert idea slot");
      return { before: [], after: [{ id, date: row.date, status: "idea", title: row.title, pillar: row.pillar, format: row.format, channels: row.channels }] };
    }
  }
}

/**
 * Accept or dismiss a proposed action. The decision is claimed first (a conditional update from `proposed`), so
 * two accepts that overlap (a double click, two tabs, a retried request) apply the change once: the second finds
 * nothing to claim. If applying fails, the claim is released back to `proposed` and the error is surfaced.
 */
export async function decideAction(db: SupabaseClient, id: string, decision: "accept" | "dismiss", actor: string) {
  const claimed = must(await db.from("gtm_report_actions")
    .update({ status: decision === "accept" ? "accepted" : "dismissed", decided_by: actor, decided_at: new Date().toISOString() })
    .eq("id", id).eq("status", "proposed").select("*"), "claim action") as ActionRow[];
  if (!claimed.length) {
    const cur = must(await db.from("gtm_report_actions").select("status").eq("id", id).maybeSingle(), "action") as { status: string } | null;
    throw new Error(cur ? `Already ${cur.status}.` : "No such change.");
  }
  const a = claimed[0];
  if (decision === "dismiss") return { id: a.id, status: a.status, decided_by: a.decided_by, decided_at: a.decided_at, applied: null };
  let applied: unknown;
  try {
    applied = await applyAction(db, a);
  } catch (e) {
    const release = await db.from("gtm_report_actions").update({ status: "proposed", decided_by: null, decided_at: null }).eq("id", id).eq("status", "accepted");
    const note = release.error ? ` (and the change could not be reopened: ${release.error.message})` : "";
    throw new Error(`${(e as Error).message}${note}`);
  }
  must(await db.from("gtm_report_actions").update({ applied }).eq("id", id), "record applied change");
  return { id: a.id, status: a.status, decided_by: a.decided_by, decided_at: a.decided_at, applied };
}
