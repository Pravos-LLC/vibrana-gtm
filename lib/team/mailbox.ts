// A team member's mailbox, read with their consent. The sync turns sent mail into counted events and per-recipient attempts
// (lib/team/classify.ts, email contract v1 in Linear VIB-496) and never stores an address, a subject, a snippet or a body,
// nor anything about mail outside the CRM. Headers read: From, To, Cc, Bcc, Date, Message-ID, Auto-Submitted, Precedence,
// X-Autoreply.
//
// Scopes: a connection made before VIB-510 granted gmail.metadata, and keeps working for everything here. New connections
// ask for gmail.readonly once TEAM_GMAIL_READONLY=1 (the Google OAuth client must list that scope first); reply text is
// read only where the stored grant has it (canReadBodies), never because the code asks for more.
//
// First run: list SENT back to BACKFILL_SINCE, resumable across runs. After that: follow Gmail's history from the stored
// historyId, both new sends and new inbound mail. Outreach threads are re-read for 30 days, and any older outreach thread
// that receives mail is re-read too, so a reply or a failure after the first outcome, or after 30 days, is still seen.
// `gtm team replay` re-lists from a date to reconcile rows written by the older sync.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { DbError, must } from "../db";
import { header, type MailMessage, type MailThread } from "../outreach/mailbox";
import { createHash } from "node:crypto";
import { TwentyError, type TwentyReader } from "../twenty";
import { classifyMessage, domainOf, FREEMAIL, recipientsOf, threadOutcome, type AttemptClass, type CrmPerson, type PersonMatch } from "./classify";
import { addressHash, messageKey, openToken } from "./crypto";
import type { TeamMember } from "./members";
import { personEmails, RESTRICTIONS_FIELD } from "./restrictions";
import { parseDeliveryStatus, replyRule } from "../email/rules";
import { classifierEnabled, classifyReply, DECISION_VERSION as MODEL_DECISION_VERSION } from "../email/classifier";
import { autoMessage } from "./classify";

export const METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** What a new connection asks Google for. gmail.readonly only once the OAuth client is configured for it. */
export const requestedScopes = (env: Record<string, string | undefined> = process.env) =>
  ["openid", "email", env.TEAM_GMAIL_READONLY === "1" ? READONLY_SCOPE : METADATA_SCOPE];
/** The scopes of a metadata-only connection (the only kind made before VIB-510). */
export const SCOPES = requestedScopes({});
/** Reply text needs gmail.readonly on the stored grant; metadata-only grants keep every metadata measure. */
export const canReadBodies = (granted: string[] | null | undefined) => (granted ?? []).includes(READONLY_SCOPE);
export const HEADERS = ["From", "To", "Cc", "Bcc", "Date", "Message-ID", "Auto-Submitted", "Precedence", "X-Autoreply"];
export const BACKFILL_SINCE = "2026-10-01T00:00:00Z";
const REPLY_WINDOW_DAYS = 30;
const DAY = 86_400_000;
/** Calculation version written by this sync. Rows of version 1 (the first sync) are rewritten when the message is seen again. */
export const CALC_VERSION = 2;

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

export function authUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint: string; scopes?: string[] }) {
  const p = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: (o.scopes ?? requestedScopes()).join(" "), state: o.state,
    code_challenge: o.challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", login_hint: o.loginHint,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Trades the code for tokens. The address comes from the id_token Google returns on this direct TLS call; the granted
 *  Gmail scopes come from Google's answer, never from what was asked. */
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
  const grantedScopes = (body.scope ?? "").split(" ").filter((s) => s === METADATA_SCOPE || s === READONLY_SCOPE);
  if (!grantedScopes.length) throw new Error("The read-only Gmail permission was not granted.");
  return { refreshToken: body.refresh_token, accessToken: body.access_token ?? null, email: claims.email.toLowerCase(), grantedScopes };
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

type HistoryMessage = { id: string; threadId?: string; labelIds?: string[] };

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
  /** The whole message, only for a grant with gmail.readonly and only for a candidate reply or failure report. */
  full(id: string) { return this.get<MailMessage & { threadId: string }>(`messages/${encodeURIComponent(id)}`, new URLSearchParams({ format: "full" })); }
  attachment(messageId: string, attachmentId: string) {
    return this.get<{ data?: string }>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
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
  /** Every message added since the cursor: sent and received. Inbound mail finds replies in threads past the 30-day window. */
  history(startHistoryId: string, pageToken?: string) {
    const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
    if (pageToken) p.set("pageToken", pageToken);
    return this.get<{ history?: { messagesAdded?: { message: HistoryMessage }[] }[]; historyId?: string; nextPageToken?: string }>("history", p);
  }
}

/* ------------------------------------------------------------------------------------------------ CRM lookups */

const PERSON_FIELDS = "id gtmRelationship prospectReviewState gtmQueue gtmEligibility gtmMarketingConsent gtmPriority gtmOrigins prospectNotSendable revEmailVerification emails { primaryEmail additionalEmails }";
// gtmEmailRestrictions exists once the CRM's `setup` has created it (vibrana-crm VIB-509). Until then there is nothing to read,
// so a Twenty error naming the field drops it for this process instead of failing the sync.
let restrictionsReadable = true;
export const resetPersonFields = () => { restrictionsReadable = true; };

async function readPeople(reader: TwentyReader, filter: Record<string, unknown>) {
  type Row = CrmPerson & { emails: { primaryEmail: string | null; additionalEmails?: unknown } | null };
  if (restrictionsReadable) {
    try { return await reader.all<Row>("people", `${PERSON_FIELDS} ${RESTRICTIONS_FIELD}`, filter, "PersonFilterInput", 100, 500); } catch (e) {
      if (!(e instanceof TwentyError) || !e.message.includes(RESTRICTIONS_FIELD)) throw e;
      restrictionsReadable = false;
    }
  }
  return reader.all<Row>("people", PERSON_FIELDS, filter, "PersonFilterInput", 100, 500);
}

/**
 * Twenty people by exact address, primary or additional, 25 addresses a request. An address held by one person maps to
 * that person; one held by several is ambiguous and attributed to nobody. Only addresses Twenty has come back.
 */
export async function lookupPeople(reader: TwentyReader, emails: string[]): Promise<Map<string, PersonMatch>> {
  const owners = new Map<string, Map<string, CrmPerson>>();
  const list = [...new Set(emails.map((e) => e.toLowerCase()))];
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25), wanted = new Set(batch);
    // ilike on the primary address: Twenty keeps emails as typed, and `in` is case-sensitive. `_` and `%` can only widen the
    // match, and every row is re-checked for the exact lowercase address below. Additional addresses use `like`, the filter
    // the CRM's own tools use on that field.
    const rows = await readPeople(reader, { or: [...batch.map((e) => ({ emails: { primaryEmail: { ilike: e } } })), ...batch.map((e) => ({ emails: { additionalEmails: { like: `%${e}%` } } }))] });
    for (const r of rows) {
      for (const e of personEmails(r)) {
        if (!wanted.has(e)) continue;
        const m = owners.get(e) ?? new Map<string, CrmPerson>();
        m.set(r.id, r);
        owners.set(e, m);
      }
    }
  }
  return new Map([...owners].map(([e, m]) => [e, m.size === 1 ? { person: [...m.values()][0] } : { ambiguous: true as const }]));
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

