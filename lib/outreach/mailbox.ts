import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Server-only Gmail reader. This module is never imported by a client component.
// No send, label mutation, read receipts, or durable token/message storage.
import { bounded } from "../db-read";

export type MailHeader = { name: string; value: string };
export type MailPart = { mimeType?: string; body?: { data?: string }; parts?: MailPart[]; headers?: MailHeader[] };
export type MailMessage = { id: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: MailPart };
export type MailThread = { id: string; messages?: MailMessage[] };
/**
 * A draft a thread can belong to. With `created_at`, only a message sent at or after the draft was created can be its send:
 * an older thread with the same person and subject (a network contact's earlier conversation) is never this draft's.
 */
export type OutreachMail = { id: string; subject: string; email_sent_at?: string | null; created_at?: string | null; prospect: { email?: string | null; company?: string | null } };
export type MailStatus = "reply" | "automated" | "delivery-failure" | "awaiting-reply";
export type Conversation = { id: string; draftId: string; company: string; subject: string; status: MailStatus; unread: boolean; lastAt: string; snippet: string; forwarded?: boolean; messageIds?: string[];
  /** When the outreach email left the mailbox (sent threads only), the first reply and the failure notice: the pipeline cron stores these. */
  sentAt?: string; replyAt?: string; failedAt?: string };
export type MailboxConfig = { email: string; clientId: string; clientSecret: string; refreshToken: string };
export const MAILBOX = loadRuntimeConfig().mail.mailbox;
export const PAGE_SIZE = 25;

/**
 * The address the client-track desk emails go out from (gtm_outreach_tracks.from_address), the one replies are matched
 * against. The connected Gmail account may be a different inbox that HQ mail is forwarded to. Without a usable track row
 * the desk's configured client sender is used, then the configured inbox MAILBOX.
 */
export async function hqAddress(db: { from: (t: string) => any }): Promise<string> {
  return (await trackAddress(db, "client")) ?? MAILBOX;
}

const oneAddress = (v: string | null | undefined) => {
  const a = v?.trim().toLowerCase();
  return a && addresses(a).length === 1 && addresses(a)[0] === a ? a : null;
};

/**
 * The address one desk stream sends from (gtm_outreach_tracks.from_address), else the stream's configured sender; null when
 * neither is a single address. A desk email's replies are matched against it. The network stream's address is a send-as alias,
 * so its sent mail and replies sit in the mailbox of the Google account behind it (networkMailboxConfig), not under its own name.
 */
export async function trackAddress(db: { from: (t: string) => any }, track: "client" | "network"): Promise<string | null> {
  const { data, error } = await db.from("gtm_outreach_tracks").select("from_address").eq("track", track).maybeSingle();
  // A failed read must not quietly search the wrong mailbox and report "no replies": it throws, and the caller says so.
  if (error) throw new Error(`outreach tracks: ${error.message}`);
  return oneAddress((data as { from_address?: string | null } | null)?.from_address) ?? oneAddress(loadRuntimeConfig().mail.trackFrom?.[track]);
}
export const validThreadId = (id: string) => /^[a-f0-9]{1,64}$/i.test(id);
export const validPageToken = (token: string) => token.length <= 2048 && /^[a-zA-Z0-9_+=/.-]*$/.test(token);
export const header = (message: MailMessage, name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
// Deliberately conservative addr-spec parsing: display names/comments never establish identity.
// Quoted local-parts and malformed/group addresses are ignored rather than guessed.
export function addresses(value: string): string[] {
  const unquoted = value.replace(/"(?:\\.|[^"\\])*"/g, "");
  let bare = "", depth = 0;
  for (const char of unquoted) {
    if (char === "(") { depth++; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); continue; }
    if (!depth) bare += char;
  }
  return bare.split(",").flatMap((entry) => {
    const angle = entry.match(/^[^<>]*<([^<>]+)>\s*$/);
    const address = (angle ? angle[1] : entry).trim();
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address) ? [address.toLowerCase()] : [];
  });
}
const subject = (value: string) => value.replace(/^(?:(?:re|fw|fwd):\s*)+/gi, "").trim().toLowerCase();

