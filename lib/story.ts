// Story staging and the final, local-byte-aware channel approval gate.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseDocument } from "yaml";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCopy, resolveAsset, type Calendar, type Item } from "./calendar";
import { channelText, checkLinkedinLength } from "./channel-rules";
import { must } from "./db";
import { frontmatterData, splitFrontmatter } from "./frontmatter";
import { BUCKET } from "./review";
import { guardMediaBytes, imageUploadProblems, UnloadableImageError, UnplayableVideoError, videoBytesProblems } from "./media-guard";
import { ffmpegAvailable, healInPlace } from "./video-heal";
import { webPlayableProblemsFile } from "./video-playable";
import { LargeMedia, MAX_VIDEO_BYTES, isLargeSize, sha256File, tusUpload } from "./large-media";
import { needsReviewProxy, stageReviewProxy } from "./review-proxy";
import { FINAL_STAGE, STAGE_PATTERN, nonFinal } from "./stage";
import { isFormat, pipelineOf, stageOf, type Format } from "./pipelines";
import { finalState, pipelineView, stagedStages, type StageRow } from "./pipeline-state";
import { planStageRows } from "./stage-progress";
import { packagingGate, legacyPackagingRecord, type ExistingPackagingAsset } from "./packaging/model";

export type StoryAssetKind = "video" | "image" | "copy" | "link";
export type StoryAsset = {
  id: string; story_id: string; title: string; kind: StoryAssetKind; source: string;
  sha256: string; revision: number; storage_path: string | null; body: string | null; url: string | null;
  metadata: Record<string, unknown>;
  /** Pipeline stage (gtm_story_assets.stage): null or "final" can go out; anything else (a rough cut) never does. */
  stage?: string | null;
};
export type StoryChannel = {
  asset_id: string; channel: string; status: "pending" | "approved" | "rejected";
  approved_sha256: string | null; note: string;
};
// stage: the pipeline stage of the media (video, image), e.g. rough-cut or final. On one asset it always applies; on the
// Story (or `gtm story stage --stage <key>`, which overrides it) it applies to the media whose bytes are new or changed,
// so staging a storyboard never relabels the rough cut beside it. Left out, an asset keeps the stage it already has.
// pipeline / series / third_party: the Story's pipeline (lib/pipelines.ts), its series for batch review, and who signs
// off on the final before it may publish. changes (Story or asset): what changed in this version, shown to John.
// label (e.g. v4), review_points ([{t, label}] jump points) and inputs ({keep: sha, ...}) describe one asset's version.
export type ReviewPoint = { t: number; label: string };
type ManifestAsset = {
  id: string; title: string; kind: StoryAssetKind; source: string; channels: string[]; stage?: string;
  changes?: string; label?: string; review_points?: ReviewPoint[]; inputs?: Record<string, string>;
  /** Local package manifest (relative to story.yaml), bound to the exact exported cover. */
  packaging?: string; role?: "cover";
};
type Manifest = {
  id: string; title: string; link: string; season?: string; stage?: string; assets: ManifestAsset[]; // season: gtm_seasons id, so /content and `gtm season` count the piece
  pipeline?: string; series?: string; third_party?: string; changes?: string;
};
export type PlannedAsset = ManifestAsset & {
  sha256: string; abs: string; bytes: number; content: Buffer | null; body: string | null; url: string | null; metadata?: Record<string, unknown>;
  /** A video over 50 MiB (an episode final): never in memory (content is null); resumable upload plus a review proxy. */
  large?: boolean;
  /** The stage was named on the asset itself, so it applies even to unchanged bytes. */
  stageExplicit?: boolean;
};
export type StoryHead = { id: string; title: string; link: string; season_id?: string | null; pipeline?: Format | null; series?: string | null; third_party_who?: string | null };
export type StageOptions = { stage?: string; changes?: string; reopen?: boolean; /** false: refuse an unplayable video instead of re-encoding it (gtm story stage --no-heal). */ heal?: boolean; shared?: boolean;
  /** Tests only (the CLI never sets it): treat shared delivery as installed, to exercise shared staging before VIB-446. */
  assumeSharedDelivery?: boolean };
