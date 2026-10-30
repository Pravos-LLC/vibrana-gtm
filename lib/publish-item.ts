// Sends one approved calendar item to Zernio. Shared by `gtm schedule` and the calendar page.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { assertNoAgentNotes } from "./copy-guard";
import { basename, dirname, extname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoryAsset } from "./story";
import { renderMentions, type MentionChannel, type Person } from "./mentions";
import { calendarPath, isValidTime, localDateTime, resolveAsset, updateItem, zonedToUtc, type Calendar, type Item } from "./calendar";
import { PDFDocument } from "pdf-lib";
import { checkChannelLinks, hasUrl, shapeFromName } from "./channel-rules";
import { createPost, uploadMedia, uploadMediaStream, ZernioError } from "./zernio";
import { guardVideoFile, guardVideoRanged, httpRangeReader, isVideo } from "./media-guard";
import { hashingStream, LargeMedia } from "./large-media";
import { tagLinks, utmCampaign } from "./utm";
import { isHandPublished } from "./hand-published";

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf" };

export type PublishMode = "schedule" | "now";

/** True when the post goes out as a LinkedIn document: page images composed into a PDF, or a ready-made PDF. */
export function isDocumentPost(item: Item): boolean {
  return item.format === "document" || (item.media ?? []).some((m) => /\.pdf(\?|$)/i.test(m));
}

/** The cover title from a carousel's slides.json: a top-level `title`, else the first cover slide's title. */
function slidesTitle(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const spec = JSON.parse(readFileSync(file, "utf8")) as { title?: unknown; slides?: Array<{ type?: unknown; title?: unknown }> };
    const cover = spec.slides?.find((slide) => slide.type === "cover") ?? spec.slides?.[0];
    const title = typeof spec.title === "string" ? spec.title : typeof cover?.title === "string" ? cover.title : undefined;
    return title?.trim() || undefined;
  } catch { return undefined; }
}

/**
 * LinkedIn requires a title on document (PDF carousel) posts; without one Zernio falls back to the
 * file name (`<id>.pdf`). Order: the copy frontmatter `title`, then the carousel's slides.json next
 * to the copy file or the media (looked up only where the calendar's files are on this machine),
 * then the calendar item title.
 */
export function documentTitle(cal: Calendar, item: Item, meta: Record<string, string>): string {
  const fromCopy = meta.title?.trim();
  if (fromCopy) return fromCopy;
  const base = cal.source === "db" ? dirname(calendarPath()) : dirname(cal.path);
  const dirs = new Set<string>();
  if (item.copy) dirs.add(dirname(resolve(base, item.copy)));
  if (cal.source !== "db") {
    for (const m of item.media ?? []) {
      if (/^https?:/.test(m)) continue;
      const dir = dirname(resolve(base, m));
      dirs.add(dir).add(dirname(dir)); // carousel.pdf and slide images live in out/ beside slides.json
    }
  }
  for (const dir of dirs) {
    const title = slidesTitle(resolve(dir, "slides.json"));
    if (title) return title;
  }
  return item.title;
}

/** The people list for mentions. With an "@" in the text a failed read stops the send (never a raw "@Name" posted
 *  silently); without one it only costs the team's plain-name tags, so the post still goes. */
export async function peopleFor(db: SupabaseClient, text: string): Promise<Person[]> {
  const { loadPeople } = await import("./people");
  if (text.includes("@")) return loadPeople(db);
  return loadPeople(db).catch(() => []);
}

/** Seasons for the UTM campaign name. A failed read only costs the season label (the ISO week is used). */
export async function seasonsFor(db?: SupabaseClient): Promise<{ id: string; starts_on: string; ends_on: string }[]> {
  if (!db) return [];
  try {
    const { data } = await db.from("gtm_seasons").select("id,starts_on,ends_on");
    return (data ?? []) as { id: string; starts_on: string; ends_on: string }[];
  } catch { return []; }
}

