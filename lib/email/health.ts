// Sender and authentication health (email contract v1, VIB-511): DNS records of the sending domains, DMARC aggregate
// reports, and incidents that both owners see and are emailed once. No address of a contact is ever read here.
//
// Sending domains come from EMAIL_HEALTH_DOMAINS (production config, never this public repo): comma-separated
// `domain` or `domain:dkimSelector`. Incidents mail EMAIL_ALERT_TO (comma-separated; it must name both owners), else the
// cron's report recipients. A check that could not run is an incident of its own, never a healthy result.
import { resolveMx, resolveTxt } from "node:dns/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";

export type DomainCheck = { domain: string; mx: boolean; spf: boolean; dmarc: string | null; dkim: boolean | null; problems: string[] };
type Resolver = { mx: (d: string) => Promise<unknown[]>; txt: (d: string) => Promise<string[][]> };
const dnsResolver: Resolver = { mx: (d) => resolveMx(d), txt: (d) => resolveTxt(d) };

export const healthDomains = (env: Record<string, string | undefined> = process.env) =>
  (env.EMAIL_HEALTH_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => { const [domain, selector] = s.split(":"); return { domain, selector: selector || null }; })
    .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d.domain));

const txt = async (r: Resolver, name: string) => { try { return (await r.txt(name)).map((parts) => parts.join("")); } catch { return []; } };

/** MX, SPF, DMARC policy and (with a selector) DKIM for one domain. A missing record is a named problem. */
export async function checkDomain(domain: string, selector: string | null, r: Resolver = dnsResolver): Promise<DomainCheck> {
  const problems: string[] = [];
  let mx = false;
  try { mx = (await r.mx(domain)).length > 0; } catch { mx = false; }
  if (!mx) problems.push("no MX record");
  const spfs = (await txt(r, domain)).filter((t) => /^v=spf1\b/i.test(t));
  if (spfs.length !== 1) problems.push(spfs.length ? "more than one SPF record" : "no SPF record");
  const dmarcRec = (await txt(r, `_dmarc.${domain}`)).find((t) => /^v=DMARC1\b/i.test(t)) ?? null;
  const dmarc = dmarcRec?.match(/\bp=(none|quarantine|reject)\b/i)?.[1]?.toLowerCase() ?? null;
  if (!dmarc) problems.push("no DMARC policy");
  let dkim: boolean | null = null;
  if (selector) { dkim = (await txt(r, `${selector}._domainkey.${domain}`)).some((t) => /\bp=[A-Za-z0-9+/=]{20,}/.test(t)); if (!dkim) problems.push(`no DKIM key at selector ${selector}`); }
  return { domain, mx, spf: spfs.length === 1, dmarc, dkim, problems };
}

/* ------------------------------------------------------------------------------------------------ DMARC aggregate */

export type DmarcReport = { report_key: string; reporter: string; domain: string; begin_at: string; end_at: string; messages: number; dmarc_pass: number; dkim_aligned: number; spf_aligned: number; sources: { ip: string; count: number; dkim: string; spf: string }[] };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"))?.[1] ?? null;

/** Reads an aggregate report (RFC 7489 appendix C), raw XML or gzip. Totals and per-source counts only. */
export function parseDmarcAggregate(input: Buffer | string): DmarcReport | null {
  let xml: string;
  try { xml = typeof input === "string" ? input : input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input).toString("utf8") : input.toString("utf8"); } catch { return null; }
  const meta = xml.match(/<report_metadata>([\s\S]*?)<\/report_metadata>/i)?.[1], policy = xml.match(/<policy_published>([\s\S]*?)<\/policy_published>/i)?.[1];
  if (!meta || !policy) return null;
  const org = tag(meta, "org_name"), id = tag(meta, "report_id"), begin = Number(tag(meta, "begin")), end = Number(tag(meta, "end")), domain = tag(policy, "domain")?.toLowerCase();
  if (!org || !id || !domain || !Number.isFinite(begin) || !Number.isFinite(end)) return null;
  let messages = 0, pass = 0, dkimOk = 0, spfOk = 0;
  const sources: DmarcReport["sources"] = [];
  for (const rec of xml.match(/<record>[\s\S]*?<\/record>/gi) ?? []) {
    const count = Number(tag(rec, "count") ?? 0), dkim = (tag(rec.match(/<policy_evaluated>[\s\S]*?<\/policy_evaluated>/i)?.[0] ?? "", "dkim") ?? "").toLowerCase();
    const spf = (tag(rec.match(/<policy_evaluated>[\s\S]*?<\/policy_evaluated>/i)?.[0] ?? "", "spf") ?? "").toLowerCase();
    if (!Number.isFinite(count) || count < 0) continue;
    messages += count; if (dkim === "pass") dkimOk += count; if (spf === "pass") spfOk += count; if (dkim === "pass" || spf === "pass") pass += count;
    sources.push({ ip: tag(rec, "source_ip") ?? "", count, dkim, spf });
  }
  return { report_key: createHash("sha256").update(`${org}\n${id}`).digest("hex"), reporter: org.slice(0, 200), domain, begin_at: new Date(begin * 1000).toISOString(),
    end_at: new Date(end * 1000).toISOString(), messages, dmarc_pass: pass, dkim_aligned: dkimOk, spf_aligned: spfOk, sources: sources.slice(0, 200) };
}

