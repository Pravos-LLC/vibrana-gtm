// Brainstorming Backlog in the database (gtm_ideas): add, list, update, promote and seed. Server and CLI only (the
// service client writes; the browser role can only read, and only as the owner).
//
// Promote hands a content idea to the Sunday candidates: it puts one text-brief candidate in the chosen week
// through the same validation as `gtm candidates put` (lib/candidates/validate.ts), then links it on the idea and
// moves the idea to in_production. The link is claimed with a conditional update, so two clicks promote once; the
// loser's candidate row is removed again. Nothing is approved or scheduled: the candidate goes through
// /signals?view=candidates and /content like every other one.
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "../candidates/select";
import { CANDIDATE_COLUMNS, type CandidateRow } from "../candidates/store";
import { candidateProblems } from "../candidates/validate";
import { must } from "../db";
import { IDEA_COLUMNS, ideaCandidate, ideaProblems, isUuid, parseTags, PATCHABLE, promoteBlocker, type Idea, type IdeaPatch, type NewIdea, type PromoteOptions } from "./model";

const now = () => new Date().toISOString();

export async function getIdea(db: SupabaseClient, ref: string): Promise<Idea> {
  const col = isUuid(ref) ? "id" : "slug";
  const row = must(await db.from("gtm_ideas").select(IDEA_COLUMNS).eq(col, ref).maybeSingle(), "idea") as Idea | null;
  if (!row) throw new Error(`No idea "${ref}".`);
  return row;
}

/** Insert a new idea. The slug comes from the title unless given; a taken slug is refused, never overwritten. */
export async function addIdea(db: SupabaseClient, input: NewIdea): Promise<Idea> {
  const row = {
    slug: input.slug ?? slugify(input.title ?? ""), title: (input.title ?? "").trim(), summary: (input.summary ?? "").trim(),
    kind: input.kind ?? "content", status: input.status ?? "idea", pillar: input.pillar ?? null, format: input.format ?? null,
    effort: input.effort ?? null, impact: input.impact ?? null, source_url: input.source_url?.trim() || null,
    owner: input.owner?.trim() || null, tags: parseTags(input.tags), created_by: input.created_by ?? null,
  };
  const problems = ideaProblems(row);
  if (problems.length) throw new Error(problems.join("; "));
  const { data, error } = await db.from("gtm_ideas").insert(row).select(IDEA_COLUMNS).single();
  if (error?.code === "23505") throw new Error(`An idea with the slug "${row.slug}" already exists; give it another title or --slug.`);
  if (error) throw new Error(`save idea: ${error.message}`);
  return data as unknown as Idea;
}

export async function listIdeas(db: SupabaseClient, filter: { status?: string; kind?: string; pillar?: string; tag?: string } = {}): Promise<Idea[]> {
  let q = db.from("gtm_ideas").select(IDEA_COLUMNS).order("updated_at", { ascending: false }).limit(500);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.pillar) q = q.eq("pillar", filter.pillar);
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  return must(await q, "ideas") as unknown as Idea[];
}

/** Change some fields of an idea. Unknown fields are refused; empty strings clear an optional field. */
export async function updateIdea(db: SupabaseClient, ref: string, patch: Record<string, unknown>): Promise<Idea> {
  const unknown = Object.keys(patch).filter((k) => !(PATCHABLE as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`cannot change ${unknown.join(", ")}`);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "tags") clean.tags = parseTags(v as string | string[]);
    else if (k === "impact") clean.impact = v === "" || v === null ? null : Number(v);
    else if (typeof v === "string" && ["pillar", "format", "effort", "source_url", "owner"].includes(k)) clean[k] = v.trim() || null;
    else if (typeof v === "string") clean[k] = v.trim();
    else clean[k] = v;
  }
  if (!Object.keys(clean).length) throw new Error("nothing to change");
  const problems = ideaProblems(clean as IdeaPatch, { partial: true });
  if (problems.length) throw new Error(problems.join("; "));
  const idea = await getIdea(db, ref);
  const updated = must(await db.from("gtm_ideas").update({ ...clean, updated_at: now() }).eq("id", idea.id).select(IDEA_COLUMNS), "update idea") as unknown as Idea[];
  if (!updated.length) throw new Error(`No idea "${ref}".`);
  return updated[0];
}