/** Bytes a publish gate verified: in memory for normal media, or a LargeMedia handle streamed when it is sent. */
export type VerifiedMedia = Map<string, Buffer | LargeMedia>;

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const mediaKinds = new Set(["video", "image"]);
const mime: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The manifest stores paths relative to calendar.yaml, matching each calendar item. */
export function planStory(manifestPath: string, cal: Calendar, stage?: string, opts: StageOptions = {}): { story: Manifest; assets: PlannedAsset[] } {
  const doc = parseDocument(readFileSync(resolve(manifestPath), "utf8"));
  if (doc.errors.length) throw new Error(`story manifest: ${doc.errors[0].message}`);
  const story = doc.toJS() as Manifest;
  if (!story || !idPattern.test(story.id) || !story.title?.trim() || !/^https:\/\//.test(story.link) || !Array.isArray(story.assets) || !story.assets.length) {
    throw new Error("story manifest needs an id, title, HTTPS link and assets");
  }
  for (const key of [stage, story.stage, ...story.assets.map((a) => a?.stage)]) {
    if (key !== undefined && (typeof key !== "string" || !STAGE_PATTERN.test(key))) throw new Error(`invalid stage ${JSON.stringify(key)}: use a lowercase key such as rough-cut or ${FINAL_STAGE}`);
  }
  if (story.pipeline !== undefined && !isFormat(story.pipeline)) throw new Error(`invalid pipeline ${JSON.stringify(story.pipeline)}: one of short, carousel, text, episode, video`);
  if (story.series !== undefined && (typeof story.series !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(story.series))) throw new Error(`invalid series ${JSON.stringify(story.series)}: a lowercase key such as example-shorts`);
  if (story.third_party !== undefined && (typeof story.third_party !== "string" || !story.third_party.trim() || story.third_party.length > 200)) throw new Error("third_party is who signs off on the final (up to 200 characters)");
  if (isFormat(story.pipeline)) {
    const p = pipelineOf(story.pipeline);
    for (const key of [stage, story.stage, ...story.assets.map((a) => a?.stage)]) {
      if (key !== undefined && !stageOf(p, key)) throw new Error(`stage "${key}" is not in the ${p.format} pipeline (${p.stages.map((s) => s.key).join(", ")})`);
    }
  }
  if (opts.shared && (story.assets.filter(a => a.kind === "copy").length !== 1 || story.assets.filter(a => a.kind === "video").length !== 1)) throw new Error("Shared review requires exactly one text and one video");
  const storyChanges = opts.changes ?? story.changes;
  const seen = new Set<string>();
  const workspace = realpathSync(process.env.GTM_WORKSPACE ?? resolve(homedir(), "Projects/john-workspace"));
  const assets = story.assets.map((a) => {
    if (!idPattern.test(a.id) || seen.has(a.id) || !a.title?.trim() || !["video", "image", "copy", "link"].includes(a.kind) || !a.source || !Array.isArray(a.channels)) {
      throw new Error(`invalid or duplicate story asset ${a.id}`);
    }
    seen.add(a.id);
    if (a.stage !== undefined && !mediaKinds.has(a.kind)) throw new Error(`${a.id}: only video and image assets have a stage (text has its own lane)`);
    const stageExplicit = a.stage !== undefined && stage === undefined;
    const assetStage = mediaKinds.has(a.kind) ? stage ?? a.stage ?? story.stage : undefined;
    a = { ...a, stage: assetStage, ...(a.packaging ? { packaging: resolve(dirname(resolve(manifestPath)), a.packaging) } : {}) };
    if (assetStage === undefined) delete a.stage;
    const meta = versionMeta(a, storyChanges);
    if (a.channels.some((ch) => !/^[a-z][a-z0-9_]*$/.test(ch)) || new Set(a.channels).size !== a.channels.length) throw new Error(`${a.id}: invalid channels`);
    const abs = resolveAsset(cal, a.source);
    if (a.kind === "link") {
      if (!/^https:\/\//.test(abs) || abs !== story.link) throw new Error(`${a.id}: link must be the Story's live HTTPS URL`);
      return { ...a, abs, sha256: digest(abs), bytes: Buffer.byteLength(abs), content: null, body: null, url: abs, ...(meta ? { metadata: meta } : {}) };
    }
    if (/^https?:/.test(abs) || !existsSync(abs)) throw new Error(`${a.id}: local file missing: ${abs}`);
    const inside = relative(workspace, realpathSync(abs));
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${a.id}: source must be inside ${workspace}`);
    const contentType = mime[extname(abs).toLowerCase()];
    if (a.kind === "video" && contentType !== "video/mp4") throw new Error(`${a.id}: expected MP4 video`);
    if (a.kind === "image" && !contentType?.startsWith("image/")) throw new Error(`${a.id}: expected PNG, JPEG or WebP image`);
    const size = statSync(abs).size;
    if (a.kind === "video" && isLargeSize(size)) {
      // An episode final: hashed in chunks, never read whole (a Buffer cannot hold several GB). See lib/large-media.ts.
      if (size > MAX_VIDEO_BYTES) throw new Error(`${a.id}: ${(size / 1024 ** 3).toFixed(2)} GiB is over the 5 GiB limit (content-review and Zernio's upload); encode it smaller`);
      return { ...a, abs, sha256: sha256File(abs), bytes: size, content: null, body: null, url: null, large: true, ...(stageExplicit ? { stageExplicit } : {}), ...(meta ? { metadata: meta } : {}) };
    }
    if (mediaKinds.has(a.kind) && isLargeSize(size)) throw new Error(`${a.id}: an image over 50 MiB; export it smaller`);
    const bytes = readFileSync(abs);
    return { ...a, abs, sha256: digest(bytes), bytes: bytes.length, content: bytes, body: a.kind === "copy" ? bytes.toString("utf8") : null, url: null, ...(stageExplicit ? { stageExplicit } : {}), ...(meta ? { metadata: meta } : {}) };
  });
  return { story, assets };
}

/** What a version says about itself (metadata on the asset, copied to its version row): changes, label, jump points, input hashes. */
function versionMeta(a: ManifestAsset, storyChanges: string | undefined): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  const changes = a.changes ?? storyChanges;
  if (changes !== undefined) {
    if (typeof changes !== "string" || changes.length > 2000) throw new Error(`${a.id}: changes is a sentence (up to 2000 characters)`);
    if (changes.trim()) meta.changes = changes.trim();
  }
  if (a.label !== undefined) {
    if (typeof a.label !== "string" || !/^[\w.\- ]{1,20}$/.test(a.label)) throw new Error(`${a.id}: label is a short version name such as v4`);
    meta.label = a.label;
  }
  if (a.review_points !== undefined) {
    if (!Array.isArray(a.review_points) || a.review_points.some((p) => typeof p?.t !== "number" || p.t < 0 || typeof p.label !== "string" || !p.label.trim())) {
      throw new Error(`${a.id}: review_points is a list of { t: seconds, label: text }`);
    }
    meta.review_points = a.review_points.map((p) => ({ t: p.t, label: p.label.trim() }));
  }
  if (a.inputs !== undefined) {
    if (!a.inputs || typeof a.inputs !== "object" || Object.values(a.inputs).some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) {
      throw new Error(`${a.id}: inputs maps a name to the sha256 of an input file`);
    }
    meta.inputs = a.inputs;
  }
  return Object.keys(meta).length ? meta : null;
}

async function upload(db: SupabaseClient, key: string, content: Buffer, ext: string, publish: boolean) {
  // An asset bound to a platform goes out (Zernio's 5 MB image limit), as the stage check says; a poster still is only
  // for the page.
  guardMediaBytes(content, mime[ext], key, { publish });
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(key, { upsert: true });
  if (error || !data) throw new Error(`sign upload ${key}: ${error?.message}`);
  const result = await db.storage.from(BUCKET).uploadToSignedUrl(key, data.token, content, {
    contentType: mime[ext], upsert: true,
  });
  if (result.error) throw new Error(`upload ${key}: ${result.error.message}`);
}

