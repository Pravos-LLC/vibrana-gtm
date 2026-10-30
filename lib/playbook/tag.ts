import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// `gtm playbook tag` (VIB-421): tags each approved, scheduled or published calendar item with one hook,
// one storyline and one CTA from the content canon's taxonomy, so the weekly report can grade our posts
// against the channel playbooks. Same route as the Signal Desk briefs: OpenRouter, a strict JSON schema
// whose enums are the taxonomy ids, only providers that honor the schema. checkTags rejects any answer
// that names an unknown or retired id, so a tag in the database always resolves in the taxonomy.
//
// Tags are stored in gtm_content_items.playbook_tags with the sha256 of the body they describe. A row is
// tagged again when its body changes (the hash no longer matches), when its tags no longer resolve (the
// taxonomy retired an id), or with --all.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { splitFrontmatter } from "../frontmatter";
import { briefModel } from "../signals/brief";
import { CTA_IDS, CTAS, HOOK_IDS, HOOKS, STORYLINE_IDS, STORYLINES, TAXONOMY, type Awareness } from "./taxonomy";

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** What the model answers. */
export type RawTags = { hook: string; storyline: string; cta: string; rationale: string; confidence: string };
/** What is stored in playbook_tags. */
export type PlaybookTags = {
  hook: string; storyline: string; cta: string; cta_awareness: Awareness;
  rationale: string; confidence: Confidence;
  body_hash: string; taxonomy_version: number; model: string; tagged_at: string;
};

/** The statuses whose copy is final enough to tag: approved by John, queued in Zernio, or out. */
export const TAGGABLE_STATUSES = ["approved", "scheduled", "published"] as const;

export type TagRow = { id: string; title: string; pillar: string; format: string; channels: string[]; status: string; body: string | null; playbook_tags?: unknown };

/** sha256 of the body the tags describe. Whitespace at the ends does not count as a change. */
export const bodyHash = (body: string | null | undefined) => createHash("sha256").update((body ?? "").trim()).digest("hex");

// ---- the guard -------------------------------------------------------------------------------------------------

/**
 * Accepts the model's answer only when every id is a live taxonomy id and the confidence is known. The rationale
 * is cleaned (no em dashes, one line, at most 240 characters). Never repairs an id: an unknown one rejects the
 * whole answer, so the row stays untagged and is tried again on the next run.
 */
export function checkTags(raw: Partial<RawTags> | null | undefined): { ok: true; tags: Pick<PlaybookTags, "hook" | "storyline" | "cta" | "cta_awareness" | "rationale" | "confidence"> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "no answer" };
  const bad: string[] = [];
  const live = (m: Map<string, { retired?: boolean }>, id: unknown) => typeof id === "string" && m.has(id) && !m.get(id)!.retired;
  if (!live(HOOKS, raw.hook)) bad.push(`unknown hook ${JSON.stringify(raw.hook)}`);
  if (!live(STORYLINES, raw.storyline)) bad.push(`unknown storyline ${JSON.stringify(raw.storyline)}`);
  if (!live(CTAS, raw.cta)) bad.push(`unknown cta ${JSON.stringify(raw.cta)}`);
  if (!(CONFIDENCE as readonly string[]).includes(String(raw.confidence))) bad.push(`unknown confidence ${JSON.stringify(raw.confidence)}`);
  if (bad.length) return { ok: false, reason: bad.join("; ") };
  const rationale = String(raw.rationale ?? "").replace(/(\w*\d\w*)[—–](\w*\d\w*)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, 240);
  return { ok: true, tags: { hook: raw.hook!, storyline: raw.storyline!, cta: raw.cta!, cta_awareness: CTAS.get(raw.cta!)!.awareness, rationale, confidence: raw.confidence as Confidence } };
}

/** True when stored tags still resolve in the taxonomy and describe this exact body. */
export function tagsCurrent(tags: unknown, body: string | null): boolean {
  if (!tags || typeof tags !== "object") return false;
  const t = tags as Partial<PlaybookTags>;
  return t.body_hash === bodyHash(body) && checkTags(t as RawTags).ok;
}

