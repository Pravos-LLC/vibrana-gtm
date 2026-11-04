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
import { createHash } from "node:crypto";
import { TwentyError, type TwentyReader } from "../twenty";
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
  constructor(private token: string, private fetcher: typeof fetch = fetch, private deadline?: number) {}
  async get<T>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await providerFetch(this.fetcher)(`https://gmail.googleapis.com/gmail/v1/users/me/${path}${params.size ? `?${params}` : ""}`, {
        headers: { Authorization: `Bearer ${this.token}` }, cache: "no-store",
        signal: AbortSignal.timeout(this.deadline != null ? Math.max(1_000, Math.min(15_000, this.deadline - Date.now())) : 15_000),
      });
      if (res.ok) return res.json() as Promise<T>;
      if (res.status === 401) throw new ReconnectError("Google no longer accepts the stored connection. Reconnect the mailbox.");
      if (res.status === 404) throw Object.assign(new Error("Gmail: not found"), { status: 404 });
      const late = this.deadline != null && Date.now() + 1000 * 2 ** attempt > this.deadline;
      if ((res.status === 429 || res.status >= 500) && attempt < 3 && !late) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
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

/** Twenty people by exact primary email (any case), 25 addresses a request. Only people Twenty already has come back. */
export async function lookupPeople(reader: TwentyReader, emails: string[]): Promise<Map<string, CrmPerson>> {
  const out = new Map<string, CrmPerson>();
  const list = [...new Set(emails)];
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25);
    // ilike, not in: Twenty keeps emails as typed, and `in` is case-sensitive. ilike's `_` and `%` can only widen the
    // match, and every row is re-checked for the exact lowercase address below.
    const rows = await reader.all<CrmPerson & { emails: { primaryEmail: string | null } | null }>("people", "id gtmRelationship prospectReviewState gtmQueue emails { primaryEmail }",
      { or: batch.map((e) => ({ emails: { primaryEmail: { ilike: e } } })) }, "PersonFilterInput", 100, 500);
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
export type SyncResult = { address: string; sends: number; outreach: number; other_crm: number; replies: number; bounces: number; threads_checked: number; pending: number; complete: boolean; error?: string };
type Event = { member: string; gmail_message_id: string; thread_id: string; kind: "outreach" | "other_crm" | "reply" | "bounce"; at: string; person_ids?: string[]; company_ids?: string[]; recipient_hashes?: string[] };

/**
 * Per-mailbox sync state (gtm_sync_state). A cursor only ever moves past work that is finished: ids listed but not yet
 * classified ride along in `pending`, so a run that stops at its deadline, or whose CRM lookup fails, loses nothing.
 * `okAt` is the last fully successful run, the watermark a history reset reads back from (adversarial review of #23).
 */
export type SyncState = { pageToken?: string; startHistory?: string; since?: string; pending?: string[]; okAt?: string };

export const stateKey = (member: string, address: string) =>
  `team.mailbox.${member.toLowerCase()}.h${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 16)}`;

/** Fixed, address-free messages for last_error, which owners read. Raw provider errors never reach it. */
export class SyncStepError extends Error {}
const failure = (e: unknown): string => {
  if (e instanceof ReconnectError || e instanceof SyncStepError) return e.message;
  if (e instanceof TwentyError) return "The CRM rejected a lookup; the sync retries next hour.";
  const status = (e as { status?: number }).status;
  if (status) return `Gmail answered ${status}; the sync retries next hour.`;
  return "The sync stopped early; it resumes where it left off next hour.";
};

