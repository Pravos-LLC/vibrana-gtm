import { loadRuntimeConfig } from "../runtime-config.mjs";
// Sunday candidates in the database (VIB-420): put a week's drafts, list them, and the three things John does
// with one in the cockpit: edit it inline, reject it with a reason, or send it to review.
//
// Send to Review stages the candidate through the same writer as `gtm story stage` (lib/story.ts writeStory):
// a Story, one copy asset per channel with a pending approval, and one `drafted` calendar item per channel, so
// the piece shows up in /content like any other. It never approves or schedules anything. The decision is
// claimed first (a conditional update from `candidate`), so a double click or two tabs stage it once.
import type { SupabaseClient } from "@supabase/supabase-js";
import { weekOfDate } from "../calendar";
import { must } from "../db";
import { actOnStory } from "../signals/actions";
import { seasonStoryPrefix } from "../season-id";
import { digest, writeStory, type PlannedAsset } from "../story";
import { addDays } from "../week";
import type { CandidateFormat, CandidatePillar, Lens, Source } from "./select";
import { REJECT_REASONS, type RejectReason } from "./reasons";
import { candidateProblems, EDITABLE, putProblems, slidesProblems, videoProblems, voiceProblems, type CandidateInput, type Editable, type Problems, type Rubric, type SlideDeck, type VideoScript } from "./validate";

export type CandidateStatus = "candidate" | "accepted" | "rejected";
export type CandidateRow = {
  id: string; week_start: string; slug: string; position: number; status: CandidateStatus;
  format: CandidateFormat; lens: Lens; pillar: CandidatePillar; channels: string[]; title: string;
  body: string; instagram: string | null; slides: SlideDeck | null; video: VideoScript | null;
  sources: Source[]; rubric: Rubric; score: number | null; playbook: Record<string, string>;
  signal_id: string | null; report_action_id: string | null;
  agent_draft: Partial<Record<Editable, unknown>>; edits: CandidateEdit[];
  reject_reason: RejectReason | null; reject_note: string | null;
  gtm_story_id: string | null; content_item_ids: string[];
  decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string;
};
export type CandidateEdit = { at: string; by: string; field: Editable; before: unknown; after: unknown };

export { REJECT_REASONS, type RejectReason };

export const CANDIDATE_COLUMNS = "id,week_start,slug,position,status,format,lens,pillar,channels,title,body,instagram,slides,video,sources,rubric,score,playbook,signal_id,report_action_id,agent_draft,edits,reject_reason,reject_note,gtm_story_id,content_item_ids,decided_by,decided_at,created_at,updated_at";

const DEFAULT_CHANNELS: Record<CandidateFormat, string[]> = { text: ["linkedin"], carousel: ["linkedin", "instagram"], video: ["linkedin", "instagram", "youtube"] };
const draftOf = (c: Pick<CandidateInput, Editable>) => ({ title: c.title, body: c.body, instagram: c.instagram ?? null, slides: c.slides ?? null, video: c.video ?? null });

export type PutResult = {
  dryRun: boolean; week_start: string; problems: Problems;
  written: string[]; kept: { slug: string; status: string; why: string }[]; email_id?: string | null; email_error?: string;
};

/**
 * Validates every candidate, then upserts the week. All or nothing: any error writes nothing. A candidate John
 * already decided, or already edited, is kept as it is (`--force` replaces an edited one, never a decided one).
 */