export async function buildPost(cal: Calendar, item: Item, copyText?: string, utm?: { campaign: string }, people: Person[] = [], options: { shared?: boolean } = {}) {
  const igStory = item.format === "ig_story";
  if (igStory && (item.channels.length !== 1 || item.channels[0] !== "instagram")) throw new Error(`${item.id}: ig_story items must target instagram only`);
  if (copyText === undefined && !item.copy && !igStory) throw new Error(`${item.id} has no copy`);
  const { parseCopy } = await import("./calendar");
  // Instagram Stories carry no caption, so an ig_story item needs no copy file or body.
  const copy = parseCopy(copyText ?? (item.copy ? readFileSync(resolveAsset(cal, item.copy), "utf8") : ""));
  if (igStory && (copy.base.trim() || copy.meta.first_comment)) throw new Error(`${item.id}: Instagram Stories take no caption or first_comment; remove the copy`);
  assertNoAgentNotes(item.id, [copy.base, copy.meta.first_comment, ...Object.values(copy.perChannel)].filter(Boolean).join("\n"));
  const channels = item.channels.filter((ch) => !cal.manual.includes(ch) && !isHandPublished(ch));
  // Hard channel link rules (lib/channel-rules.ts), checked before any upload or Zernio call.
  const video = item.media?.find((m) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(m));
  const rules = checkChannelLinks(item.id, channels, copy, video ? shapeFromName(video) : null);
  if (rules.errors.length) throw new Error(rules.errors.join("\n"));
  const firstComment = copy.meta.first_comment?.trim();
  // Reel cover frame: Zernio's Instagram thumbOffset, in milliseconds from the start of the video.
  const rawThumbOffset = copy.meta.instagram_thumb_offset_ms;
  let thumbOffset: number | undefined;
  if (rawThumbOffset !== undefined && String(rawThumbOffset).trim() !== "") {
    const v = String(rawThumbOffset).trim();
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
      throw new Error(`${item.id}: instagram_thumb_offset_ms must be a non-negative integer (milliseconds), got ${JSON.stringify(rawThumbOffset)}`);
    }
    thumbOffset = Number(v);
  }
  const platforms = channels.map((ch) => {
    const accountId = cal.accounts[ch];
    if (!accountId) throw new Error(`no Zernio account mapped for channel ${ch} (calendar.yaml accounts:)`);
    const psd: Record<string, unknown> = {};
    if (ch === "youtube" && item.story_id && !copy.meta.youtube_title && !options.shared) {
      throw new Error(`${item.id}: Story YouTube posts need youtube_title in the approved copy file`);
    }
    if (ch === "youtube") Object.assign(psd, {
      title: copy.meta.youtube_title ?? (options.shared ? copy.base.trim().split(/\r?\n/)[0].slice(0,100) : item.title), visibility: copy.meta.youtube_visibility ?? "public",
      madeForKids: false,
      ...(copy.meta.youtube_category_id || copy.meta.youtube_category === "Science & Technology"
        ? { categoryId: copy.meta.youtube_category_id ?? "28" } : {}),
    });
    if (igStory) psd.contentType = "story";
    if (ch === "instagram" && thumbOffset !== undefined) psd.thumbOffset = thumbOffset;
    if (ch === "linkedin" && isDocumentPost(item)) psd.documentTitle = documentTitle(cal, item, copy.meta);
    // Zernio posts firstComment right after publishing. LinkedIn carries its link there (never in the
    // body); Instagram never gets a link, so a first_comment holding one is not sent to it.
    // Our own links get UTM tags per platform (lib/utm.ts), so a site visit traces back to this post.
    // @mentions become each platform's tag from the people list (lib/mentions.ts), then our links get their UTM tags.
    // LinkedIn first comments keep the team's names plain, as the shared tagging contract requires.
    const tag = (raw: string, opts: { comment?: boolean } = {}) => { const text = renderMentions(raw, ch as MentionChannel, people, opts); return utm ? tagLinks(text, { source: ch, campaign: utm.campaign, content: item.id }) : text; };
    if (firstComment && (options.shared ? ch === "linkedin" : (ch === "linkedin" || ch === "youtube" || (ch === "instagram" && !hasUrl(firstComment))))) psd.firstComment = tag(firstComment, { comment: true });
    const text = tag(copy.perChannel[ch] ?? copy.base);
    const custom = copy.perChannel[ch] || text !== copy.base ? text : undefined;
    return { platform: ch, accountId, ...(custom ? { customContent: custom } : {}), ...(Object.keys(psd).length ? { platformSpecificData: psd } : {}) };
  });
  if (!platforms.length) throw new Error(`${item.id} only targets manual channels (${item.channels.join(", ")}); publish it by hand and set status: published`);
  return { copy, platforms, warnings: rules.warnings };
}

/** A `format: document` item lists page images; the PDF is composed from exactly those bytes at send time. */
export async function composePdf(pages: Buffer[], kinds: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const [i, bytes] of pages.entries()) {
    const image = kinds[i] === ".png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    pdf.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return Buffer.from(await pdf.save());
}

