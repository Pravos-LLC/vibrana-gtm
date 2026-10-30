// The writing desk in the database: dossier and profile imports (`gtm outreach import-dossiers|import-profile`), the
// queue, one person's desk, and John's actions (autosave, mark sent, LinkedIn invite sent, follow-up sent, skip, daily
// target). Server and CLI only: the service client writes; the browser role can only read, and only as the owner.
//
// Two streams (VIB-463): 'client' and 'guest'. Each person, desk draft, target, sender and profile belongs to one track
// (gtm_outreach_tracks); every read here is for one track, and an action that names a track refuses a person of the other.
// A guest is reached by one of three routes. Mark sent records it where the rest of the system already looks:
//   email         email_status 'sent' (the address, subject and body he wrote),
//   linkedin      linkedin_status 'sent' (the note he wrote; stamps linkedin_sent_at),
//   intermediary  email_status 'sent' with route 'intermediary' (an organization's contact took the message; stamps
//                 email_sent_at, so `gtm outreach queue|mark` and "sent today" need no special case; route says how).
// A follow-up is its own column (follow_up_status), so it never counts toward a target.
//
// John's text is a gtm_outreach_drafts row (batch 'desk', variant 'john', person = Twenty id), so the version trigger
// keeps every replaced text, and `gtm outreach queue|mark` and the LinkedIn runbook read it like any accepted draft.
// Marking a channel sent accepts the draft first (only an accepted draft is acted on, the table insists).
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import {
  buildQueue, DESK_BATCH, DESK_LIMITS, DESK_VARIANT, deskEditProblems, DOSSIER_COLUMNS, draftDomain, draftProspect, draftStrategy,
  draftTrigger, guestRoute, isAbout, isPersonId, parseDossiers, parseProfile, prefill, QUEUE_COLUMNS, routeSendProblems, sendProblems, TRACK_DEFAULTS, TRACKS,
  type DeskEdit, type DeskSettings, type DossierRow, type Profile, type QueueItem, type QueueRow, type Track,
} from "./desk";
import { DRAFT_COLUMNS, VERSION_COLUMNS, type Draft, type DraftVersion } from "./model";

const DRAFTS = "gtm_outreach_drafts";
const DOSSIERS = "gtm_outreach_dossiers";
const DESK = "gtm_outreach_desk"; // the old single row: only the client track's fallback until a later cleanup
const TRACKS_TABLE = "gtm_outreach_tracks";
const now = () => new Date().toISOString();

// ---- imports -----------------------------------------------------------------------------------------------------------

export type DossierImportResult = { dryRun: boolean; inserted: string[]; updated: string[]; total: number };

/**
 * `gtm outreach import-dossiers --file <path> [--track client|guest]`: upsert by Twenty person id. A re-import replaces the
 * dossier and its denormalized columns and never touches John's skip or his desk draft. The file must hold rows of the track
 * it is imported as, and a person already filed under the other track is refused (an id never changes stream).
 */
export async function importDossiers(db: SupabaseClient | null, text: string, opts: { dryRun?: boolean; track?: Track } = {}): Promise<DossierImportResult> {
  const track = opts.track ?? "client";
  const rows = parseDossiers(text, track);
  const ids = rows.map((r) => r.twenty_person_id);
  const existing = new Set<string>();
  if (db) {
    const other: string[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const page = must(await db.from(DOSSIERS).select("twenty_person_id,track").in("twenty_person_id", ids.slice(i, i + 200)), "existing dossiers") as Array<{ twenty_person_id: string; track: Track }>;
      for (const r of page) { existing.add(r.twenty_person_id); if (r.track !== track) other.push(r.twenty_person_id); }
    }
    if (other.length) throw new Error(`${other.join(", ")}: already filed under the other track, so a ${track} import cannot take them over`);
  }
  const result: DossierImportResult = { dryRun: Boolean(opts.dryRun) || !db, inserted: ids.filter((id) => !existing.has(id)), updated: ids.filter((id) => existing.has(id)), total: rows.length };
  if (opts.dryRun || !db) return result;
  // Dossiers carry full source text, so small chunks keep each request well under the API's body limit.
  for (let i = 0; i < rows.length; i += 25) {
    must(await db.from(DOSSIERS).upsert(rows.slice(i, i + 25), { onConflict: "twenty_person_id" }).select("twenty_person_id"), "upsert dossiers");
  }
  return result;
}

