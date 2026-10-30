// The continuous half of "a video that will not play is structurally impossible" (John, 2026-10-13, the third time a
// 4:4:4 clip reached /content), extended the same day to images (carousel s1-29: two slides did not load). Every stored
// video and image is re-probed from its box headers (a few KB per file, never the media
// data): content-review (Stories, their review proxies, calendar media, storyboard base videos and scene previews,
// B-roll proxies, guide media, the retired review suite) and the media already on Zernio for scheduled posts.
//
// A failure is recorded as one gtm_sync_state row per file (media.unplayable.<hash>), which /content's findings panel
// and `gtm season` show as a BLOCK linked to the piece, and, for a Story asset, an agent note on the asset so the next
// `gtm story feedback` sweep picks it up. `gtm media audit --fix` (lib/media-fix.ts) re-encodes and replaces it; the
// daily cron (/api/cron/media-audit) probes what changed in the last two days plus everything already flagged.
// The /content and /studio players report what the browser itself could not play through the same rows
// (app/media-actions.ts), so a decode failure becomes a finding without John having to write "it won't play".
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { BUCKET } from "./review";
import { httpRangeReader, isImage, isVideo, remoteImageProblems, remoteMeta, remoteSize, remoteVideoProblems } from "./media-guard";
import { BROWSER_IMAGE_BYTES, PUBLISH_IMAGE_BYTES } from "./image-loadable";
import { webPlayableProblemsRanged } from "./video-playable";
import { zernio } from "./zernio";
import type { Check } from "./season-analysis";

export const UNPLAYABLE_PREFIX = "media.unplayable.";
export const AUDIT_KEY = "media.audit";
/** The cron's window: objects changed in the last two days (a missed day is still covered), plus all flagged ones. */
export const RECENT_HOURS = 48;
/** Marks the agent note a finding leaves on a Story asset, so it is written once and found again. */
export const NOTE_MARK = "[unplayable-video]";

export type MediaKind = "video" | "image";
export type StoredVideo = { key: string; size: number; updated: string; kind?: MediaKind; mime?: string };
export type MediaRef = { kind: "story-asset" | "story-proxy" | "story-version" | "calendar" | "storyboard" | "broll" | "guide" | "review-legacy" | "zernio-post"; id: string; story_id?: string | null; detail?: string };
export type ZernioVideo = { postId: string; index: number; url: string; kind?: MediaKind; status: string; scheduledFor: string | null; platforms: string[]; calendarId: string | null; storyId: string | null };
export type MediaProblem = {
  /** content-review key, or zernio:<postId>:<media index> */
  key: string;
  where: "storage" | "zernio";
  /** video unless set (rows written before images were checked have none) */
  kind?: MediaKind;
  url?: string;
  problems: string[];
  story_id: string | null;
  refs: MediaRef[];
  source: "audit" | "browser";
  detected_at: string;
  post?: { id: string; scheduledFor: string | null; platforms: string[] };
  browser?: { code: number | null; message: string; page: string | null; decode?: boolean };
};
export type AuditResult = {
  ran_at: string; scope: "full" | "recent"; since: string | null;
  probed: number; storage: number; zernio: number; videos: number; images: number;
  bad: MediaProblem[]; unreadable: { key: string; error: string }[];
  /** Every key actually probed (storage keys and zernio:<post>:<i>): only these may be cleared. */
  probedKeys: string[];
  /** The run hit its deadline: these were listed but not probed (recorded next run; never cleared). */
  skipped: number;
  /** Storage keys the deadline left unprobed: carried to the next run like unreadable ones. */
  skippedKeys: string[];
  /** The bucket was listed (not a --keys run), so a folder entry this run did not report has listed fine. */
  listed: boolean;
  /** Zernio was listed this run: a carried Zernio entry not reported again is resolved. */
  zernioListed: boolean;
};

