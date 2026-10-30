import { outreachSignature } from "./email-format";
// The writing desk (/outreach/write, VIB-437): John reviews and owns every cold email; AI angles are optional suggestions. This module is the pure part: the
// dossier contract from vibrana-crm (one JSON array per run, keyed by Twenty person id), John's profile, the desk states,
// the composer's prefill and advisory hints, the Gmail compose link and "sent today". Database paths are in
// ./desk-store.ts; the table shapes in brand.example.com migrations 20261017010000_gtm_outreach_desk.sql and
// 20261019000000_gtm_outreach_tracks.sql (VIB-463: two streams, clients and podcast guests, each with its own sender,
// daily target and profile). No runtime imports except the copy guard, so a client component can use it.
import { findBritishSpellings } from "../copy-guard";
import type { Draft, Prospect, Strategy, Trigger } from "./model";

/** John's desk drafts: gtm_outreach_drafts rows in this batch, variant 'john', person = the Twenty person id. */
export const DESK_BATCH = "desk";
export const DESK_VARIANT = "john";
/** The two streams: cold client prospects, and podcast guests John invites (VIB-463). */
export const TRACKS = ["client", "guest"] as const;
export type Track = (typeof TRACKS)[number];
export const TRACK_LABEL: Record<Track, string> = { client: "Clients", guest: "Guests" };
/**
 * What a track falls back to when gtm_outreach_tracks has no row for it. The mailboxes are Google Workspace: clients send from
 * vibranahq.com (warmed up in Origami), guests from John's own domain, as the host of the podcast.
 */
export const TRACK_DEFAULTS: Record<Track, { daily_target: number; from_address: string }> = {
  client: { daily_target: 5, from_address: "user-045d73df3c9a@example.com" },
  guest: { daily_target: 2, from_address: "user-8dd8662c2f5a@example.com" },
};
export const DEFAULT_TARGET = TRACK_DEFAULTS.client.daily_target;
export const isTrack = (v: unknown): v is Track => v === "client" || v === "guest";
/** How a guest is reached; any route counts toward the guest target. */
export const ROUTES = ["email", "linkedin", "intermediary"] as const;
export type Route = (typeof ROUTES)[number];
export const ROUTE_LABEL: Record<Route, string> = { email: "Email", linkedin: "LinkedIn", intermediary: "Via an intermediary" };
/** A follow-up goes 7 days after the first message (outreach/05), and an export older than 3 days is stale. */
export const FOLLOW_UP_DAYS = 7;
export const STALE_DAYS = 3;
/** His two gold examples run 118 and 162 words. Advisory only. */
export const WORDS = { low: 90, high: 180 } as const;

// ---- the dossier contract (vibrana-crm desk export) --------------------------------------------------------------------

export type DossierProspect = {
  first_name?: string | null; last_name?: string | null; title?: string | null; company?: string | null; email?: string | null;
  linkedin_url?: string | null; country?: string | null; city?: string | null; lane?: string | null; score?: number | null;
  score_factors?: unknown; industry?: string | null; employees?: number | string | null;
};
export type DossierCompany = {
  name?: string | null; domain?: string | null; industry?: string | null; employees?: number | string | null; country?: string | null;
  description?: string | null; ai_native?: boolean | null; technologies?: string[] | null;
};
export type DossierSignal = { text?: string | null; url?: string | null; date?: string | null; type?: string | null };
export type DossierTrigger = { family?: string | null; subtype?: string | null; event_date?: string | null; source_url?: string | null; summary?: string | null };
export type DossierSource = { id?: string | null; url?: string | null; title?: string | null; published?: string | null; via?: string | null; text?: string | null };
export type DossierBrief = {
  problem?: string | null; problem_quote?: { text?: string | null; source_id?: string | null } | null; why_now?: string | null;
  how_john_helps?: Array<{ id?: string | null; text?: string | null }> | null; door_questions?: string[] | null;
  asset?: { id?: string | null; url?: string | null; label?: string | null } | null; recipient_note?: string | null; model?: string | null;
};
export type DossierPerson = { headline?: string | null; about?: string | null; recent_posts?: Array<{ text?: string | null; url?: string | null; date?: string | null }> | null };
export type Colleague = { name?: string | null; title?: string | null; email?: string | null; linkedin_url?: string | null };
export type HistoryItem = { channel?: string | null; date?: string | null; summary?: string | null };
export type ClientCheck = { ok?: boolean | null; reason?: string | null; checked_at?: string | null };
/** The guest block of a podcast-guest dossier (vibrana-crm guest exporter). Every field may be missing. */
export type DossierGuest = {
  season?: string | null; lane?: string | null; tier?: string | null; pillar?: string | null; template?: string | null;
  trigger?: string | null; trigger_url?: string | null; backup_trigger?: string | null; wisdom_angle?: string | null; central_question?: string | null;
  prompts?: string[] | null; warm_path?: string | null; representation?: string | null; approach_note?: string | null; protocol_note?: string | null;
  channel?: string | null; contact_line?: string | null; website?: string | null;
  /** Researched contact routes (vibrana-crm `outreach guests --contacts`): the page to write to, an organization address, other handles. */
  contact_url?: string | null; org_email?: string | null; handles?: Record<string, string> | null;
  contact_confidence?: string | null; contact_note?: string | null;
};

