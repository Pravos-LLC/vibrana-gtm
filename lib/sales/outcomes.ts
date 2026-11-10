// Outreach outcomes for the pipeline dashboard: what happened to each accepted desk email in the mailbox it was sent from,
// stored on the draft so the numbers survive (the /outreach/inbox page only ever computed them live). Two streams are read,
// each from its own mailbox: the client stream from the HQ outreach mailbox (OUTREACH_GMAIL_*), and John's network stream
// (VIB-522) from the Google account its sending address is an alias of (NETWORK_GMAIL_*). Guests are not read.
//
// - A sent thread that matches a draft with no send recorded stamps the send (a forgotten "Mark sent" still counts),
//   attributed to the mailbox address.
// - A reply (not automated, from the prospect) stamps email_replied_at and moves email_status to "replied".
// - A delivery failure with no reply stamps email_bounced_at.
// A reply date only ever moves earlier, a status only forward, and no address, subject or body is stored. Matching is lib/outreach/mailbox.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { readPages } from "../db-read";
import { GmailReader, hqAddress, mailboxConfig, networkMailboxConfig, trackAddress, type Conversation, type OutreachMail } from "../outreach/mailbox";

export type OutcomeDraft = OutreachMail & {
  email_status: "none" | "queued" | "sent" | "replied"; email_sent_by: string | null;
  email_replied_at: string | null; email_bounced_at: string | null;
};
export type OutcomePatch = Partial<Pick<OutcomeDraft, "email_status" | "email_sent_at" | "email_sent_by" | "email_replied_at" | "email_bounced_at">>;

/** The changes one conversation implies for its draft; empty when the draft already says all of it. */
export function outcomePatch(c: Conversation, d: OutcomeDraft, mailbox: string): OutcomePatch {
  const p: OutcomePatch = {};
  if (c.sentAt && !d.email_sent_at && (d.email_status === "none" || d.email_status === "queued")) {
    p.email_sent_at = c.sentAt; p.email_sent_by = mailbox.toLowerCase(); p.email_status = "sent";
  }
  if (c.status === "reply" && c.replyAt) {
    // Gmail's reply time wins over a label-time date (John may label before the sync, or long after the reply).
    if (!d.email_replied_at || Date.parse(c.replyAt) < Date.parse(d.email_replied_at)) p.email_replied_at = c.replyAt;
    if (d.email_status !== "replied" && (d.email_status === "sent" || p.email_status === "sent")) p.email_status = "replied";
  }
  if (c.status === "delivery-failure" && c.failedAt && !d.email_bounced_at && !d.email_replied_at) p.email_bounced_at = c.failedAt;
  return p;
}

export type OutcomeRun = { scanned: number; matched: number; sent: number; replied: number; bounced: number; pages: number; complete: boolean; skipped?: string };

/** The streams whose outcomes are read, and the mailbox each one is read from. */
export type OutcomeTrack = "client" | "network";
export const NOT_CONNECTED: Record<OutcomeTrack, string> = {
  client: "the HQ outreach mailbox is not connected (OUTREACH_GMAIL_*)",
  network: "the network mailbox is not connected (NETWORK_GMAIL_*)",
};

/**
 * Pages through one stream's mailbox (last 90 days) until the deadline or `maxPages`, then writes what changed on that
 * stream's accepted drafts only. The client stream (the default) reads the HQ mailbox; the network stream reads the account
 * behind its alias, searched for the alias address.
 */
export async function syncOutcomes(db: SupabaseClient, opts: { deadline: number; maxPages?: number; reader?: GmailReader; mailbox?: string; track?: OutcomeTrack }): Promise<OutcomeRun> {
  const track = opts.track ?? "client";
  const run: OutcomeRun = { scanned: 0, matched: 0, sent: 0, replied: 0, bounced: 0, pages: 0, complete: true };
  const cfg = opts.reader ? null : track === "network" ? networkMailboxConfig() : mailboxConfig();
  if (!opts.reader && !cfg) return { ...run, complete: false, skipped: NOT_CONNECTED[track] };
  // The stream's sending address, never the connected account: for clients that may be an inbox HQ mail is forwarded to,
  // and the network sends from an alias of the account it connects as.
  const mailbox = opts.mailbox ?? (track === "network" ? await trackAddress(db, "network") : await hqAddress(db));
  if (!mailbox) return { ...run, complete: false, skipped: "the network stream has no sending address (gtm_outreach_tracks)" };
  const reader = opts.reader ?? (await GmailReader.connect(cfg!));
  const drafts = (await readPages<OutcomeDraft>((from, to) => db.from("gtm_outreach_drafts")
    .select("id,subject,prospect,email_status,email_sent_at,email_sent_by,email_replied_at,email_bounced_at", { count: "exact" })
    // One stream's drafts: each mailbox only ever sees its own stream's mail (guests go from yet another mailbox).
    .eq("status", "accepted").eq("track", track).order("id").range(from, to), "outreach drafts"))
    // A draft with no subject is a LinkedIn note: it can never match an email thread, and must not match a subjectless one.
    .filter((d) => d.subject.trim() !== "");
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const patches = new Map<string, OutcomePatch>();
  let page = "";
  for (let i = 0; i < (opts.maxPages ?? 12); i++) {
    if (Date.now() > opts.deadline) { run.complete = false; break; }
    const r = await reader.list(drafts, mailbox, page);
    run.pages++; run.scanned += r.scanned;
    for (const c of r.conversations) {
      const d = byId.get(c.draftId);
      if (!d) continue;
      run.matched++;
      const p = outcomePatch(c, { ...d, ...(patches.get(d.id) ?? {}) } as OutcomeDraft, mailbox);
      if (Object.keys(p).length) patches.set(d.id, { ...(patches.get(d.id) ?? {}), ...p });
    }
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
    if (i === (opts.maxPages ?? 12) - 1) run.complete = false;
  }
  for (const [id, p] of patches) {
    // Guarded on the values being written, so a desk action between the read and the write is never overwritten.
    let q = db.from("gtm_outreach_drafts").update(p).eq("id", id);
    if (p.email_sent_at) q = q.is("email_sent_at", null);
    if (p.email_replied_at) q = q.or(`email_replied_at.is.null,email_replied_at.gt.${p.email_replied_at}`);
    if (p.email_bounced_at) q = q.is("email_bounced_at", null);
    must(await q, "save outreach outcome");
    if (p.email_sent_at) run.sent++;
    if (p.email_replied_at) run.replied++;
    if (p.email_bounced_at) run.bounced++;
  }
  return run;
}