export const problemKey = (key: string) => `${UNPLAYABLE_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
export const zernioKey = (postId: string, index: number) => `zernio:${postId}:${index}`;

/** Every video and image in content-review (optionally only those changed since `since`), walking every folder. */
export async function listStoredVideos(db: SupabaseClient, opts: { since?: string; images?: boolean; /** folders that still failed after retries */ failed?: { key: string; error: string }[]; /** epoch ms: no folder is listed after it; the rest are reported */ deadline?: number; /** folders whose files are all returned, whatever `since` says (they failed to list last run) */ fullPrefixes?: string[] } = {}): Promise<StoredVideo[]> {
  const out: StoredVideo[] = [];
  // Folders are listed three at a time (a sequential walk of the whole bucket took about a minute; eight at a time made
  // Storage answer "too many connections"), each list retried while Storage is busy.
  const queue: string[] = [""];
  const walk = async (dir: string): Promise<void> => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await retryBusy(() => db.storage.from(BUCKET).list(dir, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } }));
      if (error) throw new Error(`list ${dir || "/"}: ${error.message}`);
      for (const o of data ?? []) {
        const key = dir ? `${dir}/${o.name}` : o.name;
        if (!o.id) { queue.push(key); continue; }
        const meta = (o.metadata ?? {}) as { size?: number; mimetype?: string };
        const kind: MediaKind | null = isVideo(meta.mimetype, key) ? "video" : opts.images !== false && isImage(meta.mimetype, key) ? "image" : null;
        if (!kind) continue;
        const updated = o.updated_at ?? o.created_at ?? "";
        if (opts.since && updated && updated < opts.since && !opts.fullPrefixes?.some((p) => key.startsWith(p))) continue;
        out.push({ key, size: Number(meta.size) || 0, updated, kind, mime: meta.mimetype });
      }
      if ((data ?? []).length < 1000) break;
    }
  };
  let active = 0;
  await new Promise<void>((done, fail) => {
    const pump = () => {
      if (opts.deadline !== undefined && Date.now() > opts.deadline && opts.failed) {
        // Out of time: the folders not listed yet are reported, so probing still gets its share of the run.
        for (const dir of queue.splice(0)) opts.failed.push({ key: dir ? `${dir}/` : "(bucket root)", error: "not listed: the run's listing time ran out" });
      }
      if (!queue.length && !active) return done();
      while (queue.length && active < 3) {
        const dir = queue.shift()!;
        active++;
        // A folder that still fails after its retries is reported, not fatal: one slow folder must not cost the whole
        // audit (production, 2026-10-13: "The connection to the database timed out" on one guide folder).
        walk(dir).then(() => { active--; pump(); }, (e: unknown) => {
          if (!opts.failed) return fail(e);
          opts.failed.push({ key: dir ? `${dir}/` : "(bucket root)", error: e instanceof Error ? e.message : String(e) });
          active--; pump();
        });
      }
    };
    pump();
  });
  return out;
}

/** Storage under load answers "too many connections" (or a 429/5xx): wait and ask again, up to five times. */
export async function retryBusy<T extends { error: { message: string; statusCode?: string | number } | null }>(call: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await call();
    const busy = r.error && /too many connections|connection to the database|slow ?down|rate limit|time(d)? ?out|429|50[234]/i.test(`${r.error.message} ${r.error.statusCode ?? ""}`);
    if (!busy || attempt >= 4) return r;
    await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200));
  }
}

/** Short-lived signed URLs for many keys in a few calls (one sign per key opens too many database connections). */
export async function signAll(db: SupabaseClient, keys: string[], ttl = 900, failed?: { key: string; error: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { data, error } = await retryBusy(() => db.storage.from(BUCKET).createSignedUrls(chunk, ttl));
    if (error && failed) { for (const key of chunk) failed.push({ key, error: `could not sign: ${error.message}` }); continue; }
    if (error) throw new Error(`sign ${chunk.length} keys: ${error.message}`);
    for (const d of data ?? []) if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  }
  return out;
}

/** Header-only probe of one stored object through a signed URL. */
export async function probeStored(db: SupabaseClient, key: string, size?: number, fetchImpl: typeof fetch = fetch, signedUrl?: string, kind: MediaKind = "video", mime?: string): Promise<string[]> {
  let url = signedUrl;
  if (!url) {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(key, 600);
    if (error || !data) throw new Error(`sign ${key}: ${error?.message}`);
    url = data.signedUrl;
  }
  if (kind === "image") {
    if (size === undefined || !mime) {
      const m = await remoteMeta(url, fetchImpl);
      size ??= m.size ?? 0; mime ||= m.contentType ?? undefined;
    }
    // Media that goes out (Story assets, calendar media) is held to Zernio's 5 MB; frames, stills and thumbnails to 25 MB.
    return remoteImageProblems(httpRangeReader(url, fetchImpl), size, mime, /^(stories|calendar)\//.test(key) && !/-poster\.jpg$/.test(key) ? PUBLISH_IMAGE_BYTES : BROWSER_IMAGE_BYTES);
  }
  if (!key.toLowerCase().endsWith(".mp4")) return [`${key.slice(key.lastIndexOf("."))} is not an MP4`];
  const bytes = size || (await remoteSize(url, fetchImpl));
  if (!bytes) throw new Error(`could not read the size of ${key}`);
  return webPlayableProblemsRanged(httpRangeReader(url, fetchImpl), bytes);
}

/** Videos on Zernio posts that have not gone out yet (scheduled, draft, pending, failed: a retry would send them). */
export async function zernioVideos(statuses = ["scheduled", "draft", "pending", "failed"]): Promise<ZernioVideo[]> {
  const out: ZernioVideo[] = [];
  for (const status of statuses) {
    for (let page = 1; page < 50; page++) {
      const r = await zernio<{ posts?: Array<Record<string, any>>; pagination?: { pages?: number } }>("/posts", { query: { status, limit: 100, page } });
      for (const p of r.posts ?? []) {
        // A failed post from long ago is not going out again (its media may sit on a project that no longer exists).
        if (status === "failed" && p.scheduledFor && Date.parse(p.scheduledFor) < Date.now() - 7 * 86_400_000) continue;
        (p.mediaItems ?? []).forEach((m: { type?: string; url?: string; thumbnail?: string }, index: number) => {
          const base = { postId: String(p._id), status: String(p.status), scheduledFor: p.scheduledFor ?? null,
            platforms: (p.platforms ?? []).map((x: { platform?: string }) => x.platform).filter(Boolean),
            calendarId: p.metadata?.calendarId ?? null, storyId: p.metadata?.storyId ?? null };
          // A video's cover still (a YouTube thumbnail) is an image the platform must load too.
          if (m?.thumbnail) out.push({ ...base, index: 1000 + index, url: m.thumbnail, kind: "image" });
          if (!m?.url) return;
          const kind: MediaKind | null = m.type === "video" || isVideo(null, m.url) ? "video" : m.type === "image" || isImage(null, m.url) ? "image" : null;
          if (!kind) return;
          out.push({
            postId: String(p._id), index, url: m.url, kind, status: String(p.status), scheduledFor: p.scheduledFor ?? null,
            platforms: (p.platforms ?? []).map((x: { platform?: string }) => x.platform).filter(Boolean),
            calendarId: p.metadata?.calendarId ?? null, storyId: p.metadata?.storyId ?? null,
          });
        });
      }
      if (!r.pagination?.pages || page >= r.pagination.pages) break;
    }
  }
  return out;
}

type RefTables = {
  assets: { id: string; story_id: string; storage_path: string | null; metadata: Record<string, unknown> | null }[];
  items: { id: string; story_id: string | null; media: string[] | null; status: string; zernio_post_id: string | null }[];
  storyboards: { id: string; story_id: string }[];
  versions: { asset_id: string; revision: number; storage_path: string | null }[];
  broll: { id: string; proxy_path: string | null }[];
};

async function refTables(db: SupabaseClient): Promise<RefTables> {
  const [assets, items, storyboards, broll, versions] = await Promise.all([
    db.from("gtm_story_assets").select("id,story_id,storage_path,metadata").in("kind", ["video", "image"]),
    db.from("gtm_content_items").select("id,story_id,media,status,zernio_post_id"),
    db.from("gtm_storyboards").select("id,story_id"),
    db.from("gtm_broll_shots").select("id,proxy_path").not("proxy_path", "is", null),
    db.from("gtm_story_asset_versions").select("asset_id,revision,storage_path").in("kind", ["video", "image"]),
  ]);
  return {
    assets: must(assets, "story assets") ?? [], items: must(items, "content items") ?? [],
    storyboards: must(storyboards, "storyboards") ?? [], broll: must(broll, "b-roll shots") ?? [], versions: must(versions, "asset versions") ?? [],
  } as RefTables;
}

/** Who points at a stored key (or, for Zernio media, at a post), and the Story a finding should link to. */
export function refsFor(t: RefTables, key: string, post?: ZernioVideo): { refs: MediaRef[]; story_id: string | null } {
  const refs: MediaRef[] = [];
  if (post) {
    refs.push({ kind: "zernio-post", id: post.postId, story_id: post.storyId, detail: `${post.status} ${post.scheduledFor ?? ""} ${post.platforms.join(",")}`.trim() });
    const item = post.calendarId ? t.items.find((i) => i.id === post.calendarId) : t.items.find((i) => i.zernio_post_id === post.postId);
    if (item) refs.push({ kind: "calendar", id: item.id, story_id: item.story_id });
  }
  for (const a of t.assets) {
    if (a.storage_path === key) refs.push({ kind: "story-asset", id: a.id, story_id: a.story_id });
    else if (a.metadata?.proxy_path === key) refs.push({ kind: "story-proxy", id: a.id, story_id: a.story_id });
  }
  // An earlier version still plays in "what changed" and the version picker.
  for (const v of t.versions) if (v.storage_path === key && !refs.some((r) => r.kind === "story-asset" && r.id === v.asset_id)) refs.push({ kind: "story-version", id: v.asset_id, story_id: t.assets.find((a) => a.id === v.asset_id)?.story_id ?? null, detail: `revision ${v.revision}` });
  for (const i of t.items) if (i.media?.includes(key)) refs.push({ kind: "calendar", id: i.id, story_id: i.story_id, detail: i.status });
  const sb = key.match(/^storyboards\/([^/]+)\//)?.[1];
  if (sb && sb !== "broll") {
    const row = t.storyboards.find((s) => s.id === sb);
    refs.push({ kind: "storyboard", id: sb, story_id: row?.story_id ?? null });
  }
  for (const b of t.broll) if (b.proxy_path === key) refs.push({ kind: "broll", id: b.id });
  if (/^guide\//.test(key)) refs.push({ kind: "guide", id: key });
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(key)) refs.push({ kind: "review-legacy", id: key.split("/")[0] });
  const story_id = refs.find((r) => r.story_id)?.story_id ?? key.match(/^stories\/([^/]+)\//)?.[1] ?? null;
  return { refs, story_id };
}

/** refsFor one key, loading the reference tables (the browser report path). */
export async function refsForKey(db: SupabaseClient, key: string) {
  return refsFor(await refTables(db), key);
}

/** Runs `fn` over `list` with at most `n` in flight. */
async function pool<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i]); }
  }));
  return out;
}

/** Rows already flagged (by an audit or a browser), newest first. */
export async function loadUnplayable(db: SupabaseClient): Promise<MediaProblem[]> {
  const rows = must(await db.from("gtm_sync_state").select("key,value").like("key", `${UNPLAYABLE_PREFIX}%`), "unplayable media") as { key: string; value: MediaProblem }[] | null;
  return (rows ?? []).map((r) => r.value).sort((a, b) => b.detected_at.localeCompare(a.detected_at));
}

/**
 * Probes stored and scheduled video. `since` limits storage to objects changed after it (the cron); flagged keys are
 * always re-probed, so a fixed file clears its finding. `keys` probes only those storage keys.
 */
export async function runAudit(db: SupabaseClient, opts: { since?: string; zernio?: boolean; keys?: string[]; concurrency?: number; fetch?: typeof fetch; /** epoch ms: no probe starts after it */ deadline?: number } = {}): Promise<AuditResult> {
  const ran_at = new Date().toISOString();
  const flagged = await loadUnplayable(db);
  const unlisted: { key: string; error: string }[] = [];
  // Listing gets at most half of what remains before the deadline, so probing always has time.
  const listDeadline = opts.deadline !== undefined ? Date.now() + (opts.deadline - Date.now()) / 2 : undefined;
  // What the last run could not read or reach: files are probed again first; a folder that failed to list is listed in
  // full this time (its files may be older than the window); "(bucket root)" means everything.
  const last = opts.keys ? null : (must(await db.from("gtm_sync_state").select("value").eq("key", AUDIT_KEY).maybeSingle(), "last audit") as { value: { unreadable_keys?: string[] } } | null);
  const lastKeys = last?.value.unreadable_keys ?? [];
  const fullPrefixes = lastKeys.filter((k) => k.endsWith("/")).concat(lastKeys.includes("(bucket root)") ? [""] : []);
  let stored = opts.keys ? [] : await listStoredVideos(db, { since: opts.since, failed: unlisted, deadline: listDeadline, fullPrefixes });
  const kindOf = (key: string): MediaKind => (isImage(null, key) ? "image" : "video");
  if (opts.keys) stored = opts.keys.map((key) => ({ key, size: 0, updated: "", kind: kindOf(key) }));
  // Already-flagged files first: under a deadline, confirming or clearing a known BLOCK matters most.
  // Files the last run could not read (a Storage 429 that outlasted the retries, a folder that timed out) are probed again
  // now, first, with the flagged ones: no file goes unread for long just because it did not change.
  const carried = lastKeys.filter((k) => !k.endsWith("/") && !k.startsWith("zernio:") && k !== "(bucket root)");
  const known = [...new Set([...flagged.filter((f) => f.where === "storage").map((f) => f.key), ...carried])];
  stored = [...known.filter((k) => !stored.some((s) => s.key === k)).map((key) => ({ key, size: 0, updated: "", kind: (flagged.find((f) => f.key === key)?.kind) ?? kindOf(key) })), ...stored];
  stored.sort((a, b) => Number(known.includes(b.key)) - Number(known.includes(a.key)));
  const posts = opts.zernio === false ? [] : await zernioVideos();
  const tables = await refTables(db);
  const bad: MediaProblem[] = [];
  const unreadable: { key: string; error: string }[] = [...unlisted];
  const n = opts.concurrency ?? 8;
  const probedKeys: string[] = [];
  let skipped = 0;
  const due = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  const unsigned: { key: string; error: string }[] = [];
  const signed = await signAll(db, stored.map((s) => s.key), 900, unsigned);
  const unsignable = new Set(unsigned.map((u) => u.key));
  unreadable.push(...unsigned);
  // A Zernio finding whose post is no longer waiting to go out (published, deleted, long failed) has nothing left to
  // fix: once the listing is complete, it counts as probed and clean, so it is cleared.
  if (opts.zernio !== false) {
    const listed = new Set(posts.map((p) => zernioKey(p.postId, p.index)));
    for (const f of flagged) if (f.where === "zernio" && !listed.has(f.key)) probedKeys.push(f.key);
  }
  // Zernio first: those posts go out on their own, so they are probed before the long tail of storage.
  await pool(posts, n, async (p) => {
    const key = zernioKey(p.postId, p.index);
    if (due()) { skipped++; return; }
    probedKeys.push(key);
    try {
      const kind = p.kind ?? "video";
      const problems = kind === "image"
        ? await remoteMeta(p.url, opts.fetch).then((m) => remoteImageProblems(httpRangeReader(p.url, opts.fetch), m.size ?? 0, m.contentType, PUBLISH_IMAGE_BYTES))
        : await remoteVideoProblems(p.url, p.url.split("?")[0], opts.fetch);
      if (problems.length) bad.push({ key, where: "zernio", kind, url: p.url, problems, ...refsFor(tables, key, p), source: "audit", detected_at: ran_at, post: { id: p.postId, scheduledFor: p.scheduledFor, platforms: p.platforms } });
    } catch (e) {
      unreadable.push({ key, error: e instanceof Error ? e.message : String(e) });
    }
  });
  const skippedKeys: string[] = [];
  await pool(stored, n, async (s) => {
    if (due()) { skipped++; skippedKeys.push(s.key); return; }
    if (unsignable.has(s.key)) return; // already reported unreadable; never counted as probed, so never cleared
    probedKeys.push(s.key);
    try {
      if (!signed.has(s.key)) throw new Error("Object not found");
      const kind = s.kind ?? kindOf(s.key);
      // A stored image's size comes from the listing (0 is a real, empty file); a flagged key re-reads it.
      const size = s.updated ? s.size : undefined;
      const problems = await probeStored(db, s.key, kind === "image" ? size : s.size || undefined, opts.fetch, signed.get(s.key), kind, s.mime);
      if (problems.length) bad.push({ key: s.key, where: "storage", kind, problems, ...refsFor(tables, s.key), source: "audit", detected_at: ran_at });
    } catch (e) {
      // A key flagged earlier that no longer exists has nothing left to play.
      if (/not.?found|404|Object not found/i.test(String(e))) return;
      unreadable.push({ key: s.key, error: e instanceof Error ? e.message : String(e) });
    }
  });
  bad.sort((a, b) => a.key.localeCompare(b.key));
  return {
    ran_at, scope: opts.since || opts.keys ? "recent" : "full", since: opts.since ?? null,
    probed: stored.length + posts.length, storage: stored.length, zernio: posts.length,
    videos: stored.filter((s) => (s.kind ?? "video") === "video").length + posts.filter((p) => (p.kind ?? "video") === "video").length,
    images: stored.filter((s) => s.kind === "image").length + posts.filter((p) => p.kind === "image").length, bad, unreadable,
    probedKeys, skipped, skippedKeys, listed: !opts.keys, zernioListed: opts.zernio !== false,
  };
}

/**
 * Writes an audit: a row (and, for a Story asset, one agent note) per bad file; clears audit rows whose file now probes
 * clean. A browser report is kept until the file is replaced (`gtm media audit --fix`), even when its header looks fine:
 * the browser is the authority on what it could not play.
 */
export async function recordAudit(db: SupabaseClient, r: AuditResult): Promise<{ flagged: number; cleared: number; notes: number }> {
  const flagged = await loadUnplayable(db);
  const badKeys = new Set(r.bad.map((b) => b.key));
  let notes = 0;
  for (const b of r.bad) {
    const prior = flagged.find((f) => f.key === b.key);
    const value: MediaProblem = prior ? { ...b, detected_at: prior.detected_at, ...(prior.browser ? { browser: prior.browser } : {}) } : b;
    must(await db.from("gtm_sync_state").upsert({ key: problemKey(b.key), value, updated_at: r.ran_at }), `flag ${b.key}`);
    notes += await noteOnAsset(db, value);
  }
  const unreadable = new Set(r.unreadable.map((u) => u.key));
  // Only a file this run actually probed, clean, is cleared: a scoped run (--keys, --no-zernio) or one cut short by its
  // deadline never touches a finding it did not look at.
  const probed = new Set(r.probedKeys);
  const clear = flagged.filter((f) => f.source === "audit" && !badKeys.has(f.key) && !unreadable.has(f.key) && probed.has(f.key));
  for (const f of clear) must(await db.from("gtm_sync_state").delete().eq("key", problemKey(f.key)), `clear ${f.key}`);
  must(await db.from("gtm_sync_state").upsert({
    key: AUDIT_KEY, updated_at: r.ran_at,
    value: { ran_at: r.ran_at, scope: r.scope, since: r.since, probed: r.probed, storage: r.storage, zernio: r.zernio, videos: r.videos, images: r.images, skipped: r.skipped, bad: r.bad.length, unreadable: r.unreadable.length, unreadable_keys: await carryKeys(db, r), bad_keys: r.bad.map((b) => b.key) },
  }), "audit summary");
  return { flagged: r.bad.length, cleared: clear.length, notes };
}

/**
 * What the next run must probe again: the previous list minus what this run read, plus what this run could not read or
 * reach. A scoped run (--keys, the re-check inside --fix) only removes what it read; it never drops the cron's list.
 */
async function carryKeys(db: SupabaseClient, r: AuditResult): Promise<string[]> {
  const last = must(await db.from("gtm_sync_state").select("value").eq("key", AUDIT_KEY).maybeSingle(), "last audit") as { value: { unreadable_keys?: string[] } } | null;
  const unreadable = new Set(r.unreadable.map((u) => u.key));
  const read = new Set(r.probedKeys.filter((k) => !unreadable.has(k)));
  const isFolder = (k: string) => k.endsWith("/") || k === "(bucket root)";
  const kept = (last?.value.unreadable_keys ?? []).filter((k) => (isFolder(k) ? !r.listed : k.startsWith("zernio:") ? !r.zernioListed : !read.has(k)));
  return [...new Set([...kept, ...unreadable, ...r.skippedKeys])].slice(0, 500);
}

/** An open agent note on each Story asset behind a finding, once, so `gtm story feedback` surfaces it to the next agent. */
export async function noteOnAsset(db: SupabaseClient, p: MediaProblem): Promise<number> {
  let written = 0;
  for (const ref of p.refs.filter((x) => x.kind === "story-asset" || x.kind === "story-proxy")) {
    const open = must(await db.from("gtm_story_feedback").select("id").eq("asset_id", ref.id).is("resolved_at", null).like("body", `${NOTE_MARK}%`), "open notes") as { id: string }[] | null;
    if (open?.length) continue;
    // The reporter's own text never goes in: an agent acts on this note.
    const how = p.source === "browser" ? `A player in the cockpit could not ${p.kind === "image" ? "load" : "decode"} it; the server confirmed it.` : "The media audit probed it.";
    const body = p.kind === "image"
      ? `${NOTE_MARK} BLOCK: ${p.key} will not load in a browser: ${p.problems.join("; ")}. ${how} Fix: gtm media audit --fix (re-uploads it with the right content type, or converts it to an sRGB PNG; John's approvals carry forward), else re-export and restage it.`
      : `${NOTE_MARK} BLOCK: ${p.key} will not play in a browser: ${p.problems.join("; ")}. ${how} Fix: gtm media audit --fix (re-encodes in place to H.264 High yuv420p, AAC, faststart; John's approvals carry forward).`;
    must(await db.from("gtm_story_feedback").insert({ asset_id: ref.id, body: body.slice(0, 5000), author: "agent" }), `note on ${ref.id}`);
    written++;
  }
  return written;
}