export type Dossier = {
  twenty_person_id: string; domain?: string | null; built_at?: string | null;
  /** Guest dossiers only: 'guest', how they are reached, and whether Twenty has them (twenty_person_id is 'guest-md:<slug>' when not). */
  track?: Track | null; route?: Route | null; not_in_twenty?: boolean | null; score?: number | null; guest?: DossierGuest | null;
  prospect?: DossierProspect | null; company?: DossierCompany | null; signal?: DossierSignal | null;
  triggers?: DossierTrigger[] | null; sources?: DossierSource[] | null; brief?: DossierBrief | null; person?: DossierPerson | null;
  colleagues?: Colleague[] | null; history?: HistoryItem[] | null; client_check?: ClientCheck | null;
};

/** A gtm_outreach_dossiers row. */
export type DossierRow = {
  twenty_person_id: string; track: Track; created_at: string; updated_at: string; domain: string | null; name: string; company: string; title: string;
  score: number | null; built_at: string | null; dossier: Dossier; skipped_at: string | null; skip_reason: string; skipped_by: string | null;
};
export const DOSSIER_COLUMNS = "twenty_person_id,track,created_at,updated_at,domain,name,company,title,score,built_at,dossier,skipped_at,skip_reason,skipped_by";
/** The queue's columns: everything but the heavy dossier, plus the two bits of it the queue shows. */
export const QUEUE_COLUMNS = "twenty_person_id,track,domain,name,company,title,score,skipped_at,skip_reason,email:dossier->prospect->>email,client_ok:dossier->client_check->ok,route:dossier->>route,not_in_twenty:dossier->not_in_twenty";

// ---- John's profile (vibrana-crm qualification/outreach_profile.json) --------------------------------------------------

export type Profile = {
  name?: string; first_name?: string; title?: string; signature?: string; location?: string; positioning?: string;
  point_of_view?: string[]; facts?: Array<{ id?: string; text?: string; source?: string }>;
  proof?: Array<{ id?: string; text?: string; url?: string; fits?: string[] }>;
  assets?: Array<{ id?: string; name?: string; url?: string; pitch?: string; fits?: string[] }>;
  asks?: string[]; drip_topics?: string[]; voice?: string[];
  gold_examples?: Array<{ note?: string; subject?: string; body?: string }>;
  /** Guest profile only: the scaffold for each guest template ('01'..'04'), one string each. May be missing. */
  templates?: Partial<Record<string, string>>;
  /** Guest profile only: John's own podcasting history, the facts an invitation can draw on. */
  podcast_history?: PodcastHistory;
};
export type PodcastHistory = {
  summary?: string;
  shows?: Array<{ name?: string; language?: string; host?: string; note?: string; url?: string }>;
  notable_guests?: Array<{ name?: string; role?: string; episode?: string; url?: string }>;
  guest_count?: number | null; source?: string;
};
/** One track's settings (gtm_outreach_tracks): its target, its sender and its profile. */
/**
 * Who a composer sends as. The client stream sends from the viewer's own mailbox when their account carries
 * `app_metadata.gtm_sender` (server-set, never user-editable; Abe: his vibranahq.com address), else the stream's
 * address in gtm_outreach_tracks. Guests are invited as the podcast host, so that stream always keeps its address.
 */
export function senderFor(track: Track, trackAddress: string, claims: { app_metadata?: unknown } | null | undefined): string {
  const own = (claims?.app_metadata as { gtm_sender?: unknown } | undefined)?.gtm_sender;
  return track === "client" && typeof own === "string" && own.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(own) ? own : trackAddress;
}
/**
 * The profile the signed-in person writes with. On the client stream an account with `app_metadata.gtm_signature` signs
 * as itself (Abe: his own name, never John's), and `gtm_name` / `gtm_first_name` replace the profile's. Everything else in
 * the profile (positioning, facts, voice) stays the stream's. Guests keep the host's profile.
 */
export function senderProfile(track: Track, profile: Profile, claims: { app_metadata?: unknown } | null | undefined): Profile {
  if (track !== "client") return profile;
  const m = claims?.app_metadata as { gtm_signature?: unknown; gtm_name?: unknown; gtm_first_name?: unknown } | undefined;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.replace(/\r\n?/g, "\n").trim() : undefined);
  const signature = text(m?.gtm_signature, 500);
  if (!signature) return profile;
  return { ...profile, signature, name: text(m?.gtm_name, 100) ?? profile.name, first_name: text(m?.gtm_first_name, 60) ?? profile.first_name };
}
export type DeskSettings = { daily_target: number; from_address: string; profile: Profile; profile_imported_at: string | null };

const PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const isPersonId = (s: string) => PERSON_ID.test(s);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
export const MAX_DOSSIER_BYTES = 2_000_000;
export const MAX_PROFILE_BYTES = 500_000;

/** A domain as the tables store it: lowercase, no scheme, no www, no path. Null when there is none. */
export function cleanDomain(v: unknown): string | null {
  const d = str(v).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return d || null;
}
const emailDomain = (email: unknown) => cleanDomain(str(email).split("@")[1]);