/** The rows a run tags: approved, scheduled or published, with copy, and untagged, stale or (with `all`) any. */
export function selectRowsToTag<R extends TagRow>(rows: R[], opts: { all?: boolean } = {}): R[] {
  return rows.filter((r) => (TAGGABLE_STATUSES as readonly string[]).includes(r.status) && !!r.body?.trim() && (opts.all || !tagsCurrent(r.playbook_tags, r.body)));
}

// ---- the model call --------------------------------------------------------------------------------------------

const list = (entries: { id: string; name: string; definition: string; signals?: string[] }[]) =>
  entries.filter((e) => !(e as { retired?: boolean }).retired).map((e) => `- ${e.id}: ${e.name}. ${e.definition}${e.signals?.length ? ` Signals: ${e.signals.join("; ")}.` : ""}`).join("\n");

export const TAG_SYSTEM = `You classify one social post by Sample Author (Vibrana, an AI transformation consultancy) against the content canon's taxonomy.

Pick exactly one id from each list. Judge the copy as written, not what the author may have meant.
- hook: how the first line or two (or the opening of a video script) earns attention.
- storyline: the shape of the whole post.
- cta: how the post ends. A closing question to readers is open-question or pick-one; a link placed in the first comment, description or bio is soft-link; no request at all is none.
- rationale: one plain sentence, under 30 words, naming the words in the copy that decided it. No em dashes.
- confidence: high when the copy plainly matches the definitions, medium when two ids fit, low when none fits well.

Hooks:
${list(TAXONOMY.hooks)}

Storylines:
${list(TAXONOMY.storylines)}

CTAs:
${list(TAXONOMY.ctas)}`;

export const tagSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["hook", "storyline", "cta", "rationale", "confidence"],
  properties: {
    hook: { type: "string", enum: HOOK_IDS },
    storyline: { type: "string", enum: STORYLINE_IDS },
    cta: { type: "string", enum: CTA_IDS },
    rationale: { type: "string" },
    confidence: { type: "string", enum: [...CONFIDENCE] },
  },
});

/** The post as the model sees it: what it is and its copy (frontmatter removed, capped). */
export function tagPrompt(r: TagRow): string {
  const copy = splitFrontmatter(r.body ?? "").prose.slice(0, 8000);
  return `Title: ${r.title}\nFormat: ${r.format}\nChannels: ${r.channels.join(", ")}\nPillar: ${r.pillar}\n\n<copy>\n${copy}\n</copy>`;
}

export const tagModel = () => process.env.PLAYBOOK_TAG_MODEL || briefModel();
export type Tagger = (row: TagRow, opts?: { timeoutMs?: number }) => Promise<{ raw: RawTags; model: string }>;

/** OpenRouter chat completion with the strict tag schema. Throws on HTTP errors, refusals and truncation. */
export function openRouterTagger(opts: { key?: string; model?: string; fetcher?: typeof fetch } = {}): Tagger {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required for playbook tagging");
  const model = opts.model ?? tagModel();
  return async (row, call = {}) => {
    const res = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana playbook tags" },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        messages: [{ role: "system", content: TAG_SYSTEM }, { role: "user", content: tagPrompt(row) }],
        response_format: { type: "json_schema", json_schema: { name: "playbook_tags", strict: true, schema: tagSchema() } },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(60_000, call.timeoutMs ?? 60_000))),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[]; error?: { message?: string } } | null;
    if (!res.ok || !data?.choices?.[0]) throw new Error(`openrouter ${model}: ${res.status} ${data?.error?.message ?? ""}`.trim());
    const choice = data.choices[0];
    if (choice.message?.refusal) throw new Error(`tags declined by ${model}`);
    if (choice.finish_reason === "length") throw new Error(`tags truncated by ${model}`);
    try {
      return { raw: JSON.parse(choice.message?.content ?? "") as RawTags, model };
    } catch {
      throw new Error(`openrouter ${model}: unparseable tags (finish_reason ${choice.finish_reason ?? "unknown"})`);
    }
  };
}

// ---- the run ---------------------------------------------------------------------------------------------------