const fileName = (key: string) => key.split("/").pop()?.split("?")[0] ?? key;

/** BLOCK findings for the /content panel and `gtm season`: one per unplayable file, linked to its piece. */
export function mediaChecks(rows: MediaProblem[]): Check[] {
  return rows.map((p) => {
    const where = p.where === "zernio" ? `scheduled on Zernio (${p.post?.platforms.join(", ") || "post"} ${p.post?.scheduledFor?.slice(0, 16).replace("T", " ") ?? ""})`.trim() : "in storage";
    const image = p.kind === "image";
    const seen = p.source === "browser" ? (image ? "the page could not load it" : "the player could not play it") : p.problems.join("; ");
    return {
      id: `unplayable-${image ? "image" : "video"}:${p.key}`, severity: "block" as const, status: "fail" as const,
      message: `${image ? "Won't load" : "Won't play"}: ${fileName(p.where === "zernio" ? p.url ?? p.key : p.key)} ${where}: ${seen}. Agents: gtm media audit --fix.`,
      ...(p.story_id ? { storyId: p.story_id } : {}),
    };
  });
}

/** The same findings for a page that has a Season analysis: appended as BLOCKs with the summary counted. */
export function withMediaChecks<T extends { checks: Check[]; summary: { block: number; warn: number; info: number } }>(analysis: T, rows: MediaProblem[]): T {
  if (!rows.length) return analysis;
  const extra = mediaChecks(rows);
  return { ...analysis, checks: [...extra, ...analysis.checks], summary: { ...analysis.summary, block: analysis.summary.block + extra.length } };
}
