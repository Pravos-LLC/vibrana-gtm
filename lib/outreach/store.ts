// Cold outreach drafts in the database (gtm_outreach_drafts): import from the vibrana-crm pipeline, list, John's
// decisions from /outreach, the notes export, the action queues and their status marks. Server and CLI only (the
// service client writes; the browser role can only read, and only as the owner). Pure rules are in ./model.ts.
//
// History is the database's job: a trigger keeps every replaced text in gtm_outreach_draft_versions ("edited" by a
// person, "regenerated" by the pipeline with John's note, "reimported"). Accept goes through gtm_outreach_accept, which
// rejects the sibling variants in the same transaction.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import {
  actedOn, batchesOf, DRAFT_COLUMNS, editOf, editProblems, EMAIL_STATUSES, importContent, isUuid, LIMITS, LINKEDIN_STATUSES, noteExport, OUTREACH_STATUSES,
  parseImport, planImport, queueRows, sameEdit, VERSION_COLUMNS,
  type Draft, type DraftEdit, type DraftVersion, type EmailQueueRow, type EmailStatus, type LinkedinQueueRow, type ImportDraft, type LinkedinOutreachStatus, type OutreachStatus,
} from "./model";

const now = () => new Date().toISOString();
const TABLE = "gtm_outreach_drafts";

export type Filter = { batch?: string; status?: string };