/**
 * Streams a verified large video (an episode master, local or in storage) to Zernio, re-hashing it on the way. A
 * mismatch with the approved sha256 throws before any post is created, so the orphaned Zernio upload is never used.
 */
export async function sendLarge(m: LargeMedia, filename: string, contentType: string, db?: SupabaseClient): Promise<string> {
  let body: ReadableStream<Uint8Array>;
  if (m.storageKey) {
    if (!db) throw new Error(`${filename}: reading stored media needs a database connection`);
    const { BUCKET } = await import("./review");
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(m.storageKey, 60 * 60 * 6);
    if (error || !data) throw new Error(`${filename}: could not sign ${m.storageKey}: ${error?.message}`);
    // Header-only probe of the stored master first: a master that will not play never reaches Zernio.
    await guardVideoRanged(httpRangeReader(data.signedUrl), m.size, contentType, filename);
    const res = await fetch(data.signedUrl);
    if (!res.ok || !res.body) throw new Error(`${filename}: could not read ${m.storageKey} from storage: ${res.status}`);
    body = res.body;
  } else {
    guardVideoFile(m.path, contentType, filename);
    body = Readable.toWeb(createReadStream(m.path)) as ReadableStream<Uint8Array>;
  }
  const h = hashingStream(body);
  const url = await uploadMediaStream(h.stream, m.size, filename, contentType, isVideo(contentType, filename) ? "probed-playable" : "not-video");
  const sent = h.digest();
  if (sent.sha256 !== m.sha256 || sent.bytes !== m.size) throw new Error(`${filename}: the bytes sent do not match the approved digest; restage and review it`);
  return url;
}

const inMemory = (b: Buffer | LargeMedia, what: string): Buffer => {
  if (b instanceof LargeMedia) throw new Error(`${what} is a large video; it can only be sent as a video`);
  return b;
};

async function mediaItems(cal: Calendar, paths: string[] = [], upload: boolean, thumbnail?: string, verifiedBytes?: Map<string, Buffer | LargeMedia>, pdfName?: string) {
  const items: Array<{ type: string; url: string; thumbnail?: string }> = [];
  const verified = (abs: string) => {
    if (verifiedBytes && !verifiedBytes.has(abs)) throw new Error(`media ${abs} is outside the approved Story snapshot`);
    return verifiedBytes?.get(abs) ?? readFileSync(abs);
  };
  const content = (abs: string) => inMemory(verified(abs), abs);
  if (pdfName && paths.length && paths.every((p) => [".jpg", ".jpeg", ".png"].includes(extname(p).toLowerCase()))) {
    const abs = paths.map((p) => resolveAsset(cal, p));
    for (const a of abs) if (/^https?:/.test(a) || !existsSync(a)) throw new Error(`media not found: ${a}`);
    const pdf = await composePdf(abs.map((a) => content(a)), abs.map((a) => extname(a).toLowerCase()));
    return [{ type: "document", url: upload ? await uploadMedia(pdf, pdfName, "application/pdf") : `pdf:composed-from-${abs.length}-images` }];
  }
  for (const p of paths) {
    const abs = resolveAsset(cal, p);
    const ext = extname(abs).toLowerCase();
    const type = MIME[ext]?.startsWith("video") ? "video" : MIME[ext] === "application/pdf" ? "document" : "image";
    if (/^https?:/.test(abs)) items.push({ type, url: abs });
    else if (!existsSync(abs)) throw new Error(`media not found: ${abs}`);
    else if (!upload) items.push({ type, url: `file://${abs}` });
    else {
      const b = verified(abs);
      const contentType = MIME[ext] ?? "application/octet-stream";
      items.push({ type, url: b instanceof LargeMedia ? await sendLarge(b, basename(abs), contentType) : await uploadMedia(b, basename(abs), contentType) });
    }
  }
  if (thumbnail) {
    const videos = items.filter((item) => item.type === "video");
    if (videos.length !== 1) throw new Error("YouTube thumbnail needs exactly one video media item");
    const abs = resolveAsset(cal, thumbnail);
    const ext = extname(abs).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(ext) || /^https?:/.test(abs) || !existsSync(abs)) throw new Error(`YouTube thumbnail missing or not JPEG/PNG: ${thumbnail}`);
    videos[0].thumbnail = upload ? await uploadMedia(content(abs), basename(abs), MIME[ext]!) : `file://${abs}`;
  }
  return items;
}