/**
 * Text Postgres can store: jsonb and text refuse the NUL character, and a lone UTF-16 surrogate breaks JSON. Scraped
 * source text carries both now and then (the 2026-10-16 run had 80 NULs), so every string is cleaned on import.
 */
export function storable<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") as T;
  if (Array.isArray(v)) return v.map(storable) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k), storable(x)])) as T;
  return v;
}

/** The row an import writes for one dossier. */
export type DossierImport = {
  twenty_person_id: string; track: Track; domain: string | null; name: string; company: string; title: string;
  score: number | null; built_at: string | null; dossier: Dossier;
};

export function normalizeDossier(input: Record<string, unknown>, track: Track = "client"): DossierImport {
  const raw = storable(input);
  const p = (isObject(raw.prospect) ? raw.prospect : {}) as DossierProspect;
  const c = (isObject(raw.company) ? raw.company : {}) as DossierCompany;
  // The client contract carries the score on the prospect; the guest contract carries it at the top.
  const rawScore = p.score != null && str(p.score) !== "" ? p.score : raw.score;
  const score = typeof rawScore === "number" ? rawScore : rawScore != null && str(rawScore) !== "" && Number.isFinite(Number(rawScore)) ? Number(rawScore) : null;
  const built = str(raw.built_at);
  return {
    twenty_person_id: str(raw.twenty_person_id), track,
    domain: cleanDomain(raw.domain) ?? cleanDomain(c.domain) ?? emailDomain(p.email),
    name: [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ").slice(0, 300),
    company: (str(p.company) || str(c.name)).slice(0, 300),
    title: str(p.title).slice(0, 300),
    score,
    built_at: built && !Number.isNaN(Date.parse(built)) ? new Date(built).toISOString() : null,
    dossier: { ...(raw as Dossier), twenty_person_id: str(raw.twenty_person_id) },
  };
}

/** Problems with one dossier, in the words the CLI prints. Empty means it can be imported. */
export function dossierProblems(d: DossierImport, raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  // A guest file holds guest rows and a client file client rows (a client row may leave the track out: it is the old contract).
  const rowTrack = raw.track == null || raw.track === "" ? (d.track === "client" ? "client" : null) : str(raw.track);
  if (rowTrack !== d.track) out.push(`is a ${rowTrack ?? "row with no track"}, but this is a ${d.track} import (--track ${d.track})`);
  if (d.track === "guest") {
    if (raw.guest != null && !isObject(raw.guest)) out.push("guest must be an object or null");
    if (raw.route != null && !(ROUTES as readonly string[]).includes(str(raw.route))) out.push(`route "${str(raw.route)}" is not email, linkedin or intermediary`);
    if (isObject(raw.guest)) {
      if (raw.guest.prompts != null && !Array.isArray(raw.guest.prompts)) out.push("guest.prompts must be an array");
      if (raw.guest.template != null && !/^0[1-4]$/.test(str(raw.guest.template))) out.push(`guest.template "${str(raw.guest.template)}" is not 01 to 04`);
    }
  }
  if (!PERSON_ID.test(d.twenty_person_id)) out.push("twenty_person_id is letters, digits and . _ : - (at most 100)");
  if (d.domain && (d.domain.length > 253 || !DOMAIN.test(d.domain))) out.push(`domain "${d.domain}" is not a hostname`);
  for (const k of ["prospect", "company", "signal", "brief", "person", "client_check"] as const) if (raw[k] != null && !isObject(raw[k])) out.push(`${k} must be an object or null`);
  for (const k of ["triggers", "sources", "colleagues", "history"] as const) if (raw[k] != null && !Array.isArray(raw[k])) out.push(`${k} must be an array`);
  const bytes = new TextEncoder().encode(JSON.stringify(d.dossier)).length;
  if (bytes > MAX_DOSSIER_BYTES) out.push(`dossier is ${Math.round(bytes / 1000)} kB (at most ${MAX_DOSSIER_BYTES / 1000} kB)`);
  return out;
}

/** Parse the vibrana-crm desk file: a JSON array of dossiers. Throws with every problem, keyed by person id. */
export function parseDossiers(text: string, track: Track = "client"): DossierImport[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${(e as Error).message}`); }
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of dossiers");
  const problems: string[] = [];
  const seen = new Set<string>();
  const rows = raw.map((r, i) => {
    if (!isObject(r)) { problems.push(`entry ${i + 1}: not an object`); return null; }
    const d = normalizeDossier(r, track);
    const where = d.twenty_person_id || `entry ${i + 1}`;
    for (const p of dossierProblems(d, r)) problems.push(`${where}: ${p}`);
    if (d.twenty_person_id && seen.has(d.twenty_person_id)) problems.push(`${where}: listed twice`);
    seen.add(d.twenty_person_id);
    return d;
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return rows as DossierImport[];
}

/** Parse John's profile JSON. Throws when it is not the profile shape. */
export function parseProfile(text: string): Profile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${(e as Error).message}`); }
  if (!isObject(raw)) throw new Error("expected a JSON object (outreach_profile.json)");
  const problems: string[] = [];
  for (const k of ["name", "first_name", "title", "signature", "positioning"] as const) if (raw[k] != null && typeof raw[k] !== "string") problems.push(`${k} must be a string`);
  for (const k of ["facts", "proof", "assets", "gold_examples"] as const) {
    if (raw[k] != null && (!Array.isArray(raw[k]) || (raw[k] as unknown[]).some((x) => !isObject(x)))) problems.push(`${k} must be an array of objects`);
  }
  for (const k of ["asks", "voice", "point_of_view", "drip_topics"] as const) if (raw[k] != null && !Array.isArray(raw[k])) problems.push(`${k} must be an array`);
  if (raw.podcast_history != null && !isObject(raw.podcast_history)) problems.push("podcast_history must be an object");
  else if (isObject(raw.podcast_history)) for (const k of ["shows", "notable_guests"]) { const v = (raw.podcast_history as Record<string, unknown>)[k]; if (v != null && (!Array.isArray(v) || v.some((x) => !isObject(x)))) problems.push(`podcast_history.${k} must be an array of objects`); }
  if (raw.templates != null && (!isObject(raw.templates) || Object.values(raw.templates).some((t) => typeof t !== "string"))) problems.push("templates must be an object of strings ('01' to '04')");
  if (!str(raw.signature)) problems.push("no signature");
  if (new TextEncoder().encode(text).length > MAX_PROFILE_BYTES) problems.push(`over ${MAX_PROFILE_BYTES / 1000} kB`);
  if (problems.length) throw new Error(problems.join("\n"));
  return storable(raw) as Profile;
}