/** `gtm outreach import-profile --file <path> [--track client|guest]`: John's profile replaces the track's stored one. The target and sender are kept. */
export async function importProfile(db: SupabaseClient | null, text: string, opts: { dryRun?: boolean; track?: Track } = {}): Promise<{ dryRun: boolean; facts: number; proof: number; assets: number; gold_examples: number; templates: number }> {
  const track = opts.track ?? "client";
  const profile = parseProfile(text);
  const summary = { facts: profile.facts?.length ?? 0, proof: profile.proof?.length ?? 0, assets: profile.assets?.length ?? 0, gold_examples: profile.gold_examples?.length ?? 0, templates: Object.keys(profile.templates ?? {}).length };
  if (opts.dryRun || !db) return { dryRun: true, ...summary };
  const imported = { profile, profile_imported_at: now() };
  const rows = must(await db.from(TRACKS_TABLE).update(imported).eq("track", track).select("track"), "import profile") as unknown[];
  // The migration seeds both tracks; a missing row is made with the track's defaults, since sender and target are required.
  if (!rows.length) must(await db.from(TRACKS_TABLE).upsert({ track, ...TRACK_DEFAULTS[track], ...imported }, { onConflict: "track" }).select("track"), "import profile");
  return { dryRun: false, ...summary };
}

// ---- reads -------------------------------------------------------------------------------------------------------------

const SETTINGS_COLUMNS = "daily_target,from_address,profile,profile_imported_at";

/**
 * One track's settings: its row in gtm_outreach_tracks, else (client only) the old single desk row, else the defaults
 * (target 5 for clients, 2 for guests), so an empty table never leaves the desk without a target or a sender.
 */
export async function deskSettings(db: SupabaseClient, track: Track = "client"): Promise<DeskSettings> {
  const row = must(await db.from(TRACKS_TABLE).select(SETTINGS_COLUMNS).eq("track", track).maybeSingle(), "desk settings") as DeskSettings | null;
  if (row) return row;
  if (track === "client") {
    const old = must(await db.from(DESK).select("daily_target,profile,profile_imported_at").eq("id", true).maybeSingle(), "desk settings") as Omit<DeskSettings, "from_address"> | null;
    if (old) return { ...old, from_address: TRACK_DEFAULTS.client.from_address };
  }
  return { ...TRACK_DEFAULTS[track], profile: {}, profile_imported_at: null };
}

/** Both tracks' settings, for the page (both meters are always on screen). */
export async function deskTracks(db: SupabaseClient): Promise<Record<Track, DeskSettings>> {
  const [client, guest] = await Promise.all(TRACKS.map((t) => deskSettings(db, t)));
  return { client, guest };
}

/** Every desk draft of one track, light: what the queue and "sent today" need. */
async function deskDrafts(db: SupabaseClient, track: Track) {
  const out: Array<Pick<Draft, "id" | "status" | "email_status" | "linkedin_status" | "follow_up_status"> & { person: string; track: Track; email_sent_at: string | null; linkedin_sent_at: string | null; follow_up_sent_at: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await db.from(DRAFTS).select("id,person,track,status,email_status,linkedin_status,email_sent_at,linkedin_sent_at,follow_up_status,follow_up_sent_at")
      .eq("batch", DESK_BATCH).eq("variant", DESK_VARIANT).eq("track", track).order("id").range(from, from + 999), "desk drafts") as typeof out;
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** One track's queue, highest score first, each person with their desk state. */
export async function deskQueue(db: SupabaseClient, track: Track = "client"): Promise<QueueItem[]> {
  const rows: QueueRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await db.from(DOSSIERS).select(QUEUE_COLUMNS).eq("track", track).order("score", { ascending: false, nullsFirst: false }).order("name").range(from, from + 999), "dossiers") as unknown as QueueRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return buildQueue(rows, await deskDrafts(db, track), track);
}

