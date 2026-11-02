// The weekly report email: a short note with the headline, the summary and one button to open the dashboard.
// The dashboard itself stays in the cockpit behind login; the email carries no numbers beyond the summary.
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import type { ReportDoc } from "./doc";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const periodLabel = (from: string, to: string) => `${fmt(from)} to ${fmt(to)}`;

type Mail = { to: string; from: string; url: string; fetcher?: typeof fetch };
type ReportLike = { title: string; headline: string; period_start: string; period_end: string; doc: Pick<ReportDoc, "summary"> };

export function linkSubject(r: ReportLike) {
  return `${r.title}: ${r.headline}`.slice(0, 180);
}

function shell(body: string) {
  return `<!doctype html><html><body style="margin:0;background:#faf9fd;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2b2838">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">${body}</table></td></tr></table></body></html>`;
}

const button = (url: string, label: string) =>
  `<a href="${esc(url)}" style="display:inline-block;background:#4b3fd6;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px">${esc(label)}</a>`;

export function linkHtml(r: ReportLike, url: string) {
  const summary = (r.doc.summary ?? []).map((s) => `<li style="margin:0 0 8px">${esc(s)}</li>`).join("");
  return shell(`
  <tr><td><div style="font-size:13px;color:#6b6b80">Vibrana weekly report · ${esc(periodLabel(r.period_start, r.period_end))}</div>
  <h1 style="margin:6px 0 0;font-size:22px;line-height:1.3;color:#14121f">${esc(r.headline)}</h1></td></tr>
  ${summary ? `<tr><td style="padding-top:14px"><ul style="margin:0;padding-left:18px">${summary}</ul></td></tr>` : ""}
  <tr><td style="padding-top:18px">${button(url, "Open the report")}</td></tr>
  <tr><td style="padding-top:22px;font-size:12px;color:#6b6b80">Every past report is under Analytics, Reports in the cockpit.</td></tr>`);
}

export function linkText(r: ReportLike, url: string) {
  return [`Vibrana weekly report, ${periodLabel(r.period_start, r.period_end)}`, "", r.headline, "", ...(r.doc.summary ?? []).map((s) => `- ${s}`), "", `Open the report: ${url}`].join("\n");
}

async function send(mail: Mail, subject: string, html: string, text: string) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send the report email");
  const res = await providerFetch(mail.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: mail.from, to: mail.to.split(",").map((s) => s.trim()).filter(Boolean), subject, html, text }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}

export function sendReportLink(r: ReportLike, mail: Mail) {
  return send(mail, linkSubject(r), linkHtml(r, mail.url), linkText(r, mail.url));
}

export function sendMissingAlert(week: { from: string; to: string }, mail: Mail) {
  const label = periodLabel(week.from, week.to);
  const subject = `No weekly report for ${label}`;
  const html = shell(`
  <tr><td><div style="font-size:13px;color:#6b6b80">Vibrana weekly report</div>
  <h1 style="margin:6px 0 0;font-size:22px;line-height:1.3;color:#14121f">${esc(subject)}</h1>
  <p style="margin:12px 0 0">The weekly report for last week was not published by Monday noon in Bali. Run the weekly-report skill to write it; this alert is sent once per week.</p></td></tr>
  <tr><td style="padding-top:18px">${button(mail.url, "Open past reports")}</td></tr>`);
  const text = `${subject}\n\nThe weekly report for last week was not published by Monday noon in Bali. Run the weekly-report skill to write it; this alert is sent once per week.\n\n${mail.url}`;
  return send(mail, subject, html, text);
}