/** Create the Zernio post for one approved item. `now` publishes immediately; `schedule` uses the calendar time. */
export async function sendCalendarItem(cal: Calendar, id: string, opts: SendOpts = {}) {
  const mode = opts.mode ?? "schedule";
  const item = cal.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`no calendar item ${id}`);
  if (item.status !== "approved") throw new Error(`${id} is ${item.status}; only approved items can be scheduled`);
  // Checked before anything else: a malformed time once produced a NaN date that slipped past the too-soon guard.
  if (item.time != null && !isValidTime(item.time)) throw new Error(`${id}: bad time ${JSON.stringify(item.time)} (expected HH:MM); fix the calendar before scheduling`);
  if (cal.source === "db") return sendDbItem(cal, item, opts);
  let storySnapshot: Awaited<ReturnType<typeof import("./story")["checkStoryApproval"]>>;
  if (item.story_id) {
    const { adminDb } = await import("./db");
    const { assertFinalStage, checkStoryApproval } = await import("./story");
    storySnapshot = await checkStoryApproval(opts.db ?? adminDb(), cal, item);
    // A rough cut (any media short of its final stage) is never sent, approved or not (a Zernio draft still is).
    if (!opts.draft) assertFinalStage(item, storySnapshot?.assets ?? []);
  }
  const copyBytes = item.copy ? storySnapshot?.bytes.get(resolveAsset(cal, item.copy)) : undefined;
  const copyText = Buffer.isBuffer(copyBytes) ? copyBytes.toString("utf8") : undefined;
  if (item.story_id && item.copy && copyText === undefined) throw new Error(`${id}: approved copy snapshot is missing`);
  const { copy, platforms, warnings: ruleWarnings } = await buildPost(cal, item, copyText, { campaign: utmCampaign(item.date, await seasonsFor(opts.db)) });
  const youtube = item.channels.includes("youtube");
  const thumbnail = youtube && copy.meta.youtube_thumbnail
    ? resolve(dirname(resolveAsset(cal, item.copy!)), copy.meta.youtube_thumbnail)
    : undefined;
  if (storySnapshot && thumbnail) {
    const { assertStoryImage } = await import("./story");
    assertStoryImage(cal, item, storySnapshot.assets, thumbnail);
  }
  if (item.zernio_post_id === "pending") throw new Error(`${id} has a scheduling attempt in flight or interrupted (zernio_post_id: pending). Check Zernio for a post with metadata.calendarId=${id}, then set the real id or clear it.`);
  if (item.zernio_post_id) throw new Error(`${id} already has Zernio post ${item.zernio_post_id}`);
  if (mode === "schedule" && !opts.draft) {
    // zonedToUtc throws on a malformed time, so a NaN date can never slip past the too-soon guard.
    const when = zonedToUtc(item.date, item.time ?? "08:30", cal.timezone);
    if (Number.isNaN(when.getTime())) throw new Error(`${id}: could not resolve the scheduled time`);
    if (!opts.allowPast && when.getTime() < Date.now() + 5 * 60_000) {
      throw new Error(`${id} is due ${when.toISOString()}, which is in the past (or under 5 min away): Zernio would publish it immediately. Move the date or pass --allow-past.`);
    }
  }
  const tags = youtube && copy.meta.youtube_tags ? copy.meta.youtube_tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (copy.meta.youtube_thumbnail && (item.channels.length !== 1 || !youtube)) throw new Error(`${id}: YouTube thumbnail requires a YouTube-only item`);
  const body = {
    content: copy.base, platforms, timezone: cal.timezone,
    ...(mode === "now" && !opts.draft ? { publishNow: true } : { scheduledFor: localDateTime(item) }),
    mediaItems: await mediaItems(cal, item.media, !opts.dry, thumbnail, storySnapshot?.bytes, item.format === "document" ? `${id}.pdf` : undefined),
    ...(tags.length ? { tags } : {}),
    metadata: { calendarId: id, ...(item.story_id ? { storyId: item.story_id } : {}) }, ...(opts.draft ? { isDraft: true } : {}),
  };
  if (opts.dry) return { id, dryRun: true as const, body, ...(ruleWarnings.length ? { warnings: ruleWarnings } : {}) };
  if (!opts.draft) updateItem(cal.path, id, { zernio_post_id: "pending" });
  let created;
  try {
    const key = opts.idempotencyKey ?? `gtm-${id}${opts.draft ? "-draft" : ""}${mode === "now" ? "-now" : ""}`;
    created = await createPost(body, key);
  } catch (e) {
    if (!opts.draft && e instanceof ZernioError && e.status < 500) updateItem(cal.path, id, { zernio_post_id: null });
    throw e;
  }
  if (!created.post?._id) throw new Error(`${id}: Zernio returned no post id (left as pending; check Zernio): ${JSON.stringify(created).slice(0, 300)}`);
  const published = mode === "now" && created.post.status === "published";
  const urls = Object.fromEntries((created.post.platforms ?? []).flatMap((platform) => platform.platformPostUrl ? [[platform.platform, platform.platformPostUrl]] : []));
  if (!opts.draft) {
    const patch: Partial<Item> = { status: published ? "published" : "scheduled", zernio_post_id: created.post._id, ...(published ? { published_at: new Date().toISOString(), ...(Object.keys(urls).length ? { urls } : {}) } : {}) };
    try {
      updateItem(cal.path, id, patch);
      if (opts.db) {
        const { error } = await opts.db.from("gtm_content_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw new Error(error.message);
      }
    } catch (e) {
      throw new Error(`${id}: Zernio post ${created.post._id} WAS created but calendar write-back failed (${(e as Error).message}). Set zernio_post_id: ${created.post._id} by hand.`);
    }
  }
  return {
    id, zernioPostId: created.post._id, zernioStatus: created.post.status,
    ...( "scheduledFor" in body ? { scheduledFor: body.scheduledFor } : {}),
    draft: Boolean(opts.draft), warnings: [...(created.warnings ?? []), ...ruleWarnings],
  };
}

