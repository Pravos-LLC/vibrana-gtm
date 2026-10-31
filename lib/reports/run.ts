import { loadRuntimeConfig } from "../runtime-config.mjs";
// Entry points for the weekly content report and the baseline (VIB-418), shared by the Sunday cron
// (/api/cron/content-report) and `gtm report`. Modeled on the Signal Desk digest: the run row exists before
// the model is called (a killed run shows as `running`), a deadline keeps it inside Vercel's 300 s, and
// --dry-run reads and calls the model but writes nothing and sends nothing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { listAccounts } from "../zernio";
import { analyticsDashboard, isSkipped, linkedinAggregate, orSkip } from "../zernio-analytics";
import { addDays } from "../week";
import { checkReport, type GuardResult, type Report } from "./guard";
import { sendReport } from "./email";
import { buildPack, loadPackInputs, MEASURED_PLATFORMS, type Pack } from "./pack";
import { localDate, resolveReportWeek } from "./week";
import { openRouterReportWriter, reportModel, type ReportWriter } from "./writer";

export type WeeklyOpts = {
  week?: number; seasonId?: string; dryRun?: boolean; force?: boolean; now?: Date; deadline?: number;
  write?: ReportWriter; to?: string; live?: boolean; send?: boolean;
};
export type WeeklyResult = {
  week: { season_id: string; number: number; from: string; to: string };
  dryRun: boolean; skipped?: string; id?: string; model?: string;
  pack?: Pack; guard?: Omit<GuardResult, "report">; report?: Report; email_id?: string | null; actions?: number;
};

/** Actions as stored rows: the structured change goes into `change`, applied only when John accepts it. */
export function actionRows(reportId: string, r: Report) {
  return r.actions.map((a, position) => ({
    report_id: reportId, position, type: a.type, item_id: a.item_id, other_item_id: a.other_item_id,
    change: Object.fromEntries(Object.entries({ date: a.new_date, format: a.new_format, title: a.new_title, pillar: a.new_pillar, channels: a.new_channels?.length ? a.new_channels : undefined, signal_id: a.signal_id }).filter(([, v]) => v != null)),
    proposal: a.proposal, rationale: a.rationale, evidence: a.evidence,
  }));
}

export async function runWeeklyReport(db: SupabaseClient, opts: WeeklyOpts = {}): Promise<WeeklyResult> {
  const now = opts.now ?? new Date();
  const wk = await resolveReportWeek(db, { week: opts.week, seasonId: opts.seasonId, now });
  const week = { season_id: wk.season.id, number: wk.week, from: wk.from, to: wk.to };
  let runId: string | null = null;
  if (!opts.dryRun) {
    const existing = must(await db.from("gtm_content_reports").select("id,status").eq("kind", "weekly").eq("period_start", wk.from).maybeSingle(), "existing report") as { id: string; status: string } | null;
    if (existing?.status === "done" && !opts.force) return { week, dryRun: false, skipped: `week ${wk.week} already has a report (use --force to write it again)`, id: existing.id };
    // A rerun clears the previous report, so the page shows "being written" rather than last run's text as current.
    const row = { kind: "weekly", season_id: wk.season.id, week: wk.week, period_start: wk.from, period_end: wk.to, status: "running", started_at: now.toISOString(), finished_at: null, errors: [], report: null, headline: null, input: {}, guard: {}, email_id: null };
    if (existing) {
      must(await db.from("gtm_content_reports").update(row).eq("id", existing.id), "restart report");
      // A rerun replaces the undecided proposals; decided ones stay as history.
      must(await db.from("gtm_report_actions").delete().eq("report_id", existing.id).eq("status", "proposed"), "clear proposals");
      runId = existing.id;
    } else {
      runId = (must(await db.from("gtm_content_reports").insert(row).select("id").single(), "start report") as { id: string }).id;
    }
  }
  try {
    // Zernio reads stop 70 s before the deadline so the model call still has its budget.
    const pack = buildPack(await loadPackInputs(db, wk, { live: opts.live, deadline: (opts.deadline ?? Infinity) - 70_000 }), wk, now);
    const write = opts.write ?? openRouterReportWriter();
    const left = (opts.deadline ?? Infinity) - Date.now();
    if (left < 10_000) throw new Error("time budget used up before the model call");
    const { report: raw, model } = await write(pack, { timeoutMs: Math.min(240_000, left) });
    const { report, ...guard } = checkReport(raw, pack);
    if (opts.dryRun) return { week, dryRun: true, model, pack, guard, report };

    must(await db.from("gtm_content_reports").update({ model, headline: report.headline, input: pack, report, guard, errors: [] }).eq("id", runId!), "save report");
    const rows = actionRows(runId!, report);
    if (rows.length) must(await db.from("gtm_report_actions").insert(rows), "save actions");
    let email_id: string | null = null;
    const errors: { source: string; error: string }[] = [];
    if (opts.send !== false) {
      try {
        email_id = (await sendReport(pack, report, { to: opts.to ?? process.env.REPORT_EMAIL_TO ?? process.env.SIGNALS_DIGEST_TO ?? loadRuntimeConfig().mail.notify, cockpitUrl: process.env.GTM_COCKPIT_URL ?? "http://localhost:3000" })).id;
      } catch (e) {
        errors.push({ source: "email", error: (e as Error).message.slice(0, 300) });
      }
    }
    must(await db.from("gtm_content_reports").update({ status: "done", email_id, errors, finished_at: new Date().toISOString() }).eq("id", runId!), "finish report");
    return { week, dryRun: false, id: runId!, model, guard, report, email_id, actions: rows.length };
  } catch (e) {
    if (runId) await db.from("gtm_content_reports").update({ status: "failed", errors: [{ source: "run", error: (e as Error).message.slice(0, 500) }], finished_at: new Date().toISOString() }).eq("id", runId);
    throw e;
  }
}

