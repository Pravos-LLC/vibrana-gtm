// Brainstorming Backlog (gtm_ideas, brand.example.com migration 20261013000000_gtm_ideas.sql): the shape of an idea, its
// validation, the board's grouping, and the Sunday candidate a content idea becomes when it is promoted.
// Pure, so the page, the server actions, the CLI and the tests share one definition. The database paths are in
// ./store.ts. No runtime imports, so a client component can use the constants and labels.
import type { CandidateInput } from "../candidates/validate";

export const IDEA_KINDS = ["content", "engagement", "lead_magnet", "tool", "other"] as const;
export const IDEA_STATUSES = ["idea", "shortlisted", "in_production", "shipped", "parked"] as const;
export const IDEA_PILLARS = ["proof", "perspective", "build", "lists"] as const;
export const IDEA_FORMATS = ["text", "carousel", "video", "newsletter", "app", "other"] as const;
export const IDEA_EFFORTS = ["s", "m", "l"] as const;
export const IDEA_LENSES = ["transformation", "thought_leadership", "regenerative"] as const;
/** Kinds that are built, not posted: they move through the statuses but are never promoted to a candidate. */
export const NOT_PROMOTABLE = ["lead_magnet", "tool"] as const;

export type IdeaKind = (typeof IDEA_KINDS)[number];
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type IdeaPillar = (typeof IDEA_PILLARS)[number];
export type IdeaFormat = (typeof IDEA_FORMATS)[number];
export type IdeaEffort = (typeof IDEA_EFFORTS)[number];
export type IdeaLens = (typeof IDEA_LENSES)[number];

export type Idea = {
  id: string; slug: string; title: string; summary: string; kind: IdeaKind; pillar: IdeaPillar | null; format: IdeaFormat | null;
  effort: IdeaEffort | null; impact: number | null; status: IdeaStatus; source_url: string | null; owner: string | null; tags: string[];
  promoted_candidate_id: string | null; promoted_at: string | null; created_by: string | null; created_at: string; updated_at: string;
};
/** What `gtm idea add`, the /ideas form and a seed file give: a title, and whatever else is known. */
export type NewIdea = { title: string; slug?: string } & Partial<Pick<Idea, "summary" | "kind" | "pillar" | "format" | "effort" | "impact" | "status" | "source_url" | "owner" | "tags" | "created_by">>;
/** The fields an update may change. The slug and the promotion link are not among them. */
export const PATCHABLE = ["title", "summary", "kind", "pillar", "format", "effort", "impact", "status", "source_url", "owner", "tags"] as const;
export type IdeaPatch = Partial<Pick<Idea, (typeof PATCHABLE)[number]>>;

export const IDEA_COLUMNS = "id,slug,title,summary,kind,pillar,format,effort,impact,status,source_url,owner,tags,promoted_candidate_id,promoted_at,created_by,created_at,updated_at";

