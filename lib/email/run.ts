// The hourly email health step, run by the team cron after every mailbox sync (VIB-511). Bounce rate, collection
// problems and, once a day, the sending domains' DNS. Each finding is a durable incident that both owners see on
// /performance/team; a new incident is emailed once to EMAIL_ALERT_TO. Nothing here pauses a campaign.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TeamMember } from "../team/members";
import { loadOutcomes } from "./load";
import { bounceCheck } from "./metrics";
import { alertRecipients, checkDomain, healthDomains, notifyIncidents, reconcileIncidents, type DomainCheck, type Incident } from "./health";

const DNS_KEY = "email.health.dns";
const STALE_SYNC_MS = 3 * 3_600_000;

export type HealthRun = { incidents: number; notified: boolean; dns?: DomainCheck[] | string; error?: string };

export async function runEmailHealth(db: SupabaseClient, members: TeamMember[], opts: { now: Date; mail: { to: string; from: string }; checkDomain?: typeof checkDomain }): Promise<HealthRun> {
  const now = opts.now, observed: Incident[] = [], kinds = ["bounce_rate", "collection", "suppression"];
  // Suppression work waiting longer than two hourly runs, or failing: visible to both owners (VIB-497 section 4).
  const ops = must(await db.from("gtm_email_sync_ops").select("state,reason,created_at,updated_at,destination").in("state", ["pending_review", "approved", "failed"]), "suppression state") as { state: string; reason: string; created_at: string; updated_at: string; destination: string }[];
  const old = ops.filter((o) => o.state !== "failed" && now.getTime() - Date.parse(o.created_at) > 2 * 3_600_000);
  const reviews = old.filter((o) => o.reason === "OPT_OUT_REVIEW").length, waiting = old.length - reviews, failing = ops.filter((o) => o.state === "failed").length;
  if (reviews) observed.push({ key: "suppression:review", kind: "suppression", severity: "warning", summary: `${reviews} possible opt-out${reviews === 1 ? "" : "s"} waiting for a person's review (email is held on the desk meanwhile)`, detail: { reviews } });
  if (waiting) observed.push({ key: "suppression:pending", kind: "suppression", severity: "warning", summary: `${waiting} suppression operation${waiting === 1 ? "" : "s"} waiting over two hours for approval or apply (gtm suppression plan)`, detail: { waiting } });
  if (failing) observed.push({ key: "suppression:failed", kind: "suppression", severity: "critical", summary: `${failing} suppression operation${failing === 1 ? "" : "s"} failed to apply`, detail: { failing } });
  for (const m of members) {
    const boxes = must(await db.from("gtm_team_mailboxes").select("address,last_sync_at,last_error,backfill_done").eq("member", m.code), "mailboxes") as { address: string; last_sync_at: string | null; last_error: string | null; backfill_done: boolean }[];
    for (const b of boxes) {
      const k = `collection:${m.code.toLowerCase()}:${Buffer.from(b.address).toString("hex").slice(0, 24)}`;
      if (b.last_error) observed.push({ key: k, kind: "collection", severity: "warning", summary: `${m.label}'s mailbox sync is failing: ${b.last_error}`.slice(0, 300) });
      else if (!b.last_sync_at || now.getTime() - Date.parse(b.last_sync_at) > STALE_SYNC_MS) observed.push({ key: k, kind: "collection", severity: "warning", summary: `${m.label}'s mailbox has not synced for over 3 hours` });
    }
    if (!boxes.length) continue;
    const o = await loadOutcomes(db, m.code);
    const b = bounceCheck(o.events, o.attempts, now.getTime());
    if (b.alert) observed.push({ key: `bounce:${m.code.toLowerCase()}`, kind: "bounce_rate", severity: "critical",
      summary: `${m.label}: ${b.num} of ${b.n} cold recipients in the last 7 days failed (${Math.round((b.num / b.n) * 1000) / 10}%, threshold 2%)`, detail: { num: b.num, n: b.n } });
  }
  // DNS once a day, its own state: a lookup that cannot run is reported, never read as healthy.
  let dns: DomainCheck[] | string | undefined;
  const { data: last } = await db.from("gtm_sync_state").select("value").eq("key", DNS_KEY).maybeSingle();
  const prev = (last?.value ?? null) as { at?: string; checks?: DomainCheck[] } | null;
  const domains = healthDomains();
  if (domains.length) {
    kinds.push("dns");
    if (!prev?.at || now.getTime() - Date.parse(prev.at) > 20 * 3_600_000) {
      try {
        dns = await Promise.all(domains.map((d) => (opts.checkDomain ?? checkDomain)(d.domain, d.selector)));
        must(await db.from("gtm_sync_state").upsert({ key: DNS_KEY, value: { at: now.toISOString(), checks: dns }, updated_at: now.toISOString() }, { onConflict: "key" }), "save DNS check");
      } catch (e) { dns = `DNS check failed: ${(e as Error).message.slice(0, 160)}`; }
    } else dns = prev.checks ?? [];
    if (typeof dns === "string") observed.push({ key: "dns:check", kind: "dns", severity: "warning", summary: dns });
    else for (const c of dns) if (c.problems.length) observed.push({ key: `dns:${c.domain}`, kind: "dns", severity: "critical", summary: `${c.domain}: ${c.problems.join(", ")}` });
  }
  const fresh = await reconcileIncidents(db, observed, kinds, now);
  let notified = false;
  if (fresh.length) notified = (await notifyIncidents(db, fresh, { to: alertRecipients(opts.mail.to), from: opts.mail.from }, now)).sent;
  return { incidents: observed.length, notified, dns };
}