/** One stderr line per 10% of a long upload, so an agent watching a multi-GB stage sees it move. Silent under node --test. */
function progress(label: string) {
  let shown = -1;
  return (sent: number, total: number) => {
    const pct = Math.floor((sent / total) * 10) * 10;
    if (pct === shown || process.env.NODE_TEST_CONTEXT) return;
    shown = pct;
    process.stderr.write(`${label}: ${pct}% of ${(total / 1024 ** 2).toFixed(0)} MiB\n`);
  };
}

/** Size of a stored object, or null when it is not there. Lets a rerun after a failed proxy skip a multi-GB re-upload. */
async function storedSize(db: SupabaseClient, key: string): Promise<number | null> {
  const cut = key.lastIndexOf("/");
  const { data, error } = await db.storage.from(BUCKET).list(key.slice(0, cut), { search: key.slice(cut + 1), limit: 10 });
  if (error || !data) return null;
  const size = (data.find((o) => o.name === key.slice(cut + 1))?.metadata as { size?: unknown } | null | undefined)?.size;
  return typeof size === "number" ? size : null;
}

/** Resumable upload of a file of any size; an object whose bytes do not match the planned sha256 is removed again. */
async function uploadLarge(db: SupabaseClient, key: string, file: string, sha256: string, label: string) {
  try {
    await tusUpload({ bucket: BUCKET, object: key, file, contentType: "video/mp4", sha256, onProgress: progress(label) });
  } catch (e) {
    if (e instanceof Error && /changed while it was uploading/.test(e.message)) await db.storage.from(BUCKET).remove([key]);
    throw e;
  }
}

/**
 * A large video (an episode final): the master goes up with the resumable endpoint, then a 720p review proxy is rendered
 * and uploaded beside it. The proxy is only what /content and /shared play: approval, the third party's sign-off and the
 * scheduling gate all bind to the MASTER's sha256 (a.sha256), the bytes that go out. Returns the proxy metadata to
 * record, or nothing when unchanged bytes already have a proxy.
 */
async function stageLarge(db: SupabaseClient, storyId: string, a: PlannedAsset, storagePath: string, prior: Pick<StoryAsset, "sha256" | "storage_path" | "metadata"> | undefined): Promise<Record<string, unknown>> {
  const changed = prior?.sha256 !== a.sha256 || prior?.storage_path !== storagePath;
  if (changed && (await storedSize(db, storagePath)) !== a.bytes) await uploadLarge(db, storagePath, a.abs, a.sha256, `${a.id} master`);
  if (!changed && typeof prior?.metadata?.proxy_path === "string") return {};
  return stageReviewProxy(db, storyId, a);
}

/** A still from one second in, so the review page can show the video at its real shape before it plays. Null without ffmpeg. */
export function posterFrame(file: string): Buffer | null {
  const run = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { maxBuffer: 20 * 1024 * 1024 });
  return run.status === 0 && run.stdout.length ? run.stdout : null;
}

/** Why a planned video would not play: from its bytes in memory, or from the box headers of a large file. */
function videoFileProblems(a: PlannedAsset): string[] {
  return a.content ? videoBytesProblems(a.content, "video/mp4", a.abs) : webPlayableProblemsFile(a.abs);
}

/** Upsert review snapshots while preserving decisions on unchanged assets. */
export async function stageStory(db: SupabaseClient | null, manifestPath: string, cal: Calendar, dryRun = false, force = false, stage?: string, opts: StageOptions = {}) {
  let { story, assets } = planStory(manifestPath, cal, stage, opts);
  // Self-heal (John, 2026-10-13): a video that will not play in a browser is re-encoded in place to the RESOLVER spec
  // (same frames, PSNR checked) and staging carries on with the playable bytes. Only a failed re-encode refuses.
  // A dry run re-encodes nothing; it reports what the real run would re-encode.
  const unplayable = assets.filter((a) => a.kind === "video").map((a) => ({ a, problems: videoFileProblems(a) })).filter((x) => x.problems.length);
  const healed: Array<Record<string, unknown>> = [];
  if (unplayable.length) {
    if (opts.heal === false || !ffmpegAvailable()) {
      const x = unplayable[0];
      throw new UnplayableVideoError(`${x.a.id} (${x.a.source})`, [...x.problems, ...(opts.heal === false ? [] : ["ffmpeg is not on PATH, so it could not be re-encoded here"])]);
    }
    for (const { a, problems } of unplayable) {
      if (dryRun) { healed.push({ id: a.id, source: a.source, problems, action: "would re-encode to H.264 High yuv420p" }); continue; }
      const r = healInPlace(a.abs);
      if (r) healed.push({ id: a.id, source: a.source, problems, frames: r.frames, psnr: r.psnr === Infinity ? "inf" : Number(r.psnr.toFixed(2)), audio: r.audio, original: r.backup });
    }
    if (!dryRun) ({ story, assets } = planStory(manifestPath, cal, stage, opts));
  }
  // Before any write: whatever is still unplayable stops the whole stage (the upload helpers refuse it again anyway).
  if (!dryRun) for (const a of assets) if (a.kind === "video") { const p = videoFileProblems(a); if (p.length) throw new UnplayableVideoError(`${a.id} (${a.source})`, p); }
  // Images are never re-encoded here (a re-export is the designer's call): one that will not load refuses the stage.
  for (const a of assets) if (a.kind === "image" && a.content) {
    const p = imageUploadProblems(a.content, mime[extname(a.abs).toLowerCase()], a.abs, { publish: a.channels.length > 0 });
    if (p.length) throw new UnloadableImageError(`${a.id} (${a.source})`, p);
  }
  const heal = healed.length ? { healed } : {};
  // Dry runs use the same provenance check after media validation; never read the DB for bad media.
  if (dryRun) {
    const needsLegacy = assets.some(a => a.kind === "image" && a.channels.length > 0 && !a.packaging);
    const prior = db && needsLegacy ? must(await db.from("gtm_story_assets").select("id,sha256,stage,updated_at,metadata").eq("story_id", story.id), "packaging legacy assets") as ExistingPackagingAsset[] : [];
    packagingGate(story.id, assets, prior, story.pipeline);
  }
  // A configured `--shared` dry run also runs the read-only shared checks, so it fails the way the real run would
  // (review #145 N8). A plain dry run reads nothing new.
  // An offline dry run cannot check the shared state, so it must not read as a pass (review #145 R2).
  if (dryRun && !db && opts.shared) throw new Error("A --shared dry run needs the database (NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY): it checks the shared review before anything is written");
  if (dryRun && db && opts.shared) {
    const existing = must(await db.from("gtm_story_assets").select("id,kind,metadata").eq("story_id", story.id), "current story assets") as Array<Pick<StoryAsset, "id" | "kind" | "metadata">>;
    await sharedChecks(db, story.id, assets, existing, opts);
  }
  if (dryRun) return { dryRun: true, id: story.id, ...heal, assets: assets.map((a) => ({ id: a.id, kind: a.kind, channels: a.channels, bytes: a.bytes, sha256: a.sha256, ...(a.stage ? { stage: a.stage } : {}), ...(a.large ? { large: true, review_proxy: "720p, rendered and uploaded with the master" } : {}) })) };
  if (!db) throw new Error("Story staging needs a database connection");
  const written = await writeStory(db, {
    id: story.id, title: story.title, link: story.link, season_id: story.season ?? null,
    ...(isFormat(story.pipeline) ? { pipeline: story.pipeline } : {}), ...(story.series ? { series: story.series } : {}),
    ...(story.third_party ? { third_party_who: story.third_party.trim() } : {}),
  }, assets, force, { reopen: opts.reopen, shared: opts.shared, assumeSharedDelivery: opts.assumeSharedDelivery });
  return { ...written, ...heal };
}

