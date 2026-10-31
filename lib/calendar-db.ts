// The content calendar lives in gtm_content_items (brand.example.com Supabase). calendar.yaml in
// john-workspace is now an import/export format only: `gtm calendar import|export`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, posix, resolve } from "node:path";
import { CALENDAR } from "../config/calendar";
import { publicationConfig } from "./publications-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Document, Scalar, visit } from "yaml";
import { frontmatterData, splitFrontmatter } from "./frontmatter";
import { isValidTime, loadCalendar, STATUSES, weekOfDate, type Calendar, type Item } from "./calendar";
import { must } from "./db";
import { readPages } from "./db-read";
import { BUCKET } from "./review";
import { guardMediaBytes } from "./media-guard";

export const PILLARS = ["proof", "perspective", "build", "lists"] as const;
export const publicationIds = () => Object.keys(publicationConfig().publications);

/** Row shape of gtm_content_items after the calendar-db migration. */
export type ContentRow = {
  id: string; week: number; date: string; time: string | null; pillar: string; title: string; format: string;
  channels: string[]; status: Item["status"]; link: string | null; cta: string | null;
  zernio_post_id: string | null; published_at: string | null; urls: Record<string, string>;
  story_id: string | null; story_assets: string[]; publication: string | null; body: string | null;
  media: string[]; approved_hash: string | null; copy_path: string | null;
};

export type CalendarConfig = { timezone: string; accounts: Record<string, string>; manual: string[] };

/** Timezone, Zernio account ids and hand-published channels: versioned with the code. */
export function calendarConfig(): CalendarConfig {
  return { timezone: CALENDAR.timezone, accounts: { ...CALENDAR.accounts }, manual: [...CALENDAR.manual] };
}

/** What an approval covers: the exact text and the exact media list. */
export function contentHash(row: { body?: string | null; media?: string[] | null }): string {
  return createHash("sha256").update(JSON.stringify({ body: row.body ?? "", media: row.media ?? [] })).digest("hex");
}

export function rowToItem(row: ContentRow): Item {
  return {
    // The stored week column is not trusted: the week always comes from the date.
    id: row.id, week: weekOfDate(String(row.date).slice(0, 10), row.week), date: String(row.date).slice(0, 10), ...(row.time ? { time: row.time } : {}),
    pillar: row.pillar, title: row.title, format: row.format, channels: row.channels ?? [], status: row.status,
    ...(row.copy_path ? { copy: row.copy_path } : {}), media: row.media ?? [], ...(row.link ? { link: row.link } : {}),
    ...(row.cta ? { cta: row.cta } : {}), ...(row.story_id ? { story_id: row.story_id } : {}),
    ...(row.story_assets?.length ? { story_assets: row.story_assets } : {}),
    zernio_post_id: row.zernio_post_id, published_at: row.published_at, urls: row.urls ?? {},
    body: row.body ?? undefined, publication: row.publication, approved_hash: row.approved_hash,
  };
}

/** The database is the calendar unless GTM_CALENDAR_SOURCE=file (legacy YAML mode, used by the CLI contract tests). */
export function calendarFromDb(): boolean {
  return (process.env.GTM_CALENDAR_SOURCE ?? "db") === "db";
}

/** The calendar every reader should use: the table, or calendar.yaml in legacy file mode. */
export async function activeCalendar(db: SupabaseClient): Promise<Calendar> {
  return calendarFromDb() ? loadCalendarDb(db) : loadCalendar();
}

export async function loadCalendarDb(db: SupabaseClient): Promise<Calendar> {
  const rows = await readPages<ContentRow>((from, to) => db.from("gtm_content_items").select("*", { count: "exact" }).order("date").order("time").order("id").range(from, to), "content items");
  return { path: "db:gtm_content_items", source: "db", ...calendarConfig(), items: rows.map(rowToItem) };
}

export function validateRow(row: Partial<ContentRow> & { id: string }): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(row.id)) out.push(`${row.id}: id must be lowercase letters, digits and dashes`);
  if (row.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) out.push(`${row.id}: bad date ${row.date}`);
  if (row.time != null && !isValidTime(row.time)) out.push(`${row.id}: bad time ${JSON.stringify(row.time)} (expected HH:MM)`);
  if (row.pillar !== undefined && !(PILLARS as readonly string[]).includes(row.pillar)) out.push(`${row.id}: pillar must be one of ${PILLARS.join(", ")}`);
  if (row.status !== undefined && !STATUSES.includes(row.status)) out.push(`${row.id}: bad status ${row.status}`);
  if (row.publication != null && !publicationIds().includes(row.publication)) out.push(`${row.id}: publication must be ${publicationIds().join(" or ")}`);
  return out;
}

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };

type ImportOpts = { dryRun?: boolean; force?: boolean; upload?: (key: string, bytes: Buffer, contentType: string) => Promise<void> };

