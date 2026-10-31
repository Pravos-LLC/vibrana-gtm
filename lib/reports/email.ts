import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// The weekly report by email (Resend), linking to /performance/report/<week> where the changes are decided.
import type { Report } from "./guard";
import type { Pack } from "./pack";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const reportUrl = (cockpitUrl: string, week: number) => `${cockpitUrl}/performance/report/${week}`;

export function reportSubject(pack: Pack, report: Report) {
  const n = report.actions.length;
  return `Week ${pack.week.number} report: ${report.headline}${n ? ` (${n} ${n === 1 ? "change" : "changes"} to decide)` : ""}`.slice(0, 180);
}

/** Label for a post ref: platform, date and title or preview. */
export function postLabel(pack: Pack, ref: string) {
  const p = pack.posts.find((x) => x.ref === ref);
  if (!p) return ref;
  return `${p.platform} ${fmtDate(p.published_on)}: ${p.title ?? (p.preview.slice(0, 60) || "untitled")}`;
}

function sections(pack: Pack, r: Report): [string, string[]][] {
  return [
    ["Went out", r.went_out.map((e) => `${postLabel(pack, e.ref)}. ${e.note}`)],
    ["Did well", r.did_well.map((e) => `${postLabel(pack, e.ref)}. ${e.why}`)],
    ["Didn't", r.underperformed.map((e) => `${postLabel(pack, e.ref)}. ${e.why}`)],
    ["Patterns", r.patterns.map((e) => e.observation)],
    ["Against the playbook", r.against_playbook.map((e) => e.observation)],
    ["Pillars: playing their part?", r.pillars.map((e) => `${pack.pillars.find((p) => p.slug === e.pillar)?.name ?? e.pillar} (${e.verdict.replace("_", " ")}). ${e.note}`)],
    ["Changes to decide", r.actions.map((a) => a.proposal)],
  ];
}

export function reportHtml(pack: Pack, r: Report, cockpitUrl: string): string {
  const blocks = sections(pack, r).filter(([, lines]) => lines.length).map(([title, lines]) => `<tr><td style="padding:16px 0;border-top:1px solid #e6e4ef">
    <div style="font-size:12px;color:#6b6b80;text-transform:uppercase;letter-spacing:.06em">${esc(title)}</div>
    <ul style="margin:8px 0 0;padding-left:18px">${lines.map((l) => `<li style="margin:0 0 6px">${esc(l)}</li>`).join("")}</ul></td></tr>`).join("");
  const url = reportUrl(cockpitUrl, pack.week.number);
  return `<!doctype html><html><body style="margin:0;background:#faf9fd;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
  <tr><td style="padding-bottom:8px"><div style="font-size:13px;color:#6b6b80">Vibrana content report · week ${pack.week.number} · ${esc(fmtDate(pack.week.from))} to ${esc(fmtDate(pack.week.to))}</div>
  <h1 style="margin:6px 0 0;font-size:22px;line-height:1.3;color:#14121f">${esc(r.headline)}</h1>
  ${r.lede ? `<p style="margin:10px 0 0">${esc(r.lede)}</p>` : ""}
  <p style="margin:12px 0 0"><a href="${esc(url)}" style="color:#2563eb">Read the report${r.actions.length ? " and decide the changes" : ""}</a></p></td></tr>
  ${blocks}
  <tr><td style="padding-top:16px;font-size:12px;color:#6b6b80;border-top:1px solid #e6e4ef">Every number here comes from the cockpit's own data; claims the data did not support were removed before sending. Accepting a change only edits the calendar. Nothing is approved or scheduled.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function reportText(pack: Pack, r: Report, cockpitUrl: string): string {
  const lines = [`Vibrana content report, week ${pack.week.number} (${pack.week.from} to ${pack.week.to})`, reportUrl(cockpitUrl, pack.week.number), "", r.headline, r.lede, ""];
  for (const [title, items] of sections(pack, r)) if (items.length) lines.push(title.toUpperCase(), ...items.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

export async function sendReport(pack: Pack, r: Report, opts: { to: string; cockpitUrl: string; fetcher?: typeof fetch }) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send the report");
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.REPORT_EMAIL_FROM ?? process.env.SIGNALS_DIGEST_FROM ?? loadRuntimeConfig().mail.from,
      to: opts.to.split(",").map((s) => s.trim()).filter(Boolean),
      subject: reportSubject(pack, r), html: reportHtml(pack, r, opts.cockpitUrl), text: reportText(pack, r, opts.cockpitUrl),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}