// ---- desk states -------------------------------------------------------------------------------------------------------

export const DESK_FILTERS = ["to_write", "written", "sent", "skipped"] as const;
export type DeskState = (typeof DESK_FILTERS)[number];
export const DESK_LABEL: Record<DeskState, string> = { to_write: "To write", written: "Written", sent: "Sent", skipped: "Skipped" };
/** The guest queue also filters by "Follow-up due" and "Needs route"; neither is a state (a person is in one state at a time). */
export type DeskFilter = DeskState | "followup_due" | "needs_route";
export const FILTERS: Record<Track, readonly DeskFilter[]> = {
  client: DESK_FILTERS,
  guest: ["to_write", "written", "sent", "followup_due", "skipped", "needs_route"],
};
export const FILTER_LABEL: Record<DeskFilter, string> = { ...DESK_LABEL, followup_due: "Follow-up due", needs_route: "Needs route" };

export type DeskDraftState = Pick<Draft, "status" | "email_status" | "linkedin_status"> & {
  email_sent_at?: string | null; linkedin_sent_at?: string | null; follow_up_status?: Draft["follow_up_status"] | null; follow_up_sent_at?: string | null;
};

/**
 * Sent beats skipped beats written: a person John wrote to is sent, whatever else happened. For a client that is the email
 * (a LinkedIn invite alone is not); a guest is reached by email, LinkedIn note or an intermediary, and any of them is sent.
 */
export function deskState(row: { skipped_at: string | null }, draft: DeskDraftState | null | undefined, track: Track = "client"): DeskState {
  if (draft && (draft.email_status === "sent" || draft.email_status === "replied")) return "sent";
  if (draft && track === "guest" && (draft.linkedin_status === "sent" || draft.linkedin_status === "connected")) return "sent";
  if (row.skipped_at) return "skipped";
  if (draft) return "written";
  return "to_write";
}

export type QueueRow = {
  twenty_person_id: string; track?: Track; domain: string | null; name: string; company: string; title: string; score: number | null;
  skipped_at: string | null; skip_reason: string; email: string | null; client_ok: boolean | null;
  /** Guests: how they are reached, and whether Twenty has them (from the dossier). */
  route?: Route | null; not_in_twenty?: boolean | string | null;
};
export type QueueItem = QueueRow & {
  track: Track; state: DeskState; draft_id: string | null; status: Draft["status"] | null; email_status: Draft["email_status"] | null;
  linkedin_status: Draft["linkedin_status"] | null; email_sent_at: string | null; linkedin_sent_at: string | null;
  follow_up_status: Draft["follow_up_status"] | null; follow_up_sent_at: string | null;
};

/**
 * The queue of one track: highest score first, then by name. Each person carries their desk state. Rows and drafts of the
 * other track are left out, so a guest can never show in the client queue or the reverse (a row with no track is a client).
 */
export function buildQueue(rows: QueueRow[], drafts: Array<DeskDraftState & { id: string; person: string; track?: Track }>, track: Track = "client"): QueueItem[] {
  const byPerson = new Map(drafts.filter((d) => (d.track ?? "client") === track).map((d) => [d.person, d]));
  return rows.filter((r) => (r.track ?? "client") === track).map((r): QueueItem => {
    const d = byPerson.get(r.twenty_person_id) ?? null;
    return {
      ...r, track, client_ok: r.client_ok == null ? null : String(r.client_ok) === "true",
      state: deskState(r, d, track), draft_id: d?.id ?? null, status: d?.status ?? null, email_status: d?.email_status ?? null,
      linkedin_status: d?.linkedin_status ?? null, email_sent_at: d?.email_sent_at ?? null, linkedin_sent_at: d?.linkedin_sent_at ?? null,
      follow_up_status: d?.follow_up_status ?? null, follow_up_sent_at: d?.follow_up_sent_at ?? null,
    };
  }).sort((a, b) => (Number(b.score ?? -Infinity) - Number(a.score ?? -Infinity)) || a.name.localeCompare(b.name) || a.twenty_person_id.localeCompare(b.twenty_person_id));
}

