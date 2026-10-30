// Entry points shared by the Vercel cron routes and the `gtm signals` CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { briefTopStories } from "./brief";
import { aiRunner } from "./cloudflare";
import { signalsConfig } from "./config";
import { digestStories, sendDigest } from "./digest";
import { collect, finishRun, processSignals } from "./pipeline";
import { webJobs } from "./sources";
import { birdRunner, xJobs } from "./x";

/**
 * Sources the Mac job collects and the Vercel run skips: Reddit answers 429 to cloud IPs, and Google News
 * (which replaced GDELT) is proven from the Mac only. Both rate-limit unauthenticated callers by IP, so
 * the Mac asks at most every MAC_WEB_EVERY_HOURS (stamp file), not on every hourly X run.
 */
export const MAC_WEB_SOURCES = ["google_news", "reddit"];
export const MAC_WEB_EVERY_HOURS = 4;

/** True when the Mac-only web sources are due; records the attempt in `stamp` when they are. */
export function macWebDue(stamp: string, now = Date.now(), everyHours = MAC_WEB_EVERY_HOURS): boolean {
  const last = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) : 0;
  if (Number.isFinite(last) && now - last < everyHours * 3600_000) return false;
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, String(now));
  return true;
}

/** Open-web collection, then classify, cluster and score. Runs every two hours on Vercel. */
export async function runWeb(db: SupabaseClient, opts: { fetcher?: typeof fetch; deadline?: number } = {}) {
  const cfg = signalsConfig();
  const jobs = webJobs(cfg, opts.fetcher).filter((j) => !MAC_WEB_SOURCES.includes(j.name));
  const collected = await collect(db, jobs, "collect", cfg.ranking.max_item_age_hours, new Date(), { finish: false });
  const stats = { fetched: collected.fetched, unique: collected.unique, inserted: collected.inserted };
  try {
    const processed = await processSignals(db, aiRunner(opts.fetcher), cfg, { deadline: opts.deadline });
    await finishRun(db, collected.run_id, { ...stats, processed }, collected.errors);
    return { collected, processed };
  } catch (e) {
    // Keep the collectors' per-source errors and say why processing stopped; the run stays unfinished.
    await db.from("gtm_signal_runs").update({ stats, errors: [...collected.errors, { source: "process", error: (e as Error).message.slice(0, 300) }] }).eq("id", collected.run_id);
    throw e;
  }
}

/**
 * X collection from the Mac (bird) hourly under launchd, plus Google News and Reddit every few hours. Collect only: the Vercel cron is the single
 * processor, so two processors never cluster the same items into duplicate stories. X items are ranked
 * within two hours.
 */
export async function runX(db: SupabaseClient) {
  const cfg = signalsConfig();
  const due = macWebDue(join(homedir(), ".vibrana", "signals", "mac-web.last"));
  const web = due ? webJobs(cfg).filter((j) => MAC_WEB_SOURCES.includes(j.name)) : [];
  const collected = await collect(db, [...xJobs(cfg, birdRunner()), ...web], "collect_x", cfg.ranking.max_item_age_hours);
  return { collected, processed: null };
}

/** Morning: brief the top stories, then email them. `dryRun` returns the digest without sending. */
export async function runDigest(db: SupabaseClient, opts: { dryRun?: boolean; to?: string; now?: Date; deadline?: number } = {}) {
  const cfg = signalsConfig();
  const now = opts.now ?? new Date();
  // The run row exists before briefing, so a digest killed mid-way shows as unfinished in `gtm signals runs`.
  const run = opts.dryRun ? null : (await db.from("gtm_signal_runs").insert({ kind: "digest" }).select("id").single()).data;
  const briefs = await briefTopStories(db, cfg, undefined, now, opts.deadline);
  const stories = await digestStories(db, cfg, now);
  // The cron fires at 00:00 UTC: 08:00 in Bali (WITA), where John is. SIGNALS_DIGEST_TZ changes the date label.
  const date = new Intl.DateTimeFormat("en-US", { timeZone: process.env.SIGNALS_DIGEST_TZ ?? "Asia/Makassar", weekday: "short", month: "short", day: "numeric" }).format(now);
  const cockpitUrl = process.env.GTM_COCKPIT_URL ?? "http://localhost:3000";
  if (opts.dryRun) return { briefs, stories, sent: null };
  const to = opts.to ?? process.env.SIGNALS_DIGEST_TO ?? "user-f538cb95fc21@example.com";
  try {
    const sent = await sendDigest(cfg, stories, { to, cockpitUrl, date });
    if (run) await finishRun(db, run.id, { stories: stories.length, briefed: briefs.briefed, email_id: sent.id }, briefs.errors);
    return { briefs, stories: stories.map((s) => ({ id: s.id, title: s.brief?.headline ?? s.title })), sent };
  } catch (e) {
    if (run) await finishRun(db, run.id, { stories: stories.length, briefed: briefs.briefed }, [...briefs.errors, { source: "email", error: (e as Error).message }]);
    throw e;
  }
}