/** Every row of a select, 1000 at a time (PostgREST caps a response at max_rows). */
export async function selectAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string, max = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const rows = must(await page(from, from + 999), what) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function syncMailbox(db: SupabaseClient, member: TeamMember, row: MailboxRow, reader: TwentyReader, opts: {
  cfg: GmailConfig; fetcher?: typeof fetch; now?: Date; deadline?: number; maxMessages?: number; maxThreads?: number; clock?: () => number; chunk?: number; chunkReserveMs?: number;
}): Promise<SyncResult> {
  const now = opts.now ?? new Date(), fetcher = opts.fetcher ?? fetch, clock = opts.clock ?? Date.now;
  const result: SyncResult = { address: row.address, sends: 0, outreach: 0, other_crm: 0, replies: 0, bounces: 0, threads_checked: 0, pending: 0, complete: true };
  const late = () => opts.deadline != null && clock() > opts.deadline;
  const key = stateKey(row.member, row.address);
  const saveState = async (state: SyncState) =>
    must(await db.from("gtm_sync_state").upsert({ key, value: state, updated_at: now.toISOString() }, { onConflict: "key" }), "save mailbox sync state");
  try {
    const { data: stored, error: stateError } = await db.from("gtm_sync_state").select("value").eq("key", key).maybeSingle();
    if (stateError) throw new SyncStepError("The sync state could not be read; the sync retries next hour.");
    const state: SyncState = { ...((stored?.value as SyncState | undefined) ?? {}) };
    const refresh = openToken(row.token_ciphertext, mailboxAad(row.member, row.address));
    const gmail = new TeamGmail(await accessToken(opts.cfg, refresh, fetcher), fetcher, opts.deadline);
    const profile = await gmail.profile();
    if (profile.emailAddress.toLowerCase() !== row.address) throw new ReconnectError("The connected Google account is not the configured mailbox. Reconnect it.");

    // 1. Collect sent-message ids. Nothing is committed yet; the new cursor is only saved with the ids still to do.
    const collected: string[] = [];
    let historyId = row.history_id, backfillDone = row.backfill_done, listedAll = false;
    let nextPageToken = state.pageToken, startHistory = state.startHistory, since = state.since;
    const max = opts.maxMessages ?? 400;
    if (!backfillDone || !historyId) {
      since ??= BACKFILL_SINCE;
      startHistory ??= profile.historyId;
      const sinceMs = Date.parse(since);
      let reachedEnd = false;
      while ((state.pending?.length ?? 0) + collected.length < max && !late()) {
        const page = await gmail.listSent(nextPageToken);
        const ids = (page.messages ?? []).map((m) => m.id);
        collected.push(...ids);
        // Newest first: once a page's last message is older than the backfill start, the end is reached.
        let lastAt = 0;
        if (ids.length) { try { lastAt = Number((await gmail.message(ids.at(-1)!)).internalDate ?? 0); } catch (e) { if ((e as { status?: number }).status !== 404) throw e; } }
        nextPageToken = page.nextPageToken;
        if (!nextPageToken || (ids.length && lastAt && lastAt < sinceMs)) { reachedEnd = true; nextPageToken = undefined; break; }
      }
      if (reachedEnd) { backfillDone = true; listedAll = true; historyId = startHistory ?? profile.historyId; }
      else result.complete = false;
    } else {
      let pageToken: string | undefined, newest = historyId, finished = false;
      try {
        do {
          const page = await gmail.history(historyId, pageToken);
          for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message.labelIds?.includes("SENT")) collected.push(a.message.id);
          if (page.historyId) newest = page.historyId;
          pageToken = page.nextPageToken;
          finished = !pageToken;
        } while (pageToken && !late());
        // The history id only advances when every page was read; a partial read is re-read next run (events are unique).
        if (finished) { historyId = newest; listedAll = true; } else result.complete = false;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
        // Gmail keeps about a week of history. Too old a cursor: list SENT again from a day before the last fully
        // successful run (never from a failed run's time, which would skip what it failed to read).
        since = new Date(Date.parse(state.okAt ?? BACKFILL_SINCE) - 86_400_000).toISOString();
        startHistory = profile.historyId; nextPageToken = undefined; backfillDone = false; result.complete = false;
      }
    }

    // 2. Classify pending and new ids in chunks. Each chunk is fetched, looked up in the CRM, written, and only then
    //    taken off `pending`, so every run that gets one chunk through makes progress, and a chunk is not started
    //    when the time left could not finish it (review of #23, NS2).
    const queue = [...new Set([...(state.pending ?? []), ...collected])];
    const cutoff = Date.parse(BACKFILL_SINCE);
    const chunk = opts.chunk ?? 50, reserve = opts.chunkReserveMs ?? 30_000;
    let done = 0;
    // State and mailbox row move together: once the listing is done the state drops its listing cursor, so the row must
    // say backfill_done with the new history id in the same step, or a later failure would send the next run back to
    // Oct 1 (review of #23, NS3).
    const commit = async () => {
      result.pending = queue.length - done;
      await saveState({ pageToken: backfillDone ? undefined : nextPageToken, startHistory: backfillDone ? undefined : startHistory, since: backfillDone ? undefined : since,
        pending: queue.slice(done), okAt: state.okAt });
      must(await db.from("gtm_team_mailboxes").update({ history_id: backfillDone ? historyId : row.history_id, backfill_done: backfillDone })
        .eq("member", row.member).eq("address", row.address), "save mailbox cursor");
    };
    while (done < queue.length) {
      if (opts.deadline != null && clock() > opts.deadline - reserve) break;
      const ids = queue.slice(done, done + chunk);
      const sends: { id: string; threadId: string; at: number; rcpts: string[] }[] = [];
      for (const id of ids) {
        let m: MailMessage & { threadId: string };
        try { m = await gmail.message(id); } catch (e) { if ((e as { status?: number }).status === 404) continue; throw e; }
        const at = Number(m.internalDate ?? 0);
        if (!m.labelIds?.includes("SENT") || at < cutoff) continue;
        sends.push({ id: m.id, threadId: m.threadId, at, rcpts: recipients(m, member.mailboxes.length ? member.mailboxes : [row.address], ignoredDomains()) });
      }
      const allRcpts = sends.flatMap((x) => x.rcpts);
      const people = await lookupPeople(reader, allRcpts);
      const companies = await lookupCompanies(reader, allRcpts.filter((x) => !people.has(x)).map(domainOf));
      const events: Event[] = [];
      for (const x of sends) {
        const c = classifySend(x.rcpts, people, companies);
        if (!c) continue;
        const base = { member: row.member, gmail_message_id: x.id, thread_id: x.threadId, at: new Date(x.at).toISOString() };
        if (c.kind === "outreach") { events.push({ ...base, kind: "outreach", person_ids: c.personIds, recipient_hashes: c.recipients.map((r) => addressHash(r)) }); result.outreach++; }
        else { events.push({ ...base, kind: "other_crm", company_ids: c.companyIds }); result.other_crm++; }
      }
      if (events.length) must(await db.from("gtm_team_mail_events").upsert(events, { onConflict: "member,gmail_message_id", ignoreDuplicates: true }), "save mail events");
      result.sends += sends.length;
      done += ids.length;
      await commit();
    }
    // The listing cursor (page token, history id) is saved even when no chunk ran, with every id still pending.
    await commit();
    const remaining = queue.length - done;
    if (remaining) result.complete = false;
    // backfill_done follows the listing (saved by commit): pending ids are finished from `pending` in history mode, never
    // by re-listing (NS1).
    const caughtUp = backfillDone && listedAll && !remaining;

    // 3. Replies and bounces: re-read outreach threads of the last 30 days that have neither yet, newest first, rotating
    //    the start each hour so a long list is covered across runs rather than only ever its first slice.
    const windowStart = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000).toISOString();
    const recent = await selectAll<{ thread_id: string; kind: string; at: string; recipient_hashes: string[] }>((from, to) =>
      db.from("gtm_team_mail_events").select("thread_id,kind,at,recipient_hashes").eq("member", row.member).gte("at", windowStart).order("id").range(from, to), "recent mail events");
    const threads = new Map<string, { first: number; hashes: Set<string>; done: boolean }>();
    for (const e of recent) {
      const t = threads.get(e.thread_id) ?? { first: Infinity, hashes: new Set<string>(), done: false };
      if (e.kind === "outreach") { t.first = Math.min(t.first, Date.parse(e.at)); for (const h of e.recipient_hashes) t.hashes.add(h); }
      if (e.kind === "reply" || e.kind === "bounce") t.done = true;
      threads.set(e.thread_id, t);
    }
    const open = [...threads].filter(([, t]) => !t.done && t.first !== Infinity).sort(([, a], [, b]) => b.first - a.first);
    const cap = opts.maxThreads ?? 150;
    const start = open.length > cap ? (Math.floor(now.getTime() / 3_600_000) * cap) % open.length : 0;
    const replyEvents: Event[] = [];
    for (let k = 0; k < Math.min(cap, open.length); k++) {
      if (late()) { result.complete = false; break; }
      const [threadId, t] = open[(start + k) % open.length];
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
    if (open.length > cap) result.complete = false;
    if (replyEvents.length) must(await db.from("gtm_team_mail_events").upsert(replyEvents, { onConflict: "member,gmail_message_id", ignoreDuplicates: true }), "save replies");

    // Every sent message up to now was listed and classified: this run is the watermark a history reset reads back from.
    if (caughtUp) await saveState({ pending: [], okAt: now.toISOString() });
    must(await db.from("gtm_team_mailboxes").update({ last_sync_at: now.toISOString(), last_error: null }).eq("member", row.member).eq("address", row.address), "save mailbox status");
  } catch (e) {
    result.error = failure(e);
    result.complete = false;
    await db.from("gtm_team_mailboxes").update({ last_error: result.error, last_sync_at: now.toISOString() }).eq("member", row.member).eq("address", row.address);
  }
  return result;
}