export function counts(items: Array<{ state: DeskState }>): Record<DeskState, number> {
  const c = { to_write: 0, written: 0, sent: 0, skipped: 0 };
  for (const i of items) c[i.state]++;
  return c;
}

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function dayIn(iso: string | Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Whole calendar days from one instant to another, counted on the calendar in a time zone (so 23:00 to 01:00 is one day). */
export function daysBetween(from: string | Date, to: string | Date, tz: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(dayIn(to, tz)) - ms(dayIn(from, tz))) / 86_400_000);
}

/**
 * What "sent today" counts: a client's email, or a guest's email or LinkedIn note (any route counts; an intermediary note is
 * an email_status sent). A follow-up never counts toward the target, so follow_up_sent_at is never read here.
 */
export function sentToday(items: Array<{ email_sent_at: string | null; linkedin_sent_at?: string | null }>, tz: string, track: Track = "client", now: Date = new Date()): number {
  const today = dayIn(now, tz);
  const on = (iso: string | null | undefined) => !!iso && dayIn(iso, tz) === today;
  return items.filter((i) => on(i.email_sent_at) || (track === "guest" && on(i.linkedin_sent_at))).length;
}

/** When a guest was first reached: the email or the LinkedIn note, the earliest of the email and the LinkedIn note. */
export const firstSentAt = (i: { email_sent_at: string | null; linkedin_sent_at?: string | null }) => [i.email_sent_at, i.linkedin_sent_at].filter((t): t is string => !!t).sort()[0] ?? null;

/**
 * A guest whose follow-up is due: sent 7 or more calendar days ago (in the report time zone), no reply, no follow-up yet
 * (outreach/05). Pure on its inputs, so the edge days are unit-tested.
 */
export function followUpDue(i: { state: DeskState; email_status: Draft["email_status"] | null; follow_up_status: Draft["follow_up_status"] | null; email_sent_at: string | null; linkedin_sent_at?: string | null }, tz: string, now: Date = new Date()): boolean {
  const at = firstSentAt(i);
  return i.state === "sent" && i.email_status !== "replied" && (i.follow_up_status ?? "none") === "none" && !!at && daysBetween(at, now, tz) >= FOLLOW_UP_DAYS;
}

/** A guest with no email or LinkedIn to write to: it goes through an intermediary, or Twenty does not have them yet. */
export const needsRoute = (i: { route?: Route | null; not_in_twenty?: boolean | string | null }) => i.route === "intermediary" || String(i.not_in_twenty) === "true";

/** The people one queue chip lists. "Needs route" leaves out people already sent or skipped: there is nothing left to route. */
export function matchesFilter(i: QueueItem, f: DeskFilter, tz: string, now: Date = new Date()): boolean {
  if (f === "followup_due") return followUpDue(i, tz, now);
  if (f === "needs_route") return needsRoute(i) && (i.state === "to_write" || i.state === "written");
  return i.state === f;
}

/** How old a dossier export is, in whole days (null when it carries no date), and whether it is stale. */
export const exportAgeDays = (builtAt: string | null | undefined, now: Date = new Date()): number | null => {
  const t = builtAt ? Date.parse(builtAt) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
};
export const exportIsStale = (builtAt: string | null | undefined, now: Date = new Date()) => {
  const t = builtAt ? Date.parse(builtAt) : NaN;
  return !Number.isNaN(t) && now.getTime() - t > STALE_DAYS * 86_400_000;
};

// ---- the composer ------------------------------------------------------------------------------------------------------

/** What John edits at the desk. `to` is the address he sends to (the prospect's, unless he changes it). */
export type DeskEdit = { to: string; subject: string; body: string; linkedin_note: string };
export const DESK_LIMITS = { to: 320, subject: 300, body: 20000, linkedin_note: 300, skip_reason: 2000 } as const;

export const firstName = (d: Pick<Dossier, "prospect"> | null | undefined) => str(d?.prospect?.first_name);

/**
 * An empty composer: "Hey {first}," and his signature, nothing else. The signature is the track's own (a client's, or the
 * guest profile's as host of the podcast), so each track starts from its own blank; the body is always his to write.
 */
export function blankBody(first: string, signature: string | undefined, hello0?: string): string {
  const hello = hello0 ?? (first ? `Hey ${first},` : "Hey,");
  return signature?.trim() ? `${hello}\n\n\n\n${signature.trim()}` : `${hello}\n\n`;
}