/**
 * Promote a content idea into the Sunday candidates for `week_start` (a Monday). Refused when the idea is not
 * ready (kind, pillar, source, already promoted) or the brief fails the candidate checks. Voice findings (dashes,
 * banned words) come back as warnings: the brief is John's to rewrite before he sends it on.
 */
export async function promoteIdea(db: SupabaseClient, ref: string, opts: PromoteOptions) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.week_start) || new Date(`${opts.week_start}T12:00:00Z`).getUTCDay() !== 1) throw new Error(`week ${opts.week_start} is not a Monday`);
  const idea = await getIdea(db, ref);
  const blocker = promoteBlocker(idea, opts);
  if (blocker) throw new Error(`Cannot promote "${idea.title}": ${blocker}.`);
  const last = must(await db.from("gtm_content_candidates").select("position").eq("week_start", opts.week_start).order("position", { ascending: false }).limit(1), "week positions") as { position: number }[];
  const input = ideaCandidate(idea, { ...opts, position: (last[0]?.position ?? -1) + 1 });
  const p = candidateProblems(input);
  const blocking = p.errors.filter((e) => !/dash|banned/.test(e));
  if (blocking.length) throw new Error(`Cannot promote "${idea.title}": ${blocking.join("; ")}`);
  const warnings = [...p.errors.filter((e) => /dash|banned/.test(e)), ...p.warnings.filter((w) => !/no rubric report/.test(w))];
  const draft = { title: input.title, body: input.body, instagram: null, slides: null, video: null };
  const { data, error } = await db.from("gtm_content_candidates").insert({
    week_start: opts.week_start, slug: input.slug, position: input.position, status: "candidate", format: input.format, lens: input.lens,
    pillar: input.pillar, channels: input.channels, title: input.title, body: input.body, sources: input.sources, rubric: {},
    playbook: {}, agent_draft: draft, edits: [],
  }).select(CANDIDATE_COLUMNS).single();
  if (error?.code === "23505") throw new Error(`The week of ${opts.week_start} already has a candidate "${input.slug}".`);
  if (error) throw new Error(`promote: ${error.message}`);
  const candidate = data as unknown as CandidateRow;
  const at = now();
  const claimed = must(await db.from("gtm_ideas")
    .update({ promoted_candidate_id: candidate.id, promoted_at: at, status: "in_production", updated_at: at })
    .eq("id", idea.id).is("promoted_candidate_id", null).select(IDEA_COLUMNS), "link candidate") as unknown as Idea[];
  if (!claimed.length) {
    await db.from("gtm_content_candidates").delete().eq("id", candidate.id).eq("status", "candidate");
    throw new Error(`Cannot promote "${idea.title}": already promoted to a candidate.`);
  }
  return { idea: claimed[0], candidate, warnings };
}

/**
 * Load a seed file (JSON array of NewIdea). Idempotent: an idea whose slug exists is left as it is, so a rerun
 * never overwrites what John changed in the cockpit.
 */
export async function seedIdeas(db: SupabaseClient | null, path: string, opts: { dryRun?: boolean } = {}) {
  const entries = JSON.parse(readFileSync(path, "utf8")) as NewIdea[];
  if (!Array.isArray(entries)) throw new Error(`${path}: expected a JSON array of ideas`);
  const rows = entries.map((e) => ({ ...e, slug: e.slug ?? slugify(e.title ?? ""), tags: parseTags(e.tags) }));
  const problems = rows.flatMap((r, i) => ideaProblems(r).map((m) => `${r.slug || `entry ${i + 1}`}: ${m}`));
  if (problems.length) throw new Error(problems.join("; "));
  if (opts.dryRun || !db) return { dryRun: Boolean(opts.dryRun), added: [] as string[], kept: [] as string[], would_add: rows.map((r) => r.slug) };
  const existing = new Set((must(await db.from("gtm_ideas").select("slug").in("slug", rows.map((r) => r.slug)), "existing ideas") as { slug: string }[]).map((r) => r.slug));
  const added: string[] = [];
  for (const r of rows.filter((r) => !existing.has(r.slug))) added.push((await addIdea(db, { ...r, created_by: r.created_by ?? "seed" })).slug);
  return { dryRun: false, added, kept: rows.filter((r) => existing.has(r.slug)).map((r) => r.slug), would_add: [] as string[] };
}