/**
 * Idempotent upsert of calendar.yaml into the table, keyed by id.
 * - Copy files become `body`; local media become content-review storage paths (Story media reuse the
 *   Story's snapshot, other files upload under calendar/<id>/<sha16>-<name>).
 * - A YAML `status: approved` (John's approval, made in the file) records approved_hash for that content.
 * - Never regresses DB-side progress: scheduled/published/failed rows and Zernio ids are kept.
 * - A body edited in the dashboard is not overwritten unless `force`.
 */
export async function importCalendar(db: SupabaseClient, yamlPath: string, opts: ImportOpts = {}) {
  const cal = loadCalendar(yamlPath);
  const base = dirname(cal.path);
  const existing = new Map((must(await db.from("gtm_content_items").select("*"), "content items") as ContentRow[]).map((row) => [row.id, row]));
  const storyIds = [...new Set(cal.items.map((item) => item.story_id).filter((id): id is string => !!id))];
  const storyAssets = storyIds.length
    ? must(await db.from("gtm_story_assets").select("id,story_id,source,storage_path").in("story_id", storyIds), "story assets") as { id: string; story_id: string; source: string; storage_path: string | null }[]
    : [];
  const upload = opts.upload ?? (async (key: string, bytes: Buffer, contentType: string) => {
    guardMediaBytes(bytes, contentType, key, { publish: true });
    const { error } = await db.storage.from(BUCKET).upload(key, bytes, { contentType, upsert: true });
    if (error) throw new Error(`upload ${key}: ${error.message}`);
  });
  const result = { inserted: [] as string[], updated: [] as string[], unchanged: [] as string[], conflicts: [] as string[], uploads: [] as string[] };
  for (const item of cal.items) {
    // An inline body (e.g. from `gtm calendar export`) wins over the copy file it was imported from.
    const body = typeof item.body === "string" ? item.body : item.copy ? readCopy(base, item.copy) : null;
    const media: string[] = [];
    for (const path of item.media ?? []) {
      if (/^https:\/\//.test(path)) { media.push(path); continue; }
      const fromStory = storyAssets.find((asset) => asset.story_id === item.story_id && asset.source === path && asset.storage_path);
      if (fromStory) { media.push(fromStory.storage_path!); continue; }
      const abs = resolve(base, path);
      if (!existsSync(abs) && /^(calendar|stories)\//.test(path)) { media.push(path); continue; } // already a storage key (exported)
      if (!existsSync(abs)) throw new Error(`${item.id}: media missing ${path}`);
      const bytes = readFileSync(abs);
      guardMediaBytes(bytes, MIME[extname(abs).toLowerCase()], `${item.id}: ${path}`, { publish: true }); // before any write, dry runs included
      const sha = createHash("sha256").update(bytes).digest("hex");
      const key = `calendar/${item.id}/${sha.slice(0, 16)}-${basename(abs).replace(/[^A-Za-z0-9._-]/g, "_")}`;
      media.push(key);
      if (!opts.dryRun && !existing.get(item.id)?.media?.includes(key)) {
        await upload(key, bytes, MIME[extname(abs).toLowerCase()] ?? "application/octet-stream");
        result.uploads.push(key);
      }
    }
    const prior = existing.get(item.id);
    // A killed (skipped) row stays killed: the YAML's `drafted` must never bring a killed piece back (gtm piece kill).
    const progressed = prior && ["scheduled", "published", "failed", "skipped"].includes(prior.status);
    const meta = item.copy && body ? frontmatterField(body, "publication") : null;
    const row: Omit<ContentRow, "approved_hash"> & { approved_hash?: string | null } = {
      id: item.id, week: weekOfDate(item.date, item.week), date: item.date, time: item.time ?? null, pillar: item.pillar, title: item.title,
      format: item.format, channels: item.channels, status: progressed ? prior!.status : item.status,
      link: item.link ?? null, cta: item.cta ?? null,
      zernio_post_id: prior?.zernio_post_id ?? item.zernio_post_id ?? null, published_at: prior?.published_at ?? item.published_at ?? null,
      urls: { ...(item.urls ?? {}), ...(prior?.urls ?? {}) }, story_id: item.story_id ?? null, story_assets: item.story_assets ?? [],
      publication: (item as Item & { publication?: string }).publication ?? publicationFromChannel(meta, body) ?? prior?.publication ?? null,
      body, media, copy_path: item.copy ?? null,
    };
    let conflict = false;
    if (prior && body !== null && prior.body !== null && prior.body !== body && !opts.force) {
      // The dashboard edited this body after the last import: keep it and report. A YAML approval
      // covered the file's text, not this one, so it cannot carry over.
      row.body = prior.body;
      conflict = true;
      result.conflicts.push(item.id);
    }
    const problems = validateRow(row);
    if (problems.length) throw new Error(problems.join("; "));
    if (row.status === "approved" && conflict) {
      if (prior!.approved_hash !== contentHash(row)) { row.status = "drafted"; row.approved_hash = null; } else row.approved_hash = prior!.approved_hash;
    } else if (row.status === "approved") row.approved_hash = contentHash(row);
    else if (!progressed) row.approved_hash = null;
    if (prior && same(prior, row)) { result.unchanged.push(item.id); continue; }
    (prior ? result.updated : result.inserted).push(item.id);
    if (!opts.dryRun) must(await db.from("gtm_content_items").upsert({ ...row, updated_at: new Date().toISOString() }), `upsert ${item.id}`);
  }
  return { dryRun: Boolean(opts.dryRun), source: cal.path, items: cal.items.length, ...result };
}

function readCopy(base: string, path: string): string {
  const abs = resolve(base, path);
  if (!existsSync(abs)) throw new Error(`copy missing ${path}`);
  return readFileSync(abs, "utf8");
}

function frontmatterField(body: string, key: string): string | null {
  const value = frontmatterData(splitFrontmatter(body).frontmatter)[key];
  return typeof value === "string" ? value : null;
}

function publicationFromChannel(explicit: string | null, body: string | null): string | null {
  const config = publicationConfig();
  if (explicit && Object.hasOwn(config.publications, explicit)) return explicit;
  const channel = body ? frontmatterField(body, "channel") : null;
  return channel ? config.publicationChannels[channel] ?? null : null;
}

function same(prior: ContentRow, next: Record<string, unknown>) {
  return Object.entries(next).every(([key, value]) => {
    const current = (prior as unknown as Record<string, unknown>)[key];
    if (key === "date") return String(current).slice(0, 10) === value;
    return JSON.stringify(current ?? null) === JSON.stringify(value ?? null);
  });
}

/** YAML snapshot of the table, bodies inline. Round-trips through `importCalendar` via a temp dir. */
export async function exportCalendar(db: SupabaseClient): Promise<string> {
  const cal = await loadCalendarDb(db);
  const items = cal.items.map((item) => {
    const { body, approved_hash: _hash, ...rest } = item;
    return { ...rest, ...(body !== undefined ? { body } : {}) };
  });
  return `# Exported from gtm_content_items ${new Date().toISOString()}. The database is the source of truth.\n` +
    toYaml({ timezone: cal.timezone, accounts: cal.accounts, manual_channels: cal.manual, items });
}

// "14:00" unquoted is a string to this yaml library (YAML 1.2) but base-60 minutes (840) to YAML 1.1
// readers such as PyYAML. Quote every string that looks like a clock or base-60 number.
const SEXAGESIMAL = /^[-+]?\d+(?::[0-5]?\d)+(?:\.\d*)?$/;

/** YAML that every reader parses the same way: time-like strings are always double-quoted. */
export function toYaml(value: unknown): string {
  const doc = new Document(value);
  visit(doc, { Scalar(_key, node) { if (typeof node.value === "string" && SEXAGESIMAL.test(node.value)) node.type = Scalar.QUOTE_DOUBLE; } });
  return doc.toString({ lineWidth: 0 });
}

/**
 * Repair the stored week column: set it to the ISO week of the row's date, and touch nothing else.
 * Readers already derive the week from the date; this keeps the column honest for anyone reading the table.
 */
export async function repairWeeks(db: SupabaseClient, opts: { dryRun?: boolean } = {}) {
  const rows = must(await db.from("gtm_content_items").select("id,week,date").order("date").order("id"), "content items") as Pick<ContentRow, "id" | "week" | "date">[];
  const changes = rows
    .map((row) => ({ id: row.id, date: String(row.date).slice(0, 10), old: row.week, new: weekOfDate(String(row.date).slice(0, 10), row.week) }))
    .filter((c) => c.old !== c.new);
  if (!opts.dryRun) {
    for (const c of changes) must(await db.from("gtm_content_items").update({ week: c.new }).eq("id", c.id).eq("week", c.old), `week ${c.id}`);
  }
  return { dryRun: Boolean(opts.dryRun), checked: rows.length, changes };
}

export async function updateItemDb(db: SupabaseClient, id: string, patch: Partial<ContentRow>) {
  const problems = validateRow({ id, ...patch });
  if (problems.length) throw new Error(problems.join("; "));
  if (patch.date) patch = { ...patch, week: weekOfDate(patch.date) }; // the week column follows the date
  must(await db.from("gtm_content_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id), `update ${id}`);
}

/** Calendar-relative POSIX path for a file next to a copy file (e.g. a YouTube thumbnail). */
export function siblingSource(copyPath: string, file: string) {
  return posix.normalize(posix.join(posix.dirname(copyPath), file));
}