/** Where the composer starts: his saved desk draft, else his own rewrite from a pipeline batch (variant john), else blank. */
export function prefill(dossier: Dossier, profile: Profile, desk: Pick<Draft, "subject" | "body" | "linkedin_note" | "prospect"> | null, own: Pick<Draft, "subject" | "body" | "linkedin_note"> | null, streamSignature?: string): DeskEdit & { from: "desk" | "own" | "blank" } {
  const to = str(dossier.prospect?.email);
  // Someone else's earlier text ends in the stream's signature; the signed-in account sends it under its own.
  const resign = (raw: string) => {
    const now = profile.signature?.trim();
    const nl = (t: string) => t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
    if (!streamSignature?.trim() || !now || nl(streamSignature) === nl(now)) return raw;
    const body = nl(raw);
    // The generator drops link-only signature lines and may put a P.S. after the sign-off, so match the signature either way.
    for (const was of [nl(streamSignature), nl(outreachSignature(streamSignature))]) {
      const at = was ? body.lastIndexOf(was) : -1;
      if (at < 0) continue;
      const tail = body.slice(at + was.length).trim();
      if (!tail || /^P\.?S\.?(?::|\s)/i.test(tail)) return `${body.slice(0, at)}${nl(now)}${tail ? `\n\n${tail}` : ""}`;
    }
    return raw;
  };
  if (desk) return { to: str(desk.prospect?.email) || to, subject: desk.subject, body: resign(desk.body), linkedin_note: desk.linkedin_note, from: "desk" };
  if (own) return { to, subject: own.subject, body: resign(own.body), linkedin_note: own.linkedin_note, from: "own" };
  // Through an intermediary the first line goes to whoever answers the organization's inbox, not to the guest.
  const viaOrg = dossier.track === "guest" && guestRoute(dossier) === "intermediary";
  return { to: viaOrg ? str(dossier.guest?.org_email) || to : to, subject: "", body: blankBody(firstName(dossier), profile.signature, viaOrg ? "Hello," : undefined), linkedin_note: "", from: "blank" };
}

/** Problems that stop a save (the database would refuse them). Advisory hints are separate. */
export function deskEditProblems(e: DeskEdit): string[] {
  const out: string[] = [];
  if (e.to.length > DESK_LIMITS.to) out.push("The address is too long.");
  if (e.subject.length > DESK_LIMITS.subject) out.push(`The subject is over ${DESK_LIMITS.subject} characters.`);
  if (e.body.length > DESK_LIMITS.body) out.push(`The email is over ${DESK_LIMITS.body} characters.`);
  if (e.linkedin_note.length > DESK_LIMITS.linkedin_note) out.push(`The LinkedIn note is ${e.linkedin_note.length} characters; LinkedIn allows ${DESK_LIMITS.linkedin_note}.`);
  return out;
}

/** How a guest is reached: the dossier's route, else email. */
export const guestRoute = (d: Pick<Dossier, "route"> | null | undefined): Route => ((ROUTES as readonly string[]).includes(str(d?.route)) ? (str(d?.route) as Route) : "email");

/**
 * What has to be there before a guest is marked sent, by route. An email needs what any email needs; a LinkedIn note needs the
 * note; an intermediary message goes through an organization's contact (often a form or a phone line), so it needs only the text.
 */
export function routeSendProblems(e: DeskEdit, route: Route): string[] {
  if (route === "email") return sendProblems(e);
  const out = deskEditProblems(e);
  if (route === "linkedin" && !e.linkedin_note.trim()) out.push("The LinkedIn note is empty.");
  if (route === "intermediary" && !e.body.trim()) out.push("The message is empty.");
  return out;
}

/** What has to be there before the email can be marked sent. */
export function sendProblems(e: DeskEdit): string[] {
  const out = deskEditProblems(e);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.to.trim())) out.push("Add the address it goes to.");
  if (!e.subject.trim()) out.push("Add a subject.");
  if (!e.body.trim()) out.push("The email is empty.");
  return out;
}

export const sameDeskEdit = (a: DeskEdit, b: DeskEdit) => a.to === b.to && a.subject === b.subject && a.body === b.body && a.linkedin_note === b.linkedin_note;

// ---- links ----------------------------------------------------------------------------------------------------------------
// The body is plain text with Markdown-style links, [text](https://url). Cmd/Ctrl+K wraps the selection; copying turns them
// into real links (HTML) for Gmail, with "text (url)" as the plain-text fallback.

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export type BodyLink = { text: string; url: string; start: number; end: number };
export function bodyLinks(body: string): BodyLink[] {
  return [...body.matchAll(LINK)].map((m) => ({ text: m[1], url: m[2], start: m.index!, end: m.index! + m[0].length }));
}
export const hasLinks = (body: string) => bodyLinks(body).length > 0;

/** "https://" added when he types a bare domain; null when it is not a web address. */
export function normalizeLinkUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  const u = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { const p = new URL(u); return p.hostname.includes(".") ? u : null; } catch { return null; }
}

/** Wrap body[start, end) as a link, or insert [fallback](url) at the cursor when nothing is selected. Selecting an existing
 *  link (or inside one) replaces its URL. Returns the new body and the cursor position after the link. */
export function applyLink(body: string, start: number, end: number, url: string, fallback: string): { body: string; cursor: number } {
  const hit = bodyLinks(body).find((l) => start >= l.start && end <= l.end && (start < l.end || start === end));
  if (hit) {
    const md = `[${hit.text}](${url})`;
    return { body: body.slice(0, hit.start) + md + body.slice(hit.end), cursor: hit.start + md.length };
  }
  const sel = body.slice(start, end);
  const lead = sel.match(/^\s*/)![0], trail = sel.match(/\s*$/)![0];
  const text = (sel.trim() || fallback).replace(/[[\]\n]/g, " ").trim() || url;
  const md = `${lead}[${text}](${url})${sel.trim() ? trail : ""}`;
  return { body: body.slice(0, start) + md + body.slice(end), cursor: start + md.length };
}

