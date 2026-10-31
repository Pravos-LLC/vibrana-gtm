import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// The morning digest: the top briefed stories by email (Resend), linking back to /signals.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brief, SignalsConfig } from "./config";
import { listStories, storyItems } from "./pipeline";

export type DigestLink = { title: string; url: string; source: string };
export type DigestStory = { id: string; title: string; lanes: string[]; score: number; source_count: number; brief: Brief | null; links?: DigestLink[] };

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

export function laneName(cfg: SignalsConfig, slug: string) {
  return cfg.lanes.find((l) => l.slug === slug)?.name ?? slug;
}

export function digestSubject(stories: DigestStory[], date: string) {
  const lead = stories[0]?.brief?.headline ?? stories[0]?.title ?? "No new stories";
  return `Signal Desk ${date}: ${lead}`.slice(0, 180);
}

/** Plain, readable HTML: one block per story with the brief, the three angles and the sources. */
export function digestHtml(cfg: SignalsConfig, stories: DigestStory[], cockpitUrl: string, date: string): string {
  const blocks = stories.map((s, i) => {
    const b = s.brief;
    const lanes = s.lanes.map((l) => laneName(cfg, l)).join(" · ");
    const sources = (b?.sources ?? s.links ?? []).map((src) => `<li><a href="${esc(src.url)}">${esc(src.title)}</a> <span style="color:#6b6b80">(${esc(src.source)})</span></li>`).join("");
    return `<tr><td style="padding:20px 0;border-top:1px solid #e6e4ef">
      <div style="font-size:12px;color:#6b6b80;text-transform:uppercase;letter-spacing:.04em">${i + 1}. ${esc(lanes || "Signal")} · ${s.source_count} source${s.source_count === 1 ? "" : "s"}</div>
      <h2 style="margin:6px 0 8px;font-size:18px;line-height:1.3;color:#14121f">${esc(b?.headline ?? s.title)}</h2>
      ${b ? `<p style="margin:0 0 8px"><b>What happened.</b> ${esc(b.what_happened)}</p>
      <p style="margin:0 0 8px"><b>Why it matters.</b> ${esc(b.why_it_matters)}</p>
      <p style="margin:0 0 8px"><b>The tension.</b> ${esc(b.tension)}</p>
      <p style="margin:0 0 4px"><b>Angles</b></p>
      <ul style="margin:0 0 8px;padding-left:18px"><li>LinkedIn take: ${esc(b.angles.linkedin_take)}</li><li>Story: ${esc(b.angles.story)}</li><li>Video: ${esc(b.angles.video)}</li></ul>
      ` : ""}<ul style="margin:0;padding-left:18px;font-size:13px">${sources}</ul>
    </td></tr>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;background:#faf9fd;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
  <tr><td style="padding-bottom:8px"><div style="font-size:13px;color:#6b6b80">Vibrana Signal Desk · ${esc(date)}</div>
  <h1 style="margin:4px 0 0;font-size:22px;color:#14121f">${stories.length} stories worth a look</h1>
  <p style="margin:8px 0 0"><a href="${esc(cockpitUrl)}/signals" style="color:#6d4aff">Open the Signal Desk</a> to queue a story, a repost or a video.</p></td></tr>
  ${blocks || `<tr><td style="padding:20px 0">Nothing cleared the bar since yesterday.</td></tr>`}
  <tr><td style="padding-top:20px;font-size:12px;color:#6b6b80;border-top:1px solid #e6e4ef">Briefs are machine summaries of the linked sources. Check a fact at its source before you publish it.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function digestText(cfg: SignalsConfig, stories: DigestStory[], cockpitUrl: string, date: string): string {
  const lines = [`Vibrana Signal Desk, ${date}`, `${cockpitUrl}/signals`, ""];
  stories.forEach((s, i) => {
    const b = s.brief;
    lines.push(`${i + 1}. ${b?.headline ?? s.title} [${s.lanes.map((l) => laneName(cfg, l)).join(", ")}]`);
    if (b) {
      lines.push(`   What happened: ${b.what_happened}`, `   Why it matters: ${b.why_it_matters}`, `   Tension: ${b.tension}`);
      lines.push(`   LinkedIn take: ${b.angles.linkedin_take}`, `   Story: ${b.angles.story}`, `   Video: ${b.angles.video}`);
    }
    for (const src of b?.sources ?? s.links ?? []) lines.push(`   - ${src.title} (${src.source}) ${src.url}`);
    lines.push("");
  });
  return lines.join("\n");
}

/** The digest's stories: the highest-scoring undismissed stories seen in the last day. */
export async function digestStories(db: SupabaseClient, cfg: SignalsConfig, now = new Date()): Promise<DigestStory[]> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const stories = (await listStories(db, { since, limit: cfg.ranking.digest_size })) as DigestStory[];
  // A story whose brief failed still carries its sources, so the digest is useful even when briefing fails.
  const items = await storyItems(db, stories.filter((s) => !s.brief).map((s) => s.id));
  for (const story of stories) if (!story.brief) story.links = items.filter((i) => i.story_id === story.id).slice(0, 3).map((i) => ({ title: i.title.slice(0, 160), url: i.url, source: i.source }));
  return stories;
}

export async function sendDigest(cfg: SignalsConfig, stories: DigestStory[], opts: { to: string; cockpitUrl: string; date: string; fetcher?: typeof fetch }) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send the digest");
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.SIGNALS_DIGEST_FROM ?? loadRuntimeConfig().mail.from,
      to: opts.to.split(",").map((s) => s.trim()).filter(Boolean),
      subject: digestSubject(stories, opts.date),
      html: digestHtml(cfg, stories, opts.cockpitUrl, opts.date),
      text: digestText(cfg, stories, opts.cockpitUrl, opts.date),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}
