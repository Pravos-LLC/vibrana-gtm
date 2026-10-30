import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Server-only Gmail reader. This module is never imported by a client component.
// No send, label mutation, read receipts, or durable token/message storage.
import { bounded } from "../db-read";

export type MailHeader = { name: string; value: string };
export type MailPart = { mimeType?: string; body?: { data?: string }; parts?: MailPart[]; headers?: MailHeader[] };
export type MailMessage = { id: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: MailPart };
export type MailThread = { id: string; messages?: MailMessage[] };
export type OutreachMail = { id: string; subject: string; email_sent_at?: string | null; prospect: { email?: string | null; company?: string | null } };
export type MailStatus = "reply" | "automated" | "delivery-failure" | "awaiting-reply";
export type Conversation = { id: string; draftId: string; company: string; subject: string; status: MailStatus; unread: boolean; lastAt: string; snippet: string; forwarded?: boolean; messageIds?: string[] };
export type MailboxConfig = { email: string; clientId: string; clientSecret: string; refreshToken: string };
export const MAILBOX = "user-045d73df3c9a@example.com";
export const PAGE_SIZE = 25;
export const validThreadId = (id: string) => /^[a-f0-9]{1,64}$/i.test(id);
export const validPageToken = (token: string) => token.length <= 2048 && /^[a-zA-Z0-9_+=/.-]*$/.test(token);
export const header = (message: MailMessage, name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
// Deliberately conservative addr-spec parsing: display names/comments never establish identity.
// Quoted local-parts and malformed/group addresses are ignored rather than guessed.
function addresses(value: string): string[] {
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

export function mailboxConfig(env: Record<string, string | undefined> = process.env): MailboxConfig | null {
  if (process.env.DEMO_MODE === "1") return null;
  assertLiveProvidersAllowed();
  const clientId = env.OUTREACH_GMAIL_CLIENT_ID, clientSecret = env.OUTREACH_GMAIL_CLIENT_SECRET, refreshToken = env.OUTREACH_GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const email = env.OUTREACH_GMAIL_ACCOUNT?.trim() || MAILBOX;
  if (addresses(email).length !== 1 || addresses(email)[0] !== email.toLowerCase()) return null;
  return { email, clientId, clientSecret, refreshToken };
}

const automated = (m: MailMessage) => (!!header(m, "Auto-Submitted") && header(m, "Auto-Submitted").toLowerCase() !== "no") || /auto.?reply|out of (?:the )?office/i.test(header(m, "Subject"));

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
    lastAt: new Date(Number(latest.internalDate)).toISOString(), snippet: latest.snippet ?? "", forwarded: true, messageIds: replies.map((m) => m.id) };
}

/** Prefer an actual sent thread; forwarded replies use the more conservative sent-record match above. */
export function matchConversation(thread: MailThread, drafts: OutreachMail[], mailbox: string): Conversation | null {
  const messages = [...(thread.messages ?? [])].filter((m) => !m.labelIds?.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)))
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  const outgoing = messages.find((m) => m.labelIds?.includes("SENT") && addresses(header(m, "From")).includes(mailbox.toLowerCase())
    && drafts.some((d) => d.prospect.email && addresses(header(m, "To")).includes(d.prospect.email.toLowerCase()) && subject(header(m, "Subject")) === subject(d.subject)));
  if (!outgoing) return matchForwarded(thread, messages, drafts, mailbox);
  const draft = drafts.find((d) => d.prospect.email && addresses(header(outgoing, "To")).includes(d.prospect.email.toLowerCase()) && subject(header(outgoing, "Subject")) === subject(d.subject))!;
  const incoming = messages.filter((m) => Number(m.internalDate ?? 0) > Number(outgoing.internalDate ?? 0) && !m.labelIds?.includes("SENT") && !addresses(header(m, "From")).includes(mailbox.toLowerCase()));
  const failed = incoming.find((m) => /mailer-daemon|postmaster/i.test(header(m, "From")) || m.payload?.mimeType === "multipart/report");
  const replies = incoming.filter((m) => !automated(m) && addresses(header(m, "From")).includes(draft.prospect.email!.toLowerCase()));
  const latest = replies.at(-1) ?? failed ?? incoming.at(-1) ?? messages.at(-1)!;
  const timestamp = Number(latest.internalDate);
  return { id: thread.id, draftId: draft.id, company: draft.prospect.company ?? "", subject: header(outgoing, "Subject"),
    status: replies.length ? "reply" : failed ? "delivery-failure" : incoming.some(automated) ? "automated" : "awaiting-reply",
    unread: incoming.some((m) => m.labelIds?.includes("UNREAD")), lastAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "", snippet: latest.snippet ?? "" };
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
  static async connect(config: MailboxConfig, fetcher: typeof fetch = fetch): Promise<GmailReader> {
    const response = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: "refresh_token" }),
      cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("The HQ inbox connection needs to be renewed.");
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error("Gmail did not return an access token.");
    const reader = new GmailReader(body.access_token, fetcher);
    const profile = await reader.get<{ emailAddress: string }>("profile");
    if (profile.emailAddress.toLowerCase() !== config.email.toLowerCase()) throw new Error("The connected Gmail account is not the configured inbox.");
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