/* ------------------------------------------------------------------------------------------------ episodes */

export type DeskDraft = { id: string; sentAt: number | null };
const h32 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/**
 * The person's outreach effort a send belongs to. A desk draft marked sent within three days of the message is that draft's
 * effort; otherwise the send continues the person's latest earlier desk effort, else their one manual effort. A new Gmail
 * thread or another sender is never a new effort by itself, and there is no quiet-period reset. Two candidate drafts: the
 * effort is unresolved (null) and the send still counts in message totals. First touch is the effort's earliest send,
 * worked out when reading (the backfill lists newest first).
 */
export function episodeFor(personId: string, at: number, drafts: DeskDraft[]): { episodeId: string | null; draftId: string | null } {
  const near = drafts.filter((d) => d.sentAt != null && Math.abs(d.sentAt - at) <= 3 * DAY);
  if (near.length > 1) return { episodeId: null, draftId: null };
  if (near.length === 1) return { episodeId: h32(`draft:${near[0].id}:${personId}`), draftId: near[0].id };
  const prior = drafts.filter((d) => d.sentAt != null && d.sentAt < at).sort((a, b) => b.sentAt! - a.sentAt!)[0];
  return { episodeId: h32(prior ? `draft:${prior.id}:${personId}` : `manual:${personId}`), draftId: null };
}