/** Everything the desk shows for one person. */
export type DeskPerson = {
  row: DossierRow;
  draft: Draft | null;
  versions: DraftVersion[];
  /** Pipeline drafts about this person (any batch), newest batch first: AI drafts for reference, and John's own rewrites. */
  reference: Draft[];
  start: DeskEdit & { from: "desk" | "own" | "blank" };
};

export async function deskPerson(db: SupabaseClient, personId: string, profile: Profile, track?: Track): Promise<DeskPerson> {
  if (!isPersonId(personId)) throw new Error(`"${personId}" is not a Twenty person id`);
  const row = must(await db.from(DOSSIERS).select(DOSSIER_COLUMNS).eq("twenty_person_id", personId).maybeSingle(), "dossier") as unknown as DossierRow | null;
  if (!row) throw new Error("No dossier for this person. Import it with gtm outreach import-dossiers.");
  onTrack(row, track);
  const draft = must(await db.from(DRAFTS).select(DRAFT_COLUMNS).eq("batch", DESK_BATCH).eq("variant", DESK_VARIANT).eq("person", personId).maybeSingle(), "desk draft") as unknown as Draft | null;
  const versions = draft ? (must(await db.from("gtm_outreach_draft_versions").select(VERSION_COLUMNS).eq("draft_id", draft.id).order("created_at", { ascending: false }).limit(50), "draft history") as unknown as DraftVersion[]) : [];
  // Person id and domain are validated (a token and a hostname), so they are safe inside the filter.
  const ors = [`prospect->>twenty_person_id.eq.${personId}`, ...(row.domain ? [`domain.eq.${row.domain}`] : [])].join(",");
  const candidates = must(await db.from(DRAFTS).select(DRAFT_COLUMNS).neq("batch", DESK_BATCH).eq("track", row.track).or(ors).order("created_at", { ascending: false }).limit(100), "reference drafts") as unknown as Draft[];
  const reference = candidates.filter((d) => isAbout(d, personId, row.domain));
  const own = reference.find((d) => d.variant === DESK_VARIANT) ?? null;
  return { row, draft, versions, reference, start: prefill(row.dossier, profile, draft, own, (await deskSettings(db, row.track)).profile.signature) };
}

// ---- John's actions (the server actions check the owner claim first) --------------------------------------------------

/** The caller's stream must be the person's: a guest id sent as a client (or the reverse) is refused, never half-handled. */
function onTrack(row: Pick<DossierRow, "track">, track: Track | undefined) {
  if (track && row.track !== track) throw new Error(`This person is on the ${row.track} stream, not the ${track} stream.`);
}

async function dossierRow(db: SupabaseClient, personId: string, track?: Track): Promise<DossierRow> {
  if (!isPersonId(personId)) throw new Error(`"${personId}" is not a Twenty person id`);
  const row = must(await db.from(DOSSIERS).select(DOSSIER_COLUMNS).eq("twenty_person_id", personId).maybeSingle(), "dossier") as unknown as DossierRow | null;
  if (!row) throw new Error("No dossier for this person.");
  onTrack(row, track);
  return row;
}

async function deskDraft(db: SupabaseClient, personId: string): Promise<Draft | null> {
  return must(await db.from(DRAFTS).select(DRAFT_COLUMNS).eq("batch", DESK_BATCH).eq("variant", DESK_VARIANT).eq("person", personId).maybeSingle(), "desk draft") as unknown as Draft | null;
}