// ---- baseline ------------------------------------------------------------------------------------------------

export type BaselineChannel = {
  platform: string; account_id: string; username: string | null; followers: number | null;
  window: { from: string; to: string };
  impressions: number | null; reach: number | null; views: number | null; engagements: number | null;
  comments: number | null; saves: number | null; shares: number | null;
  linkedin?: { impressions: number; reach: number; reactions: number; comments: number; shares: number; saves: number; sends: number } | null;
  note?: string;
};

/**
 * Absolute counts per channel today: followers, and the last 28 days of impressions, reach, views and
 * engagements from Zernio's dashboard (plus LinkedIn's own aggregate with saves and sends). STRATEGY.md asks
 * for this before any change ships, so later weeks have something to move against.
 */
export async function recordBaseline(db: SupabaseClient, opts: { dryRun?: boolean; now?: Date; days?: number } = {}) {
  const today = localDate(opts.now ?? new Date());
  const from = addDays(today, -((opts.days ?? 28) - 1));
  const { accounts } = await listAccounts();
  const channels: BaselineChannel[] = [];
  for (const a of accounts.filter((x) => MEASURED_PLATFORMS.includes(x.platform))) {
    const base: BaselineChannel = {
      platform: a.platform, account_id: a._id, username: a.username ?? a.displayName ?? null, followers: a.followersCount ?? null,
      window: { from, to: today }, impressions: null, reach: null, views: null, engagements: null, comments: null, saves: null, shares: null,
    };
    const d = await orSkip(() => analyticsDashboard({ platform: a.platform, fromDate: from, toDate: today }));
    if (isSkipped(d)) base.note = d.skipped;
    else Object.assign(base, {
      impressions: d.totals.impressions, reach: d.totals.reach, views: d.totals.views,
      engagements: d.totals.likes + d.totals.comments + d.totals.shares + d.totals.saves,
      comments: d.totals.comments, saves: d.totals.saves, shares: d.totals.shares,
      followers: d.followers.byAccount.find((x) => x.accountId === a._id)?.current ?? base.followers,
    });
    if (a.platform === "linkedin") {
      // LinkedIn's own numbers, including saves and sends; only posts sent through Zernio. toDate is exclusive.
      const li = await orSkip(() => linkedinAggregate(a._id, { aggregation: "TOTAL", fromDate: from, toDate: addDays(today, 1) }));
      if (!isSkipped(li)) {
        const n = (k: string) => (typeof li.analytics[k] === "number" ? (li.analytics[k] as number) : 0);
        base.linkedin = { impressions: n("impressions"), reach: n("reach"), reactions: n("reactions"), comments: n("comments"), shares: n("shares"), saves: n("saves"), sends: n("sends") };
      } else base.linkedin = null;
    }
    channels.push(base);
  }
  const report = { recorded_on: today, channels };
  if (opts.dryRun) return { dryRun: true, period_start: from, period_end: today, report };
  const row = { kind: "baseline", period_start: from, period_end: today, status: "done", model: null, headline: `Baseline ${today}`, report, input: {}, finished_at: new Date().toISOString() };
  const saved = must(await db.from("gtm_content_reports").upsert(row, { onConflict: "kind,period_start" }).select("id").single(), "save baseline") as { id: string };
  return { dryRun: false, id: saved.id, period_start: from, period_end: today, report };
}

export { reportModel };
