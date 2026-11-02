// gtm_analytics_reports: publish (the skill, through `gtm analytics publish`), read (the cockpit pages) and the
// link email the hourly cron sends once per report. A week with no report by Monday noon in Bali gets one
// "not written" alert instead, so a missed week is never silent again.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { addDays, mondayOf } from "../week";
import { localDate, REPORT_TZ } from "../reports/week";
import { reportSlug, validateReportDoc, type ReportDoc } from "./doc";
import { sendMissingAlert, sendReportLink } from "./email";

export type ReportRow = {
  id: string; kind: "weekly"; slug: string; period_start: string; period_end: string; title: string; headline: string;
  doc: ReportDoc; author: string | null; published_at: string; updated_at: string; email_id: string | null; emailed_at: string | null;
};
export type ReportListRow = Omit<ReportRow, "doc">;

const LIST = "id,kind,slug,period_start,period_end,title,headline,author,published_at,updated_at,email_id,emailed_at";

export async function listReports(db: SupabaseClient, limit = 52): Promise<ReportListRow[]> {
  return must(await db.from("gtm_analytics_reports").select(LIST).order("period_start", { ascending: false }).limit(limit), "analytics reports") as ReportListRow[];
}

export async function getReport(db: SupabaseClient, slug: string): Promise<ReportRow | null> {
  return must(await db.from("gtm_analytics_reports").select("*").eq("slug", slug).maybeSingle(), "analytics report") as ReportRow | null;
}

/**
 * Validate and upsert one report (one per kind and Monday). A republished week keeps its email record, so a
 * correction does not send John a second link unless `resend` asks for it.
 */
export async function publishReport(db: SupabaseClient, doc: unknown, opts: { resend?: boolean; dryRun?: boolean } = {}) {
  const problems = validateReportDoc(doc);
  if (problems.length) throw new Error(`report not published:\n- ${problems.join("\n- ")}`);
  const d = doc as ReportDoc;
  if (mondayOf(d.period.start) !== d.period.start) throw new Error(`report not published: period.start ${d.period.start} is not a Monday`);
  const row = {
    kind: d.kind, slug: reportSlug(d), period_start: d.period.start, period_end: d.period.end,
    title: d.title, headline: d.headline, doc: d, author: d.author ?? null, updated_at: new Date().toISOString(),
    ...(opts.resend ? { email_id: null, emailed_at: null } : {}),
  };
  if (opts.dryRun) return { dryRun: true as const, slug: row.slug };
  const saved = must(await db.from("gtm_analytics_reports").upsert(row, { onConflict: "kind,period_start" }).select("id,slug,emailed_at").single(), "publish report") as { id: string; slug: string; emailed_at: string | null };
  return { dryRun: false as const, ...saved };
}

export const reportPath = (slug: string) => `/performance/reports/${slug}`;

/** The cockpit's https origin for links in email, or null when it is not set (a link to localhost helps nobody). */
export function cockpitOrigin(env = process.env): string | null {
  const u = env.GTM_COCKPIT_URL?.trim().replace(/\/+$/, "");
  return u && /^https:\/\//.test(u) ? u : null;
}

/** The Monday of the last complete week (Monday to Sunday) before `now`, by John's date in Bali. */
export function lastWeekStart(now: Date, tz = REPORT_TZ()) {
  return addDays(mondayOf(localDate(now, tz)), -7);
}

/** Hour of `now` in the report timezone. */
function localHour(now: Date, tz = REPORT_TZ()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
}

export const MISSING_AFTER_HOUR = 12;
const missingKey = (monday: string) => `analytics_report.missing.${monday.replaceAll("-", "")}`;

export type DeliveryResult = { sent: { slug: string; email_id: string | null }[]; missing: { week: string; email_id: string | null } | null; errors: string[] };

/**
 * The hourly cron's work: email a link for every report published in the last 14 days that has not been
 * emailed, then, from Monday noon in Bali, alert once if last week has no report at all.
 */
export async function deliverReports(db: SupabaseClient, opts: { now?: Date; to: string; from: string; fetcher?: typeof fetch }): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const origin = cockpitOrigin();
  if (!origin) throw new Error("GTM_COCKPIT_URL must be the deployed https cockpit, or the email would link to nowhere");
  const out: DeliveryResult = { sent: [], missing: null, errors: [] };
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const unsent = must(await db.from("gtm_analytics_reports").select("id,slug,title,headline,period_start,period_end,doc").is("emailed_at", null).gte("published_at", since).order("period_start"), "unsent reports") as Pick<ReportRow, "id" | "slug" | "title" | "headline" | "period_start" | "period_end" | "doc">[];
  for (const r of unsent) {
    try {
      const { id } = await sendReportLink(r, { to: opts.to, from: opts.from, url: `${origin}${reportPath(r.slug)}`, fetcher: opts.fetcher });
      must(await db.from("gtm_analytics_reports").update({ email_id: id, emailed_at: new Date().toISOString() }).eq("id", r.id), "mark emailed");
      out.sent.push({ slug: r.slug, email_id: id });
    } catch (e) {
      out.errors.push(`${r.slug}: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  const monday = lastWeekStart(now);
  const today = localDate(now);
  const due = today > addDays(monday, 7) || localHour(now) >= MISSING_AFTER_HOUR;
  if (due) {
    const have = must(await db.from("gtm_analytics_reports").select("id").eq("kind", "weekly").eq("period_start", monday).maybeSingle(), "last week's report");
    const alerted = must(await db.from("gtm_sync_state").select("key").eq("key", missingKey(monday)).maybeSingle(), "missing alert record");
    if (!have && !alerted) {
      try {
        const { id } = await sendMissingAlert({ from: monday, to: addDays(monday, 6) }, { to: opts.to, from: opts.from, url: `${origin}/performance/reports`, fetcher: opts.fetcher });
        must(await db.from("gtm_sync_state").upsert({ key: missingKey(monday), value: { at: new Date().toISOString(), email_id: id }, updated_at: new Date().toISOString() }), "record missing alert");
        out.missing = { week: monday, email_id: id };
      } catch (e) {
        out.errors.push(`missing alert ${monday}: ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }
  return out;
}