export const STATUS_LABEL: Record<IdeaStatus, string> = { idea: "Idea", shortlisted: "Shortlisted", in_production: "In production", shipped: "Shipped", parked: "Parked" };
/** Board column headings: the first column holds the new, untriaged ideas. */
const COLUMN_LABEL: Record<IdeaStatus, string> = { ...STATUS_LABEL, idea: "New ideas" };
export const KIND_LABEL: Record<IdeaKind, string> = { content: "Content", engagement: "Engagement", lead_magnet: "Lead magnet", tool: "Tool", other: "Other" };
export const EFFORT_LABEL: Record<IdeaEffort, string> = { s: "Small", m: "Medium", l: "Large" };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z0-9][a-z0-9-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export const isUuid = (s: string) => UUID.test(s);

/** Comma or space separated tags as stored: lowercase words joined by dashes, no duplicates. */
export function parseTags(raw: string | string[] | undefined | null): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  return [...new Set(list.map((t) => t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-")).filter(Boolean))];
}

/** Problems with a new idea or a patch, in the words the CLI and the form show. Empty means it is valid. */
export function ideaProblems(row: IdeaPatch & { slug?: string }, opts: { partial?: boolean } = {}): string[] {
  const out: string[] = [];
  if (!opts.partial || row.title !== undefined) {
    if (typeof row.title !== "string" || !row.title.trim()) out.push("an idea needs a title");
    else if (row.title.trim().length > 300) out.push("the title is at most 300 characters");
  }
  if (row.slug !== undefined && !SLUG.test(row.slug)) out.push("slug must be lowercase letters, digits and dashes (at most 64)");
  if (row.summary != null && row.summary.length > 5000) out.push("the summary is at most 5000 characters");
  if (row.kind !== undefined && !one(IDEA_KINDS, row.kind)) out.push(`kind must be one of ${IDEA_KINDS.join(", ")}`);
  if (row.status !== undefined && !one(IDEA_STATUSES, row.status)) out.push(`status must be one of ${IDEA_STATUSES.join(", ")}`);
  if (row.pillar != null && !one(IDEA_PILLARS, row.pillar)) out.push(`pillar must be one of ${IDEA_PILLARS.join(", ")}`);
  if (row.format != null && !one(IDEA_FORMATS, row.format)) out.push(`format must be one of ${IDEA_FORMATS.join(", ")}`);
  if (row.effort != null && !one(IDEA_EFFORTS, row.effort)) out.push(`effort must be one of ${IDEA_EFFORTS.join(", ")}`);
  if (row.impact != null && !(Number.isInteger(row.impact) && row.impact >= 1 && row.impact <= 5)) out.push("impact is a whole number from 1 to 5");
  if (row.source_url != null && !(/^https?:\/\/\S+$/.test(row.source_url) && row.source_url.length <= 2000)) out.push("source must be an http(s) link");
  if (row.owner != null && (!row.owner.trim() || row.owner.length > 200)) out.push("owner is a name of at most 200 characters");
  if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.length > 20 || row.tags.some((t) => typeof t !== "string" || !TAG.test(t)))) out.push("tags are at most 20 lowercase words joined by dashes");
  return out;
}

/** The board: every status in order, each column sorted by impact (high first), then the cheaper effort, then newest. */
export function groupByStatus(ideas: Idea[]): { status: IdeaStatus; label: string; ideas: Idea[] }[] {
  const effort = (e: IdeaEffort | null) => (e ? IDEA_EFFORTS.indexOf(e) : 3);
  const sorted = [...ideas].sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0) || effort(a.effort) - effort(b.effort) || b.updated_at.localeCompare(a.updated_at));
  return IDEA_STATUSES.map((status) => ({ status, label: COLUMN_LABEL[status], ideas: sorted.filter((i) => i.status === status) }));
}

export type PromoteOptions = { week_start: string; lens?: IdeaLens; pillar?: IdeaPillar; source_url?: string; position?: number };

/** Why an idea cannot be promoted yet, or null. */
export function promoteBlocker(idea: Pick<Idea, "kind" | "pillar" | "source_url" | "promoted_candidate_id" | "status">, opts: Partial<PromoteOptions> = {}): string | null {
  if (idea.promoted_candidate_id) return "already promoted to a candidate";
  if (one(NOT_PROMOTABLE, idea.kind)) return `a ${KIND_LABEL[idea.kind].toLowerCase()} is built, not posted: move it to in production instead (a post about it is its own content idea)`;
  if (idea.status === "shipped" || idea.status === "parked") return `it is ${idea.status}; move it back to shortlisted first`;
  if (!(opts.pillar ?? idea.pillar)) return "set a pillar first (proof, perspective, build or lists)";
  if (!(opts.source_url ?? idea.source_url)) return "add a source link first: the case study, post or page the piece draws on";
  return null;
}

/**
 * The Sunday candidate a content idea becomes: a text brief in the week John picks, holding the idea's summary (or its
 * title) and nothing else. No [JOHN: ...] slot (John, 2026-10-13): a slot sent to review became a BLOCK finding in
 * /content. John edits it inline in /signals?view=candidates and sends it to review, or rejects it, like any other
 * candidate; the idea keeps its planned format.
 */
export function ideaCandidate(idea: Pick<Idea, "slug" | "title" | "summary" | "pillar" | "format" | "source_url">, opts: PromoteOptions): CandidateInput {
  const body = `${(idea.summary || idea.title).trim()}\n`;
  return {
    slug: `idea-${idea.slug}`.slice(0, 64).replace(/-$/, ""),
    title: idea.title.trim(),
    format: "text",
    lens: opts.lens ?? "transformation",
    pillar: (opts.pillar ?? idea.pillar)!,
    channels: ["linkedin"],
    body,
    sources: [{ title: idea.title.trim(), url: (opts.source_url ?? idea.source_url)!, source: "Brainstorming Backlog" }],
    rubric: null,
    position: opts.position,
  };
}