export async function listDrafts(db: SupabaseClient, f: Filter = {}): Promise<Draft[]> {
  if (f.status && !(OUTREACH_STATUSES as readonly string[]).includes(f.status)) throw new Error(`status must be one of ${OUTREACH_STATUSES.join(", ")}`);
  const out: Draft[] = [];
  // Pages of 1000 (the API's row cap), so a large batch is never cut short.
  for (let from = 0; ; from += 1000) {
    let q = db.from(TABLE).select(DRAFT_COLUMNS).order("batch").order("domain").order("variant").range(from, from + 999);
    if (f.batch) q = q.eq("batch", f.batch);
    if (f.status) q = q.eq("status", f.status);
    const page = must(await q, "outreach drafts") as unknown as Draft[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function getDraft(db: SupabaseClient, id: string): Promise<Draft> {
  if (!isUuid(id)) throw new Error(`"${id}" is not a draft id (a uuid; see gtm outreach list --json)`);
  const row = must(await db.from(TABLE).select(DRAFT_COLUMNS).eq("id", id).maybeSingle(), "outreach draft") as unknown as Draft | null;
  if (!row) throw new Error(`No outreach draft ${id}.`);
  return row;
}

/** Every batch, newest first. */
export async function listBatches(db: SupabaseClient): Promise<string[]> {
  const rows: Array<{ batch: string; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await db.from(TABLE).select("batch,created_at").order("created_at", { ascending: false }).range(from, from + 999), "outreach batches") as Array<{ batch: string; created_at: string }>;
    rows.push(...page);
    if (page.length < 1000) return batchesOf(rows);
  }
}

export async function draftVersions(db: SupabaseClient, ids: string[]): Promise<DraftVersion[]> {
  if (!ids.length) return [];
  const out: DraftVersion[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...(must(await db.from("gtm_outreach_draft_versions").select(VERSION_COLUMNS).in("draft_id", ids.slice(i, i + 200)).order("created_at"), "draft history") as unknown as DraftVersion[]));
  }
  return out;
}

export type ImportResult = {
  dryRun: boolean; inserted: string[]; regenerated: string[]; refreshed: string[];
  kept: Array<{ key: string; reason: string }>; raced: string[];
};
const label = (d: ImportDraft) => `${d.batch}/${d.domain}/${d.variant}`;

/**
 * `gtm outreach import <file.json>`: upsert by (batch, domain, variant). New drafts are inserted; a draft John sent back
 * is replaced (version + 1, pending again, his note kept in the history); an untouched pending draft is refreshed; an
 * accepted, rejected or edited draft is never overwritten. Each update is conditional on the row still being in the
 * state it was read in, so a decision John makes mid-import wins ("raced").
 */
export async function importDrafts(db: SupabaseClient | null, text: string, opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  const incoming = parseImport(text);
  const result: ImportResult = { dryRun: Boolean(opts.dryRun), inserted: [], regenerated: [], refreshed: [], kept: [], raced: [] };
  const existing: Draft[] = [];
  if (db) {
    for (const batch of [...new Set(incoming.map((d) => d.batch))]) {
      const domains = [...new Set(incoming.filter((d) => d.batch === batch).map((d) => d.domain))];
      for (let i = 0; i < domains.length; i += 200) {
        existing.push(...(must(await db.from(TABLE).select(DRAFT_COLUMNS).eq("batch", batch).eq("person", "").in("domain", domains.slice(i, i + 200)), "existing drafts") as unknown as Draft[]));
      }
    }
  }
  const plan = planImport(incoming, existing);
  for (const a of plan) if (a.kind === "keep") result.kept.push({ key: label(a.draft), reason: a.reason });
  if (opts.dryRun || !db) {
    for (const a of plan) if (a.kind !== "keep") result[a.kind === "insert" ? "inserted" : a.kind === "regenerate" ? "regenerated" : "refreshed"].push(label(a.draft));
    return result;
  }
  const inserts = plan.flatMap((a) => (a.kind === "insert" ? [a.draft] : []));
  for (let i = 0; i < inserts.length; i += 200) {
    const chunk = inserts.slice(i, i + 200);
    must(await db.from(TABLE).insert(chunk.map((d) => ({ batch: d.batch, domain: d.domain, variant: d.variant, ...importContent(d) }))).select("id"), "insert drafts");
    result.inserted.push(...chunk.map(label));
  }
  for (const a of plan) {
    if (a.kind === "regenerate") {
      const rows = must(await db.from(TABLE).update({
        ...importContent(a.draft), version: a.existing.version + 1, status: "pending", note: "",
        decided_by: null, decided_at: null, edited_by: null, edited_at: null,
      }).eq("id", a.existing.id).eq("status", "regenerate").eq("version", a.existing.version).select("id"), `regenerate ${label(a.draft)}`) as unknown[];
      (rows.length ? result.regenerated : result.raced).push(label(a.draft));
    } else if (a.kind === "refresh") {
      const rows = must(await db.from(TABLE).update(importContent(a.draft))
        .eq("id", a.existing.id).eq("status", "pending").is("edited_at", null).eq("version", a.existing.version).select("id"), `refresh ${label(a.draft)}`) as unknown[];
      (rows.length ? result.refreshed : result.raced).push(label(a.draft));
    }
  }
  return result;
}

/** `gtm outreach notes`: every draft John sent back, with his note and his edit, for the pipeline to regenerate. */
export async function regenerateNotes(db: SupabaseClient, batch?: string) {
  return (await listDrafts(db, { batch, status: "regenerate" })).map(noteExport);
}

/** `gtm outreach queue linkedin|email`: accepted drafts with what is needed to act. */
export async function actionQueue(db: SupabaseClient, channel: "linkedin", batch?: string): Promise<LinkedinQueueRow[]>;
export async function actionQueue(db: SupabaseClient, channel: "email", batch?: string): Promise<EmailQueueRow[]>;
export async function actionQueue(db: SupabaseClient, channel: "linkedin" | "email", batch?: string): Promise<LinkedinQueueRow[] | EmailQueueRow[]>;
export async function actionQueue(db: SupabaseClient, channel: "linkedin" | "email", batch?: string): Promise<LinkedinQueueRow[] | EmailQueueRow[]> {
  return queueRows(await listDrafts(db, { batch, status: "accepted" }), channel);
}

/** `gtm outreach mark <id> --linkedin S | --email S`. Only an accepted draft is acted on. */
export async function markDraft(db: SupabaseClient, id: string, mark: { linkedin?: string; email?: string }): Promise<Draft> {
  const patch: { linkedin_status?: LinkedinOutreachStatus; email_status?: EmailStatus } = {};
  if (mark.linkedin !== undefined) {
    if (!(LINKEDIN_STATUSES as readonly string[]).includes(mark.linkedin) || mark.linkedin === "none") throw new Error(`--linkedin is one of ${LINKEDIN_STATUSES.filter((s) => s !== "none").join(", ")}`);
    patch.linkedin_status = mark.linkedin as LinkedinOutreachStatus;
  }
  if (mark.email !== undefined) {
    if (!(EMAIL_STATUSES as readonly string[]).includes(mark.email) || mark.email === "none") throw new Error(`--email is one of ${EMAIL_STATUSES.filter((s) => s !== "none").join(", ")}`);
    patch.email_status = mark.email as EmailStatus;
  }
  if (!Object.keys(patch).length) throw new Error("give --linkedin sent|connected|skipped|queued or --email sent|replied|queued");
  const d = await getDraft(db, id);
  if (d.status !== "accepted") throw new Error(`${d.domain}/${d.variant} is ${d.status}; only an accepted draft is acted on`);
  const rows = must(await db.from(TABLE).update(patch).eq("id", id).eq("status", "accepted").select(DRAFT_COLUMNS), "mark draft") as unknown as Draft[];
  if (!rows.length) throw new Error(`${d.domain}/${d.variant} changed while marking; run it again`);
  return rows[0];
}

// ---- John's decisions from /outreach (the server actions check the owner claim first) ------------------------------

const friendly = (e: { message: string; code?: string } | null, what: string) => {
  if (!e) return null;
  if (/acted_only_when_accepted|already acted on/.test(e.message)) return new Error("This prospect was already contacted, so it can't change any more.");
  if (/one_accepted/.test(e.message)) return new Error("Another variant of this prospect is already accepted.");
  return new Error(`${what}: ${e.message}`);
};

/** Save John's edit (subject, body, LinkedIn note, follow-ups). A rejected or already-emailed draft cannot change. */
export async function saveEdit(db: SupabaseClient, id: string, edit: DraftEdit, actor: string): Promise<Draft> {
  const problems = editProblems(edit);
  if (problems.length) throw new Error(problems.join(" "));
  const d = await getDraft(db, id);
  if (sameEdit(editOf(d), edit)) return d;
  if (d.status === "rejected") throw new Error("This draft was rejected; undo that first to edit it.");
  if (d.email_status !== "none") throw new Error("This email was already sent, so it can't change any more.");
  const { data, error } = await db.from(TABLE).update({ ...edit, edited_by: actor, edited_at: now() })
    .eq("id", id).neq("status", "rejected").eq("email_status", "none").select(DRAFT_COLUMNS);
  const err = friendly(error, "save");
  if (err) throw err;
  if (!data?.length) throw new Error("This draft changed meanwhile; reload the page.");
  return data[0] as unknown as Draft;
}

/** Accept a variant with any pending edit; its siblings are rejected ("other variant chosen") in the same transaction. */
export async function acceptDraft(db: SupabaseClient, id: string, edit: DraftEdit | null, actor: string): Promise<{ draft: Draft; siblings: Draft[] }> {
  if (edit) {
    const problems = editProblems(edit);
    if (problems.length) throw new Error(problems.join(" "));
  }
  const d = await getDraft(db, id);
  if (edit && d.email_status !== "none" && !sameEdit(editOf(d), edit)) throw new Error("This email was already sent, so it can't change any more.");
  const { data, error } = await db.rpc("gtm_outreach_accept", {
    p_id: id, p_actor: actor,
    p_subject: edit?.subject ?? null, p_body: edit?.body ?? null, p_linkedin_note: edit?.linkedin_note ?? null, p_followups: edit?.followups ?? null,
  });
  const err = friendly(error, "accept");
  if (err) throw err;
  const draft = (Array.isArray(data) ? data[0] : data) as Draft;
  const siblings = must(await db.from(TABLE).select(DRAFT_COLUMNS).eq("batch", d.batch).eq("domain", d.domain).eq("person", d.person ?? "").neq("id", id), "variants") as unknown as Draft[];
  return { draft, siblings };
}

/** Reject, with an optional reason. A draft already contacted cannot be rejected. */
export async function rejectDraft(db: SupabaseClient, id: string, reason: string, actor: string): Promise<Draft> {
  if (reason.length > LIMITS.note) throw new Error(`The reason is over ${LIMITS.note} characters.`);
  return decide(db, id, { status: "rejected", note: reason.trim() }, actor, "reject");
}

/** Send back for regeneration with John's note (required). Any pending edit is saved first, so the pipeline sees it. */
export async function sendBack(db: SupabaseClient, id: string, note: string, edit: DraftEdit | null, actor: string): Promise<Draft> {
  if (!note.trim()) throw new Error("Write what should change.");
  if (note.length > LIMITS.note) throw new Error(`The note is over ${LIMITS.note} characters.`);
  if (edit) await saveEdit(db, id, edit, actor);
  return decide(db, id, { status: "regenerate", note: note.trim() }, actor, "send back");
}

/** Undo a decision: back to pending. Not once the prospect was contacted. */
export async function reopenDraft(db: SupabaseClient, id: string): Promise<Draft> {
  const d = await getDraft(db, id);
  if (actedOn(d)) throw new Error("This prospect was already contacted, so it can't change any more.");
  const { data, error } = await db.from(TABLE).update({ status: "pending", note: "", decided_by: null, decided_at: null })
    .eq("id", id).eq("linkedin_status", "none").eq("email_status", "none").select(DRAFT_COLUMNS);
  const err = friendly(error, "undo");
  if (err) throw err;
  if (!data?.length) throw new Error("This draft changed meanwhile; reload the page.");
  return data[0] as unknown as Draft;
}

async function decide(db: SupabaseClient, id: string, patch: { status: OutreachStatus; note: string }, actor: string, what: string): Promise<Draft> {
  const d = await getDraft(db, id);
  if (actedOn(d)) throw new Error("This prospect was already contacted, so it can't change any more.");
  const { data, error } = await db.from(TABLE).update({ ...patch, decided_by: actor, decided_at: now() })
    .eq("id", id).eq("linkedin_status", "none").eq("email_status", "none").select(DRAFT_COLUMNS);
  const err = friendly(error, what);
  if (err) throw err;
  if (!data?.length) throw new Error("This draft changed meanwhile; reload the page.");
  return data[0] as unknown as Draft;
}