/** The HQ outreach mailbox the client stream's outcomes and /outreach/inbox read (OUTREACH_GMAIL_*). */
export function mailboxConfig(env: Record<string, string | undefined> = process.env): MailboxConfig | null {
  return gmailEnv(env, "OUTREACH_GMAIL", MAILBOX);
}

/**
 * The mailbox the network stream's outcomes read (VIB-522): the Google account whose send-as alias the network desk sends from.
 * NETWORK_GMAIL_CLIENT_ID, NETWORK_GMAIL_CLIENT_SECRET and NETWORK_GMAIL_REFRESH_TOKEN (an OAuth client and a refresh token
 * granted gmail.readonly by that account; a thread search needs more than gmail.metadata), and NETWORK_GMAIL_ACCOUNT, that
 * account's primary address, which the connection is checked against. Null until all four are set.
 */
export function networkMailboxConfig(env: Record<string, string | undefined> = process.env): MailboxConfig | null {
  return gmailEnv(env, "NETWORK_GMAIL", null);
}

function gmailEnv(env: Record<string, string | undefined>, prefix: "OUTREACH_GMAIL" | "NETWORK_GMAIL", fallbackAccount: string | null): MailboxConfig | null {
  if (process.env.DEMO_MODE === "1") return null;
  assertLiveProvidersAllowed();
  const clientId = env[`${prefix}_CLIENT_ID`], clientSecret = env[`${prefix}_CLIENT_SECRET`], refreshToken = env[`${prefix}_REFRESH_TOKEN`];
  if (!clientId || !clientSecret || !refreshToken) return null;
  const email = env[`${prefix}_ACCOUNT`]?.trim() || fallbackAccount;
  if (!email || addresses(email).length !== 1 || addresses(email)[0] !== email.toLowerCase()) return null;
  return { email, clientId, clientSecret, refreshToken };
}

export const automated = (m: MailMessage) => (!!header(m, "Auto-Submitted") && header(m, "Auto-Submitted").toLowerCase() !== "no") || /auto.?reply|out of (?:the )?office/i.test(header(m, "Subject"));

/** Forwarding has no sent copy: require an unambiguous sent record, original recipient, sender, subject and later receipt. */
function matchForwarded(thread: MailThread, messages: MailMessage[], drafts: OutreachMail[], mailbox: string): Conversation | null {
  const matches = drafts.flatMap((draft) => {
    const sentAt = Date.parse(draft.email_sent_at ?? "");
    if (!Number.isFinite(sentAt) || !draft.prospect.email || !subject(draft.subject)) return [];
    const replies = messages.filter((m) => !m.labelIds?.includes("SENT") && Number(m.internalDate) > sentAt && Number(m.internalDate) <= 8.64e15
      && addresses(header(m, "From")).includes(draft.prospect.email!.toLowerCase())
      && [...addresses(header(m, "To")), ...addresses(header(m, "Cc"))].includes(mailbox.toLowerCase())
      && subject(header(m, "Subject")) === subject(draft.subject));
    return replies.length ? [{ draft, replies }] : [];
  });
  if (matches.length !== 1) return null;
  const { draft, replies } = matches[0];
  const latest = replies.filter((m) => !automated(m)).at(-1) ?? replies.at(-1)!;
  return { id: thread.id, draftId: draft.id, company: draft.prospect.company ?? "", subject: draft.subject,
    status: replies.some((m) => !automated(m)) ? "reply" : "automated", unread: replies.some((m) => m.labelIds?.includes("UNREAD")),
    lastAt: new Date(Number(latest.internalDate)).toISOString(), snippet: latest.snippet ?? "", forwarded: true, messageIds: replies.map((m) => m.id),
    replyAt: (() => { const t = Number(replies.find((m) => !automated(m))?.internalDate); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined; })() };
}

