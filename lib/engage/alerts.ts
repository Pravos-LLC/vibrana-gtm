import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Out-of-cycle red-flag alert (VIB-424): when a post newly crosses the backlash threshold, John gets one
// email right away instead of at 07:00. At most one alert per post per cooldown (24 h), recorded in
// gtm_red_flag_alerts. Checked on webhook ingest; the daily run records the flags it emails so the next
// webhook does not alert on the same post again.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { platformName } from "./digest";
import { FLAG_COLUMNS, FLAG_LABEL, REDFLAGS, actionLabel, flagPost, type FlagComment, type RedFlag, type RedFlagConfig } from "./redflags";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

export type PostRef = { platform: string; zernio_post_id: string | null; platform_post_id: string | null };

/** Every comment on one post (the flag reads the whole thread, not just the window). */
export async function postComments(db: SupabaseClient, ref: PostRef): Promise<FlagComment[]> {
  let q = db.from("gtm_comments").select(FLAG_COLUMNS).eq("platform", ref.platform).eq("kind", "comment").eq("is_own", false);
  q = ref.zernio_post_id ? q.eq("zernio_post_id", ref.zernio_post_id) : q.eq("platform_post_id", ref.platform_post_id ?? "");
  return must(await q.order("commented_at").limit(1000), "post comments") as FlagComment[];
}

/**
 * Claims the alert for this post, or null when one went out inside the cooldown. Atomic in the database:
 * gtm_claim_red_flag_alert takes an advisory lock on the post key, checks the window and inserts in one
 * transaction, so concurrent webhooks cannot both win.
 */
export async function claimAlert(db: SupabaseClient, flag: RedFlag, opts: { cfg?: RedFlagConfig; via: "webhook" | "daily"; email_id?: string | null }): Promise<{ id: string } | null> {
  const cfg = opts.cfg ?? REDFLAGS;
  const { data, error } = await db.rpc("gtm_claim_red_flag_alert", {
    p_post_key: flag.post_key, p_flag: flag.flag, p_cooldown_hours: cfg.alert.cooldown_hours,
    p_stats: { via: opts.via, counts: flag.counts, reasons: flag.reasons },
  });
  if (error) throw new Error(`claim alert: ${error.message}`);
  if (!data) return null;
  const id = String(data);
  if (opts.email_id) await db.from("gtm_red_flag_alerts").update({ email_id: opts.email_id }).eq("id", id);
  return { id };
}

/** Releases a claim whose email never went out, so the next webhook can still alert. */
export async function releaseAlert(db: SupabaseClient, id: string) {
  await db.from("gtm_red_flag_alerts").delete().eq("id", id).is("email_id", null);
}

export function alertSubject(f: RedFlag) {
  return `Red flag: ${FLAG_LABEL[f.flag].toLowerCase()} on ${platformName(f.platform)}, "${f.title.slice(0, 60)}"`;
}

/** One flag as plain lines (alert email text and the daily email's text part). */
export function flagLines(f: RedFlag): string[] {
  const who = f.who.notable.map((n) => `${n.name}${n.tags.length ? ` (${n.tags.join(", ")})` : ""}`).join("; ");
  return [
    `${FLAG_LABEL[f.flag]}: ${platformName(f.platform)}, ${f.title}`,
    `  Why: ${f.reasons.join("; ")}`,
    `  Comments: ${f.counts.supportive} supportive, ${f.counts.question} questions, ${f.counts.constructive_dissent} reasoned dissent, ${f.counts.misread} misreads, ${f.counts.hostile} hostile, ${f.counts.troll_or_bad_faith} bad faith`,
    ...(f.objection ? [`  Core objection: ${f.objection}`] : []),
    ...(who ? [`  Who: ${who}`] : []),
    `  Recommended: ${actionLabel(f.action)}${f.also.length ? ` (also: ${f.also.map((a) => actionLabel(a)).join("; ")})` : ""}`,
  ];
}

export function flagHtml(f: RedFlag, cockpitUrl: string): string {
  const lines = flagLines(f);
  const link = `${cockpitUrl}/engage?post=${encodeURIComponent(f.post_key)}`;
  return `<div style="padding:10px 0;border-top:1px solid #e6e4ef"><div style="font-weight:600">${esc(lines[0])}</div>${lines.slice(1).map((l) => `<div style="font-size:14px;color:#2b2838">${esc(l.trim())}</div>`).join("")}<div style="margin-top:4px"><a href="${esc(link)}" style="color:#6d4aff">See the comments</a>${f.url ? ` · <a href="${esc(f.url)}" style="color:#6d4aff">Open the post</a>` : ""}</div></div>`;
}

export async function sendAlert(f: RedFlag, opts: { to?: string; cockpitUrl?: string; fetcher?: typeof fetch } = {}) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send a red-flag alert");
  const cockpitUrl = opts.cockpitUrl ?? process.env.GTM_COCKPIT_URL ?? "http://localhost:3000";
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.ENGAGE_DIGEST_FROM ?? "Vibrana Engage <user-10beea67bd6f@example.com>",
      to: (opts.to ?? process.env.ENGAGE_DIGEST_TO ?? process.env.SIGNALS_DIGEST_TO ?? "user-f538cb95fc21@example.com").split(",").map((s) => s.trim()).filter(Boolean),
      subject: alertSubject(f),
      html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838;max-width:600px">${flagHtml(f, cockpitUrl)}<p style="font-size:12px;color:#6b6b80">Nothing has been hidden, deleted or answered. The recommendation is yours to take or leave.</p></body></html>`,
      text: [...flagLines(f), "", `${cockpitUrl}/engage?post=${encodeURIComponent(f.post_key)}`, "", "Nothing has been hidden, deleted or answered."].join("\n"),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}

/**
 * The webhook-side check for one post: compute its flag and, if it is an alerting flag (backlash) not
 * alerted inside the cooldown, email John once. Returns what happened, for logs and tests.
 */
export async function checkPostAlert(db: SupabaseClient, ref: PostRef, opts: { cfg?: RedFlagConfig; now?: Date; send?: typeof sendAlert } = {}) {
  const cfg = opts.cfg ?? REDFLAGS;
  const flag = flagPost(await postComments(db, ref), { cfg });
  if (!flag || !(cfg.alert.flags as string[]).includes(flag.flag)) return { flag: flag?.flag ?? null, alerted: false };
  // Claim first (atomic), so a racing webhook cannot also send; give the claim back if the email fails,
  // so a failed send never suppresses the next alert for 24 h.
  const claim = await claimAlert(db, flag, { cfg, via: "webhook" });
  if (!claim) return { flag: flag.flag, alerted: false, reason: "already alerted inside the cooldown" };
  let sent: { id: string | null };
  try {
    sent = await (opts.send ?? sendAlert)(flag);
  } catch (e) {
    await releaseAlert(db, claim.id);
    throw e;
  }
  await db.from("gtm_red_flag_alerts").update({ email_id: sent.id ?? "sent" }).eq("id", claim.id);
  return { flag: flag.flag, alerted: true };
}