/** PostgREST's answer when a column is not in the table (the brand.example.com migration has not run there). */
const missingColumn = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42703" || e.code === "PGRST204" || /playbook_tags.*does not exist|could not find the 'playbook_tags' column/i.test(e.message ?? ""));
export const COLUMN_MISSING = "gtm_content_items.playbook_tags does not exist yet (the brand.example.com migration has not been applied); nothing was tagged";

export const NO_KEY = "OPENROUTER_API_KEY is not set";

export type TagResult = {
  dryRun: boolean; all: boolean; considered: number; selected: number; skipped?: string;
  tagged: { id: string; title: string; status: string; tags: PlaybookTags }[];
  rejected: { id: string; title: string; reason: string }[];
  errors: { id: string; error: string }[];
  deferred: string[];
};

/**
 * Tags the rows selectRowsToTag picks. `deadline` (epoch ms): no call starts within 5 s of it and each call's
 * timeout is capped at what is left; rows not reached are listed in `deferred` and tagged on the next run.
 * --dry-run calls the model and writes nothing; it also runs before the column exists (every row is untagged then).
 */
export async function tagPlaybook(db: SupabaseClient, opts: { all?: boolean; dryRun?: boolean; deadline?: number; limit?: number; tag?: Tagger; now?: Date } = {}): Promise<TagResult> {
  const deadline = opts.deadline ?? Infinity;
  const out: TagResult = { dryRun: !!opts.dryRun, all: !!opts.all, considered: 0, selected: 0, tagged: [], rejected: [], errors: [], deferred: [] };
  const cols = "id,title,pillar,format,channels,status,body";
  const read = (select: string) => db.from("gtm_content_items").select(select).in("status", [...TAGGABLE_STATUSES]).order("date");
  let res = await read(`${cols},playbook_tags`);
  let columnMissing = false;
  if (missingColumn(res.error)) {
    columnMissing = true;
    if (!opts.dryRun) return { ...out, skipped: COLUMN_MISSING };
    res = await read(cols);
  }
  const rows = must(res, "content items to tag") as unknown as TagRow[];
  out.considered = rows.length;
  let due = selectRowsToTag(rows, { all: opts.all });
  if (opts.limit && opts.limit > 0) due = due.slice(0, opts.limit);
  out.selected = due.length;
  if (columnMissing) out.skipped = "dry run only: " + COLUMN_MISSING.replace("; nothing was tagged", "");
  if (!due.length) return out;
  // Created only when there is work, so a day with nothing to tag needs no key. Without a key, skip and say so.
  if (!opts.tag && !process.env.OPENROUTER_API_KEY) return { ...out, skipped: `${NO_KEY}; ${due.length} ${due.length === 1 ? "item" : "items"} left untagged` };
  const tag = opts.tag ?? openRouterTagger();
  for (const row of due) {
    const left = deadline - Date.now();
    if (left < 5000) { out.deferred.push(row.id); continue; }
    try {
      const { raw, model } = await tag(row, { timeoutMs: Math.min(60_000, left - 2000) });
      const checked = checkTags(raw);
      if (!checked.ok) { out.rejected.push({ id: row.id, title: row.title, reason: checked.reason }); continue; }
      const tags: PlaybookTags = { ...checked.tags, body_hash: bodyHash(row.body), taxonomy_version: TAXONOMY.version, model, tagged_at: (opts.now ?? new Date()).toISOString() };
      if (!opts.dryRun) {
        const saved = await db.from("gtm_content_items").update({ playbook_tags: tags }).eq("id", row.id);
        if (missingColumn(saved.error)) return { ...out, skipped: COLUMN_MISSING };
        must(saved, `save tags for ${row.id}`);
      }
      out.tagged.push({ id: row.id, title: row.title, status: row.status, tags });
    } catch (e) {
      out.errors.push({ id: row.id, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** Display names for stored ids (the report page's chips and the CLI). */
export const tagNames = (t: Pick<PlaybookTags, "hook" | "storyline" | "cta">) => ({
  hook: HOOKS.get(t.hook)?.name ?? t.hook, storyline: STORYLINES.get(t.storyline)?.name ?? t.storyline, cta: CTAS.get(t.cta)?.name ?? t.cta,
});
