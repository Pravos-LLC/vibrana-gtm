// Cold outreach drafts (gtm_outreach_drafts, brand.example.com migration 20261016230000_gtm_outreach_drafts.sql): the shape of
// a draft, validation of what the vibrana-crm pipeline imports, what an import does to each existing row, and the
// shapes `gtm outreach notes|queue` hand back. Pure, so the page, the server actions, the CLI and the tests share one
// definition. The database paths are in ./store.ts. No runtime imports, so a client component can use it.

export const OUTREACH_STATUSES = ["pending", "accepted", "rejected", "regenerate"] as const;
export const LINKEDIN_STATUSES = ["none", "queued", "sent", "connected", "skipped"] as const;
export const EMAIL_STATUSES = ["none", "queued", "sent", "replied"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
export type LinkedinOutreachStatus = (typeof LINKEDIN_STATUSES)[number];
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export type Prospect = {
  first_name?: string | null; last_name?: string | null; title?: string | null; company?: string | null; email?: string | null;
  linkedin_url?: string | null; country?: string | null; lane?: string | null; score?: number | null; twenty_person_id?: string | null;
};
export type Trigger = { what?: string | null; date?: string | null; url?: string | null };
export type Strategy = { problem?: string | null; proof?: string | null; why_now?: string | null; door?: string | null; asset?: string | null };
export type Followup = { day?: number | null; subject?: string | null; body?: string | null; topic?: string | null };
export type Claim = { claim?: string | null; source_url?: string | null; quote?: string | null };
export type Finding = { level: "block" | "advice"; code?: string | null; detail?: string | null };

export type Draft = {
  id: string; created_at: string; updated_at: string; batch: string; domain: string; variant: string;
  prospect: Prospect; trigger: Trigger; strategy: Strategy;
  subject: string; body: string; original_subject: string; original_body: string; linkedin_note: string;
  followups: Followup[]; claims: Claim[]; findings: Finding[]; model: string; version: number;
  status: OutreachStatus; note: string; decided_by: string | null; decided_at: string | null;
  edited_by: string | null; edited_at: string | null; linkedin_status: LinkedinOutreachStatus; email_status: EmailStatus;
  /** The Twenty person id on a writing-desk draft (one per person); '' on pipeline drafts (one per company). */
  person?: string;
  /** Set by the database the first time each channel is marked sent. */
  email_sent_at?: string | null; linkedin_sent_at?: string | null;
  /** The writing desk's stream (default 'client'), how a guest is reached, and the single follow-up (never counts toward the target). */
  track?: "client" | "guest"; route?: "email" | "linkedin" | "intermediary";
  follow_up_status?: "none" | "sent"; follow_up_sent_at?: string | null;
};
export const DRAFT_COLUMNS = "id,created_at,updated_at,batch,domain,variant,person,prospect,trigger,strategy,subject,body,original_subject,original_body,linkedin_note,followups,claims,findings,model,version,status,note,decided_by,decided_at,edited_by,edited_at,linkedin_status,email_status,email_sent_at,linkedin_sent_at,track,route,follow_up_status,follow_up_sent_at";

export type DraftVersion = {
  id: string; created_at: string; draft_id: string; version: number; reason: "edited" | "regenerated" | "reimported";
  subject: string; body: string; linkedin_note: string; followups: Followup[]; status: OutreachStatus; note: string; actor: string | null;
};
export const VERSION_COLUMNS = "id,created_at,draft_id,version,reason,subject,body,linkedin_note,followups,status,note,actor";

/** What John can change in /outreach. */
export type DraftEdit = { subject: string; body: string; linkedin_note: string; followups: Followup[] };

export const LIMITS = { subject: 300, body: 20000, linkedin_note: 300, note: 5000 } as const;
const BATCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A draft's identity across imports. */
export const draftKey = (d: { batch: string; domain: string; variant: string }) => `${d.batch}|${d.domain}|${d.variant}`;

/** One entry of the pipeline's JSON array, after normalization. */
export type ImportDraft = {
  batch: string; domain: string; variant: string; prospect: Prospect; trigger: Trigger; strategy: Strategy;
  subject: string; body: string; original_subject: string; original_body: string; linkedin_note: string;
  followups: Followup[]; claims: Claim[]; findings: Finding[]; model: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Normalize one pipeline entry: trimmed keys, a lowercase domain, "main" when no variant, empty collections when absent. */
export function normalizeImport(raw: Record<string, unknown>): ImportDraft {
  const subject = str(raw.subject), body = str(raw.body);
  return {
    batch: str(raw.batch).trim(), domain: str(raw.domain).trim().toLowerCase().replace(/^www\./, ""), variant: str(raw.variant).trim() || "main",
    prospect: (isObject(raw.prospect) ? raw.prospect : {}) as Prospect,
    trigger: (isObject(raw.trigger) ? raw.trigger : {}) as Trigger,
    strategy: (isObject(raw.strategy) ? raw.strategy : {}) as Strategy,
    subject, body,
    original_subject: raw.original_subject == null ? subject : str(raw.original_subject),
    original_body: raw.original_body == null ? body : str(raw.original_body),
    linkedin_note: str(raw.linkedin_note),
    followups: (Array.isArray(raw.followups) ? raw.followups : []) as Followup[],
    claims: (Array.isArray(raw.claims) ? raw.claims : []) as Claim[],
    findings: (Array.isArray(raw.findings) ? raw.findings : []) as Finding[],
    model: str(raw.model),
  };
}

/** Problems with one normalized entry, in the words the CLI prints. Empty means it can be imported. */
export function importProblems(d: ImportDraft, raw: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  if (!BATCH.test(d.batch)) out.push("batch is letters, digits and . _ : - (at most 80)");
  if (d.batch === "desk") out.push("batch \"desk\" is John's writing desk; the pipeline imports into its own batch");
  if (d.domain.length > 253 || !DOMAIN.test(d.domain)) out.push(`domain "${d.domain}" is not a hostname`);
  if (!VARIANT.test(d.variant)) out.push("variant is letters, digits and . _ : / - (at most 80)");
  if (!d.subject.trim()) out.push("no subject");
  if (!d.body.trim()) out.push("no body");
  if (d.subject.length > LIMITS.subject) out.push(`subject is over ${LIMITS.subject} characters`);
  if (d.body.length > LIMITS.body) out.push(`body is over ${LIMITS.body} characters`);
  if (d.linkedin_note.length > LIMITS.linkedin_note) out.push(`linkedin_note is ${d.linkedin_note.length} characters (LinkedIn allows ${LIMITS.linkedin_note})`);
  for (const k of ["prospect", "trigger", "strategy"] as const) if (raw[k] != null && !isObject(raw[k])) out.push(`${k} must be an object`);
  for (const k of ["followups", "claims", "findings"] as const) if (raw[k] != null && !Array.isArray(raw[k])) out.push(`${k} must be an array`);
  if (d.findings.some((f) => !isObject(f) || (f.level !== "block" && f.level !== "advice"))) out.push("each finding needs level 'block' or 'advice'");
  if (d.followups.some((f) => !isObject(f))) out.push("each follow-up is an object {day, subject, body, topic}");
  return out;
}

/** Parse the pipeline's file: a JSON array of drafts. Throws with every problem, keyed by domain/variant. */
export function parseImport(text: string): ImportDraft[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${(e as Error).message}`); }
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of drafts");
  const problems: string[] = [];
  const seen = new Set<string>();
  const rows = raw.map((r, i) => {
    if (!isObject(r)) { problems.push(`entry ${i + 1}: not an object`); return null; }
    const d = normalizeImport(r);
    const where = d.domain ? `${d.domain}/${d.variant}` : `entry ${i + 1}`;
    for (const p of importProblems(d, r)) problems.push(`${where}: ${p}`);
    if (seen.has(draftKey(d))) problems.push(`${where}: listed twice in batch ${d.batch}`);
    seen.add(draftKey(d));
    return d;
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return rows as ImportDraft[];
}

export type ImportAction =
  | { kind: "insert"; draft: ImportDraft }
  | { kind: "regenerate"; draft: ImportDraft; existing: Draft }
  | { kind: "refresh"; draft: ImportDraft; existing: Draft }
  | { kind: "keep"; draft: ImportDraft; existing: Draft; reason: string };

/**
 * What an import does to each draft. New: inserted. Sent back by John (regenerate): replaced, version + 1, pending again
 * (his note stays in the history). Pending and untouched: refreshed in place. Accepted, rejected, or pending with John's
 * edit: never overwritten.
 */
export function planImport(incoming: ImportDraft[], existing: Draft[]): ImportAction[] {
  const byKey = new Map(existing.map((d) => [draftKey(d), d]));
  return incoming.map((draft): ImportAction => {
    const e = byKey.get(draftKey(draft));
    if (!e) return { kind: "insert", draft };
    if (e.status === "regenerate") return { kind: "regenerate", draft, existing: e };
    if (e.status === "accepted" || e.status === "rejected") return { kind: "keep", draft, existing: e, reason: `John ${e.status} it` };
    if (e.edited_at) return { kind: "keep", draft, existing: e, reason: "John edited it" };
    return { kind: "refresh", draft, existing: e };
  });
}

/** The columns an import writes from a pipeline entry. */
export const importContent = (d: ImportDraft) => ({
  prospect: d.prospect, trigger: d.trigger, strategy: d.strategy, subject: d.subject, body: d.body,
  original_subject: d.original_subject, original_body: d.original_body, linkedin_note: d.linkedin_note,
  followups: d.followups, claims: d.claims, findings: d.findings, model: d.model,
});

/** Problems with John's edit, in the words /outreach shows. */
export function editProblems(e: DraftEdit): string[] {
  const out: string[] = [];
  if (!e.subject.trim()) out.push("The subject is empty.");
  if (!e.body.trim()) out.push("The email is empty.");
  if (e.subject.length > LIMITS.subject) out.push(`The subject is over ${LIMITS.subject} characters.`);
  if (e.body.length > LIMITS.body) out.push(`The email is over ${LIMITS.body} characters.`);
  if (e.linkedin_note.length > LIMITS.linkedin_note) out.push(`The LinkedIn note is ${e.linkedin_note.length} characters; LinkedIn allows ${LIMITS.linkedin_note}.`);
  if (!Array.isArray(e.followups) || e.followups.some((f) => !isObject(f))) out.push("Follow-ups are malformed.");
  return out;
}

export const sameEdit = (a: DraftEdit, b: DraftEdit) =>
  a.subject === b.subject && a.body === b.body && a.linkedin_note === b.linkedin_note && JSON.stringify(a.followups) === JSON.stringify(b.followups);
export const editOf = (d: Pick<Draft, "subject" | "body" | "linkedin_note" | "followups">): DraftEdit =>
  ({ subject: d.subject, body: d.body, linkedin_note: d.linkedin_note, followups: d.followups ?? [] });

/** John changed the agent's subject or body. */
export const isEdited = (d: Pick<Draft, "subject" | "body" | "original_subject" | "original_body">) => d.subject !== d.original_subject || d.body !== d.original_body;
/** Only an accepted draft with nothing sent yet can still be reopened or changed. */
export const actedOn = (d: Pick<Draft, "linkedin_status" | "email_status">) => d.linkedin_status !== "none" || d.email_status !== "none";

/** `gtm outreach notes`: what the pipeline needs to regenerate a draft John sent back. */
export function noteExport(d: Draft) {
  const edited = isEdited(d);
  return {
    id: d.id, batch: d.batch, domain: d.domain, variant: d.variant, version: d.version, model: d.model, note: d.note,
    subject: d.subject, body: d.body, original_subject: d.original_subject, original_body: d.original_body,
    edited, edited_subject: edited ? d.subject : null, edited_body: edited ? d.body : null,
  };
}

export const prospectName = (p: Prospect) => [p.first_name, p.last_name].filter((x) => x && String(x).trim()).join(" ").trim();

/** `gtm outreach queue linkedin|email`: accepted drafts not yet acted on that have what the channel needs. */
type QueueBase = { id: string; batch: string; domain: string; variant: string; name: string; company: string | null };
export type LinkedinQueueRow = QueueBase & { linkedin_url: string; linkedin_note: string; linkedin_status: LinkedinOutreachStatus };
export type EmailQueueRow = QueueBase & { email: string; subject: string; body: string; followups: Followup[]; email_status: EmailStatus };
export function queueRows(drafts: Draft[], channel: "linkedin"): LinkedinQueueRow[];
export function queueRows(drafts: Draft[], channel: "email"): EmailQueueRow[];
export function queueRows(drafts: Draft[], channel: "linkedin" | "email"): LinkedinQueueRow[] | EmailQueueRow[];
export function queueRows(drafts: Draft[], channel: "linkedin" | "email"): LinkedinQueueRow[] | EmailQueueRow[] {
  const base = (d: Draft): QueueBase => ({ id: d.id, batch: d.batch, domain: d.domain, variant: d.variant, name: prospectName(d.prospect), company: d.prospect.company ?? null });
  if (channel === "linkedin") {
    return drafts.filter((d) => d.track !== "guest" && d.status === "accepted" && (d.linkedin_status === "none" || d.linkedin_status === "queued") && d.prospect.linkedin_url && d.linkedin_note.trim())
      .map((d) => ({ ...base(d), linkedin_url: d.prospect.linkedin_url!, linkedin_note: d.linkedin_note, linkedin_status: d.linkedin_status }));
  }
  return drafts.filter((d) => d.track !== "guest" && d.status === "accepted" && (d.email_status === "none" || d.email_status === "queued") && d.prospect.email)
    .map((d) => ({ ...base(d), email: d.prospect.email!, subject: d.subject, body: d.body, followups: d.followups, email_status: d.email_status }));
}

/** Batches, newest first (by the newest draft in each). */
export function batchesOf(rows: Array<{ batch: string; created_at: string }>): string[] {
  const latest = new Map<string, string>();
  for (const r of rows) if (!latest.has(r.batch) || r.created_at > latest.get(r.batch)!) latest.set(r.batch, r.created_at);
  return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).map(([b]) => b);
}

/** One card per prospect: its variants side by side, undecided prospects first, then by score, then by name. */
export type ProspectGroup = { key: string; domain: string; batch: string; drafts: Draft[] };
export function groupByProspect(drafts: Draft[]): ProspectGroup[] {
  const groups = new Map<string, ProspectGroup>();
  for (const d of drafts) {
    // Desk drafts are one per person, so two people at one company are two cards, never two "variants".
    const key = d.person ? `${d.batch}|${d.domain}|${d.person}` : `${d.batch}|${d.domain}`;
    const g = groups.get(key) ?? { key, domain: d.domain, batch: d.batch, drafts: [] };
    g.drafts.push(d);
    groups.set(key, g);
  }
  const open = (g: ProspectGroup) => g.drafts.some((d) => d.status === "pending" || d.status === "regenerate") && !g.drafts.some((d) => d.status === "accepted");
  const score = (g: ProspectGroup) => Math.max(...g.drafts.map((d) => Number(d.prospect.score ?? -1)));
  for (const g of groups.values()) g.drafts.sort((a, b) => (a.variant === "main" ? -1 : b.variant === "main" ? 1 : a.variant.localeCompare(b.variant)));
  return [...groups.values()].sort((a, b) => Number(open(b)) - Number(open(a)) || score(b) - score(a) || a.domain.localeCompare(b.domain));
}

export const STATUS_LABEL: Record<OutreachStatus, string> = { pending: "To review", accepted: "Accepted", rejected: "Rejected", regenerate: "Sent back" };
