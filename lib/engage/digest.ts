import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// The morning "N replies to approve" email (Resend), linking to /engage. Same sender setup as the
// Signal Desk digest.
import { flagHtml, flagLines } from "./alerts";
import { FLAG_LABEL, type RedFlag } from "./redflags";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

export type DigestItem = { platform: string; author: string; text: string; classification: string | null };

const PLATFORM: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", threads: "Threads", twitter: "X", tiktok: "TikTok" };
export const platformName = (p: string) => PLATFORM[p] ?? p;

/** "N replies to approve" counts replies only; spam to hide is named separately. */
export function engageSubject(items: DigestItem[], flags: RedFlag[] = []) {
  const red = flags.filter((f) => f.flag !== "healthy_debate").length;
  const spam = items.filter((i) => i.classification === "spam").length;
  const n = items.length - spam;
  const needsJohn = items.filter((i) => i.classification === "needs_john").length;
  const head = n ? `${n} ${n === 1 ? "reply" : "replies"} to approve${needsJohn ? ` (${needsJohn} need${needsJohn === 1 ? "s" : ""} you)` : ""}` : "No replies to approve";
  const withSpam = spam ? `${head}, ${spam} spam to hide` : head;
  return red ? `${red} red flag${red === 1 ? "" : "s"}: ${withSpam}` : withSpam;
}

/** "Flags (3): 1 backlash, 2 healthy debate". Healthy debate is listed but never counted as a red flag. */
export function flagsHeading(flags: RedFlag[]) {
  const parts = (["backlash", "not_landing", "healthy_debate"] as const).map((k) => [k, flags.filter((f) => f.flag === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${FLAG_LABEL[k].toLowerCase()}`);
  return `Flags (${flags.length}): ${parts.join(", ")}`;
}

/** The flag section: most severe first, at most five. */
export function flagsHtml(flags: RedFlag[], cockpitUrl: string): string {
  if (!flags.length) return "";
  return `<tr><td style="padding:12px 0 4px"><h2 style="margin:0;font-size:17px;color:#14121f">${esc(flagsHeading(flags))}</h2>
    <div style="font-size:13px;color:#6b6b80">Recommendations only: nothing was hidden or answered.</div>
    ${flags.slice(0, 5).map((f) => flagHtml(f, cockpitUrl)).join("")}</td></tr>`;
}

export function engageHtml(items: DigestItem[], cockpitUrl: string, date: string, flags: RedFlag[] = []): string {
  const rows = items.slice(0, 12).map((i) => `<tr><td style="padding:10px 0;border-top:1px solid #e6e4ef">
    <div style="font-size:12px;color:#6b6b80">${esc(platformName(i.platform))} · ${esc(i.author)}${i.classification === "needs_john" ? " · <b>needs you</b>" : i.classification === "spam" ? " · looks like spam" : ""}</div>
    <div style="margin-top:4px">${esc(i.text.length > 200 ? `${i.text.slice(0, 199)}…` : i.text)}</div></td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#faf9fd;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="padding-bottom:8px"><div style="font-size:13px;color:#6b6b80">Vibrana Engage · ${esc(date)}</div>
  <h1 style="margin:4px 0 0;font-size:22px;color:#14121f">${esc(engageSubject(items, flags))}</h1>
  <p style="margin:12px 0"><a href="${esc(cockpitUrl)}/engage" style="display:inline-block;background:#6d4aff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the queue</a></p></td></tr>
  ${flagsHtml(flags, cockpitUrl)}
  ${rows}
  ${items.length > 12 ? `<tr><td style="padding:10px 0;color:#6b6b80">and ${items.length - 12} more</td></tr>` : ""}
  <tr><td style="padding-top:16px;font-size:12px;color:#6b6b80;border-top:1px solid #e6e4ef">Drafts are suggestions. Nothing is sent until you approve it.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function engageText(items: DigestItem[], cockpitUrl: string, date: string, flags: RedFlag[] = []): string {
  return [`Vibrana Engage, ${date}`, engageSubject(items, flags), `${cockpitUrl}/engage`, "",
    ...(flags.length ? [flagsHeading(flags), ...flags.slice(0, 5).flatMap(flagLines), ""] : []),
    ...items.slice(0, 12).map((i) => `- ${platformName(i.platform)} · ${i.author}: ${i.text.slice(0, 160)}`)].join("\n");
}

export async function sendEngageEmail(items: DigestItem[], opts: { to: string; cockpitUrl: string; date: string; fetcher?: typeof fetch; flags?: RedFlag[] }) {
  const flags = opts.flags ?? [];
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send the engage email");
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.ENGAGE_DIGEST_FROM ?? loadRuntimeConfig().mail.engageFrom,
      to: opts.to.split(",").map((s) => s.trim()).filter(Boolean),
      subject: engageSubject(items, flags),
      html: engageHtml(items, opts.cockpitUrl, opts.date, flags),
      text: engageText(items, opts.cockpitUrl, opts.date, flags),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}
