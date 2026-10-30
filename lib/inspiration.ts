// Inspiration library (gtm_inspiration): videos, carousels, newsletters and posts we want to learn from.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PILLARS } from "./calendar-db";
import { must } from "./db";
import { BUCKET } from "./review";
import { guardMediaBytes } from "./media-guard";

export const KINDS = ["video", "carousel", "newsletter", "post"] as const;
export type InspirationKind = (typeof KINDS)[number];
export type Inspiration = {
  id: string; kind: InspirationKind; url: string; title: string; platform: string | null; tags: string[];
  why_we_like: string; thumbnail_path: string | null; pillar: string | null; added_by: string | null; created_at: string;
};
export type NewInspiration = Omit<Inspiration, "id" | "created_at" | "title" | "platform" | "tags" | "why_we_like" | "thumbnail_path" | "pillar" | "added_by"> &
  Partial<Pick<Inspiration, "title" | "platform" | "tags" | "why_we_like" | "thumbnail_path" | "pillar" | "added_by">>;

export function platformOf(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return "youtube";
  if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)substack\.com$/.test(host)) return "substack";
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return "x";
  if (/(^|\.)vimeo\.com$/.test(host)) return "vimeo";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  return host;
}

export function validateInspiration(row: NewInspiration): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/[^\s]+$/.test(row.url ?? "")) out.push("url must be http(s)");
  if (!(KINDS as readonly string[]).includes(row.kind)) out.push(`kind must be one of ${KINDS.join(", ")}`);
  if (row.pillar != null && !(PILLARS as readonly string[]).includes(row.pillar)) out.push(`pillar must be one of ${PILLARS.join(", ")}`);
  if (row.tags && row.tags.some((tag) => !/^[a-z0-9][a-z0-9-]*$/.test(tag))) out.push("tags are lowercase words joined by dashes");
  return out;
}

const decode = (value?: string) => value?.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim();

/** Title and thumbnail from oEmbed (YouTube, Vimeo) or the page's Open Graph tags. Never throws. */
export async function fetchPreview(url: string, fetcher: typeof fetch = fetch): Promise<{ title?: string; thumbnail?: string }> {
  const platform = platformOf(url);
  const oembed = platform === "youtube" ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
    : platform === "vimeo" ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}` : null;
  try {
    if (oembed) {
      const response = await fetcher(oembed, { signal: AbortSignal.timeout(6000) });
      if (response.ok) {
        const data = await response.json() as { title?: string; thumbnail_url?: string };
        return { title: data.title, thumbnail: data.thumbnail_url };
      }
    }
    const response = await fetcher(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; vibrana-gtm)" }, signal: AbortSignal.timeout(6000) });
    const html = (await response.text()).slice(0, 400_000);
    const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, "i"))?.[1]
      ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, "i"))?.[1];
    const title = decode(meta("og:title") ?? meta("twitter:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]);
    const image = decode(meta("og:image") ?? meta("twitter:image"));
    return { title, thumbnail: image && /^https?:\/\//.test(image) ? image : undefined };
  } catch {
    return {};
  }
}

/** Insert or update by URL (the table's unique key). Missing title/thumbnail are fetched. */
export async function addInspiration(db: SupabaseClient, input: NewInspiration, opts: { fetcher?: typeof fetch; preview?: boolean } = {}) {
  const problems = validateInspiration(input);
  if (problems.length) throw new Error(problems.join("; "));
  const preview = opts.preview === false || (input.title && input.thumbnail_path) ? {} : await fetchPreview(input.url, opts.fetcher);
  const row = {
    kind: input.kind, url: input.url, title: input.title || preview.title || "", platform: input.platform ?? platformOf(input.url),
    tags: [...new Set(input.tags ?? [])], why_we_like: input.why_we_like ?? "", thumbnail_path: input.thumbnail_path ?? preview.thumbnail ?? null,
    pillar: input.pillar ?? null, added_by: input.added_by ?? null,
  };
  return must(await db.from("gtm_inspiration").upsert(row, { onConflict: "url" }).select().single(), `save ${input.url}`) as Inspiration;
}

export async function listInspiration(db: SupabaseClient, filter: { kind?: string; tag?: string; pillar?: string } = {}) {
  let query = db.from("gtm_inspiration").select("*").order("created_at", { ascending: false });
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.pillar) query = query.eq("pillar", filter.pillar);
  if (filter.tag) query = query.contains("tags", [filter.tag]);
  return must(await query, "inspiration") as Inspiration[];
}

type SeedEntry = NewInspiration & { thumbnail_file?: string; pending?: string; url: string | null };

/** Seed file: JSON array of entries. `thumbnail_file` (relative to the seed) uploads to private storage. */
export async function importInspiration(db: SupabaseClient | null, seedPath: string, opts: { dryRun?: boolean; fetcher?: typeof fetch } = {}) {
  const entries = JSON.parse(readFileSync(seedPath, "utf8")) as SeedEntry[];
  const out = { saved: [] as string[], skipped: [] as { title?: string; reason: string }[] };
  for (const entry of entries) {
    if (entry.pending || !entry.url) { out.skipped.push({ title: entry.title, reason: entry.pending ?? "no url" }); continue; }
    const { thumbnail_file, pending: _pending, ...row } = entry;
    const problems = validateInspiration(row as NewInspiration);
    if (problems.length) throw new Error(`${entry.url}: ${problems.join("; ")}`);
    let thumbnail = row.thumbnail_path ?? null;
    if (thumbnail_file) {
      const abs = resolve(dirname(seedPath), thumbnail_file.replace(/^~\//, `${process.env.HOME}/`));
      if (!existsSync(abs)) throw new Error(`${entry.url}: thumbnail_file missing ${thumbnail_file}`);
      const bytes = readFileSync(abs);
      thumbnail = `inspiration/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}-${basename(abs)}`;
      if (!opts.dryRun && db) {
        const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(abs).toLowerCase()];
        if (!type) throw new Error(`${entry.url}: thumbnail must be PNG, JPEG or WebP`);
        guardMediaBytes(bytes, type, thumbnail);
        const { error } = await db.storage.from(BUCKET).upload(thumbnail, bytes, { contentType: type, upsert: true });
        if (error) throw new Error(`upload ${thumbnail}: ${error.message}`);
      }
    }
    if (!opts.dryRun && db) await addInspiration(db, { ...(row as NewInspiration), thumbnail_path: thumbnail }, { fetcher: opts.fetcher });
    out.saved.push(entry.url);
  }
  return { dryRun: Boolean(opts.dryRun), ...out };
}