export async function putCandidates(db: SupabaseClient | null, weekStart: string, list: CandidateInput[], opts: { dryRun?: boolean; force?: boolean } = {}): Promise<Omit<PutResult, "email_id">> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 1) throw new Error(`week_start ${weekStart} is not a Monday`);
  const problems = putProblems(list);
  const { per: _per, ...summary } = problems;
  if (problems.errors.length || opts.dryRun || !db || !list.length) return { dryRun: Boolean(opts.dryRun), week_start: weekStart, problems: summary, written: [], kept: [] };
  const existing = must(await db.from("gtm_content_candidates").select("slug,status,edits").eq("week_start", weekStart), "existing candidates") as { slug: string; status: string; edits: unknown[] }[];
  const kept: PutResult["kept"] = [];
  const rows = [];
  for (const [i, c] of list.entries()) {
    const prior = existing.find((e) => e.slug === c.slug);
    if (prior && prior.status !== "candidate") { kept.push({ slug: c.slug, status: prior.status, why: `John already ${prior.status} it` }); continue; }
    if (prior && prior.edits?.length && !opts.force) { kept.push({ slug: c.slug, status: prior.status, why: "John edited it; --force replaces his edits" }); continue; }
    rows.push({
      week_start: weekStart, slug: c.slug, position: c.position ?? i, status: "candidate", format: c.format, lens: c.lens, pillar: c.pillar,
      channels: c.channels?.length ? c.channels : DEFAULT_CHANNELS[c.format], title: c.title.trim(), body: c.body,
      instagram: c.instagram ?? null, slides: c.slides ?? null, video: c.video ?? null, sources: c.sources, rubric: c.rubric ?? {},
      score: c.score ?? null, playbook: c.playbook ?? {}, signal_id: c.signal_id ?? null, report_action_id: c.report_action_id ?? null,
      agent_draft: draftOf(c), edits: [], updated_at: new Date().toISOString(),
    });
  }
  if (rows.length) must(await db.from("gtm_content_candidates").upsert(rows, { onConflict: "week_start,slug" }), "upsert candidates");
  return { dryRun: false, week_start: weekStart, problems: summary, written: rows.map((r) => r.slug), kept };
}

export async function listCandidates(db: SupabaseClient, filter: { week_start?: string; status?: string; limit?: number } = {}): Promise<CandidateRow[]> {
  let q = db.from("gtm_content_candidates").select(CANDIDATE_COLUMNS).order("week_start", { ascending: false }).order("position").limit(filter.limit ?? 50);
  if (filter.week_start) q = q.eq("week_start", filter.week_start);
  if (filter.status) q = q.eq("status", filter.status);
  return must(await q, "candidates") as CandidateRow[];
}

/** Candidates still waiting for John: the Today tile and the email both count these. */
export async function waitingCount(db: SupabaseClient): Promise<number> {
  const { count, error } = await db.from("gtm_content_candidates").select("id", { count: "exact", head: true }).eq("status", "candidate");
  if (error) throw new Error(`candidates: ${error.message}`);
  return count ?? 0;
}

async function load(db: SupabaseClient, id: string): Promise<CandidateRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("No such candidate.");
  const row = must(await db.from("gtm_content_candidates").select(CANDIDATE_COLUMNS).eq("id", id).maybeSingle(), "candidate") as CandidateRow | null;
  if (!row) throw new Error("No such candidate.");
  return row;
}

/**
 * John edits one field inline. Shape errors refuse the edit (a slides.json that would not render); voice findings
 * come back as warnings, because the text is now his. Every change is appended to `edits` next to the frozen
 * `agent_draft`, so agent-versus-John is kept as voice signal. Refuses a stale page (the row changed since).
 */
export async function editCandidate(db: SupabaseClient, id: string, field: Editable, value: unknown, actor: string, expectedUpdatedAt?: string) {
  if (!(EDITABLE as readonly string[]).includes(field)) throw new Error("That part cannot be edited here.");
  const row = await load(db, id);
  if (row.status !== "candidate") throw new Error(`Already ${row.status}.`);
  if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(row.updated_at).getTime()) throw new Error("This candidate changed since the page loaded; reload and edit again.");
  const p: Problems = { errors: [], warnings: [], john_slots: 0 };
  let next: unknown = value;
  if (field === "title" || field === "body" || field === "instagram") {
    if (typeof value !== "string") throw new Error("Expected text.");
    next = field === "instagram" && !value.trim() ? null : field === "title" ? value.trim() : value;
    if ((field === "title" || field === "body") && !String(next).trim()) throw new Error(`The ${field} cannot be empty.`);
    if (typeof next === "string") voiceProblems(field, next, p);
  } else if (field === "slides") {
    try { next = typeof value === "string" ? JSON.parse(value) : value; } catch (e) { throw new Error(`slides.json is not valid JSON: ${(e as Error).message}`); }
    if (row.format !== "carousel") throw new Error("Only a carousel has slides.");
    slidesProblems("slides.json", next, p);
  } else if (field === "video") {
    try { next = typeof value === "string" ? JSON.parse(value) : value; } catch (e) { throw new Error(`The script is not valid JSON: ${(e as Error).message}`); }
    if (row.format !== "video") throw new Error("Only a video has a script.");
    videoProblems("video", next, p);
  }
  if (p.errors.some((e) => !/dash|banned/.test(e))) throw new Error(p.errors.filter((e) => !/dash|banned/.test(e)).join("; "));
  const warnings = [...p.warnings, ...p.errors.filter((e) => /dash|banned/.test(e))];
  if (JSON.stringify(row[field] ?? null) === JSON.stringify(next ?? null)) return { row, warnings, changed: false };
  const edit: CandidateEdit = { at: new Date().toISOString(), by: actor, field, before: row[field] ?? null, after: next ?? null };
  const updated = must(await db.from("gtm_content_candidates")
    .update({ [field]: next, edits: [...(row.edits ?? []), edit], updated_at: edit.at })
    .eq("id", id).eq("status", "candidate").eq("updated_at", row.updated_at).select(CANDIDATE_COLUMNS), "edit candidate") as CandidateRow[];
  if (!updated.length) throw new Error("This candidate changed while you were editing; reload and try again.");
  return { row: updated[0], warnings, changed: true };
}

