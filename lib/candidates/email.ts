import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// "N candidates waiting": the Sunday email (Resend), the same plain pattern as the Signal Desk digest. It links
// to /signals?view=candidates, where John sends each one to review, edits it or rejects it.
import type { CandidateFormat } from "./select";

export type EmailCandidate = { slug: string; title: string; format: CandidateFormat; pillar: string; lens: string; channels: string[]; body: string; score: number | null; john_slots: number };

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
const FORMAT: Record<CandidateFormat, string> = { text: "Text post", carousel: "Carousel", video: "Video script" };
const LENS: Record<string, string> = { transformation: "Transformation", thought_leadership: "Thought leadership", regenerative: "Regenerative" };
const first = (body: string) => body.replace(/^---\n[\s\S]*?\n---\n/, "").trim().split("\n").find((l) => l.trim())?.slice(0, 220) ?? "";
const fmtWeek = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const candidatesUrl = (cockpitUrl: string) => `${cockpitUrl}/signals?view=candidates`;

export function candidatesSubject(list: EmailCandidate[], weekStart: string) {
  return `${list.length} ${list.length === 1 ? "candidate" : "candidates"} waiting for the week of ${fmtWeek(weekStart)}`;
}

export function candidatesHtml(list: EmailCandidate[], weekStart: string, cockpitUrl: string): string {
  const rows = list.map((c, i) => `<tr><td style="padding:16px 0;border-top:1px solid #e6e4ef">
    <div style="font-size:12px;color:#6b6b80;text-transform:uppercase;letter-spacing:.04em">${i + 1}. ${FORMAT[c.format]} · ${esc(c.pillar)} · ${esc(LENS[c.lens] ?? c.lens)}${c.score != null ? ` · rubric ${Math.round(c.score)}` : ""}</div>
    <h2 style="margin:6px 0 6px;font-size:17px;line-height:1.3;color:#14121f">${esc(c.title)}</h2>
    <p style="margin:0;color:#2b2838">${esc(first(c.body))}</p>
    ${c.john_slots ? `<p style="margin:6px 0 0;font-size:13px;color:#b45309">${c.john_slots} ${c.john_slots === 1 ? "place needs" : "places need"} your take</p>` : ""}
  </td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#faf9fd;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
  <tr><td style="padding-bottom:8px"><div style="font-size:13px;color:#6b6b80">Vibrana Sunday candidates · week of ${esc(fmtWeek(weekStart))}</div>
  <h1 style="margin:4px 0 0;font-size:22px;color:#14121f">${esc(candidatesSubject(list, weekStart))}</h1>
  <p style="margin:8px 0 0"><a href="${esc(candidatesUrl(cockpitUrl))}" style="color:#2563eb">Open the candidates</a> to send each one to review, edit it or reject it.</p></td></tr>
  ${rows}
  <tr><td style="padding-top:16px;font-size:12px;color:#6b6b80;border-top:1px solid #e6e4ef">Drafted by the writers room from the Signal Desk and this morning's report. Nothing is posted: Send to Review puts a draft in Content review, where it still needs your approval.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function candidatesText(list: EmailCandidate[], weekStart: string, cockpitUrl: string): string {
  const lines = [candidatesSubject(list, weekStart), candidatesUrl(cockpitUrl), ""];
  list.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title} [${FORMAT[c.format]}, ${c.pillar}, ${LENS[c.lens] ?? c.lens}${c.score != null ? `, rubric ${Math.round(c.score)}` : ""}]`, `   ${first(c.body)}`);
    if (c.john_slots) lines.push(`   ${c.john_slots} ${c.john_slots === 1 ? "place needs" : "places need"} your take`);
    lines.push("");
  });
  return lines.join("\n");
}

export async function sendCandidatesEmail(list: EmailCandidate[], weekStart: string, opts: { to: string; cockpitUrl: string; fetcher?: typeof fetch }) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send the candidates email");
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.CANDIDATES_EMAIL_FROM ?? process.env.SIGNALS_DIGEST_FROM ?? loadRuntimeConfig().mail.from,
      to: opts.to.split(",").map((s) => s.trim()).filter(Boolean),
      subject: candidatesSubject(list, weekStart), html: candidatesHtml(list, weekStart, opts.cockpitUrl), text: candidatesText(list, weekStart, opts.cockpitUrl),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}