type SendOpts = {
  mode?: PublishMode; dry?: boolean; draft?: boolean; allowPast?: boolean; db?: SupabaseClient;
  /**
   * Zernio's Idempotency-Key. Defaults to `gtm-<id>` (plus -draft/-now). A retry of a failed post passes its own: Zernio keeps
   * a key for 24 hours and answers the same key with a different body with a 422 (lib/retry-item.ts).
   */
  idempotencyKey?: string;
};

function guardTiming(cal: Calendar, item: Item, mode: PublishMode, opts: SendOpts) {
  if (item.zernio_post_id === "pending") throw new Error(`${item.id} has a scheduling attempt in flight or interrupted (zernio_post_id: pending). Check Zernio for a post with metadata.calendarId=${item.id}, then set the real id or clear it.`);
  if (item.zernio_post_id) throw new Error(`${item.id} already has Zernio post ${item.zernio_post_id}`);
  if (mode === "schedule" && !opts.draft) {
    const when = zonedToUtc(item.date, item.time ?? "08:30", cal.timezone);
    if (Number.isNaN(when.getTime())) throw new Error(`${item.id}: could not resolve the scheduled time`);
    if (!opts.allowPast && when.getTime() < Date.now() + 5 * 60_000) {
      throw new Error(`${item.id} is due ${when.toISOString()}, which is in the past (or under 5 min away): Zernio would publish it immediately. Move the date or pass --allow-past.`);
    }
  }
}