const fields = (row: DossierRow, e: DeskEdit) => ({
  subject: e.subject, body: e.body, linkedin_note: e.linkedin_note, prospect: draftProspect(row.dossier, e.to),
  // A guest's draft records how they are reached (the dossier's route); a client's stays at the column default.
  ...(row.track === "guest" ? { route: guestRoute(row.dossier) } : {}),
});

/**
 * Autosave: the first save creates John's desk draft (pending), later saves update it. Every replaced text is kept by
 * the version trigger. Once the email is sent the text is final.
 */
export async function saveDesk(db: SupabaseClient, personId: string, edit: DeskEdit, actor: string, profile: Profile = {}, track?: Track): Promise<Draft> {
  const problems = deskEditProblems(edit);
  if (problems.length) throw new Error(problems.join(" "));
  const row = await dossierRow(db, personId, track);
  const existing = await deskDraft(db, personId);
  if (existing) {
    const same = existing.subject === edit.subject && existing.body === edit.body && existing.linkedin_note === edit.linkedin_note && (existing.prospect?.email ?? "") === (edit.to.trim() || row.dossier.prospect?.email || "");
    if (same) return existing;
    if (existing.email_status !== "none") throw new Error("This email was already sent, so it can't change any more.");
    // A guest's LinkedIn note is final once it is sent (the client's invite stays editable, as before).
    if (row.track === "guest" && (existing.linkedin_status === "sent" || existing.linkedin_status === "connected")) throw new Error("This note was already sent, so it can't change any more.");
    const rows = must(await db.from(DRAFTS).update({ ...fields(row, edit), edited_by: actor, edited_at: now() })
      .eq("id", existing.id).eq("email_status", "none").select(DRAFT_COLUMNS), "save") as unknown as Draft[];
    if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
    return rows[0];
  }
  const domain = draftDomain(row, edit.to);
  if (!domain) throw new Error("This person has no company domain or email address, so the draft has nowhere to be filed. Add their email first.");
  const start = prefill(row.dossier, profile, null, null);
  const { data, error } = await db.from(DRAFTS).insert({
    batch: DESK_BATCH, domain, variant: DESK_VARIANT, person: personId, model: "", track: row.track, ...fields(row, edit),
    trigger: draftTrigger(row.dossier), strategy: draftStrategy(row.dossier),
    // The empty composer is the "original", so a diff shows what John wrote.
    original_subject: start.subject, original_body: start.body, edited_by: actor, edited_at: now(),
  }).select(DRAFT_COLUMNS);
  if (error?.code === "23505") return saveDesk(db, personId, edit, actor, profile, track); // a second tab created it first
  if (error) throw new Error(`save: ${error.message}`);
  return (data as unknown as Draft[])[0];
}