/**
 * Read-only checks before a shared piece is written (also run by a configured dry run). Refuses:
 * - `--shared` while shared delivery is not installed (review #145 N1), unless a test assumes it;
 * - `--shared` onto a Story with any asset that is not already part of a shared piece (#145 N4): adopting a historical
 *   piece is the owner's choice in /content, and an image left on the legacy path would become unpublishable;
 * - a restage without `--shared` of a piece left part-way by a failed `--shared` run (#145 N5): it would write shared
 *   assets with no shared review behind them, invisible in /content and refused by legacy publishing;
 * - for a configured piece: dropping the canonical text or video, or channels that differ from the review (#145 N3,
 *   compared with the same `sharedChannels` rule configuration uses).
 */
async function sharedChecks(db: SupabaseClient, storyId: string, assets: Array<Pick<PlannedAsset, "id" | "channels" | "kind">>, existing: Array<Pick<StoryAsset, "id" | "metadata" | "kind">>, opts: { shared?: boolean; assumeSharedDelivery?: boolean }) {
  const marked = existing.some((a) => a.metadata?.shared_review === true);
  if (!opts.shared && !marked) return null;
  const { loadPieceReview, sameChannels, sharedChannels, sharedDeliveryInstalled } = await import("./piece-review");
  if (opts.shared && !opts.assumeSharedDelivery) {
    const installed = await sharedDeliveryInstalled(db);
    if (!installed.ok) throw new Error(`--shared is not available yet: ${installed.reason}. Stage without --shared.`);
  }
  const review = await loadPieceReview(db, storyId);
  if (!review) {
    if (!opts.shared) throw new Error(`${storyId} is part-way into shared review (its assets are marked shared but no shared review exists): restage with --shared to finish it`);
    const legacy = existing.filter((a) => a.metadata?.shared_review !== true);
    if (legacy.length) throw new Error(`Choose the existing piece's canonical text and video in /content before staging it with --shared (not part of a shared piece: ${legacy.map((a) => a.id).join(", ")})`);
    // Before any write: the piece must end with exactly one text and one video, counting what a part-way run already
    // wrote, so a renamed asset never gets uploaded and stamped first (review #145 R1).
    for (const kind of ["copy", "video"] as const) {
      const ids = [...new Set([...existing, ...assets].filter((a) => a.kind === kind).map((a) => a.id))];
      if (ids.length !== 1) throw new Error(`Shared review needs exactly one ${kind === "copy" ? "text" : "video"}; this piece would have ${ids.length} (${ids.join(", ")}). Keep the ids a part-way run already staged.`);
    }
    return null;
  }
  const canonical = [review.text.asset.id, review.video.asset.id];
  const dropped = canonical.filter((id) => !assets.some((a) => a.id === id));
  if (dropped.length) throw new Error(`Keep the canonical text and video ids when restaging: ${dropped.join(", ")}`);
  if (!sameChannels(sharedChannels(assets, canonical), review.channels)) {
    throw new Error("Selected channels differ from shared review; change them explicitly in /content before staging");
  }
  return review;
}

/**
 * The database half of staging, shared by `gtm story stage` (assets read from local files) and the cockpit's
 * Send to Review on a Sunday candidate (copy built in memory): upsert the Story, its asset snapshots and their
 * pending channel assignments, keeping every decision on an unchanged asset.
 */