/** Claims a candidate's decision, so it happens once however many requests race for it. */
async function claim(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<CandidateRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("No such candidate.");
  const claimed = must(await db.from("gtm_content_candidates").update(patch).eq("id", id).eq("status", "candidate").select(CANDIDATE_COLUMNS), "claim candidate") as CandidateRow[];
  if (claimed.length) return claimed[0];
  const cur = must(await db.from("gtm_content_candidates").select("status").eq("id", id).maybeSingle(), "candidate") as { status: string } | null;
  throw new Error(cur ? `Already ${cur.status}.` : "No such candidate.");
}

/** Reject with a reason. The reason is also a taste label on the signal it came from (gtm_signal_feedback); an idea promoted into it is freed. */
export async function rejectCandidate(db: SupabaseClient, id: string, reason: RejectReason, note: string | null, actor: string) {
  if (!REJECT_REASONS.some((r) => r.slug === reason)) throw new Error("Pick a reason.");
  const clean = note?.trim().slice(0, 2000) || null;
  const now = new Date().toISOString();
  const row = await claim(db, id, { status: "rejected", reject_reason: reason, reject_note: clean, decided_by: actor, decided_at: now, updated_at: now });
  const reopen = () => db.from("gtm_content_candidates").update({ status: "candidate", reject_reason: null, reject_note: null, decided_by: null, decided_at: null }).eq("id", id).eq("status", "rejected");
  // A candidate promoted from the Brainstorming Backlog frees its idea: back on the shortlist, promotable again
  // (promoted_at stays as history). Done before the signal label, so a failure can put both back.
  const { data: freed, error: ideaError } = await db.from("gtm_ideas").update({ promoted_candidate_id: null, status: "shortlisted", updated_at: now }).eq("promoted_candidate_id", id).select("id");
  if (ideaError) {
    await reopen();
    throw new Error(`could not free the idea it was promoted from: ${ideaError.message}`);
  }
  if (row.signal_id) {
    const { error } = await db.from("gtm_signal_feedback").insert({ story_id: row.signal_id, actor, action: "reject", reason: clean ? `${reason}: ${clean}` : reason, candidate_id: row.id });
    if (error) {
      await reopen();
      if (freed?.length) await db.from("gtm_ideas").update({ promoted_candidate_id: id, status: "in_production" }).in("id", freed.map((i) => i.id)).is("promoted_candidate_id", null);
      throw new Error(`could not record the reason: ${error.message}`);
    }
  }
  return row;
}

