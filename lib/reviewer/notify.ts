import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Tells John when a third party acts on their review link, so a note or an approval never waits for him to open
// /content. Best effort: the decision is already saved when this runs, and a failed email is only logged.
import { cockpitUrl } from "./invites";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

export type ReviewerEvent = { party: string; piece: string; storyId: string; kind: "approved" | "changes" | "note"; note: string };

export function eventSubject(e: ReviewerEvent): string {
  const verb = e.kind === "approved" ? "approved" : e.kind === "changes" ? "asked for changes on" : "left a note on";
  return `${e.party} ${verb} ${e.piece}`;
}

export async function notifyJohn(e: ReviewerEvent, opts: { fetcher?: typeof fetch } = {}) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to tell John about a review");
  // The piece itself: /content with the piece filter, one piece at a time.
  const link = `${cockpitUrl()}/content?piece=${encodeURIComponent(e.storyId)}`;
  const after = e.kind === "approved"
    ? "Recorded against that asset. Once every asset is approved, their sign-off opens the hold and what you have approved is scheduled."
    : "Read it with gtm reviewer notes, or in /content. It does not queue agent work: you decide what happens next.";
  const res = await providerFetch(opts.fetcher)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.REVIEW_NOTIFY_FROM ?? loadRuntimeConfig().mail.outreachFrom,
      to: (process.env.REVIEW_NOTIFY_TO ?? process.env.SIGNALS_DIGEST_TO ?? loadRuntimeConfig().mail.notify).split(",").map((s) => s.trim()).filter(Boolean),
      subject: eventSubject(e),
      html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2838;max-width:600px"><p style="font-weight:600">${esc(eventSubject(e))}</p>${e.note ? `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #6d4aff;white-space:pre-wrap">${esc(e.note)}</blockquote>` : ""}<p>${esc(after)}</p><p><a href="${esc(link)}" style="color:#6d4aff">Open it in /content</a></p></body></html>`,
      text: [eventSubject(e), "", e.note, "", after, link].filter((l, i) => l || i === 1).join("\n"),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${data.message ?? "send failed"}`);
  return { id: data.id ?? null };
}
