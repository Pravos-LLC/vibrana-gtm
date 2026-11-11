// The hourly email health step, run by the team cron after every mailbox sync (VIB-511). Bounce rate, collection
// problems and, once a day, the sending domains' DNS. Each finding is a durable incident that both owners see on
// /performance/team; a new incident is emailed once to EMAIL_ALERT_TO. Nothing here pauses a campaign.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TeamMember } from "../team/members";
import { loadOutcomes } from "./load";
import { bounceCheck } from "./metrics";
import { alertRecipients, checkDomain, healthDomains, notifyIncidents, reconcileIncidents, type DomainCheck, type Incident } from "./health";
import { loadMirrorState, mirrorProblems } from "../crm/mirror";
import { origamiApplyEnabled } from "../origami/client";
import { RUN_KEY as ORIGAMI_RUN_KEY, type RunState as OrigamiRunState } from "../origami/optouts";
import { failureKey, selfHealing, type FailureStreak } from "../team/mailbox";

const DNS_KEY = "email.health.dns";
const STALE_SYNC_MS = 3 * 3_600_000;
const HOUR = 3_600_000;

/**
 * The Origami step's incidents. Critical: a stage failed, or for three hours no run read the newest replies (runs that
 * only carry older scans to the next hour still count as progress). Warning: no full pass, including Origami's own
 * unsubscribes, for 24 hours, so those may be found late. A state written before `lastProgressAt` existed falls back to
 * `lastOkAt`.
 */
export function origamiStepProblems(run: OrigamiRunState | null, now: number): Incident[] {
  if (!run) return [{ key: "suppression:origami_step", kind: "suppression", severity: "critical", summary: "The Origami opt-out step has not run yet", detail: { lastOkAt: null } }];
  const age = (at: string | null | undefined) => (at ? now - Date.parse(at) : Infinity);
  const progressAt = run.lastProgressAt ?? run.lastOkAt;
  if (run.error || age(progressAt) > 3 * HOUR) return [{ key: "suppression:origami_step", kind: "suppression", severity: "critical",
    summary: `The Origami opt-out step ${run.error ? `failed: ${run.error}` : "has not read new Origami replies for over three hours"}`.slice(0, 300), detail: { lastOkAt: run.lastOkAt, lastProgressAt: progressAt ?? null } }];
  if (age(run.lastOkAt ?? run.firstAt) > 24 * HOUR) return [{ key: "suppression:origami_backlog", kind: "suppression", severity: "warning",
    summary: "The Origami opt-out step has not finished a full pass for over 24 hours; new replies are still read hourly, but Origami's own unsubscribes may be found late", detail: { lastOkAt: run.lastOkAt } }];
  return [];
}

/** A mailbox's `last_error` as an incident: one that clears itself is reported only from its second run in a row. */
export const collectionFailing = (lastError: string, streak: FailureStreak | null) => !selfHealing(lastError) || !streak || streak.count >= 2;

export type HealthRun = { incidents: number; notified: boolean; dns?: DomainCheck[] | string; error?: string };