export async function writeStory(db: SupabaseClient, story: StoryHead, assets: PlannedAsset[], force = false, opts: { reopen?: boolean; shared?: boolean; assumeSharedDelivery?: boolean } = {}) {
  const allExisting = must(await db.from("gtm_story_assets").select("id,story_id,sha256,storage_path").in("id", assets.map((a) => a.id)), "existing story assets") as Pick<StoryAsset, "id" | "story_id" | "sha256" | "storage_path">[];
  const otherStory = allExisting.find((a) => a.story_id !== story.id);
  if (otherStory) throw new Error(`${otherStory.id} already belongs to Story ${otherStory.story_id}`);
  const existing = must(await db.from("gtm_story_assets").select("id,kind,sha256,revision,storage_path,metadata,stage,updated_at").eq("story_id", story.id), "current story assets") as Array<Pick<StoryAsset, "id" | "kind" | "sha256" | "storage_path" | "metadata" | "stage"> & { revision: number; updated_at: string }>;
  const edited = existing.filter((e) => e.metadata?.edited_in_dashboard && assets.some((a) => a.id === e.id && a.kind === "copy" && a.sha256 !== e.sha256));
  if (edited.length && !force) {
    throw new Error(`copy edited in the dashboard would be overwritten by the local file: ${edited.map((e) => e.id).join(", ")}. Copy the dashboard text into the file (gtm calendar export shows it) or pass --force.`);
  }
  const shared = !!opts.shared || existing.some((a) => a.metadata?.shared_review === true);
  const review = await sharedChecks(db, story.id, assets, existing, opts);
  const missingShared = existing.filter((a) => a.metadata?.shared_review_part && !assets.some((next) => next.id === a.id));
  if (missingShared.length) throw new Error(`Keep the canonical text and video ids when restaging: ${missingShared.map((a) => a.id).join(", ")}`);
  const stale = existing.filter((a) => !assets.some((next) => next.id === a.id));
  if (stale.length && !shared) throw new Error(`story ${story.id} has assets missing from the manifest: ${stale.map((a) => a.id).join(", ")}. Resolve them explicitly before staging.`);
  const channelRows = must(await db.from("gtm_story_asset_channels").select("asset_id,channel").in("asset_id", assets.map((a) => a.id)), "existing channel assignments") as { asset_id: string; channel: string }[];
  for (const a of assets) {
    const removed = channelRows.filter((row) => row.asset_id === a.id && !a.channels.includes(row.channel));
    if (removed.length && !shared) throw new Error(`${a.id} has channel assignments missing from the manifest: ${removed.map((c) => c.channel).join(", ")}. Resolve them explicitly.`);
  }
  // The stage each media asset ends at: named on the asset, or the run's stage for new or changed bytes; else unchanged.
  const stageFor = new Map<string, string | undefined>();
  for (const a of assets) {
    if (!mediaKinds.has(a.kind)) continue;
    const prior = existing.find((e) => e.id === a.id);
    const changed = !prior || prior.sha256 !== a.sha256;
    stageFor.set(a.id, a.stage !== undefined && (a.stageExplicit || changed) ? a.stage : undefined);
  }
  // LinkedIn refuses more than 4,000 characters (lib/channel-rules.ts): refuse to stage such a text, warn over 3,000.
  const lengthWarnings: string[] = [];
  for (const a of assets) {
    if (a.kind !== "copy" || !a.body || !a.channels.includes("linkedin")) continue;
    const length = checkLinkedinLength(a.id, channelText(parseCopy(a.body), "linkedin"));
    if (length.errors.length) throw new Error(length.errors.join("\n"));
    lengthWarnings.push(...length.warnings);
  }
  const progress = shared ? { rows: [], warnings: [] } : await planProgress(db, story, assets, existing, stageFor, !!opts.reopen);
  packagingGate(story.id, assets, existing, story.pipeline);
  must(await db.from("gtm_stories").upsert({
    id: story.id, title: story.title, link_url: story.link, ...(story.season_id ? { season_id: story.season_id } : {}),
    ...(story.pipeline ? { pipeline: story.pipeline } : {}), ...(story.series ? { series: story.series } : {}),
    ...(story.third_party_who ? { third_party_who: story.third_party_who } : {}), updated_at: new Date().toISOString(),
  }), "upsert story");
  // Identical bytes whose storage key moves (a key written under another name, e.g. by hand): the database keeps John's
  // approval, which follows the sha256 (brand.example.com 20261013180000), and the calendar rows are pointed at the new key below.
  const moved: { asset: string; from: string; to: string }[] = [];
  const rekeyed = new Map<string, string>(); // every key that changed this run, old -> new
  for (const a of assets) {
    const prior = existing.find((e) => e.id === a.id);
    const ext = extname(a.abs).toLowerCase();
    const storagePath = mediaKinds.has(a.kind) ? `stories/${story.id}/${a.id}-${a.sha256.slice(0, 16)}${ext}` : null;
    if (storagePath && prior?.storage_path && prior.storage_path !== storagePath) {
      rekeyed.set(prior.storage_path, storagePath);
      if (prior.sha256 === a.sha256) moved.push({ asset: a.id, from: prior.storage_path, to: storagePath });
    }
    let proxy: Record<string, unknown> = {};
    if (storagePath && a.large) proxy = await stageLarge(db, story.id, a, storagePath, prior);
    else if (storagePath && (prior?.sha256 !== a.sha256 || prior.storage_path !== storagePath)) await upload(db, storagePath, a.content!, ext, a.channels.length > 0);
    if (!a.large && a.kind === "video" && needsReviewProxy(a.bytes) && !(prior?.sha256 === a.sha256 && prior.metadata?.proxy_path))
      proxy = await stageReviewProxy(db, story.id, a);
    let posterPath: string | undefined;
    if (a.kind === "video") {
      const frame = posterFrame(a.abs);
      if (frame) { posterPath = `stories/${story.id}/${a.id}-${a.sha256.slice(0, 16)}-poster.jpg`; await upload(db, posterPath, frame, ".jpg", false); }
    }
    // A YouTube listing's thumbnail (youtube_thumbnail in the copy's frontmatter) is stored beside it, so a reviewer sees the
    // thumbnail with the title and description. It is not an asset of its own: it ships with the copy at publish time.
    let thumb: { path: string; sha256: string } | undefined;
    if (a.kind === "copy" && a.body) {
      const rel = frontmatterData(splitFrontmatter(a.body).frontmatter).youtube_thumbnail;
      const file = typeof rel === "string" ? resolve(dirname(a.abs), rel) : null;
      if (file && existsSync(file) && [".jpg", ".jpeg", ".png"].includes(extname(file).toLowerCase())) {
        const bytes = readFileSync(file), sha = digest(bytes), tExt = extname(file).toLowerCase();
        const key = `stories/${story.id}/${a.id}-${sha.slice(0, 16)}-thumb${tExt}`;
        if (prior?.metadata?.thumbnail_path !== key) await upload(db, key, bytes, tExt, false);
        thumb = { path: key, sha256: sha };
      }
    }
    const legacy = a.kind === "image" && !a.packaging && prior?.sha256 === a.sha256 ? legacyPackagingRecord(prior) : undefined;
    const row = {
      id: a.id, story_id: story.id, title: a.title, kind: a.kind, source: a.source, sha256: a.sha256,
      // Unchanged bytes keep their metadata (e.g. the public newsletter URL); changed bytes start clean.
      // A stage is written only when it applies (see stageFor), so a plain restage keeps the asset's stage. Moving to
      // another stage clears the asset's approvals in the database (a rough-cut approval is not a final one).
      ...(stageFor.get(a.id) !== undefined ? { stage: stageFor.get(a.id) } : {}),
      // A version's own description (changes, label, jump points) belongs to new bytes; unchanged bytes keep theirs.
      storage_path: storagePath, body: a.body, url: a.url, metadata: { ...(prior?.sha256 === a.sha256 ? prior.metadata ?? {} : {}), ...(prior?.sha256 === a.sha256 ? {} : a.metadata ?? {}), ...(legacy ? { packaging_legacy: legacy } : {}), bytes: a.bytes, ...proxy, ...(posterPath ? { poster_path: posterPath } : {}), ...(thumb ? { thumbnail_path: thumb.path, thumbnail_sha256: thumb.sha256 } : {}), ...(prior?.sha256 !== a.sha256 ? { edited_in_dashboard: undefined } : {}) },
    };
    if (shared) Object.assign(row.metadata, { shared_review: true, ...(prior?.metadata?.shared_review_part ? { shared_review_part: prior.metadata.shared_review_part } : {}) });
    // Compare-and-swap prevents another stage or human save being overwritten after the read.
    if (prior) {
      const saved = must(await db.from("gtm_story_assets").update(row).eq("id", a.id).eq("revision", prior.revision).eq("sha256", prior.sha256).eq("metadata", JSON.stringify(prior.metadata ?? {})).select("id").maybeSingle(), `update asset ${a.id}`);
      if (!saved) throw new Error(`${a.id} changed while staging; reload the canonical version before retrying`);
    } else must(await db.from("gtm_story_assets").insert(row), `insert asset ${a.id}`);
    const channels = channelRows.filter((row) => row.asset_id === a.id);
    for (const channel of shared ? [] : a.channels) {
      if (!channels.some((c) => c.channel === channel)) {
        must(await db.from("gtm_story_asset_channels").insert({ asset_id: a.id, channel, status: "pending" }), `assign ${a.id} to ${channel}`);
      }
    }
  }
  if (progress.rows.length) must(await db.from("gtm_story_stages").upsert(progress.rows.map((r) => ({ story_id: story.id, ...r }))), "stage progress");
  const rebound = shared ? [] : await rebindOpenItems(db, story.id, rekeyed);
  const kept = moved.length ? await approvalsKept(db, moved.map((m) => m.asset), assets) : [];
  // A new shared piece is configured here, after its assets are written, with the same channel rule the restage check
  // uses. A run that fails before this point is resumed by restaging with --shared (sharedChecks says so).
  if (opts.shared && !review) {
    const { pieceCandidates, configurePieceReview, sharedChannels } = await import("./piece-review");
    const choices = await pieceCandidates(db, story.id);
    const texts = choices.filter((a) => a.asset.kind === "copy"), videos = choices.filter((a) => a.asset.kind === "video");
    if (texts.length !== 1 || videos.length !== 1) throw new Error("Shared review needs exactly one text and one video; choose canonical assets in /content");
    await configurePieceReview(db, { storyId: story.id, text: texts[0], video: videos[0], channels: sharedChannels(assets, [texts[0].asset.id, videos[0].asset.id]) });
  }
  return {
    id: story.id, assets: assets.length, channels: [...new Set(assets.flatMap((a) => a.channels))],
    ...(moved.length ? { moved_keys: moved, approvals_kept: kept } : {}), ...(rebound.length ? { rebound_items: rebound } : {}),
    ...(progress.rows.length ? { stages: progress.rows.map((r) => `${r.stage}: ${r.status}`) } : {}),
    ...(progress.warnings.length || lengthWarnings.length ? { warnings: [...progress.warnings, ...lengthWarnings] } : {}),
  };
}