/** Save, then accept (only an accepted draft can be acted on). Returns the accepted draft. */
async function readyDesk(db: SupabaseClient, personId: string, edit: DeskEdit, actor: string, profile: Profile, track?: Track): Promise<Draft> {
  const saved = await saveDesk(db, personId, edit, actor, profile, track);
  if (saved.status === "accepted") return saved;
  const { data, error } = await db.rpc("gtm_outreach_accept", { p_id: saved.id, p_actor: actor });
  if (error) throw new Error(`ready: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) as Draft;
}

/** "Mark sent": John sent it from Gmail. Counts toward today. */
export async function markDeskEmailSent(db: SupabaseClient, personId: string, edit: DeskEdit, actor: string, profile: Profile = {}, track?: Track): Promise<Draft> {
  const problems = sendProblems(edit);
  if (problems.length) throw new Error(problems.join(" "));
  const d = await readyDesk(db, personId, edit, actor, profile, track);
  const rows = must(await db.from(DRAFTS).update({ email_status: "sent" }).eq("id", d.id).eq("status", "accepted").in("email_status", ["none", "queued"]).select(DRAFT_COLUMNS), "mark sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This email was already marked sent.");
  return rows[0];
}

/** Undo a mistaken "Mark sent" (the email was not actually sent). */
export async function unmarkDeskEmailSent(db: SupabaseClient, personId: string, track?: Track): Promise<Draft> {
  await dossierRow(db, personId, track);
  const d = await deskDraft(db, personId);
  if (!d || d.email_status !== "sent") throw new Error("This email is not marked sent.");
  const rows = must(await db.from(DRAFTS).update({ email_status: "none", email_sent_at: null }).eq("id", d.id).eq("email_status", "sent").select(DRAFT_COLUMNS), "undo sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
  return rows[0];
}

/** "Mark invite sent": the LinkedIn connection request with his note went out. */
export async function markDeskLinkedinSent(db: SupabaseClient, personId: string, edit: DeskEdit, actor: string, profile: Profile = {}, track?: Track): Promise<Draft> {
  const problems = deskEditProblems(edit);
  if (problems.length) throw new Error(problems.join(" "));
  // The client stream's invite button only. A guest on the LinkedIn route is marked sent by its route (markDeskSent), which
  // records the route too, so undo can find it.
  if ((await dossierRow(db, personId, track)).track !== "client") throw new Error("Mark invite sent is for the client stream; a guest is marked sent by its route.");
  const d = await readyDesk(db, personId, edit, actor, profile, track);
  if (d.linkedin_status === "sent" || d.linkedin_status === "connected") return d;
  const rows = must(await db.from(DRAFTS).update({ linkedin_status: "sent" }).eq("id", d.id).eq("status", "accepted").select(DRAFT_COLUMNS), "mark invite sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
  return rows[0];
}

/**
 * "Mark sent" for either stream. A client is the email, as ever. A guest goes by the route their dossier names (see the top of
 * this file): email and intermediary set email_status, linkedin sets linkedin_status; each is checked for what that route needs.
 */
export async function markDeskSent(db: SupabaseClient, personId: string, edit: DeskEdit, actor: string, profile: Profile = {}, track?: Track): Promise<Draft> {
  const row = await dossierRow(db, personId, track);
  if (row.track === "client") return markDeskEmailSent(db, personId, edit, actor, profile, track);
  const route = guestRoute(row.dossier);
  const problems = routeSendProblems(edit, route);
  if (problems.length) throw new Error(problems.join(" "));
  const d = await readyDesk(db, personId, edit, actor, profile, track);
  const patch = route === "linkedin" ? { linkedin_status: "sent" } : { email_status: "sent" };
  const rows = must(await db.from(DRAFTS).update({ ...patch, route }).eq("id", d.id).eq("status", "accepted")
    .in(route === "linkedin" ? "linkedin_status" : "email_status", ["none", "queued"]).select(DRAFT_COLUMNS), "mark sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This was already marked sent.");
  return rows[0];
}

/** Undo a mistaken "Mark sent" on either stream (it was not actually sent). A follow-up has to be undone first. */
export async function unmarkDeskSent(db: SupabaseClient, personId: string, track?: Track): Promise<Draft> {
  const row = await dossierRow(db, personId, track);
  if (row.track === "client") return unmarkDeskEmailSent(db, personId, track);
  const d = await deskDraft(db, personId);
  if (!d) throw new Error("This is not marked sent.");
  if (d.follow_up_status === "sent") throw new Error("Mark the follow-up not sent first.");
  const linkedin = (d.route ?? guestRoute(row.dossier)) === "linkedin";
  if ((linkedin ? d.linkedin_status : d.email_status) !== "sent") throw new Error("This is not marked sent.");
  const patch = linkedin ? { linkedin_status: "none", linkedin_sent_at: null } : { email_status: "none", email_sent_at: null };
  const rows = must(await db.from(DRAFTS).update(patch).eq("id", d.id).eq(linkedin ? "linkedin_status" : "email_status", "sent").select(DRAFT_COLUMNS), "undo sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
  return rows[0];
}

/** "Mark follow-up sent": the single follow-up went out (7 to 10 days on, same thread). Never counts toward the target. */
export async function markDeskFollowUpSent(db: SupabaseClient, personId: string, track?: Track): Promise<Draft> {
  if ((await dossierRow(db, personId, track)).track !== "guest") throw new Error("Follow-ups are for the guest stream.");
  const d = await deskDraft(db, personId);
  if (!d || !(d.email_status === "sent" || d.email_status === "replied" || d.linkedin_status === "sent" || d.linkedin_status === "connected")) throw new Error("Mark the first message sent before its follow-up.");
  if (d.follow_up_status === "sent") return d;
  const rows = must(await db.from(DRAFTS).update({ follow_up_status: "sent" }).eq("id", d.id).eq("follow_up_status", "none").select(DRAFT_COLUMNS), "mark follow-up sent") as unknown as Draft[];
  if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
  return rows[0];
}

/** Undo a mistaken "Mark follow-up sent" (the database clears follow_up_sent_at). */
export async function unmarkDeskFollowUpSent(db: SupabaseClient, personId: string, track?: Track): Promise<Draft> {
  if ((await dossierRow(db, personId, track)).track !== "guest") throw new Error("Follow-ups are for the guest stream.");
  const d = await deskDraft(db, personId);
  if (!d || d.follow_up_status !== "sent") throw new Error("No follow-up is marked sent.");
  const rows = must(await db.from(DRAFTS).update({ follow_up_status: "none" }).eq("id", d.id).eq("follow_up_status", "sent").select(DRAFT_COLUMNS), "undo follow-up") as unknown as Draft[];
  if (!rows.length) throw new Error("This draft changed meanwhile; reload the page.");
  return rows[0];
}

/** Skip a person, with why (optional). Unskip clears it. A re-import keeps it. */
export async function skipPerson(db: SupabaseClient, personId: string, reason: string, actor: string, track?: Track): Promise<DossierRow> {
  if (reason.length > DESK_LIMITS.skip_reason) throw new Error(`The reason is over ${DESK_LIMITS.skip_reason} characters.`);
  await dossierRow(db, personId, track);
  const rows = must(await db.from(DOSSIERS).update({ skipped_at: now(), skip_reason: reason.trim(), skipped_by: actor }).eq("twenty_person_id", personId).select(DOSSIER_COLUMNS), "skip") as unknown as DossierRow[];
  return rows[0];
}
export async function unskipPerson(db: SupabaseClient, personId: string, track?: Track): Promise<DossierRow> {
  await dossierRow(db, personId, track);
  const rows = must(await db.from(DOSSIERS).update({ skipped_at: null, skip_reason: "", skipped_by: null }).eq("twenty_person_id", personId).select(DOSSIER_COLUMNS), "unskip") as unknown as DossierRow[];
  return rows[0];
}

/** One track's daily target. Whole numbers from 1 to 200, the table's own check. */
export async function setDailyTarget(db: SupabaseClient, target: number, actor: string, track: Track = "client"): Promise<number> {
  if (!Number.isInteger(target) || target < 1 || target > 200) throw new Error("The daily target is a whole number from 1 to 200.");
  const rows = must(await db.from(TRACKS_TABLE).update({ daily_target: target, updated_by: actor }).eq("track", track).select("daily_target"), "daily target") as Array<{ daily_target: number }>;
  if (rows.length) return rows[0].daily_target;
  const up = must(await db.from(TRACKS_TABLE).upsert({ track, ...TRACK_DEFAULTS[track], daily_target: target, updated_by: actor }, { onConflict: "track" }).select("daily_target"), "daily target") as Array<{ daily_target: number }>;
  return up[0].daily_target;
}