/** Prefer an actual sent thread; forwarded replies use the more conservative sent-record match above. */
export function matchConversation(thread: MailThread, drafts: OutreachMail[], mailbox: string): Conversation | null {
  const messages = [...(thread.messages ?? [])].filter((m) => !m.labelIds?.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)))
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  // The draft's send is the earliest matching SENT message at or after the draft was created (when that is known).
  const sentFor = (m: MailMessage, d: OutreachMail) => !!d.prospect.email && addresses(header(m, "To")).includes(d.prospect.email.toLowerCase())
    && subject(header(m, "Subject")) === subject(d.subject) && (!d.created_at || Number(m.internalDate ?? 0) >= Date.parse(d.created_at));
  const outgoing = messages.find((m) => m.labelIds?.includes("SENT") && addresses(header(m, "From")).includes(mailbox.toLowerCase()) && drafts.some((d) => sentFor(m, d)));
  if (!outgoing) return matchForwarded(thread, messages, drafts, mailbox);
  const draft = drafts.find((d) => sentFor(outgoing, d))!;
  const incoming = messages.filter((m) => Number(m.internalDate ?? 0) > Number(outgoing.internalDate ?? 0) && !m.labelIds?.includes("SENT") && !addresses(header(m, "From")).includes(mailbox.toLowerCase()));
  const failed = incoming.find((m) => /mailer-daemon|postmaster/i.test(header(m, "From")) || m.payload?.mimeType === "multipart/report");
  const replies = incoming.filter((m) => !automated(m) && addresses(header(m, "From")).includes(draft.prospect.email!.toLowerCase()));
  const latest = replies.at(-1) ?? failed ?? incoming.at(-1) ?? messages.at(-1)!;
  const timestamp = Number(latest.internalDate);
  const iso = (m: MailMessage | undefined) => { const t = Number(m?.internalDate); return m && Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined; };
  return { id: thread.id, draftId: draft.id, company: draft.prospect.company ?? "", subject: header(outgoing, "Subject"),
    status: replies.length ? "reply" : failed ? "delivery-failure" : incoming.some(automated) ? "automated" : "awaiting-reply",
    unread: incoming.some((m) => m.labelIds?.includes("UNREAD")), lastAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "", snippet: latest.snippet ?? "",
    sentAt: iso(outgoing), replyAt: iso(replies[0]), failedAt: replies.length ? undefined : iso(failed) };
}

/** Plain text only. HTML, remote images, attachments and their tracking pixels are never rendered or fetched. */
export function plainBody(part: MailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, 20000);
  return (part.parts ?? []).map(plainBody).filter(Boolean).join("\n").slice(0, 20000);
}

export class GmailReader {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async get<T>(path: string): Promise<T> {
    const response = await providerFetch(this.fetcher)(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`The inbox could not be read (Gmail ${response.status}). Reconnect the mailbox or retry.`);
    return response.json() as Promise<T>;
  }
  /** `label` names the mailbox in the errors John sees ("HQ inbox", "network mailbox"), so a renewal goes to the right credential. */
  static async connect(config: MailboxConfig, fetcher: typeof fetch = fetch, label = "HQ inbox"): Promise<GmailReader> {
    const response = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: "refresh_token" }),
      cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`The ${label} connection needs to be renewed.`);
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error("Gmail did not return an access token.");
    const reader = new GmailReader(body.access_token, fetcher);
    const profile = await reader.get<{ emailAddress: string }>("profile");
    if (profile.emailAddress.toLowerCase() !== config.email.toLowerCase()) throw new Error(label === "HQ inbox" ? "The connected Gmail account is not the configured inbox." : `The connected Gmail account is not the configured ${label}.`);
    return reader;
  }
  async list(drafts: OutreachMail[], mailbox: string, pageToken = "") {
    if (!validPageToken(pageToken)) throw new Error("Invalid inbox page. Return to the first page.");
    const params = new URLSearchParams({ q: `{from:${mailbox} to:${mailbox} cc:${mailbox}} newer_than:90d -in:trash -in:spam`, maxResults: String(PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await this.get<{ threads?: { id: string }[]; nextPageToken?: string }>(`threads?${params}`);
    const threads = await bounded(page.threads ?? [], 4, (t) => this.thread(t.id, false));
    const conversations = threads.map((t) => matchConversation(t, drafts, mailbox)).filter((c): c is Conversation => !!c)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return { conversations, nextPageToken: page.nextPageToken ?? "", scanned: threads.length };
  }
  async thread(id: string, full = true): Promise<MailThread> {
    if (!validThreadId(id)) throw new Error("Invalid conversation.");
    const params = new URLSearchParams({ format: full ? "full" : "metadata" });
    if (!full) for (const name of ["From", "To", "Cc", "Subject", "Auto-Submitted"]) params.append("metadataHeaders", name);
    return this.get<MailThread>(`threads/${id}?${params}`);
  }
}