/**
 * Calendar rows not yet sent (no Zernio post; drafted, failed or an idea) still naming an earlier storage key of one of
 * their assets are pointed at the asset's current key, so the publish gate and /content find the bytes John approved.
 * Rows already on Zernio are left alone: Zernio holds its own copy, and an old key is never deleted, so it stays valid.
 * Approved rows are left to the auto-scheduler, which rebinds them as it schedules (a media change there drops the
 * row to drafted).
 */
async function rebindOpenItems(db: SupabaseClient, storyId: string, rekeyed: Map<string, string>): Promise<string[]> {
  const { rebindStoryItem } = await import("./auto-schedule");
  const items = must(await db.from("gtm_content_items").select("id,story_id,media,story_assets,status,zernio_post_id").eq("story_id", storyId), "story calendar items") as
    Array<{ id: string; story_id: string; media: string[] | null; story_assets: string[] | null; status: string; zernio_post_id: string | null }> | null;
  const open = (items ?? []).filter((i) => !i.zernio_post_id && ["idea", "drafted", "failed"].includes(i.status));
  if (!open.length) return [];
  const assets = must(await db.from("gtm_story_assets").select("id,source,storage_path").eq("story_id", storyId), "story asset keys") as Pick<StoryAsset, "id" | "source" | "storage_path">[];
  const rebound: string[] = [];
  for (const i of open) {
    // This run's key changes first (whatever the old key was named), then any older content-addressed key.
    const media = (i.media ?? []).map((m) => rekeyed.get(m) ?? m);
    const r = rebindStoryItem({ ...i, media, story_assets: i.story_assets ?? [] } as unknown as Item, assets);
    if (!r.changed && media.every((m, n) => m === i.media?.[n])) continue;
    must(await db.from("gtm_content_items").update({ media: r.media, story_assets: r.story_assets, updated_at: new Date().toISOString() }).eq("id", i.id).is("zernio_post_id", null), `rebind ${i.id}`);
    rebound.push(i.id);
  }
  return rebound;
}