/** Database calendar: text from the row (or the approved Story snapshot), media from storage. */
async function sendDbItem(cal: Calendar, item: Item, opts: SendOpts) {
  const id = item.id;
  const mode = opts.mode ?? "schedule";
  const { adminDb } = await import("./db");
  const { BUCKET } = await import("./review");
  const { contentHash, siblingSource, updateItemDb } = await import("./calendar-db");
  const db = opts.db ?? adminDb();
  if(item.story_id) {
    const {loadPieceReview}=await import("./piece-review");
    const shared=await loadPieceReview(db,item.story_id);
    if(shared) {
      if(opts.draft||mode==="now")throw new Error("Shared pieces use review and automatic scheduling; inspect their channel deliveries in /content");
      if(!shared.ready)throw new Error(shared.blockers.join("; "));
      const result=await (await import("./piece-schedule")).scheduleSharedPieces(db,{storyId:item.story_id,dryRun:opts.dry});
      if(opts.dry)return {id,dryRun:true as const,body:{sharedReview:shared,slots:result.scheduled}};
      const sent=result.scheduled.find(s=>s.id===id);
      if(!sent?.zernioPostId)throw new Error(result.failed.find(f=>f.id===id)?.error??result.skipped.find(s=>s.id===id)?.reason??"No new delivery created. Inspect the existing channel outcome before retrying.");
      return {id,zernioPostId:sent.zernioPostId,zernioStatus:sent.zernioStatus??"scheduled",scheduledFor:`${sent.date}T${sent.time}:00`,draft:false,warnings:[]};
    }
  }
  // Pending third-party approval: a held Story is never sent (a Zernio draft to preview it still is).
  if (item.story_id && !opts.draft) {
    const { holdFor, holdReason, loadAgentHolds, heldBy } = await import("./auto-schedule");
    // The same channel-scoped agent holds as autoscheduling (#157): a fix on the Instagram text never holds LinkedIn.
    const hold = await holdFor(db, item.story_id) ?? heldBy(item, await loadAgentHolds(db, item.story_id));
    if (hold) throw new Error(`${id} is on hold, ${holdReason(hold)}. Release it ("<who> approved the final" in /content, or gtm release ${item.story_id}) first.`);
  }
  let copyText: string | undefined;
  let snapshot: Map<string, Buffer | LargeMedia> | undefined;
  let storyAssets: import("./story").StoryAsset[] = [];
  if (item.story_id) {
    const { assertFinalStage, checkStoryApprovalDb } = await import("./story");
    const story = await checkStoryApprovalDb(db, item);
    // The last gate before Zernio, beside the hold: a rough cut is never sent, approved or not (a draft still is).
    if (!opts.draft) assertFinalStage(item, story.assets);
    copyText = story.copyText;
    snapshot = story.bytes;
    storyAssets = story.assets;
  } else {
    if (!item.body?.trim() && item.format !== "ig_story") throw new Error(`${id} has no body`);
    if (!item.approved_hash || item.approved_hash !== contentHash({ body: item.body, media: item.media })) {
      throw new Error(`${id}: the text or media changed after approval (or it was never approved); approve it again`);
    }
    copyText = item.body ?? "";
  }
  const { copy, platforms, warnings: ruleWarnings } = await buildPost(cal, item, copyText, { campaign: utmCampaign(item.date, await seasonsFor(db)) }, copyText ? await peopleFor(db, copyText) : []);
  const youtube = item.channels.includes("youtube");
  if (copy.meta.youtube_thumbnail && (item.channels.length !== 1 || !youtube)) throw new Error(`${id}: YouTube thumbnail requires a YouTube-only item`);
  let thumbnailKey: string | undefined;
  let thumbnailSha: string | undefined;
  if (youtube && copy.meta.youtube_thumbnail) {
    if (!item.copy) throw new Error(`${id}: a YouTube thumbnail needs the Story copy path to resolve against`);
    const source = siblingSource(item.copy, copy.meta.youtube_thumbnail);
    const asset = storyAssets.find((a) => a.kind === "image" && a.source === source && item.story_assets?.includes(a.id));
    if (asset?.storage_path) thumbnailKey = asset.storage_path;
    else {
      // No image asset of its own: the thumbnail staged beside the approved YouTube copy (gtm story stage stores it with its
      // sha256). It is re-hashed against that digest as it is sent, so only the staged bytes ever go out.
      const own = storyAssets.find((a) => a.kind === "copy" && a.source === item.copy && item.story_assets?.includes(a.id));
      const staged = own?.metadata as { thumbnail_path?: string; thumbnail_sha256?: string } | null | undefined;
      if (!staged?.thumbnail_path || !staged.thumbnail_sha256) throw new Error(`${id}: cover ${source} is not bound to an approved Story image`);
      thumbnailKey = staged.thumbnail_path;
      thumbnailSha = staged.thumbnail_sha256;
    }
  }
  // Length, measured on exactly what each platform receives (mentions and UTM tags rendered, which can add characters):
  // LinkedIn refuses a text over 4,000 at publish time (lib/channel-rules.ts TEXT_LIMITS). Nothing is uploaded first.
  const { checkChannelLength } = await import("./channel-rules");
  const long = platforms.flatMap((p) => checkChannelLength(id, [p.platform], { base: (p as { customContent?: string }).customContent ?? copy.base, perChannel: {}, meta: copy.meta }));
  if (long.length) throw new Error(long.join("\n"));
  guardTiming(cal, item, mode, opts);
  const read = async (key: string) => {
    const cached = snapshot?.get(key);
    if (cached) return cached;
    if (item.story_id) throw new Error(`media ${key} is outside the approved Story snapshot`);
    const { data, error } = await db.storage.from(BUCKET).download(key);
    if (error || !data) throw new Error(`${id}: media ${key} missing from storage: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  };
  const upload = async (key: string) => {
    const ext = extname(key).toLowerCase();
    if (opts.dry) return `storage://${key}`;
    const b = await read(key);
    const contentType = MIME[ext] ?? "application/octet-stream";
    // A large master streams from storage to Zernio, re-hashed against its approved sha256 on the way.
    return b instanceof LargeMedia ? sendLarge(b, basename(key), contentType, db) : uploadMedia(b, basename(key), contentType);
  };
  const mediaItems: Array<{ type: string; url: string; thumbnail?: string }> = [];
  const media = item.media ?? [];
  const pageImage = (path: string) => [".jpg", ".jpeg", ".png"].includes(extname(path.split("?")[0]).toLowerCase());
  if (item.format === "document" && media.length && media.every(pageImage)) {
    // Same as the file calendar: a document item lists page images and the PDF is composed from exactly those bytes.
    const pages: Buffer[] = [];
    for (const path of media) {
      if (/^https:\/\//.test(path)) throw new Error(`${id}: document pages must be stored media, not ${path}`);
      pages.push(inMemory(await read(path), path));
    }
    const pdf = await composePdf(pages, media.map((path) => extname(path.split("?")[0]).toLowerCase()));
    mediaItems.push({ type: "document", url: opts.dry ? `pdf:composed-from-${pages.length}-images` : await uploadMedia(pdf, `${id}.pdf`, "application/pdf") });
  } else for (const path of media) {
    const ext = extname(path.split("?")[0]).toLowerCase();
    const type = MIME[ext]?.startsWith("video") ? "video" : MIME[ext] === "application/pdf" ? "document" : "image";
    mediaItems.push({ type, url: /^https:\/\//.test(path) ? path : await upload(path) });
  }
  if (thumbnailKey) {
    const videos = mediaItems.filter((m) => m.type === "video");
    if (videos.length !== 1) throw new Error("YouTube thumbnail needs exactly one video media item");
    if (thumbnailSha) {
      if (opts.dry) videos[0].thumbnail = `storage://${thumbnailKey}`;
      else {
        const { digest } = await import("./story");
        const { data, error } = await db.storage.from(BUCKET).download(thumbnailKey);
        if (error || !data) throw new Error(`${id}: thumbnail ${thumbnailKey} missing from storage: ${error?.message}`);
        const bytes = Buffer.from(await data.arrayBuffer());
        if (digest(bytes) !== thumbnailSha) throw new Error(`${id}: the thumbnail changed after approval; restage the copy`);
        videos[0].thumbnail = await uploadMedia(bytes, basename(thumbnailKey), MIME[extname(thumbnailKey).toLowerCase()] ?? "image/jpeg");
      }
    } else videos[0].thumbnail = await upload(thumbnailKey);
  }
  // Instagram Reel cover (John, 2026-10-16): the Story image bound beside exactly one video is its cover, never a slide. It
  // goes out from the approved snapshot as Zernio's instagramThumbnail. LinkedIn has no cover option and the YouTube API
  // takes no custom thumbnail on a Short, so those posts carry the video alone.
  if (item.story_id && item.channels.length === 1 && item.channels[0] === "instagram") {
    const cover = reelCover(item, storyAssets, mediaItems);
    const ig = platforms.find((p) => p.platform === "instagram") as { platformSpecificData?: Record<string, unknown> } | undefined;
    if (cover && ig) ig.platformSpecificData = { ...(ig.platformSpecificData ?? {}), instagramThumbnail: await upload(cover) };
  }
  const tags = youtube && copy.meta.youtube_tags ? copy.meta.youtube_tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const body = {
    content: copy.base, platforms, timezone: cal.timezone,
    ...(mode === "now" && !opts.draft ? { publishNow: true } : { scheduledFor: localDateTime(item) }),
    mediaItems, ...(tags.length ? { tags } : {}),
    metadata: { calendarId: id, ...(item.story_id ? { storyId: item.story_id } : {}) }, ...(opts.draft ? { isDraft: true } : {}),
  };
  if (opts.dry) return { id, dryRun: true as const, body, ...(ruleWarnings.length ? { warnings: ruleWarnings } : {}) };
  if (!opts.draft) await claimLegacySend(db, id, item, storyAssets, mode);
  let created;
  try {
    created = await createPost(body, opts.idempotencyKey ?? `gtm-${id}${opts.draft ? "-draft" : ""}${mode === "now" ? "-now" : ""}`);
  } catch (e) {
    // A 4xx means Zernio created nothing (a 429 is still rate-limited after the client's retries): the claim is reset, so
    // the next pass retries it, and the failure is in the pass's report on /content (review #151 F1; main's behavior).
    if (!opts.draft && e instanceof ZernioError && e.status < 500) {
      await updateItemDb(db, id, { zernio_post_id: null });
      if (e.status === 429) throw new Error(`${id}: Zernio is rate-limiting posts (429) and created nothing; it is retried on the next scheduling pass`);
    }
    throw e;
  }
  if (!created.post?._id) throw new Error(`${id}: Zernio returned no post id (left as pending; check Zernio): ${JSON.stringify(created).slice(0, 300)}`);
  const published = mode === "now" && created.post.status === "published";
  const urls = Object.fromEntries((created.post.platforms ?? []).flatMap((p) => p.platformPostUrl ? [[p.platform, p.platformPostUrl]] : []));
  if (!opts.draft) {
    try {
      await updateItemDb(db, id, { status: published ? "published" : "scheduled", zernio_post_id: created.post._id, ...(published ? { published_at: new Date().toISOString(), ...(Object.keys(urls).length ? { urls } : {}) } : {}) });
    } catch (e) {
      throw new Error(`${id}: Zernio post ${created.post._id} WAS created but calendar write-back failed (${(e as Error).message}). Set zernio_post_id: ${created.post._id} by hand.`);
    }
  }
  return {
    id, zernioPostId: created.post._id, zernioStatus: created.post.status,
    ...("scheduledFor" in body ? { scheduledFor: body.scheduledFor } : {}),
    draft: Boolean(opts.draft), warnings: [...(created.warnings ?? []), ...ruleWarnings],
  };
}

/** The storage key of a Reel's cover: one bound Story image that is not itself posted, beside exactly one video. */
export function reelCover(item: Pick<Item, "media" | "story_assets">, assets: Pick<StoryAsset, "id" | "kind" | "storage_path">[], media: Array<{ type: string }>): string | null {
  if (media.filter((m) => m.type === "video").length !== 1 || media.length !== 1) return null;
  const covers = assets.filter((a) => a.kind === "image" && a.storage_path && item.story_assets?.includes(a.id) && !(item.media ?? []).includes(a.storage_path));
  return covers.length === 1 ? covers[0].storage_path : null;
}

/**
 * The one claim before a legacy post reaches Zernio (gtm_claim_legacy_send): holds, accepted fixes, final approval at the
 * current bytes and third-party sign-off are re-checked in the database, and the row is marked pending so a second
 * sender stops. Its refusals are put in plain words (review #151 N4). "Publish now" is never refused only because the
 * channel already has a post that day: the database refuses for the slot only after every other check passed, so the
 * claim is then taken with a compare-and-swap on the same approved row.
 */
export async function claimLegacySend(db: SupabaseClient, id: string, item: Item, storyAssets: Array<Pick<StoryAsset, "id" | "sha256" | "revision">>, mode: "now" | "schedule" | string) {
  const r = await db.rpc("gtm_claim_legacy_send", { p_calendar_id: id, p_expected: { calendar: { body: item.body ?? null, media: item.media ?? [], assets: item.story_assets ?? [], date: item.date, time: item.time ?? null, channels: item.channels, story_id: item.story_id ?? null, approved_hash: item.approved_hash ?? null }, assets: storyAssets.map((a) => ({ id: a.id, sha256: a.sha256, revision: a.revision })) } });
  if (!r.error) return;
  const msg = r.error.message;
  if (/publishing slot was taken/.test(msg)) {
    if (mode === "now") {
      const q = db.from("gtm_content_items").update({ zernio_post_id: "pending" }).eq("id", id).eq("status", "approved").is("zernio_post_id", null).eq("date", item.date);
      const claimed = await (item.approved_hash ? q.eq("approved_hash", item.approved_hash) : q.is("approved_hash", null)).select("id").maybeSingle();
      if (claimed.error) throw new Error(`${id}: could not claim the post: ${claimed.error.message}`);
      if (!claimed.data) throw new Error(`${id}: the post changed or was sent by someone else meanwhile; refresh and try again`);
      return;
    }
    throw new Error(`${id}: ${item.channels.join(", ")} already has a post on ${item.date}. Move this post to another day in /calendar, or use Publish now to send it anyway.`);
  }
  if (/already claimed or no longer approved/.test(msg))
    throw new Error(`${id}: not sent. It is ${item.status === "approved" ? "already on its way to Zernio (another send claimed it)" : `a ${item.status} post`}; ${item.status === "approved" ? "refresh the calendar" : "approve it in /content first"}.`);
  if (/held or waiting for an accepted fix/.test(msg)) throw new Error(`${id}: not sent. The piece is on hold or waiting for the fix John approved with a note.`);
  if (/use shared piece dispatch/.test(msg)) throw new Error(`${id}: not sent. This piece uses shared review; it schedules from its card in /content.`);
  if (/changed before sending/.test(msg)) throw new Error(`${id}: not sent. The post or its approval changed since this page loaded; refresh and try again.`);
  throw new Error(`${id}: claim approved post: ${msg}`);
}