export async function saveDmarc(db: SupabaseClient, r: DmarcReport) {
  must(await db.from("gtm_dmarc_reports").upsert(r, { onConflict: "report_key", ignoreDuplicates: true }), "save DMARC report");
}

/* ------------------------------------------------------------------------------------------------ incidents */

export type Incident = { key: string; kind: string; severity: "warning" | "critical"; summary: string; detail?: Record<string, unknown> };

export const alertRecipients = (fallback: string, env: Record<string, string | undefined> = process.env) =>
  (env.EMAIL_ALERT_TO ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Opens an incident or refreshes the open one with the same key; resolves open incidents of the given kinds whose key is
 * no longer observed, except kinds in `unchecked` (their check could not run, so a prior problem is not known to be gone,
 * review of #32 F5). The text an incident is emailed with is fixed when it opens (`detail.notice`). Returns open incidents
 * that have not been emailed yet.
 */
export async function reconcileIncidents(db: SupabaseClient, observed: Incident[], kinds: string[], now: Date, unchecked: Set<string> = new Set()) {
  const open = must(await db.from("gtm_email_incidents").select("id,incident_key,kind,severity,summary,detail,notified_at").is("resolved_at", null).in("kind", kinds), "open incidents") as
    { id: number; incident_key: string; kind: string; severity: Incident["severity"]; summary: string; detail: Record<string, unknown>; notified_at: string | null }[];
  const seen = new Set(observed.map((o) => o.key));
  for (const o of open) if (!seen.has(o.incident_key) && !unchecked.has(o.kind)) must(await db.from("gtm_email_incidents").update({ resolved_at: now.toISOString(), last_seen_at: now.toISOString() }).eq("id", o.id), "resolve incident");
  for (const o of observed) {
    const cur = open.find((x) => x.incident_key === o.key);
    if (cur) must(await db.from("gtm_email_incidents").update({ last_seen_at: now.toISOString(), summary: o.summary.slice(0, 300), detail: { ...(o.detail ?? {}), notice: cur.detail?.notice ?? cur.summary, ...(cur.detail?.envelope ? { envelope: cur.detail.envelope } : {}) } }).eq("id", cur.id), "refresh incident");
    else must(await db.from("gtm_email_incidents").insert({ incident_key: o.key, kind: o.kind, severity: o.severity, summary: o.summary.slice(0, 300), detail: { ...(o.detail ?? {}), notice: o.summary.slice(0, 300) }, opened_at: now.toISOString(), last_seen_at: now.toISOString() }), "open incident");
  }
  // Every incident not yet emailed, resolved or not: a notice that failed to send is still owed once (review of #32, B2).
  return must(await db.from("gtm_email_incidents").select("id,incident_key,kind,severity,summary,detail,resolved_at").is("notified_at", null).in("kind", kinds), "incidents to email") as
    { id: number; incident_key: string; kind: string; severity: Incident["severity"]; summary: string; detail: Record<string, unknown> }[];
}

/**
 * One email per incident, each with its own idempotency key and the text fixed when it opened, so a retry after a crash
 * (or after the notified mark failed) repeats the same request and the provider sends it once (review of #32, F4). The
 * provider's idempotency window is finite (about a day); an incident still unmarked after that may be sent again, which
 * the hourly schedule makes a rare, visible duplicate rather than a silent loss.
 */
export async function notifyIncidents(db: SupabaseClient, incidents: { id: number; severity: string; detail: Record<string, unknown>; summary: string }[], mail: { to: string[]; from: string }, now: Date) {
  if (!incidents.length) return { sent: false };
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("email health alert: RESEND_API_KEY is not set");
  // Recipients are needed only for an incident whose request is not frozen yet; a frozen one is retried as stored.
  if (!mail.to.length && incidents.some((i) => !i.detail?.envelope)) throw new Error("email health alert: no recipients (EMAIL_ALERT_TO)");
  // The whole request is fixed before its first attempt and stored on the incident, so every retry under the same
  // idempotency key is byte-identical: a recovery, a new summary or a changed EMAIL_ALERT_TO never alters it (review of
  // #32, round 3). The envelope holds team addresses only. One incident's failure never blocks the others.
  type Envelope = { from: string; to: string[]; subject: string; text: string };
  let sent = false;
  const failures: string[] = [];
  for (const i of incidents) {
    try {
      let env = i.detail?.envelope as Envelope | undefined;
      if (!env) {
        const notice = String(i.detail?.notice ?? i.summary);
        env = { from: mail.from, to: mail.to, subject: `Email health [${i.severity}]: ${notice}`.slice(0, 180),
          text: [`Email health incident: ${notice}`, "", "Either of you can pick this up. It stays open on /performance/team until the check passes.", "Alerts never pause a campaign by themselves."].join("\n") };
        must(await db.from("gtm_email_incidents").update({ detail: { ...(i.detail ?? {}), envelope: env } }).eq("id", i.id).is("notified_at", null), "freeze notice");
      }
      const res = await providerFetch()("https://api.resend.com/emails", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `email-health/incident/${i.id}` },
        body: JSON.stringify(env), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`);
      must(await db.from("gtm_email_incidents").update({ notified_at: now.toISOString() }).eq("id", i.id), "mark notified");
      sent = true;
    } catch (e) { failures.push(`incident ${i.id}: ${(e as Error).message.slice(0, 120)}`); }
  }
  if (failures.length) throw new Error(`email health alert: ${failures.join("; ")}`);
  return { sent };
}
