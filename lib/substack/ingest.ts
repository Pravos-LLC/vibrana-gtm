// Substack has no API, so its numbers arrive as the two dashboard exports John downloads: the subscriber list and the
// "growth sources" CSV. This turns them into the weekly numbers /performance shows (gtm_manual_metrics), so he drops the
// files and runs one command instead of typing into the sheet. Opens and post views are not in either export; those two
// stay manual.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { parseCsvObjects } from "../youtube/csv";
import { addDays, mondayOf } from "../week";

export type SubRow = { date: string; paid: boolean; owner: boolean };
export type GrowthRow = { date: string; visitors: number; newSubscribers: number; source: string };

const day = (s: string) => /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s.trim())?.slice(1, 4).join("-") ?? null;

export function parseSubscribers(csv: string): SubRow[] {
  const rows = parseCsvObjects(csv);
  if (rows.length && !("Start date" in rows[0] && "Type" in rows[0])) throw new Error("Not a Substack subscriber export (needs Type and Start date columns)");
  return rows.flatMap((r) => {
    const date = day(r["Start date"] ?? "");
    if (!date) return [];
    const type = (r["Type"] ?? "").toLowerCase();
    return [{ date, owner: type === "author", paid: ["founding member", "yearly subscriber", "monthly subscriber"].includes(type) }];
  });
}

export function parseGrowth(csv: string): GrowthRow[] {
  const rows = parseCsvObjects(csv);
  if (rows.length && !("Unique visitors" in rows[0] && "New subscribers" in rows[0])) throw new Error("Not a Substack growth export (needs Unique visitors and New subscribers columns)");
  return rows.flatMap((r) => {
    const date = day(r["Date"] ?? "");
    const visitors = Number(r["Unique visitors"]), newSubscribers = Number(r["New subscribers"]);
    return date && Number.isFinite(visitors) && Number.isFinite(newSubscribers) ? [{ date, visitors, newSubscribers, source: r["Source"] ?? "" }] : [];
  });
}

export type WeekStats = { week_start: string; subscribers?: number; new_subscribers?: number; visitors?: number };

/**
 * Weekly numbers for the last `weeks` finished weeks. `subscribers` counts the current subscribers who had joined by
 * that Sunday (the export lists current subscribers only, so earlier weeks omit people who have since left).
 * Visitors and new subscribers come from the growth export and are only written for weeks the file covers.
 */
export function weeklyStats(subs: SubRow[], growth: GrowthRow[], asOf: string, weeks = 12): WeekStats[] {
  const lastSunday = addDays(mondayOf(asOf), -1);
  const audience = subs.filter((s) => !s.owner);
  const growthFrom = growth.length ? growth.map((g) => g.date).sort()[0] : null;
  const out: WeekStats[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(lastSunday, -6 - 7 * i), end = addDays(start, 6);
    const w: WeekStats = { week_start: start };
    if (subs.length) w.subscribers = audience.filter((s) => s.date <= end).length;
    // A week counts only when it starts on or after the file's first row: an earlier week may be cut off by the export's
    // start date, and "0" there would really be "unknown". Weeks after the first row with no rows are true zeros.
    if (growthFrom && growthFrom <= start) {
      const g = growth.filter((x) => x.date >= start && x.date <= end);
      w.visitors = g.reduce((a, x) => a + x.visitors, 0);
      w.new_subscribers = g.reduce((a, x) => a + x.newSubscribers, 0);
    }
    out.push(w);
  }
  return out;
}

const NOTE = "from Substack export; earlier weeks count current subscribers only";

/** Upserts each week into the channel's manual row, never lowering a hand-typed opens or views number. */
export async function saveSubstackStats(db: SupabaseClient, channel: string, stats: WeekStats[], actor = "substack-export") {
  let written = 0;
  for (const s of stats) {
    const { week_start, ...metrics } = s;
    if (!Object.keys(metrics).length) continue;
    const prior = must(await db.from("gtm_manual_metrics").select("metrics,note").eq("week_start", week_start).eq("channel", channel).maybeSingle(), "manual read") as { metrics: Record<string, number>; note: string } | null;
    must(await db.from("gtm_manual_metrics").upsert({ week_start, channel, metrics: { ...(prior?.metrics ?? {}), ...metrics }, note: prior?.note || NOTE, entered_by: actor, updated_at: new Date().toISOString() }, { onConflict: "week_start,channel" }), "manual write");
    written++;
  }
  return written;
}