/** Channel approvals that survived a key move: still approved for the asset's (identical) bytes. */
async function approvalsKept(db: SupabaseClient, ids: string[], assets: PlannedAsset[]): Promise<string[]> {
  const rows = must(await db.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", ids), "approvals after restage") as StoryChannel[] | null;
  return (rows ?? []).filter((r) => r.status === "approved" && r.approved_sha256 === assets.find((a) => a.id === r.asset_id)?.sha256).map((r) => `${r.asset_id}:${r.channel}`);
}

/**
 * Stage progress for a pipeline Story: which rows staging moves (the staged stage to review, agent stages behind it to
 * done) and what John must know (a paper edit not approved yet keeps a rough cut out of /content). Refuses a plan asset
 * bound to a platform, and a restage behind the current stage without --reopen. A Story without a pipeline has none.
 */
async function planProgress(db: SupabaseClient, story: StoryHead, assets: PlannedAsset[], existing: Pick<StoryAsset, "id" | "kind" | "sha256" | "stage">[], stageFor: Map<string, string | undefined>, reopen: boolean) {
  const none = { rows: [] as StageRow[], warnings: [] as string[] };
  const head = must(await db.from("gtm_stories").select("pipeline").eq("id", story.id), "story pipeline") as { pipeline: string | null }[] | null;
  const format = story.pipeline ?? head?.[0]?.pipeline ?? null;
  if (!isFormat(format)) {
    if ([...stageFor.values()].some((s) => s !== undefined && s !== FINAL_STAGE)) none.warnings.push("this Story has no pipeline: set pipeline: in its manifest so the cockpit shows its stages");
    return none;
  }
  const pipeline = pipelineOf(format);
  // /content shows only what goes out (rough cuts, finals): a media asset bound to no platform is a production asset.
  for (const a of assets) {
    if (mediaKinds.has(a.kind) && !a.channels.length) throw new Error(`${a.id}: bound to no platform, so it is a production asset (a storyboard, a contact sheet). Those never go into /content: John reviews them in Cursor or the terminal, and an agent records his decision with gtm story progress.`);
    if (mediaKinds.has(a.kind) && a.channels.includes("plan")) throw new Error(`${a.id}: "plan" is not a platform; production assets (a storyboard, a contact sheet) never go into /content`);
  }
  const touched = [...new Set([...stageFor.values()].filter((s): s is string => s !== undefined))];
  if (!touched.length) return none;
  const rows = must(await db.from("gtm_story_stages").select("stage,status,note,actor,updated_at").eq("story_id", story.id), "stage rows") as StageRow[] | null;
  const before = existing.map((e) => ({ ...e, stage: e.stage ?? null }));
  const view = pipelineView(pipeline, rows ?? [], { stagedStages: stagedStages(before), final: finalState(before, []) });
  const out = { rows: [] as StageRow[], warnings: [] as string[] };
  for (const key of touched.sort((x, y) => pipeline.stages.findIndex((s) => s.key === x) - pipeline.stages.findIndex((s) => s.key === y))) {
    const changed = assets.some((a) => stageFor.get(a.id) === key && existing.find((e) => e.id === a.id)?.sha256 !== a.sha256);
    const plan = planStageRows(pipeline, view, key, { changed, reopen });
    for (const r of plan.rows) if (!out.rows.some((x) => x.stage === r.stage)) out.rows.push(r);
    out.warnings.push(...plan.warnings.map((w) => w.replace("<id>", story.id)));
  }
  return out;
}

/** Pure gate: a channel can go out only if every bound asset is approved for its current bytes. */
export function assertStoryApproval(cal: Calendar, item: Item, assets: StoryAsset[], approvals: StoryChannel[]): VerifiedMedia {
  const bytes: VerifiedMedia = new Map();
  if (assets.some((a) => a.metadata?.shared_review === true)) throw new Error("This piece uses shared approvals; use the shared publishing workflow");
  if (!item.story_id) return bytes;
  if (item.channels.length !== 1 || !item.story_assets?.length) throw new Error(`${item.id}: Story posts need one channel and explicit story_assets`);
  const channel = item.channels[0];
  const ids = new Set(item.story_assets);
  if (ids.size !== item.story_assets.length) throw new Error(`${item.id}: duplicate story assets`);
  const selected = assets.filter((a) => ids.has(a.id) && a.story_id === item.story_id);
  if (selected.length !== ids.size) throw new Error(`${item.id}: Story assets missing from the Cockpit`);
  const required = [item.copy, ...(item.media ?? []), item.link].filter((x): x is string => !!x);
  for (const source of required) if (!selected.some((a) => a.source === source)) throw new Error(`${item.id}: calendar source ${source} is not bound to an approved Story asset`);
  for (const a of selected) {
    if (a.kind === "link") continue;
    const approval = approvals.find((r) => r.asset_id === a.id && r.channel === channel);
    if (!approval || approval.status !== "approved" || approval.approved_sha256 !== a.sha256) throw new Error(`${item.id}: ${a.title} is not approved for ${channel}`);
    const path = resolveAsset(cal, a.source);
    if (/^https?:/.test(path) || !existsSync(path)) throw new Error(`${item.id}: asset missing: ${a.source}`);
    // A large video is hashed in chunks and streamed when sent, never read whole; it is re-hashed on the way out too.
    const size = statSync(path).size;
    if (a.kind === "video" && isLargeSize(size)) {
      if (sha256File(path) !== a.sha256) throw new Error(`${item.id}: ${a.title} changed after approval; restage and review it`);
      bytes.set(path, new LargeMedia(path, size, a.sha256));
      continue;
    }
    const content = readFileSync(path);
    const current = digest(content ?? path);
    if (current !== a.sha256) throw new Error(`${item.id}: ${a.title} changed after approval; restage and review it`);
    if (content) bytes.set(path, content);
  }
  return bytes;
}

/** The last gate before Zernio: a Story item never goes out while a bound media asset is short of its final stage. */
export function assertFinalStage(item: Pick<Item, "id" | "story_assets">, assets: Array<Pick<StoryAsset, "id" | "kind" | "title" | "stage">>) {
  const early = nonFinal(assets.filter((a) => item.story_assets?.includes(a.id)));
  if (early.length) throw new Error(`${item.id}: ${early.map((a) => `${a.title} is at stage ${a.stage}`).join(", ")}, not final. A rough-cut approval means the edit is good; only a final cut is scheduled or published. Restage the final with gtm story stage <manifest> --stage final.`);
}

export function assertStoryImage(cal: Calendar, item: Item, assets: StoryAsset[], file: string) {
  if (!item.story_assets?.some((id) => assets.some((a) => a.id === id && a.kind === "image" && resolveAsset(cal, a.source) === file))) {
    throw new Error(`${item.id}: cover ${file} is not bound to an approved Story image`);
  }
}

export async function checkStoryApproval(db: SupabaseClient, cal: Calendar, item: Item) {
  if (!item.story_id) return;
  const assets = must(await db.from("gtm_story_assets").select("*").eq("story_id", item.story_id).in("id", item.story_assets ?? []), "story assets") as StoryAsset[];
  const approvals = must(await db.from("gtm_story_asset_channels").select("*").in("asset_id", item.story_assets ?? []), "story approvals") as StoryChannel[];
  return { assets, bytes: assertStoryApproval(cal, item, assets, approvals) };
}

/**
 * Database-backed variant of the approval gate: copy text comes from the approved snapshot row and
 * media bytes from the private bucket, each re-hashed against the approved digest. Nothing is read
 * from ~/Projects, so this works from Vercel and from any machine.
 */
export async function checkStoryApprovalDb(db: SupabaseClient, item: Item) {
  if (!item.story_id) throw new Error(`${item.id} is not a Story item`);
  if (item.channels.length !== 1 || !item.story_assets?.length) throw new Error(`${item.id}: Story posts need one channel and explicit story_assets`);
  const channel = item.channels[0];
  const ids = new Set(item.story_assets);
  if (ids.size !== item.story_assets.length) throw new Error(`${item.id}: duplicate story assets`);
  const assets = must(await db.from("gtm_story_assets").select("*").eq("story_id", item.story_id).in("id", item.story_assets), "story assets") as StoryAsset[];
  const approvals = must(await db.from("gtm_story_asset_channels").select("*").in("asset_id", item.story_assets), "story approvals") as StoryChannel[];
  if (assets.some((a) => a.metadata?.shared_review === true)) throw new Error("This piece uses shared approvals; use the shared publishing workflow");
  if (assets.length !== ids.size) throw new Error(`${item.id}: Story assets missing from the Cockpit`);
  const bound = (ref: string) => assets.some((a) => a.source === ref || a.storage_path === ref);
  for (const ref of [item.copy, ...(item.media ?? [])].filter((x): x is string => !!x)) {
    if (!bound(ref)) throw new Error(`${item.id}: calendar source ${ref} is not bound to an approved Story asset`);
  }
  let copyText: string | undefined;
  const bytes: VerifiedMedia = new Map();
  for (const a of assets) {
    if (a.kind === "link") continue;
    const approval = approvals.find((r) => r.asset_id === a.id && r.channel === channel);
    if (!approval || approval.status !== "approved" || approval.approved_sha256 !== a.sha256) throw new Error(`${item.id}: ${a.title} is not approved for ${channel}`);
    if (a.kind === "copy") {
      if (digest(a.body ?? "") !== a.sha256) throw new Error(`${item.id}: ${a.title} snapshot does not match its digest`);
      if (a.source === item.copy) copyText = a.body!;
      continue;
    }
    // A large stored video (an episode master) is not downloaded here: it is re-hashed against its approved sha256 as it
    // streams to Zernio (lib/publish-item.ts), and the post is created only if that matches. Never the review proxy.
    const size = typeof a.metadata?.bytes === "number" ? a.metadata.bytes : null;
    if (a.kind === "video" && (typeof a.metadata?.proxy_path === "string" || (size !== null && needsReviewProxy(size)))) {
      if (size === null) throw new Error(`${item.id}: ${a.title} has no recorded size; restage it`);
      bytes.set(a.storage_path!, new LargeMedia(a.storage_path!, size, a.sha256, a.storage_path!));
      continue;
    }
    const { data, error } = await db.storage.from(BUCKET).download(a.storage_path!);
    if (error || !data) throw new Error(`${item.id}: could not read ${a.title} from storage: ${error?.message}`);
    const content = Buffer.from(await data.arrayBuffer());
    if (digest(content) !== a.sha256) throw new Error(`${item.id}: ${a.title} stored bytes do not match the approved digest`);
    bytes.set(a.storage_path!, content);
  }
  if (item.copy && copyText === undefined) throw new Error(`${item.id}: approved copy snapshot is missing`);
  // The item's link is covered by a Story link asset, or by the approved text that carries it (a LinkedIn first comment).
  if (item.link && !bound(item.link) && !(copyText ?? "").includes(item.link)) {
    throw new Error(`${item.id}: calendar source ${item.link} is not bound to an approved Story asset`);
  }
  return { assets, copyText, bytes };
}

/** Writes copy edited in the cockpit back to the local files the calendar points at, so the approved bytes are what ships. */
export async function syncStoryCopy(db: SupabaseClient, cal: Calendar, storyId: string): Promise<string[]> {
  if (cal.source === "db") throw new Error("syncStoryCopy writes local copy files: pass the calendar.yaml calendar, not the database one");
  const rows = must(await db.from("gtm_story_assets").select("id,source,body,sha256").eq("story_id", storyId).eq("kind", "copy"), "story copy") as { id: string; source: string; body: string | null; sha256: string }[];
  const written: string[] = [];
  for (const row of rows) {
    const abs = resolveAsset(cal, row.source);
    if (/^https?:/.test(abs) || row.body === null) continue;
    if (existsSync(abs) && digest(readFileSync(abs)) === row.sha256) continue;
    if (digest(row.body) !== row.sha256) throw new Error(`${row.id}: cockpit copy digest does not match its body; edit it again in the cockpit`);
    writeFileSync(abs, row.body);
    written.push(row.id);
  }
  return written;
}
