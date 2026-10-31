import { loadRuntimeConfig } from "../runtime-config.mjs";
// Weekly numbers no API exposes (VIB-419): Substack subscribers, opens and views, YouTube impressions and
// click-through rate. John types them into the /performance "Add week's stats" sheet; they land in
// gtm_manual_metrics, one row per (week, channel). Parsing is pure so the rules are tested.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { mondayOf } from "../week";

export type ManualField = { key: string; label: string; kind: "count" | "percent"; hint?: string };
export type ManualChannel = { slug: string; label: string; fields: ManualField[]; required: string[] };

const SAMPLE_MANUAL_CHANNELS: ManualChannel[] = [
  {
    slug: "youtube", label: "YouTube", required: ["impressions", "ctr"],
    fields: [
      { key: "impressions", label: "Impressions", kind: "count", hint: "YouTube Studio, Analytics, Reach, this week" },
      { key: "ctr", label: "Impressions click-through rate (%)", kind: "percent", hint: "For example 4.2" },
    ],
  },
  {
    slug: "substack_sample_author", label: "Substack: sample_author", required: ["subscribers"],
    fields: [
      { key: "subscribers", label: "Subscribers at week end", kind: "count" },
      { key: "opens", label: "Email opens this week", kind: "count" },
      { key: "views", label: "Post views this week", kind: "count" },
    ],
  },
  {
    slug: "substack_regenera", label: "Substack: Regenera", required: ["subscribers"],
    fields: [
      { key: "subscribers", label: "Subscribers at week end", kind: "count" },
      { key: "opens", label: "Email opens this week", kind: "count" },
      { key: "views", label: "Post views this week", kind: "count" },
    ],
  },
];

export function manualChannels(): ManualChannel[] {
  const { brand } = loadRuntimeConfig();
  return SAMPLE_MANUAL_CHANNELS.map(channel => channel.slug === "substack_sample_author"
    ? { ...channel, slug: brand.personalFrontDoorId, label: `Substack: ${brand.authorLabel}` } : channel);
}
export const MANUAL_CHANNELS = manualChannels();

export type ManualEntry = { week_start: string; channel: string; metrics: Record<string, number>; note: string };

/**
 * Validates one form submission. Empty fields are left out (unknown, not 0); a filled field must be a
 * non-negative number (a percent at most 100); the week is normalized to its Monday.
 */
export function parseManualEntry(input: { week: string; channel: string; values: Record<string, string>; note?: string }): { ok: true; entry: ManualEntry } | { ok: false; error: string } {
  // A server action receives whatever the client sends: coerce before using string methods.
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  input = { week: str(input?.week), channel: str(input?.channel), note: str(input?.note), values: input?.values && typeof input.values === "object" ? input.values : {} };
  const ch = manualChannels().find((c) => c.slug === input.channel);
  if (!ch) return { ok: false, error: "Pick a channel." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.week ?? "") || Number.isNaN(Date.parse(`${input.week}T12:00:00Z`))) return { ok: false, error: "Pick a week." };
  const metrics: Record<string, number> = {};
  for (const f of ch.fields) {
    const raw = str(input.values[f.key]).trim().replace(/,/g, "").replace(/%$/, "");
    if (!raw) continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${f.label}: enter a number of 0 or more.` };
    if (f.kind === "count" && !Number.isInteger(v)) return { ok: false, error: `${f.label}: enter a whole number.` };
    if (f.kind === "percent" && v > 100) return { ok: false, error: `${f.label}: a percent is at most 100.` };
    metrics[f.key] = f.kind === "percent" ? Math.round(v * 100) / 100 : v;
  }
  if (!Object.keys(metrics).length) return { ok: false, error: "Enter at least one number." };
  return { ok: true, entry: { week_start: mondayOf(input.week), channel: ch.slug, metrics, note: (input.note ?? "").trim().slice(0, 500) } };
}

/** True when every required field for the channel is present in the stored row. */
export function manualComplete(channel: string, metrics: Record<string, unknown> | null | undefined): boolean {
  const ch = manualChannels().find((c) => c.slug === channel);
  return !!ch && !!metrics && ch.required.every((k) => typeof metrics[k] === "number");
}

/** Upserts the week's row; numbers already stored for other fields are kept (a later entry adds to the row). Service role only. */
export async function saveManualEntry(db: SupabaseClient, e: ManualEntry, actor: string) {
  const prior = must(await db.from("gtm_manual_metrics").select("metrics,note").eq("week_start", e.week_start).eq("channel", e.channel).maybeSingle(), "manual metrics") as { metrics: Record<string, number>; note: string } | null;
  const row = { week_start: e.week_start, channel: e.channel, metrics: { ...(prior?.metrics ?? {}), ...e.metrics }, note: e.note || prior?.note || "", entered_by: actor, updated_at: new Date().toISOString() };
  return must(await db.from("gtm_manual_metrics").upsert(row, { onConflict: "week_start,channel" }).select("week_start,channel,metrics").single(), "save manual metrics");
}
