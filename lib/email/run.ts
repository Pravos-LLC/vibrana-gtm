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
  const now = opts.now, observed: Incident[] = [], kinds = ["bounce_rate", "collection", "health_check"], unchecked = new Set<string>();
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
      if (b.last_error) observed.push({ key: k, kind: "collection", severity: "warning", summary: `${m.label}'s mailbox sync is failing: ${b.last_error}`.slice(0, 300) });
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