/** Remove a link, keeping its text. */
export function removeLink(body: string, link: Pick<BodyLink, "start" | "end" | "text">): string {
  return body.slice(0, link.start) + link.text + body.slice(link.end);
}

/** The body with each link read as its text, for counting and spelling. */
export const linkText = (body: string) => body.replace(LINK, "$1");
/** Plain-text email: "text (url)". */
export const bodyPlain = (body: string) => body.replace(LINK, (_m, t: string, u: string) => `${t} (${u})`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** HTML for the clipboard: paragraphs and line breaks as written, links as anchors. */
export function bodyHtml(body: string): string {
  const inline = (s: string) => {
    let out = "", at = 0;
    for (const m of s.matchAll(LINK)) {
      out += esc(s.slice(at, m.index)) + `<a href="${esc(m[2])}">${esc(m[1])}</a>`;
      at = m.index! + m[0].length;
    }
    return (out + esc(s.slice(at))).replace(/\n/g, "<br>");
  };
  return body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => `<p style="margin:0 0 1em">${inline(p)}</p>`).join("");
}

/** Words in the body, not counting his signature block when it ends the email. Links count as their text. */
export function wordCount(body: string, signature?: string): number {
  let text = linkText(body);
  const sig = signature?.trim();
  if (sig && text.trimEnd().endsWith(sig)) text = text.trimEnd().slice(0, -sig.length);
  return (text.match(/[A-Za-z0-9À-ɏ'’]+/g) ?? []).length;
}

export type Hints = { words: number; length: "short" | "ok" | "long"; british: string[]; wisdom: string[]; emDash: boolean; slots: number };
const WISDOM = /\b(wisdom[- ]?keepers?|elders?)\b/gi;
export const SLOT = /\{\{[^{}\n]+\}\}/g;
/**
 * Advisory only, never blocking: length against his gold examples, and British spellings (John writes American). Dashes are
 * his to use with a client. For a guest it also flags an em dash, the words "wisdom keeper" and "elder" (use them only if the
 * guest does; a flag, not a rule) and template slots still unfilled.
 */
export function hints(e: Pick<DeskEdit, "subject" | "body" | "linkedin_note">, signature?: string, track: Track = "client"): Hints {
  const words = wordCount(e.body, signature);
  const all = `${e.subject}\n${linkText(e.body)}\n${e.linkedin_note}`;
  const guest = track === "guest";
  return {
    words,
    length: words < WORDS.low ? "short" : words > WORDS.high ? "long" : "ok",
    british: findBritishSpellings(all),
    wisdom: guest ? [...new Set([...all.matchAll(WISDOM)].map((m) => m[1].toLowerCase()))] : [],
    emDash: guest && /\u2014/.test(all),
    slots: guest ? (all.match(SLOT) ?? []).length : 0,
  };
}

// ---- guest templates (outreach/01 to 04), carried in the guest profile ---------------------------------------------------

export const TEMPLATE_LABEL: Record<string, string> = { "01": "Operator", "02": "Governance research", "03": "Finance", "04": "Wisdom keeper" };
export type Scaffold = { id: string; label: string; subject: string; body: string };
/**
 * The scaffold the guest's template names (profile.templates['01'..'04']), or null when the guest has none or the profile
 * carries no text for it (the control is then hidden). A leading "Subject: ..." line becomes the subject; {{first_name}} and
 * {{company}} are filled from the dossier, every other {{slot}} is left for him.
 */
export function scaffoldFor(profile: Profile, d: Pick<Dossier, "guest" | "prospect"> | null | undefined): Scaffold | null {
  const id = str(d?.guest?.template);
  const text = profile.templates?.[id];
  if (!/^0[1-4]$/.test(id) || typeof text !== "string" || !text.trim()) return null;
  const first = str(d?.prospect?.first_name), company = str(d?.prospect?.company);
  const filled = text.replace(/\{\{first_name\}\}/g, first || "{{first_name}}").replace(/\{\{company\}\}/g, company || "{{company}}").replace(/\r\n/g, "\n");
  const m = filled.match(/^\s*(?:\*\*)?subject:(?:\*\*)?\s*(.*)\n+/i);
  return { id, label: TEMPLATE_LABEL[id] ?? id, subject: m ? m[1].trim() : "", body: (m ? filled.slice(m[0].length) : filled).trim() };
}

/** Gmail's compose window, signed in as the sending mailbox, with to, subject and body filled in. The URL can only carry
 *  plain text, so a body with links is left out: the desk copies it to the clipboard as HTML for him to paste. */
export function gmailComposeUrl(e: Pick<DeskEdit, "to" | "subject" | "body">, from: string = TRACK_DEFAULTS.client.from_address): string {
  const q = new URLSearchParams({ authuser: from, view: "cm", fs: "1", tf: "1", to: e.to.trim(), su: e.subject });
  if (!hasLinks(e.body)) q.set("body", e.body);
  return `https://mail.google.com/mail/?${q.toString()}`;
}

// ---- where to find a guest -------------------------------------------------------------------------------------------------

export type ReachKind = "linkedin" | "email" | "org_email" | "website" | "contact" | "handle" | "search";
/** One way to reach a guest. `found` is false for a search link John follows to find the real thing. */
export type ReachLink = { kind: ReachKind; label: string; href: string; copy?: string; found: boolean };

/** A web address as the dossier holds it: a bare host ("cybernetics.anu.edu.au") becomes https://host, anything else must already be http(s). */
export function siteUrl(v: string | null | undefined): string | null {
  const t = str(v);
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return safeUrl(t);
  return DOMAIN.test(cleanDomain(t) ?? "") ? `https://${t.replace(/^\/+/, "")}` : null;
}
const HANDLE_BASE: Record<string, (h: string) => string> = {
  x: (h) => `https://x.com/${h.replace(/^@/, "")}`, twitter: (h) => `https://x.com/${h.replace(/^@/, "")}`,
  instagram: (h) => `https://www.instagram.com/${h.replace(/^@/, "")}`,
};

/**
 * Every way to reach a guest that the dossier knows, best first: LinkedIn, their email, an organization address, their site, the
 * page to write to, other handles. When there is no LinkedIn or no way in at all, a search link stands in, so the desk never
 * leaves John with a name and nothing to click.
 */
export function guestReach(d: Dossier, name: string, company: string): ReachLink[] {
  const g = d.guest ?? {}, p = d.prospect ?? {};
  const out: ReachLink[] = [];
  const li = safeUrl(p.linkedin_url);
  const who = [name, company].filter(Boolean).join(" ");
  if (li) out.push({ kind: "linkedin", label: "LinkedIn", href: li, copy: li, found: true });
  else if (who) out.push({ kind: "search", label: "Find on LinkedIn", href: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(who)}`, found: false });
  const email = str(p.email), org = str(g.org_email);
  if (email) out.push({ kind: "email", label: email, href: `mailto:${email}`, copy: email, found: true });
  if (org && org !== email) out.push({ kind: "org_email", label: `${org} (organization)`, href: `mailto:${org}`, copy: org, found: true });
  const site = siteUrl(g.website) ?? (d.domain && !d.domain.endsWith(".guest.invalid") ? siteUrl(d.domain) : null);
  if (site) out.push({ kind: "website", label: cleanDomain(site) ?? site, href: site, copy: site, found: true });
  const contact = safeUrl(g.contact_url);
  if (contact && contact !== site) out.push({ kind: "contact", label: "Contact page", href: contact, copy: contact, found: true });
  for (const [k, v] of Object.entries(g.handles ?? {})) {
    const raw = str(v);
    const base = Object.hasOwn(HANDLE_BASE, k.toLowerCase()) ? HANDLE_BASE[k.toLowerCase()] : undefined;
    const href = !k || !raw ? null : safeUrl(/^https?:\/\//i.test(raw) ? raw : base?.(raw));
    if (href) out.push({ kind: "handle", label: k[0].toUpperCase() + k.slice(1), href, copy: href, found: true });
  }
  if (!out.some((l) => l.found) && who) out.push({ kind: "search", label: "Search the web", href: `https://www.google.com/search?q=${encodeURIComponent(`${who} contact`)}`, found: false });
  return out;
}

// ---- the draft row behind the desk ---------------------------------------------------------------------------------------

/** The prospect as gtm_outreach_drafts keeps it (what `gtm outreach queue` hands the senders). */
export function draftProspect(d: Dossier, to: string): Prospect {
  const p = d.prospect ?? {};
  return {
    first_name: p.first_name ?? null, last_name: p.last_name ?? null, title: p.title ?? null, company: p.company ?? d.company?.name ?? null,
    email: to.trim() || p.email || null, linkedin_url: p.linkedin_url ?? null, country: p.country ?? null, lane: p.lane ?? null,
    score: typeof p.score === "number" ? p.score : null, twenty_person_id: d.twenty_person_id,
  };
}
export function draftTrigger(d: Dossier): Trigger {
  const s = d.signal ?? {};
  return { what: s.text ?? null, date: s.date ?? null, url: s.url ?? null };
}
export function draftStrategy(d: Dossier): Strategy {
  const b = d.brief ?? {};
  return { problem: b.problem ?? null, proof: null, why_now: b.why_now ?? null, door: b.door_questions?.[0] ?? null, asset: b.asset?.url ?? null };
}
/** The domain a desk draft is filed under: the dossier's, else the prospect's email domain. */
export function draftDomain(row: Pick<DossierRow, "domain">, to: string): string | null {
  const d = row.domain ?? emailDomain(to);
  return d && DOMAIN.test(d) ? d : null;
}

/** A pipeline draft about this person: their Twenty id when it has one, else the same company domain. */
export function isAbout(draft: Pick<Draft, "domain" | "prospect">, personId: string, domain: string | null): boolean {
  const pid = draft.prospect?.twenty_person_id;
  if (pid) return pid === personId;
  return !!domain && draft.domain === domain;
}

export const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);