async function deskDrafts(db: SupabaseClient, personIds: string[]): Promise<Map<string, DeskDraft[]>> {
  const out = new Map<string, DeskDraft[]>();
  for (let i = 0; i < personIds.length; i += 100) {
    const ids = personIds.slice(i, i + 100);
    const rows = await selectAll<{ id: string; email_sent_at: string | null; person: string | null }>((from, to) => db.from("gtm_outreach_drafts")
      .select("id,email_sent_at,person:prospect->>twenty_person_id").eq("status", "accepted").in("prospect->>twenty_person_id", ids).order("id").range(from, to), "desk drafts");
    for (const r of rows) if (r.person) out.set(r.person, [...(out.get(r.person) ?? []), { id: r.id, sentAt: r.email_sent_at ? Date.parse(r.email_sent_at) : null }]);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ sync */

export type MailboxRow = { member: string; address: string; token_ciphertext: string; history_id: string | null; backfill_done: boolean; last_sync_at: string | null; granted_scopes?: string[] | null };

type Part = { mimeType?: string; body?: { data?: string; attachmentId?: string }; parts?: Part[] };
const decode = (b64: string | undefined) => (b64 ? Buffer.from(b64, "base64url").toString("utf8") : "");
/** The text of the first part with this MIME type (inline or as an attachment). Held in memory only. */
async function partText(gmail: TeamGmail, messageId: string, root: Part | undefined, mime: RegExp): Promise<string | null> {
  const stack = root ? [root] : [];
  while (stack.length) {
    const p = stack.shift()!;
    if (p.mimeType && mime.test(p.mimeType)) {
      if (p.body?.data) return decode(p.body.data);
      if (p.body?.attachmentId) return decode((await gmail.attachment(messageId, p.body.attachmentId)).data);
    }
    stack.push(...(p.parts ?? []));
  }
  return null;
}
export type SyncResult = {
  address: string; sends: number; outreach: number; other_crm: number; replies: number; bounces: number; threads_checked: number; pending: number; complete: boolean;
  attempts: number; reconciled: number; ambiguous_only: number; unattributed_failures: number;
  /** With gmail.readonly: failure reports read per recipient, replies checked by the deterministic rules. */
  reports_read: number; replies_checked: number; possible_opt_outs: number; model_labeled: number; model_skipped: number; model_failed: number;
  /** Replies left for the next run without a request: the run's model cap or time ran out (VIB-517). Not failures. */
  model_waiting: number;
  /** A copy of a message already counted from another mailbox (same Message-ID): an observation, not another send. */
  copies: number;
  /** A Gmail id another mailbox of the member already holds while the member-wide key exists (until the schema follow-up). */
  id_collisions: number; error?: string;
};
type EventKind = "outreach" | "other_crm" | "reply" | "bounce";
type Event = {
  member: string; gmail_message_id: string; thread_id: string; kind: EventKind; at: string; person_ids?: string[]; company_ids?: string[]; recipient_hashes?: string[];
  mailbox: string; message_key?: string | null; source: "team_mailbox"; draft_id?: string | null; calc_version: number;
};
type StoredEvent = { id: number; gmail_message_id: string; thread_id: string; kind: string; at: string; mailbox: string | null; calc_version: number; recipient_hashes: string[]; message_key?: string | null; person_ids?: string[] };

/**
 * Per-mailbox sync state (gtm_sync_state). A cursor only ever moves past work that is finished: ids listed but not yet
 * classified ride along in `pending`, so a run that stops at its deadline, or whose CRM lookup fails, loses nothing.
 * `okAt` is the last fully successful run, the watermark a history reset reads back from (adversarial review of #23).
 * `threads` are threads that received mail since the last run; `replay` marks a listing started by `gtm team replay`.
 */
export type SyncState = { pageToken?: string; startHistory?: string; since?: string; pending?: string[]; okAt?: string; threads?: string[]; replay?: boolean;
  /** A replay's thread window, kept until listing, classification and every thread in it are done; and the threads re-read so far. */
  replayThreadsSince?: string; replayScanned?: string[] };

export const stateKey = (member: string, address: string) =>
  `team.mailbox.${member.toLowerCase()}.h${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 16)}`;

/** Fixed, address-free messages for last_error, which owners read. Raw provider errors never reach it. */
export class SyncStepError extends Error {}
const failure = (e: unknown): string => {
  if (e instanceof ReconnectError || e instanceof SyncStepError) return e.message;
  if (e instanceof TwentyError) return "The CRM rejected a lookup; the sync retries next hour.";
  const status = (e as { status?: number }).status;
  if (status) return `Gmail answered ${status}; the sync retries next hour.`;
  return `The sync stopped early (${failedStep(e)}); it resumes where it left off next hour.`;
};

/**
 * Where an unexpected failure happened, in words safe for last_error and the alert email: the fixed step label of a failed
 * database call (lib/db.ts DbError, set in code), the violated constraint's name when there is one, else the error type.
 * Never the database message itself (it can quote a value) and never a provider body.
 */
// PostgreSQL's constraint-violation messages, matched whole (anchored), so a quoted value inside another error's message
// can never pass as a constraint name (review of #38, B1). Only names on this schema's own tables (gtm_*) are shown.
const PG_CONSTRAINT: [RegExp, string][] = [
  [/^new row for relation "gtm_[a-z0-9_]{1,60}" violates check constraint "(gtm_[a-z0-9_]{1,80})"$/, "check"],
  [/^duplicate key value violates unique constraint "(gtm_[a-z0-9_]{1,80})"$/, "unique"],
  [/^insert or update on table "gtm_[a-z0-9_]{1,60}" violates foreign key constraint "(gtm_[a-z0-9_]{1,80})"$/, "foreign key"],
  [/^null value in column "[a-z0-9_]{1,60}" of relation "gtm_[a-z0-9_]{1,60}" violates not-null constraint$/, "not-null"],
];
function constraintOf(e: DbError): string | null {
  const detail = e.message.slice(e.step.length + 2);
  for (const [re, kind] of PG_CONSTRAINT) {
    const m = re.exec(detail);
    if (m) return m[1] ? `${kind} constraint ${m[1]}` : `${kind} constraint`;
  }
  return null;
}

export function failedStep(e: unknown): string {
  try {
    if (e instanceof DbError) {
      const label = /^[a-z][a-z ,'-]{2,60}$/.test(e.step) ? e.step : "a database step";
      const constraint = constraintOf(e);
      return constraint ? `at "${label}", ${constraint}` : `at "${label}"`;
    }
    const type = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "unknown error";
    return type;
  } catch { return "unknown error"; }
}

/** Every row of a select, 1000 at a time (PostgREST caps a response at max_rows). Past `max` rows it throws rather than
 *  return a silently truncated list (VIB-516). The select must be ordered by a unique key so pages neither skip nor repeat. */
export async function selectAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string, max = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    if (from >= max) throw new DbError(what, `more than ${max} rows; refusing to return a silently truncated list`);
    const rows = must(await page(from, from + 999), what) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const EVENT_COLS = "id,gmail_message_id,thread_id,kind,at,mailbox,calc_version,recipient_hashes,message_key,person_ids";

/** Upserts once per row identity, whichever unique key the schema has: the per-mailbox constraint (vibrana.ai
 *  20261106020000) or, before it, the member-wide one. Decided on every write, never cached, so a running process keeps
 *  working across that migration (review of #30, F2). */
async function insertOnce(db: SupabaseClient, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  for (const target of ["mailbox,gmail_message_id", "member,gmail_message_id", "mailbox,gmail_message_id"]) {
    const { error } = await db.from("gtm_team_mail_events").upsert(rows, { onConflict: target, ignoreDuplicates: true });
    if (!error) return;
    if (error.code === "42P10") continue;   // that key does not exist (yet, or any more)
    if (error.code === "23505" && rows.length > 1) { for (const r of rows) await insertOnce(db, [r]); return; }   // one clash loses nothing else
    if (error.code === "23505") return;     // the row exists under the other key: read back below
    throw new DbError("save mail events", error.message);
  }
  throw new Error("save mail events: no unique key on gtm_team_mail_events matches");
}

/**
 * Writes events once (the first observation wins) and returns this mailbox's stored rows by Gmail id. A row from the older
 * sync (no mailbox) is claimed and rewritten in place, keeping its id, never duplicated (review of #30, F1). Every row names
 * its arrays: a mixed batch never writes a null array.
 */
async function writeEvents(db: SupabaseClient, member: string, mailbox: string, input: Event[], result: { reconciled: number; id_collisions: number }): Promise<Map<string, StoredEvent>> {
  const stored = new Map<string, StoredEvent>();
  if (!input.length) return stored;
  const events = input.map((e) => ({ ...e, person_ids: e.person_ids ?? [], company_ids: e.company_ids ?? [], recipient_hashes: e.recipient_hashes ?? [], message_key: e.message_key ?? null, draft_id: e.draft_id ?? null }));
  const read = async () => must(await db.from("gtm_team_mail_events").select(EVENT_COLS).eq("member", member).in("gmail_message_id", events.map((e) => e.gmail_message_id)), "read mail events") as StoredEvent[];
  const before = await read();
  const fresh: typeof events = [];
  for (const e of events) {
    if (before.some((r) => r.gmail_message_id === e.gmail_message_id && r.mailbox === mailbox)) continue;
    const legacy = before.find((r) => r.gmail_message_id === e.gmail_message_id && r.mailbox == null);
    if (legacy) {
      const { member: _m, gmail_message_id: _g, ...patch } = e;
      // Claimed only while still unclaimed: a concurrent run that claimed it first wins.
      must(await db.from("gtm_team_mail_events").update(patch).eq("id", legacy.id).is("mailbox", null), "claim older row");
      result.reconciled++;
    } else fresh.push(e);
  }
  await insertOnce(db, fresh);
  const rows = await read();
  for (const e of events) {
    const r = rows.find((x) => x.gmail_message_id === e.gmail_message_id && x.mailbox === mailbox);
    if (!r) { result.id_collisions++; continue; }   // held under the member-wide key by another mailbox (until 20261106020000)
    if (r.calc_version < CALC_VERSION) {
      const { member: _m, gmail_message_id: _g, ...patch } = e;
      must(await db.from("gtm_team_mail_events").update(patch).eq("id", r.id), "reconcile mail event");
      Object.assign(r, { kind: e.kind, calc_version: e.calc_version, recipient_hashes: e.recipient_hashes });
      result.reconciled++;
    } else if ((e.kind === "reply" || e.kind === "bounce") && !(r.person_ids ?? []).length && e.person_ids.length) {
      // A reply stored before the attempts it is attributed through existed (a failed write, repaired since) gains its
      // person on a later read. Only an empty attribution is filled; nothing already attributed changes (review of #30, D1).
      must(await db.from("gtm_team_mail_events").update({ person_ids: e.person_ids }).eq("id", r.id).eq("person_ids", "{}"), "complete reply attribution");
      r.person_ids = e.person_ids;
      result.reconciled++;
    }
    stored.set(r.gmail_message_id, r);
  }
  return stored;
}

export async function syncMailbox(db: SupabaseClient, member: TeamMember, row: MailboxRow, reader: TwentyReader, opts: {
  cfg: GmailConfig; fetcher?: typeof fetch; now?: Date; deadline?: number; maxMessages?: number; maxThreads?: number; clock?: () => number; chunk?: number; chunkReserveMs?: number;
}): Promise<SyncResult> {
  const now = opts.now ?? new Date(), fetcher = opts.fetcher ?? fetch, clock = opts.clock ?? Date.now;
  const result: SyncResult = { address: row.address, sends: 0, outreach: 0, other_crm: 0, replies: 0, bounces: 0, threads_checked: 0, pending: 0, complete: true,
    attempts: 0, reconciled: 0, ambiguous_only: 0, unattributed_failures: 0, reports_read: 0, replies_checked: 0, possible_opt_outs: 0, model_labeled: 0, model_skipped: 0, model_failed: 0, model_waiting: 0, copies: 0, id_collisions: 0 };
  const bodies = canReadBodies(row.granted_scopes);
  const late = () => opts.deadline != null && clock() > opts.deadline;
  const key = stateKey(row.member, row.address);
  const own_ = member.mailboxes.length ? member.mailboxes : [row.address];
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

    // 1. Collect sent-message ids, and the threads that received mail. Nothing is committed yet; the new cursor is only
    //    saved with the ids still to do.
    const collected: string[] = [];
    const inbound = new Set(state.threads ?? []);
    let historyId = row.history_id, backfillDone = row.backfill_done, listedAll = false;
    let nextPageToken = state.pageToken, startHistory = state.startHistory, since = state.since;
    const replaying = !!state.replay;
    let replayWindow = state.replayThreadsSince ?? (replaying ? state.since : undefined);
    const replayScanned: string[] = [...(state.replayScanned ?? [])];
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
          for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) {
            const labels = a.message.labelIds ?? [];
            if (labels.includes("SENT")) collected.push(a.message.id);
            else if (a.message.threadId && !labels.some((l) => l === "SPAM" || l === "TRASH" || l === "DRAFT")) inbound.add(a.message.threadId);
          }
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
        since = new Date(Date.parse(state.okAt ?? BACKFILL_SINCE) - DAY).toISOString();
        startHistory = profile.historyId; nextPageToken = undefined; backfillDone = false; result.complete = false;
      }
    }
    // Threads that received mail wait here until they are looked up (and, if outreach, re-read): nothing is dropped; each run
    // looks up a bounded batch (review of #30, F4).
    const pendingThreads = [...inbound];
    const threadBatch = pendingThreads.slice(0, 200);

    // 2. Classify pending and new ids in chunks. Each chunk is fetched, looked up in the CRM, written, and only then
    //    taken off `pending`, so every run that gets one chunk through makes progress, and a chunk is not started
    //    when the time left could not finish it (review of #23, NS2).
    const queue = [...new Set([...(state.pending ?? []), ...collected])];
    const cutoff = Date.parse(BACKFILL_SINCE);
    const chunk = opts.chunk ?? 50, reserve = opts.chunkReserveMs ?? 30_000;
    let done = 0;
    let lastSaved: SyncState | null = null;
    const deferred = new Set<string>();
    // State and mailbox row move together: once the listing is done the state drops its listing cursor, so the row must
    // say backfill_done with the new history id in the same step, or a later failure would send the next run back to
    // Oct 1 (review of #23, NS3).
    const commit = async () => {
      result.pending = queue.length - done;
      lastSaved = { pageToken: backfillDone ? undefined : nextPageToken, startHistory: backfillDone ? undefined : startHistory, since: backfillDone ? undefined : since,
        pending: [...deferred, ...queue.slice(done).filter((id) => !deferred.has(id))], okAt: state.okAt, threads: pendingThreads, replay: backfillDone ? undefined : state.replay,
        // A replay's listing can finish before its old threads are re-read: their window stays until they are (review of #30).
        replayThreadsSince: replayWindow, replayScanned: replayWindow ? replayScanned : undefined };
      await saveState(lastSaved);
      must(await db.from("gtm_team_mailboxes").update({ history_id: backfillDone ? historyId : row.history_id, backfill_done: backfillDone })
        .eq("member", row.member).eq("address", row.address), "save mailbox cursor");
    };
    while (done < queue.length) {
      if (opts.deadline != null && clock() > opts.deadline - reserve) break;
      const ids = queue.slice(done, done + chunk);
      const sends: { id: string; threadId: string; at: number; key: string | null; rcpts: ReturnType<typeof recipientsOf> }[] = [];
      for (const id of ids) {
        let m: MailMessage & { threadId: string };
        try { m = await gmail.message(id); } catch (e) { if ((e as { status?: number }).status === 404) continue; throw e; }
        const at = Number(m.internalDate ?? 0);
        if (!m.labelIds?.includes("SENT") || at < cutoff) continue;
        const mid = header(m, "Message-ID");
        sends.push({ id: m.id, threadId: m.threadId, at, key: mid ? messageKey(mid) : null, rcpts: recipientsOf(m, own_, ignoredDomains()) });
      }
      const allRcpts = [...new Set(sends.flatMap((x) => x.rcpts.map((r) => r.address)))];
      const people = await lookupPeople(reader, allRcpts);
      const companies = await lookupCompanies(reader, allRcpts.filter((x) => !people.has(x)).map(domainOf));
      const classes = sends.map((x) => ({ x, c: classifyMessage(x.rcpts, people, companies, now.getTime() - x.at < DAY) }));
      for (const { x, c } of classes) if (!c && x.rcpts.some((r) => { const p = people.get(r.address); return !!p && "ambiguous" in p; })) result.ambiguous_only++;
      const counted = classes.filter((k): k is { x: (typeof sends)[number]; c: NonNullable<typeof k.c> } => !!k.c);
      const drafts = await deskDrafts(db, [...new Set(counted.flatMap((k) => k.c.personIds))]);
      const episodes = new Map<string, Map<string, ReturnType<typeof episodeFor>>>();
      const events: Event[] = counted.map(({ x, c }) => {
        const byPerson = new Map(c.personIds.map((p) => [p, episodeFor(p, x.at, drafts.get(p) ?? [])]));
        episodes.set(x.id, byPerson);
        const draftIds = [...new Set([...byPerson.values()].map((e) => e.draftId))];
        if (c.kind === "outreach") result.outreach++; else result.other_crm++;
        return {
          member: row.member, gmail_message_id: x.id, thread_id: x.threadId, kind: c.kind, at: new Date(x.at).toISOString(),
          person_ids: c.personIds, company_ids: c.companyIds, recipient_hashes: c.attempts.filter((a) => a.stream === "cold").map((a) => addressHash(a.address)),
          mailbox: row.address, message_key: x.key, source: "team_mailbox", draft_id: draftIds.length === 1 ? draftIds[0] : null, calc_version: CALC_VERSION,
        };
      });
      const written = await writeEvents(db, row.member, row.address, events, result);
      // An id that could not be stored (another mailbox holds it under the member-wide key, before 20261106020000) stays
      // pending instead of being dropped (review of #30, round 3).
      for (const { x } of counted) if (!written.has(x.id)) deferred.add(x.id);
      // One canonical observation per keyed Message-ID: the earliest stored outreach row, whichever mailbox wrote it. Only it
      // carries attempts, and they are (re)written idempotently every time it is processed, so an attempts write that failed
      // is repaired on retry even after another mailbox stored a copy (review of #30, C1). Every other observation (a send-as
      // alias, a delegated mailbox) gets none; the thread pass resolves it to the canonical attempts, readers count it once.
      const keys = [...new Set(counted.map((k) => k.x.key).filter((k): k is string => !!k))];
      const canonicalOf = new Map<string, number>();
      for (let i = 0; i < keys.length; i += 200) {
        for (const e of must(await db.from("gtm_team_mail_events").select("id,message_key").in("message_key", keys.slice(i, i + 200)).eq("kind", "outreach"), "canonical observations") as { id: number; message_key: string }[]) {
          canonicalOf.set(e.message_key, Math.min(canonicalOf.get(e.message_key) ?? Infinity, e.id));
        }
      }
      const isCopy = (x: { key: string | null }, id: number) => !!x.key && (canonicalOf.get(x.key) ?? id) !== id;
      const attemptRows = counted.flatMap(({ x, c }) => {
        const ev = written.get(x.id);
        if (!ev) return [];
        if (isCopy(x, ev.id)) { result.copies++; return []; }
        const live = now.getTime() - x.at < DAY;
        return c.attempts.map((a: AttemptClass) => ({
          event_id: ev.id, recipient_hash: addressHash(a.address), field: a.field, match: a.match, person_id: a.personId, stream: a.stream,
          verification: a.verification, verification_basis: a.verificationBasis, policy_flags: a.policyFlags, attribution: live ? "observed" : "inferred",
          episode_id: a.personId ? episodes.get(x.id)?.get(a.personId)?.episodeId ?? null : null,
        }));
      });
      if (attemptRows.length) must(await db.from("gtm_email_attempts").upsert(attemptRows, { onConflict: "event_id,recipient_hash", ignoreDuplicates: true }), "save attempts");
      result.attempts += attemptRows.length;
      result.sends += sends.length;
      done += ids.length;
      await commit();
    }
    // The listing cursor (page token, history id) is saved even when no chunk ran, with every id still pending.
    await commit();
    const remaining = queue.length - done + deferred.size;
    if (remaining) result.complete = false;
    // backfill_done follows the listing (saved by commit): pending ids are finished from `pending` in history mode, never
    // by re-listing (NS1).
    const caughtUp = backfillDone && listedAll && !remaining;

    // 3. Replies and failures. Outreach threads of the last 30 days (or since the replay start) are re-read, unanswered
    //    first, rotating the start each hour so a long list is covered across runs; any older outreach thread that received
    //    mail is re-read too. A thread is never closed by its first outcome: a later opt-out or failed follow-up still counts.
    const windowStart = new Date(Math.min(now.getTime() - REPLY_WINDOW_DAYS * DAY, replayWindow ? Date.parse(replayWindow) : Infinity)).toISOString();
    // This mailbox's threads only (Gmail thread ids are per mailbox); rows from before VIB-510 have no mailbox yet.
    const own = `mailbox.eq."${row.address}",mailbox.is.null`;
    const recent = await selectAll<StoredEvent>((from, to) =>
      db.from("gtm_team_mail_events").select(EVENT_COLS).eq("member", row.member).or(own).gte("at", windowStart).order("id").range(from, to), "recent mail events");
    const older = threadBatch.length ? await selectAll<StoredEvent>((from, to) =>
      db.from("gtm_team_mail_events").select(EVENT_COLS).eq("member", row.member).or(own).lt("at", windowStart).in("thread_id", threadBatch).order("id").range(from, to), "older threads with new mail") : [];
    const threads = new Map<string, { first: number; hashes: Set<string>; answered: boolean; sends: StoredEvent[] }>();
    for (const e of [...recent, ...older]) {
      const t = threads.get(e.thread_id) ?? { first: Infinity, hashes: new Set<string>(), answered: false, sends: [] };
      if (e.kind === "outreach") { t.first = Math.min(t.first, Date.parse(e.at)); for (const h of e.recipient_hashes ?? []) t.hashes.add(h); t.sends.push(e); }
      if (e.kind === "reply" || e.kind === "bounce") t.answered = true;
      threads.set(e.thread_id, t);
    }
    // Who each recipient hash is, per outreach message, for reply attribution and per-attempt failures.
    // A copy's attempts live on the first observation of its Message-ID (another mailbox): resolve to those.
    const copyKeys = [...new Set([...threads.values()].flatMap((t) => t.sends.map((x) => x.message_key)).filter((k): k is string => !!k))];
    const canonical = new Map<string, number>();
    for (let i = 0; i < copyKeys.length; i += 200) {
      for (const e of must(await db.from("gtm_team_mail_events").select("id,message_key").in("message_key", copyKeys.slice(i, i + 200)).eq("kind", "outreach"), "first observations") as { id: number; message_key: string }[]) {
        canonical.set(e.message_key, Math.min(canonical.get(e.message_key) ?? Infinity, e.id));
      }
    }
    const attemptIdOf = (s: StoredEvent) => (s.message_key && canonical.get(s.message_key)) || s.id;
    const sendIds = [...new Set([...threads.values()].flatMap((t) => t.sends.map(attemptIdOf)))];
    const attempts: { id: number; event_id: number; recipient_hash: string; person_id: string | null; stream: string; delivery: string }[] = [];
    for (let i = 0; i < sendIds.length; i += 200) {
      const ids = sendIds.slice(i, i + 200);
      attempts.push(...await selectAll<(typeof attempts)[number]>((from, to) => db.from("gtm_email_attempts").select("id,event_id,recipient_hash,person_id,stream,delivery").in("event_id", ids).order("id").range(from, to), "attempts"));
    }
    const open = [...threads].filter(([, t]) => t.first !== Infinity).sort(([, a], [, b]) => Number(a.answered) - Number(b.answered) || b.first - a.first);
    const cap = opts.maxThreads ?? 150;
    const start = open.length > cap ? (Math.floor(now.getTime() / 3_600_000) * cap) % open.length : 0;
    const replyEvents: Event[] = [];
    const failed: { attemptId: number; at: number; reportId: string; delivery?: string }[] = [];
    const ruled: { replyId: string; persons: string[]; intent: string; opt_out: string }[] = [];
    const modeled: { replyId: string; persons: string[]; intent: string; opt_out: string; model: string }[] = [];
    // The model classifier (lib/email/classifier.ts) runs only when switched on, and at most MODEL_CAP replies a run.
    const classifierOn = bodies && classifierEnabled();
    const MODEL_CAP = 40;
    let modelCalls = 0;
    // A reply is done with the rules once a rule decision is stored for it (a neutral one included). An existing reply
    // event alone is not: a run that stopped early, a failed label write or an older metadata-only grant leave it to retry
    // (review of #32, F3).
    const replyRows = [...recent, ...older].filter((e) => e.kind === "reply");
    const ruledDone = new Set<number>(), autoRuled = new Set<number>(), modelDone = new Set<number>();
    if (bodies) for (let i = 0; i < replyRows.length; i += 200) {
      for (const l of must(await db.from("gtm_email_reply_labels").select("event_id,source,intent").in("source", ["deterministic", "model"]).is("superseded_at", null)
        .in("event_id", replyRows.slice(i, i + 200).map((e) => e.id)), "reply decisions") as { event_id: number; source: string; intent: string }[]) {
        if (l.source === "model") modelDone.add(l.event_id);
        else { ruledDone.add(l.event_id); if (l.intent === "auto_reply") autoRuled.add(l.event_id); }
      }
    }
    // With the classifier on, a reply is done once the model has labeled it too (an auto-reply needs no model); a model call
    // that failed or was over the run's cap leaves the reply to be read again next run.
    const knownReplies = new Set(replyRows.filter((e) => ruledDone.has(e.id) && (!classifierOn || modelDone.has(e.id) || autoRuled.has(e.id))).map((e) => e.gmail_message_id));
    let threadsDone = true;
    const scanned = new Set<string>();
    // Threads whose reply text or failure report still needs reading (the run ran out of time first). They stay queued,
    // however old their outreach, until that is done (review of #32, B1).
    const bodyPending = new Set<string>();
    for (let k = 0; k < Math.min(cap, open.length); k++) {
      if (late()) { result.complete = false; threadsDone = false; break; }
      const [threadId, t] = open[(start + k) % open.length];
      result.threads_checked++;
      scanned.add(threadId);
      let thread: MailThread;
      try { thread = await gmail.thread(threadId); } catch (e) { if ((e as { status?: number }).status === 404) continue; throw e; }
      const out = threadOutcome(thread.messages ?? [], t.first, own_, (a) => t.hashes.has(addressHash(a)));
      const mine = attempts.filter((a) => t.sends.some((s) => attemptIdOf(s) === a.event_id));
      for (const r of out.replies) {
        const hash = addressHash(r.from);
        const who = [...new Set(mine.filter((a) => a.recipient_hash === hash && a.person_id).map((a) => a.person_id!))];
        // Reply text, only with gmail.readonly and only for a reply from an outreach recipient: the deterministic rules
        // record an auto-reply or a possible opt-out (held for a person). Nothing of the text is kept.
        if (bodies && !knownReplies.has(r.id) && late()) bodyPending.add(threadId);
        else if (bodies && !knownReplies.has(r.id)) {
          const m = await gmail.full(r.id).catch((e) => { if ((e as { status?: number }).status === 404) return null; throw e; });
          if (m) {
            const text = await partText(gmail, r.id, m.payload as Part | undefined, /^text\/plain$/i) ?? "";
            const rule = replyRule(text, autoMessage(m));
            result.replies_checked++;
            if (rule.opt_out !== "none") result.possible_opt_outs++;
            ruled.push({ replyId: r.id, persons: who, intent: rule.intent, opt_out: rule.opt_out });   // neutral too: the completion record
            if (classifierOn && rule.intent !== "auto_reply") {
              const res = modelCalls < MODEL_CAP && !late() ? await classifyReply(text, { deadline: opts.deadline, now: clock, maxAttempts: MODEL_CAP - modelCalls }) : null;
              modelCalls += res?.attempts ?? 0;   // only real requests count toward the cap (review of #34, finding 2)
              if (res?.status === "decided") {
                modeled.push({ replyId: r.id, persons: who, intent: res.decision.intent, opt_out: res.decision.opt_out, model: res.decision.model }); result.model_labeled++;
              } else if (res?.status === "skipped") {
                // Nothing safe to send (no new text, HTML only, or a quoted header): recorded as done, never retried, and it
                // says nothing (currentDecisions ignores it).
                modeled.push({ replyId: r.id, persons: who, intent: "uncertain", opt_out: "none", model: `none:${res.reason}` }); result.model_skipped++;
              } else {
                // Read again next run. A request that went out and got no usable answer is a failure; a reply the cap or the
                // clock left unasked is only waiting (VIB-517).
                if (res && res.attempts > 0) result.model_failed++; else result.model_waiting++;
                bodyPending.add(threadId);
              }
            }
          }
        }
        replyEvents.push({ member: row.member, gmail_message_id: r.id, thread_id: threadId, kind: "reply", at: new Date(r.at).toISOString(),
          person_ids: who, recipient_hashes: [hash], mailbox: row.address, source: "team_mailbox", calc_version: CALC_VERSION });
        result.replies++;
      }
      // The legacy bounce row only when nobody answered (the Team page's reply rate reads it that way until VIB-512).
      if (out.bounce && !out.replies.length) {
        replyEvents.push({ member: row.member, gmail_message_id: out.bounce.id, thread_id: threadId, kind: "bounce", at: new Date(out.bounce.at).toISOString(),
          mailbox: row.address, source: "team_mailbox", calc_version: CALC_VERSION });
        result.bounces++;
      }
      // A failure report belongs to the latest send before it. Metadata cannot say which recipient failed, so only a
      // single-recipient send is marked; the rest wait for the report's text (VIB-511) and are counted as unattributed.
      for (const f of out.failures) {
        const send = t.sends.filter((s) => Date.parse(s.at) < f.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
        const cold = send ? mine.filter((a) => a.event_id === attemptIdOf(send) && a.stream === "cold") : [];
        // With gmail.readonly the report names each failed recipient and why (RFC 3464): only those attempts change.
        const typable = bodies && send && cold.some((a) => a.delivery === "no_failure_observed" || a.delivery === "delayed" || a.delivery === "failed_unclassified");
        if (typable && late()) { bodyPending.add(threadId); continue; }   // read the report next run, not the metadata guess now
        if (typable) {
          const m = await gmail.full(f.id).catch((e) => { if ((e as { status?: number }).status === 404) return null; throw e; });
          const status = m ? await partText(gmail, f.id, m.payload as Part | undefined, /^message\/(global-)?delivery-status$/i) : null;
          const named = status ? parseDeliveryStatus(status) : [];
          if (named.length) {
            result.reports_read++;
            for (const n of named) {
              const hit = mine.find((a) => a.event_id === attemptIdOf(send) && a.recipient_hash === addressHash(n.address));
              if (hit) failed.push({ attemptId: hit.id, at: f.at, reportId: f.id, delivery: n.delivery });
              else result.unattributed_failures++;
            }
            continue;
          }
        }
        // Metadata cannot say who failed: only a send whose sole external recipient is that cold attempt is marked. The count
        // comes from the sent message itself, because correspondence recipients are deliberately not stored (review of #30).
        let sole = false;
        if (cold.length === 1 && cold[0].delivery === "no_failure_observed") {
          const m = await gmail.message(send!.gmail_message_id).catch((e) => { if ((e as { status?: number }).status === 404) return null; throw e; });
          sole = !!m && recipientsOf(m, own_, ignoredDomains()).length === 1;
        }
        if (sole) failed.push({ attemptId: cold[0].id, at: f.at, reportId: f.id });
        else if (!(cold.length === 1 && cold[0].delivery !== "no_failure_observed")) result.unattributed_failures++;
      }
    }
    if (open.length > cap) result.complete = false;
    const outcomes = await writeEvents(db, row.member, row.address, replyEvents, result);
    for (const f of failed) {
      // A typed outcome from the report replaces an untyped or temporary one, never a permanent one; metadata alone only
      // ever marks a send that had no outcome yet.
      const allowed = f.delivery ? (f.delivery === "delayed" ? ["no_failure_observed"] : ["no_failure_observed", "delayed", "failed_unclassified"]) : ["no_failure_observed"];
      must(await db.from("gtm_email_attempts").update({ delivery: f.delivery ?? "failed_unclassified", delivery_at: new Date(f.at).toISOString(), delivery_event_id: outcomes.get(f.reportId)?.id ?? null, updated_at: now.toISOString() })
        .eq("id", f.attemptId).in("delivery", allowed), "record failure");
    }
    for (const r of ruled) {
      const ev = outcomes.get(r.replyId);
      if (!ev) continue;
      const { error } = await db.from("gtm_email_reply_labels").insert({ event_id: ev.id, person_id: r.persons.length === 1 ? r.persons[0] : null, source: "deterministic", intent: r.intent, opt_out: r.opt_out, decision_version: 1 });
      if (error && error.code !== "23505") throw new DbError("save reply rule", error.message);   // one current rule decision per reply
    }
    for (const r of modeled) {
      const ev = outcomes.get(r.replyId);
      if (!ev) continue;
      const { error } = await db.from("gtm_email_reply_labels").insert({ event_id: ev.id, person_id: r.persons.length === 1 ? r.persons[0] : null, source: "model", model: r.model,
        intent: r.intent, opt_out: r.opt_out, decision_version: MODEL_DECISION_VERSION });
      if (error && error.code !== "23505") throw new DbError("save model decision", error.message);   // one current model decision per reply
    }

    // Every sent message up to now was listed and classified: this run is the watermark a history reset reads back from.
    // A looked-up thread leaves the queue once it has been re-read, or once it is known not to be outreach: only when no sent
    // message is still waiting to be classified, since that could make it outreach (review of #30, F6).
    const outreachThreads = new Set([...threads].filter(([, t]) => t.first !== Infinity).map(([id]) => id));
    const looked = new Set(threadBatch);
    const settled = backfillDone && !remaining;
    const remainingThreads = pendingThreads.filter((id) => bodyPending.has(id) || !(looked.has(id) && (scanned.has(id) || (settled && !outreachThreads.has(id)))));
    for (const id of bodyPending) if (!remainingThreads.includes(id)) remainingThreads.push(id);
    // A replay's window closes only when its listing and classification are done and every thread in it was re-read,
    // across as many runs as that takes (review of #30, F5, N1).
    if (replayWindow) {
      for (const id of scanned) if (!replayScanned.includes(id)) replayScanned.push(id);
      if (settled && threadsDone && open.every(([id]) => replayScanned.includes(id))) replayWindow = undefined;
    }
    const replayState = { replayThreadsSince: replayWindow, replayScanned: replayWindow ? replayScanned : undefined };
    if (caughtUp) await saveState({ pending: [], okAt: now.toISOString(), threads: remainingThreads, ...replayState });
    else await saveState({ ...(lastSaved ?? {}), threads: remainingThreads, ...replayState });
    must(await db.from("gtm_team_mailboxes").update({ last_sync_at: now.toISOString(), last_error: null }).eq("member", row.member).eq("address", row.address), "save mailbox status");
  } catch (e) {
    result.error = failure(e);
    result.complete = false;
    await db.from("gtm_team_mailboxes").update({ last_error: result.error, last_sync_at: now.toISOString() }).eq("member", row.member).eq("address", row.address);
  }
  return result;
}

/**
 * `gtm team replay`: list this mailbox's sent mail again from `since` and re-read its outreach threads from then, so rows the
 * older sync wrote are rewritten with this calculation and late replies are found. Idempotent; sends nothing.
 */
export async function scheduleReplay(db: SupabaseClient, member: string, address: string, since: string) {
  if (!Number.isFinite(Date.parse(since)) || Date.parse(since) < Date.parse(BACKFILL_SINCE)) throw new Error(`replay starts on or after ${BACKFILL_SINCE.slice(0, 10)}`);
  const key = stateKey(member, address);
  const prev = (must(await db.from("gtm_sync_state").select("value").eq("key", key).maybeSingle(), "read sync state") as { value?: SyncState } | null)?.value ?? {};
  must(await db.from("gtm_sync_state").upsert({ key, value: { pending: prev.pending ?? [], okAt: prev.okAt, threads: prev.threads ?? [], since, replay: true }, updated_at: new Date().toISOString() }, { onConflict: "key" }), "save replay");
  must(await db.from("gtm_team_mailboxes").update({ backfill_done: false }).eq("member", member).eq("address", address), "start replay");
}