export async function runEmailHealth(db: SupabaseClient, members: TeamMember[], opts: { now: Date; mail: { to: string; from: string }; checkDomain?: typeof checkDomain }): Promise<HealthRun> {
  const now = opts.now, observed: Incident[] = [], kinds = ["bounce_rate", "collection", "health_check", "suppression"], unchecked = new Set<string>();
  // Suppression work waiting longer than two hourly runs, or failing: visible to both owners (VIB-497 section 4).
  const ops = must(await db.from("gtm_email_sync_ops").select("state,reason,created_at,updated_at,destination").in("state", ["pending_review", "approved", "queued", "applied", "failed"]), "suppression state") as { state: string; reason: string; created_at: string; updated_at: string; destination: string }[];
  const old = ops.filter((o) => o.state !== "failed" && now.getTime() - Date.parse(o.created_at) > 2 * 3_600_000);
  const reviews = old.filter((o) => o.reason === "OPT_OUT_REVIEW").length, waiting = old.length - reviews, failing = ops.filter((o) => o.state === "failed").length;
  if (reviews) observed.push({ key: "suppression:review", kind: "suppression", severity: "warning", summary: `${reviews} possible opt-out${reviews === 1 ? "" : "s"} waiting for a person's review (email is held on the desk meanwhile)`, detail: { reviews } });
  if (waiting) observed.push({ key: "suppression:pending", kind: "suppression", severity: "warning", summary: `${waiting} suppression operation${waiting === 1 ? "" : "s"} waiting over two hours for approval or apply (gtm suppression plan)`, detail: { waiting } });
  if (failing) observed.push({ key: "suppression:failed", kind: "suppression", severity: "critical", summary: `${failing} suppression operation${failing === 1 ? "" : "s"} failed to apply`, detail: { failing } });
  // Origami opt-outs (VIB-521): one that no single Twenty person matched waits for a person (its sequences are stopped),
  // and evidence that keeps failing to process is not suppressed anywhere yet.
  if (origamiApplyEnabled()) {
    const ev = must(await db.from("gtm_origami_replies").select("match,processed_at,last_error,created_at").neq("classification", "none").is("reviewed_at", null).in("match", ["pending", "ambiguous", "unmatched"]), "origami opt-outs") as { match: string; processed_at: string | null; last_error: string | null; created_at: string }[];
    const unmatched = ev.filter((r) => r.processed_at && r.match !== "pending").length;
    // Stuck counts every match state: a matched row is processed only once its sequences were all found and stopped, and
    // the step's progress check no longer stands in for that (runs that read new replies count as progress).
    const unprocessed = await db.from("gtm_origami_replies").select("id", { count: "exact", head: true }).neq("classification", "none").is("reviewed_at", null).is("processed_at", null)
      .lt("created_at", new Date(now.getTime() - 2 * 3_600_000).toISOString());
    must(unprocessed, "origami unprocessed");
    const stuck = unprocessed.count ?? 0;
    if (unmatched) observed.push({ key: "suppression:origami_unmatched", kind: "suppression", severity: "warning", summary: `${unmatched} Origami opt-out${unmatched === 1 ? "" : "s"} matched no single Twenty person; their Origami sequences are stopped, the CRM is not (gtm suppression origami-reviewed --handled)`, detail: { unmatched } });
    if (stuck) observed.push({ key: "suppression:origami_stuck", kind: "suppression", severity: "critical", summary: `${stuck} Origami opt-out${stuck === 1 ? "" : "s"} not processed after two hours`, detail: { stuck } });
    // The step itself (lib/origami/optouts.ts runOrigamiOptouts): replies may not be read at all, which no evidence row can show.
    const run = (must(await db.from("gtm_sync_state").select("value").eq("key", ORIGAMI_RUN_KEY).maybeSingle(), "origami step") as { value: OrigamiRunState } | null)?.value ?? null;
    observed.push(...origamiStepProblems(run, now.getTime()));
  }
  for (const m of members) {
    const read = await db.from("gtm_team_mailboxes").select("address,last_sync_at,last_error,backfill_done").eq("member", m.code);
    if (read.error) {
      // Collection state could not be read: an incident, and the collection and bounce problems it would have judged stay
      // as they are (review of #32, B3). The other checks still run.
      unchecked.add("collection"); unchecked.add("bounce_rate");
      observed.push({ key: `health_check:mailboxes:${m.code.toLowerCase()}`, kind: "health_check", severity: "warning", summary: `${m.label}: mailbox state could not be read (${read.error.message.slice(0, 120)})` });
      continue;
    }
    const boxes = (read.data ?? []) as { address: string; last_sync_at: string | null; last_error: string | null; backfill_done: boolean }[];
    for (const b of boxes) {
      const k = `collection:${m.code.toLowerCase()}:${Buffer.from(b.address).toString("hex").slice(0, 24)}`;
      if (b.last_error) {
        // A streak that cannot be read counts as unknown: alert (collectionFailing with null).
        const streak = (await db.from("gtm_sync_state").select("value").eq("key", failureKey(m.code, b.address)).maybeSingle()).data?.value as FailureStreak | undefined;
        if (collectionFailing(b.last_error, streak ?? null)) observed.push({ key: k, kind: "collection", severity: "warning", summary: `${m.label}'s mailbox sync is failing: ${b.last_error}`.slice(0, 300) });
      }
      else if (!b.last_sync_at || now.getTime() - Date.parse(b.last_sync_at) > STALE_SYNC_MS) observed.push({ key: k, kind: "collection", severity: "warning", summary: `${m.label}'s mailbox has not synced for over 3 hours` });
    }
    if (!boxes.length) continue;
    let o: Awaited<ReturnType<typeof loadOutcomes>>;
    try { o = await loadOutcomes(db, m.code); } catch (e) {
      // The bounce check could not run: say so, and leave any open bounce incident open (review of #32, F5).
      unchecked.add("bounce_rate");
      observed.push({ key: `health_check:bounce:${m.code.toLowerCase()}`, kind: "health_check", severity: "warning", summary: `${m.label}: the bounce check could not read email outcomes (${(e as Error).message.slice(0, 120)})` });
      continue;
    }
    const b = bounceCheck(o.events, o.attempts, now.getTime(), m.code, o.collection.complete);
    if (b.alert) observed.push({ key: `bounce:${m.code.toLowerCase()}`, kind: "bounce_rate", severity: "critical",
      summary: `${m.label}: ${b.num} of ${b.n} cold recipients in the last 7 days failed (${Math.round((b.num / b.n) * 1000) / 10}%, threshold 2%)`, detail: { num: b.num, n: b.n } });
  }
  // The CRM people mirror (VIB-516): a breaker stop or a stale mirror means people are not measured; say so once.
  try {
    for (const p of mirrorProblems(await loadMirrorState(db), now.getTime())) observed.push({ key: p.key, kind: "health_check", severity: "warning", summary: p.summary });
  } catch (e) {
    observed.push({ key: "health_check:crm_mirror:state", kind: "health_check", severity: "warning", summary: `CRM mirror: its state could not be read (${(e as Error).message.slice(0, 120)})` });
  }
  // DNS once a day, its own state: a lookup that cannot run is reported, never read as healthy.
  let dns: DomainCheck[] | string | undefined;
  const { data: last } = await db.from("gtm_sync_state").select("value").eq("key", DNS_KEY).maybeSingle();
  const prev = (last?.value ?? null) as { at?: string; checks?: DomainCheck[] } | null;
  const domains = healthDomains();
  // The DNS check needs its targets. Not configured (or nothing valid) is an incident, unless explicitly turned off.
  const fingerprint = JSON.stringify(domains);
  kinds.push("dns");
  if (!domains.length) {
    unchecked.add("dns");
    if ((process.env.EMAIL_HEALTH_DOMAINS ?? "").trim().toLowerCase() !== "off") {
      observed.push({ key: "health_check:dns", kind: "health_check", severity: "warning", summary: "The sending-domain DNS check has no valid targets: set EMAIL_HEALTH_DOMAINS (domain or domain:dkimSelector)" });
    }
  } else {
    // A cached result is reused only for the same targets (review of #32, N1).
    if (!prev?.at || now.getTime() - Date.parse(prev.at) > 20 * 3_600_000 || (prev as { targets?: string }).targets !== fingerprint) {
      try {
        dns = await Promise.all(domains.map((d) => (opts.checkDomain ?? checkDomain)(d.domain, d.selector)));
        must(await db.from("gtm_sync_state").upsert({ key: DNS_KEY, value: { at: now.toISOString(), targets: fingerprint, checks: dns }, updated_at: now.toISOString() }, { onConflict: "key" }), "save DNS check");
      } catch (e) { dns = `DNS check failed: ${(e as Error).message.slice(0, 160)}`; }
    } else dns = prev.checks ?? [];
    if (typeof dns === "string") { unchecked.add("dns"); observed.push({ key: "health_check:dns", kind: "health_check", severity: "warning", summary: dns }); }
    else for (const c of dns) if (c.problems.length) observed.push({ key: `dns:${c.domain}`, kind: "dns", severity: "critical", summary: `${c.domain}: ${c.problems.join(", ")}` });
  }
  const fresh = await reconcileIncidents(db, observed, kinds, now, unchecked);
  let notified = false;
  if (fresh.length) notified = (await notifyIncidents(db, fresh, { to: alertRecipients(opts.mail.to), from: opts.mail.from }, now)).sent;
  return { incidents: observed.length, notified, dns };
}
