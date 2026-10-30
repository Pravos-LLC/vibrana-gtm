// calendar.yaml (in john-workspace/2-work/content-engine/) is the source of truth for planned content.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { isoWeek } from "./week";
import { frontmatterMeta, splitFrontmatterRaw } from "./frontmatter";

export const STATUSES = ["idea", "drafted", "approved", "scheduled", "published", "failed", "skipped"] as const;
export type Status = (typeof STATUSES)[number];

export type Item = {
  id: string;
  week: number; // ISO 8601 week of `date`, always derived from it (weekOfDate); a stored or YAML week is ignored
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM in calendar timezone
  pillar: string;
  title: string;
  format: string;
  channels: string[];
  copy?: string; // path to copy file, relative to calendar dir
  media?: string[]; // local paths (relative to calendar dir) or https URLs
  link?: string;
  story_id?: string; // Story whose assets must be approved for this item's sole channel
  story_assets?: string[]; // asset ids reviewed for this channel, including copy/media/link/cover
  cta?: string;
  status: Status;
  zernio_post_id?: string | null;
  published_at?: string | null;
  urls?: Record<string, string>;
  // Database-backed calendar only (gtm_content_items):
  body?: string; // the post text itself (replaces the copy file)
  publication?: string | null; // sample_author | regenera, for newsletters
  approved_hash?: string | null; // contentHash(body, media) at approval time
};

export type Calendar = {
  path: string;
  source?: "file" | "db"; // db: items come from gtm_content_items and media are storage paths
  timezone: string;
  accounts: Record<string, string>; // channel -> Zernio accountId
  manual: string[]; // channels published by hand (newsletter, website): tracked, never sent to Zernio
  items: Item[];
};

/** The ISO week an item is filed under: computed from its date. `fallback` only for an unreadable date (validate reports it). */
export function weekOfDate(date: string, fallback?: unknown): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? isoWeek(date).week : (fallback as number);
}

export function calendarPath(): string {
  return process.env.GTM_CALENDAR ?? resolve(homedir(), "Projects/john-workspace/2-work/content-engine/calendar.yaml");
}

export function loadCalendar(path = calendarPath(), opts: { validate?: boolean } = {}): Calendar {
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length) throw new Error(`calendar.yaml: ${doc.errors[0].message}`);
  const raw = doc.toJS() as any;
  const items: Item[] = (raw.items ?? []).map((i: any) => ({ ...i, date: String(i.date), week: weekOfDate(String(i.date), i.week), channels: i.channels ?? [] }));
  const problems = opts.validate === false ? [] : validate(items);
  if (problems.length) throw new Error(`calendar.yaml invalid:\n  ${problems.join("\n  ")}`);
  return { path, timezone: raw.timezone ?? "Europe/Berlin", accounts: raw.accounts ?? {}, manual: raw.manual_channels ?? ["newsletter", "website"], items };
}

/** Calendar times are 24h wall-clock HH:MM. Anything else (e.g. a YAML value of `"\"15:00\""`) is rejected. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isValidTime(time: unknown): time is string {
  return typeof time === "string" && TIME_PATTERN.test(time);
}

export function validate(items: Item[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (!i.id) out.push(`item without id: ${JSON.stringify(i).slice(0, 80)}`);
    if (seen.has(i.id)) out.push(`duplicate id ${i.id}`);
    seen.add(i.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) out.push(`${i.id}: bad date ${i.date}`);
    if (!STATUSES.includes(i.status)) out.push(`${i.id}: bad status ${i.status}`);
    if (i.time !== undefined && i.time !== null && !isValidTime(i.time)) out.push(`${i.id}: bad time ${JSON.stringify(i.time)} (expected HH:MM, 24h, written as time: "15:00")`);
    if (!Number.isInteger(i.week)) out.push(`${i.id}: week must be an integer`);
    if (i.story_id && (i.channels.length !== 1 || !i.story_assets?.length)) out.push(`${i.id}: Story items need one channel and story_assets`);
    if (i.story_assets?.length && !i.story_id) out.push(`${i.id}: story_assets needs story_id`);
  }
  return out;
}

/** Update fields on one item in place, preserving comments and formatting elsewhere. */
export function updateItem(path: string, id: string, patch: Partial<Item>) {
  const doc = parseDocument(readFileSync(path, "utf8"));
  const items = doc.get("items") as any;
  const node = items.items.find((n: any) => n.get("id") === id);
  if (!node) throw new Error(`no calendar item ${id}`);
  const withWeek = patch.date ? { ...patch, week: weekOfDate(patch.date) } : patch; // the week follows the date
  for (const [k, v] of Object.entries(withWeek)) node.set(k, v);
  // Write-then-rename so a concurrent reader (hourly sync, editor) never sees a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, path);
}

export function resolveAsset(cal: Calendar, p: string): string {
  return /^https?:\/\//.test(p) ? p : resolve(dirname(cal.path), p);
}

/** Copy files: frontmatter-free body is the default text; `--- channel: <name> ---` lines start per-channel overrides. */
export function parseCopy(text: string): { base: string; perChannel: Record<string, string>; meta: Record<string, string> } {
  // Frontmatter is YAML (block scalars, quoted colons, multi-line values); see lib/frontmatter.ts.
  const split = splitFrontmatterRaw(text);
  const meta = split ? frontmatterMeta(split.frontmatter) : {};
  const body = split ? split.body : text;
  const parts = body.split(/^--- channel: ([a-z]+) ---$/m);
  const perChannel: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) perChannel[parts[i]] = parts[i + 1].trim();
  return { base: parts[0].trim(), perChannel, meta };
}

/** Local wall time in an IANA zone -> ISO string without offset (Zernio takes scheduledFor + timezone). */
export function localDateTime(item: Item): string {
  const time = item.time ?? "08:30";
  if (!isValidTime(time)) throw new Error(`${item.id}: bad time ${JSON.stringify(time)} (expected HH:MM)`);
  return `${item.date}T${time}:00`;
}

/** Convert a wall-clock time in an IANA zone to a UTC Date (DST-aware). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date ${JSON.stringify(date)} (expected YYYY-MM-DD)`);
  if (!isValidTime(time)) throw new Error(`bad time ${JSON.stringify(time)} (expected HH:MM)`);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(at)).map((p) => [p.type, p.value]),
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc); // second pass settles DST boundaries
  if (Number.isNaN(utc)) throw new Error(`could not resolve ${date} ${time} in ${timeZone}`);
  return new Date(utc);
}
