// A team member's mailbox, read with their consent: Gmail `gmail.metadata` scope only (Google refuses bodies to that
// scope), headers From, To, Cc, Date, Auto-Submitted, Precedence and X-Autoreply. The sync turns sent mail into counted
// events (lib/team/classify.ts) and never stores an address, a subject or anything about mail outside the CRM.
//
// First run: list SENT back to BACKFILL_SINCE, resumable across runs. After that: follow Gmail's history from the stored
// historyId. Every outreach thread is re-read for 30 days to catch replies and bounces, however late they come.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import type { MailMessage, MailThread } from "../outreach/mailbox";
import type { TwentyReader } from "../twenty";
import { classifySend, domainOf, FREEMAIL, recipients, threadOutcome, type CrmPerson } from "./classify";
import { addressHash, openToken } from "./crypto";
import type { TeamMember } from "./members";

export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.metadata"];
export const HEADERS = ["From", "To", "Cc", "Date", "Auto-Submitted", "Precedence", "X-Autoreply"];
export const BACKFILL_SINCE = "2026-10-01T00:00:00Z";
const REPLY_WINDOW_DAYS = 30;

export type GmailConfig = { clientId: string; clientSecret: string };
export function gmailConfig(env: Record<string, string | undefined> = process.env): GmailConfig | null {
  const clientId = env.TEAM_GMAIL_CLIENT_ID?.trim(), clientSecret = env.TEAM_GMAIL_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Domains that are never prospects: the team's own (TEAM_IGNORE_DOMAINS, comma separated) plus each mailbox's domain. */
export const ignoredDomains = (env: Record<string, string | undefined> = process.env) =>
  (env.TEAM_IGNORE_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export const mailboxAad = (member: string, address: string) => `${member}:${address.toLowerCase()}`;

export class ReconnectError extends Error {}

/* ------------------------------------------------------------------------------------------------ OAuth */

export function authUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint: string }) {
  const p = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: SCOPES.join(" "), state: o.state,
    code_challenge: o.challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", login_hint: o.loginHint,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Trades the code for tokens. The address comes from the id_token Google returns on this direct TLS call. */
export async function exchangeCode(cfg: GmailConfig, code: string, verifier: string, redirectUri: string, fetcher: typeof fetch = fetch) {
  assertLiveProvidersAllowed();
  const res = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = await res.json().catch(() => ({})) as { refresh_token?: string; access_token?: string; id_token?: string; scope?: string };
  if (!res.ok || !body.refresh_token || !body.id_token) throw new Error("Google did not grant offline access. Try connecting again.");
  const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
  if (!claims.email || claims.email_verified === false) throw new Error("Google did not confirm the mailbox address.");
  const scopes = (body.scope ?? "").split(" ");
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.metadata")) throw new Error("The read-only metadata permission was not granted.");
  return { refreshToken: body.refresh_token, accessToken: body.access_token ?? null, email: claims.email.toLowerCase() };
}

export async function revokeToken(token: string, fetcher: typeof fetch = fetch) {
  assertLiveProvidersAllowed();
  await providerFetch(fetcher)("https://oauth2.googleapis.com/revoke", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function accessToken(cfg: GmailConfig, refreshToken: string, fetcher: typeof fetch) {
  const res = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (res.status === 400 || res.status === 401 || body.error === "invalid_grant") throw new ReconnectError("Google no longer accepts the stored connection. Reconnect the mailbox.");
  if (!res.ok || !body.access_token) throw new Error(`Google token refresh failed (${res.status})`);
  return body.access_token;
}

/* ------------------------------------------------------------------------------------------------ Gmail */

export class TeamGmail {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async get<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await providerFetch(this.fetcher)(`https://gmail.googleapis.com/gmail/v1/users/me/${path}${params.size ? `?${params}` : ""}`, {
        headers: { Authorization: `Bearer ${this.token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return res.json() as Promise<T>;
      if (res.status === 401) throw new ReconnectError("Google no longer accepts the stored connection. Reconnect the mailbox.");
      if (res.status === 404) throw Object.assign(new Error("Gmail: not found"), { status: 404 });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new Error(`Gmail ${res.status}`);
    }
  }
  profile() { return this.get<{ emailAddress: string; historyId: string }>("profile"); }
  message(id: string) {
    const p = new URLSearchParams({ format: "metadata" });
    for (const h of HEADERS) p.append("metadataHeaders", h);
    return this.get<MailMessage & { threadId: string }>(`messages/${encodeURIComponent(id)}`, p);
  }
  thread(id: string) {
    const p = new URLSearchParams({ format: "metadata" });
    for (const h of HEADERS) p.append("metadataHeaders", h);
    return this.get<MailThread>(`threads/${encodeURIComponent(id)}`, p);
  }
  listSent(pageToken?: string) {
    const p = new URLSearchParams({ labelIds: "SENT", maxResults: "100" });
    if (pageToken) p.set("pageToken", pageToken);
    return this.get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>("messages", p);
  }
  history(startHistoryId: string, pageToken?: string) {
    const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", labelId: "SENT", maxResults: "500" });
    if (pageToken) p.set("pageToken", pageToken);
    return this.get<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string }>("history", p);
  }
}

/* ------------------------------------------------------------------------------------------------ CRM lookups */

/** Twenty people by exact primary email, 50 addresses a request. Only people Twenty already has come back. */
export async function lookupPeople(reader: TwentyReader, emails: string[]): Promise<Map<string, CrmPerson>> {
  const out = new Map<string, CrmPerson>();
  const list = [...new Set(emails)];
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const rows = await reader.all<CrmPerson & { emails: { primaryEmail: string | null } | null }>("people", "id gtmRelationship prospectReviewState gtmQueue emails { primaryEmail }",
      { emails: { primaryEmail: { in: batch } } }, "PersonFilterInput", 100, 500);
    for (const r of rows) {
      const e = r.emails?.primaryEmail?.toLowerCase();
      if (e && batch.includes(e)) out.set(e, { id: r.id, gtmRelationship: r.gtmRelationship, prospectReviewState: r.prospectReviewState, gtmQueue: r.gtmQueue });
    }
  }
  return out;
}

const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try { return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
};

/** Twenty companies whose website is on the domain, 10 domains a request. Freemail domains are never looked up. */
export async function lookupCompanies(reader: TwentyReader, domains: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = [...new Set(domains)].filter((d) => !FREEMAIL.has(d) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  for (let i = 0; i < list.length; i += 10) {
    const batch = list.slice(i, i + 10);
    const rows = await reader.all<{ id: string; domainName: { primaryLinkUrl: string | null } | null }>("companies", "id domainName { primaryLinkUrl }",
      { or: batch.map((d) => ({ domainName: { primaryLinkUrl: { ilike: `%${d}%` } } })) }, "CompanyFilterInput", 100, 500);
    for (const r of rows) {
      const host = hostOf(r.domainName?.primaryLinkUrl);
      if (host && batch.includes(host)) out.set(host, [...(out.get(host) ?? []), r.id]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ sync */

export type MailboxRow = { member: string; address: string; token_ciphertext: string; history_id: string | null; backfill_done: boolean; last_sync_at: string | null };
export type SyncResult = { address: string; sends: number; outreach: number; other_crm: number; replies: number; bounces: number; threads_checked: number; complete: boolean; error?: string };
type Event = { member: string; gmail_message_id: string; thread_id: string; kind: "outreach" | "other_crm" | "reply" | "bounce"; at: string; person_ids?: string[]; company_ids?: string[]; recipient_hashes?: string[] };

const backfillKey = (member: string) => `team.backfill.${member.toLowerCase()}`;

export async function syncMailbox(db: SupabaseClient, member: TeamMember, row: MailboxRow, reader: TwentyReader, opts: {
  cfg: GmailConfig; fetcher?: typeof fetch; now?: Date; deadline?: number; maxMessages?: number; maxThreads?: number;
}): Promise<SyncResult> {
  const now = opts.now ?? new Date(), fetcher = opts.fetcher ?? fetch;
  const result: SyncResult = { address: row.address, sends: 0, outreach: 0, other_crm: 0, replies: 0, bounces: 0, threads_checked: 0, complete: true };
  const late = () => !!opts.deadline && Date.now() > opts.deadline;
  try {
    const refresh = openToken(row.token_ciphertext, mailboxAad(row.member, row.address));
    const gmail = new TeamGmail(await accessToken(opts.cfg, refresh, fetcher), fetcher);
    const profile = await gmail.profile();
    if (profile.emailAddress.toLowerCase() !== row.address) throw new ReconnectError("The connected Google account is not the configured mailbox. Reconnect it.");

    // 1. Which sent messages are new.
    const ids: string[] = [];
    let historyId = row.history_id, backfillDone = row.backfill_done;
    const max = opts.maxMessages ?? 400;
    if (!backfillDone || !historyId) {
      const { data } = await db.from("gtm_sync_state").select("value").eq("key", backfillKey(row.member)).maybeSingle();
      const state = (data?.value as { pageToken?: string; historyId?: string; since?: string } | undefined) ?? {};
      const since = Date.parse(state.since ?? BACKFILL_SINCE);
      let pageToken = state.pageToken, startHistory = state.historyId ?? profile.historyId, reachedEnd = false;
      while (ids.length < max && !late()) {
        const page = await gmail.listSent(pageToken);
        const metas = [];
        for (const m of page.messages ?? []) metas.push(m.id);
        ids.push(...metas);
        // Gmail lists newest first: stop paging once a page reaches past the backfill start (the classifier drops older ones).
        const last = metas.at(-1);
        const lastAt = last ? Number((await gmail.message(last)).internalDate ?? 0) : 0;
        if (!page.nextPageToken || (last && lastAt < since)) { reachedEnd = true; break; }
        pageToken = page.nextPageToken;
      }
      if (reachedEnd) {
        historyId = startHistory; backfillDone = true;
        await db.from("gtm_sync_state").delete().eq("key", backfillKey(row.member));
      } else {
        result.complete = false;
        must(await db.from("gtm_sync_state").upsert({ key: backfillKey(row.member), value: { pageToken, historyId: startHistory, since: state.since ?? BACKFILL_SINCE }, updated_at: now.toISOString() }, { onConflict: "key" }), "save backfill cursor");
      }
    } else {
      let pageToken: string | undefined;
      try {
        do {
          const page = await gmail.history(historyId, pageToken);
          for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message.labelIds?.includes("SENT")) ids.push(a.message.id);
          if (page.historyId) historyId = page.historyId;
          pageToken = page.nextPageToken;
        } while (pageToken && ids.length < max && !late());
        if (pageToken) result.complete = false;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
        // Gmail keeps about a week of history. Too old a cursor: list SENT again from a day before the last sync.
        const since = new Date(Date.parse(row.last_sync_at ?? BACKFILL_SINCE) - 86_400_000).toISOString();
        must(await db.from("gtm_sync_state").upsert({ key: backfillKey(row.member), value: { since, historyId: profile.historyId }, updated_at: now.toISOString() }, { onConflict: "key" }), "reset backfill");
        backfillDone = false; result.complete = false;
      }
    }

    // 2. Classify each new send against the CRM.
    const since = Date.parse(BACKFILL_SINCE);
    const sends: { id: string; threadId: string; at: number; rcpts: string[] }[] = [];
    for (const id of [...new Set(ids)]) {
      if (late()) { result.complete = false; break; }
      const m = await gmail.message(id);
      const at = Number(m.internalDate ?? 0);
      if (!m.labelIds?.includes("SENT") || at < since) continue;
      sends.push({ id: m.id, threadId: m.threadId, at, rcpts: recipients(m, member.mailboxes.length ? member.mailboxes : [row.address], ignoredDomains()) });
    }
    result.sends = sends.length;
    const allRcpts = sends.flatMap((s) => s.rcpts);
    const people = await lookupPeople(reader, allRcpts);
    const companies = await lookupCompanies(reader, allRcpts.filter((a) => !people.has(a)).map(domainOf));
    const events: Event[] = [];
    for (const s of sends) {
      const c = classifySend(s.rcpts, people, companies);
      if (!c) continue;
      const base = { member: row.member, gmail_message_id: s.id, thread_id: s.threadId, at: new Date(s.at).toISOString() };
      if (c.kind === "outreach") { events.push({ ...base, kind: "outreach", person_ids: c.personIds, recipient_hashes: c.recipients.map((a) => addressHash(a)) }); result.outreach++; }
      else { events.push({ ...base, kind: "other_crm", company_ids: c.companyIds }); result.other_crm++; }
    }
    if (events.length) must(await db.from("gtm_team_mail_events").upsert(events, { onConflict: "member,gmail_message_id", ignoreDuplicates: true }), "save mail events");

    // 3. Replies and bounces: re-read each outreach thread of the last 30 days that has neither yet.
    const windowStart = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000).toISOString();
    const recent = must(await db.from("gtm_team_mail_events").select("thread_id,kind,at,recipient_hashes").eq("member", row.member).gte("at", windowStart), "recent mail events") as
      { thread_id: string; kind: string; at: string; recipient_hashes: string[] }[];
    const threads = new Map<string, { first: number; hashes: Set<string>; done: boolean }>();
    for (const e of recent) {
      const t = threads.get(e.thread_id) ?? { first: Infinity, hashes: new Set<string>(), done: false };
      if (e.kind === "outreach") { t.first = Math.min(t.first, Date.parse(e.at)); for (const h of e.recipient_hashes) t.hashes.add(h); }
      if (e.kind === "reply" || e.kind === "bounce") t.done = true;
      threads.set(e.thread_id, t);
    }
    const replyEvents: Event[] = [];
    for (const [threadId, t] of threads) {
      if (t.done || t.first === Infinity) continue;
      if (result.threads_checked >= (opts.maxThreads ?? 150) || late()) { result.complete = false; break; }
      result.threads_checked++;
      let thread: MailThread;
      try { thread = await gmail.thread(threadId); } catch (e) { if ((e as { status?: number }).status === 404) continue; throw e; }
      const out = threadOutcome(thread.messages ?? [], t.first, member.mailboxes.length ? member.mailboxes : [row.address], (a) => t.hashes.has(addressHash(a)));
      for (const r of out.replies) { replyEvents.push({ member: row.member, gmail_message_id: r.id, thread_id: threadId, kind: "reply", at: new Date(r.at).toISOString() }); result.replies++; }
      if (out.bounce && !out.replies.length) {
        replyEvents.push({ member: row.member, gmail_message_id: out.bounce.id, thread_id: threadId, kind: "bounce", at: new Date(out.bounce.at).toISOString() });
        result.bounces++;
      }
    }
    if (replyEvents.length) must(await db.from("gtm_team_mail_events").upsert(replyEvents, { onConflict: "member,gmail_message_id", ignoreDuplicates: true }), "save replies");

    must(await db.from("gtm_team_mailboxes").update({ history_id: historyId, backfill_done: backfillDone, last_sync_at: now.toISOString(), last_error: null })
      .eq("member", row.member).eq("address", row.address), "save mailbox cursor");
  } catch (e) {
    result.error = (e as Error).message.slice(0, 300);
    result.complete = false;
    await db.from("gtm_team_mailboxes").update({ last_error: result.error, last_sync_at: now.toISOString() }).eq("member", row.member).eq("address", row.address);
  }
  return result;
}