/** The Story and calendar rows a candidate becomes. Pure, so the shape is unit tested. */
export function candidateStory(c: CandidateRow, seasonId: string) {
  const storyId = `${seasonStoryPrefix(seasonId)}c${c.week_start.replaceAll("-", "").slice(2)}-${c.slug}`.slice(0, 80).replace(/-$/, "");
  const label = new Date(`${c.week_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const story = { id: storyId, title: `Candidate wk ${label} | ${c.title}`, link: loadRuntimeConfig().brand.websiteUrl, season_id: seasonId };
  // Tue, Wed, Thu of the week by position: a starting point John moves in the calendar.
  const date = addDays(c.week_start, 1 + (c.position % 3));
  const meta = { candidate_id: c.id, format: c.format, lens: c.lens, ...(c.slides ? { slides: c.slides } : {}), ...(c.video ? { video: c.video } : {}), sources: c.sources };
  const assets: PlannedAsset[] = [];
  const items = [];
  for (const channel of c.channels) {
    const body = channel === "instagram" && c.instagram ? c.instagram : c.body;
    const id = `${storyId}-${channel}`;
    const source = `candidates/${c.week_start}/${c.slug}/${channel}.md`;
    const bytes = Buffer.from(body, "utf8");
    assets.push({ id, title: `${channel === "linkedin" ? "LinkedIn" : channel === "instagram" ? "Instagram" : "YouTube"} text`, kind: "copy", source, channels: [channel],
      sha256: digest(bytes), abs: source, bytes: bytes.length, content: bytes, body, url: null, metadata: meta });
    const format = c.format === "carousel" ? (channel === "linkedin" ? "document" : "carousel") : c.format;
    items.push({ id, week: weekOfDate(date), date, time: null, pillar: c.pillar, title: c.title, format, channels: [channel], status: "drafted",
      story_id: storyId, story_assets: [id], copy_path: source, body, media: [], urls: {}, link: null, cta: null });
  }
  return { story, assets, items };
}

/**
 * Send to Review: claim, stage through writeStory, add the drafted calendar items, mark the signal drafted.
 * A failure releases the claim, and a retry is safe: the Story upsert keeps decisions and existing items stay.
 */
export async function sendToReview(db: SupabaseClient, id: string, actor: string) {
  const now = new Date().toISOString();
  const c = await claim(db, id, { status: "accepted", decided_by: actor, decided_at: now, updated_at: now });
  try {
    const problems = candidateProblems({ ...c, instagram: c.instagram ?? undefined } as CandidateInput);
    const blocking = problems.errors.filter((e) => !/dash|banned/.test(e)); // John's own edits may keep his wording
    if (blocking.length) throw new Error(blocking.join("; "));
    const season = must(await db.from("gtm_seasons").select("id").lte("starts_on", c.week_start).gte("ends_on", c.week_start).order("starts_on", { ascending: false }).limit(1).maybeSingle(), "season") as { id: string } | null;
    if (!season) throw new Error(`No season covers the week of ${c.week_start}; create it with \`gtm season set\` (or a brand.example.com migration) before sending candidates to review.`);
    const plan = candidateStory(c, season.id);
    await writeStory(db, plan.story, plan.assets);
    must(await db.from("gtm_content_items").upsert(plan.items.map((i) => ({ ...i, updated_at: now })), { onConflict: "id", ignoreDuplicates: true }), "drafted calendar items");
    if (c.signal_id) {
      // A retry after a partial failure must not label the signal twice.
      const sig = must(await db.from("gtm_signal_stories").select("status,gtm_story_id").eq("id", c.signal_id).maybeSingle(), "signal") as { status: string; gtm_story_id: string | null } | null;
      if (sig && !(sig.status === "drafted" && sig.gtm_story_id === plan.story.id)) await actOnStory(db, { id: c.signal_id, action: "drafted", actor, gtmStoryId: plan.story.id });
    }
    const done = must(await db.from("gtm_content_candidates").update({ gtm_story_id: plan.story.id, content_item_ids: plan.items.map((i) => i.id) }).eq("id", id).select(CANDIDATE_COLUMNS).single(), "record staging") as CandidateRow;
    return done;
  } catch (e) {
    const release = await db.from("gtm_content_candidates").update({ status: "candidate", decided_by: null, decided_at: null }).eq("id", id).eq("status", "accepted").is("gtm_story_id", null);
    const note = release.error ? ` (and it could not be reopened: ${release.error.message})` : "";
    throw new Error(`${(e as Error).message}${note}`);
  }
}

/** The agent's draft against what John sent on: one entry per field he changed. */
export function editDiff(c: Pick<CandidateRow, "agent_draft" | Editable>) {
  return EDITABLE.filter((f) => JSON.stringify(c.agent_draft?.[f] ?? null) !== JSON.stringify(c[f] ?? null)).map((f) => ({ field: f, agent: c.agent_draft?.[f] ?? null, john: c[f] ?? null }));
}
