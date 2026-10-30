// `gtm media audit --fix`: replaces each unplayable video or unloadable image found by lib/media-audit.ts, in place.
// CLI only (ffmpeg, local temp files). For each finding:
//   * the bytes are re-encoded to the RESOLVER spec (video: lib/video-heal.ts, frame count and PSNR verified) or, for an
//     image whose only fault is its content type, re-uploaded unchanged with the right type; any other image fault is
//     converted to an sRGB PNG of the same size;
//   * the result goes back under the SAME storage key, so every calendar row, approved_hash (which hashes keys) and
//     signed link keeps working;
//   * a Story asset row is moved to the new sha256, and every platform approval John gave the old bytes is recorded
//     again for the new ones with a note saying why (the picture is the same; the bytes are not), as John directed on
//     2026-10-13; the local source in the workspace is replaced too when it was exactly the old bytes, so a restage
//     stages the same file;
//   * media already on Zernio for a post that has not gone out is uploaded again and the post updated in place,
//     keeping its scheduled time.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { BUCKET } from "./review";
import { digest } from "./story";
import { guardMediaBytes } from "./media-guard";
import { imageBytesProblems, imageProblems, IMAGE_TYPES, sniffImage } from "./image-loadable";
import { LARGE_MEDIA_BYTES, sha256File, tusUpload } from "./large-media";
import { healTo, keepOriginal, type Verification } from "./video-heal";
import { hashingStream } from "./large-media";
import { webPlayableProblemsFile } from "./video-playable";
import { getPost, uploadMedia, zernio, ZernioError } from "./zernio";
import { problemKey, type MediaProblem } from "./media-audit";

export type FixResult = {
  key: string; kind: "video" | "image"; action: string; ok: boolean; error?: string;
  sha256Before?: string; sha256After?: string; frames?: number; psnr?: number | "inf";
  approvals_carried?: string[]; source_replaced?: string; zernio?: { post: string; scheduledFor: string | null; url: string };
  warnings?: string[];
};

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

async function download(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}

/** An image re-exported as an sRGB PNG of the same pixels (sips on a Mac, else ffmpeg). */
export function convertImage(src: string, out: string) {
  const sips = process.platform === "darwin" ? spawnSync("sips", ["-s", "format", "png", "-m", "/System/Library/ColorSync/Profiles/sRGB Profile.icc", src, "--out", out], { stdio: ["ignore", "ignore", "pipe"] }) : null;
  if (!sips || sips.status !== 0) {
    const ff = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", src, "-frames:v", "1", "-pix_fmt", "rgba", out], { stdio: ["ignore", "ignore", "pipe"] });
    if (ff.status !== 0) throw new Error(`could not convert ${basename(src)}: ${ff.stderr?.toString().trim().slice(-300)}`);
  }
  const before = imageProblems(readFileSync(src).subarray(0, 1 << 20), statSync(src).size);
  const bytes = readFileSync(out);
  const after = imageProblems(bytes.subarray(0, 1 << 20), bytes.length, bytes.subarray(-32));
  if (after.problems.length) throw new Error(`the converted ${basename(src)} still will not load: ${after.problems.join("; ")}`);
  if (before.width && (before.width !== after.width || before.height !== after.height)) throw new Error(`the converted ${basename(src)} is ${after.width}x${after.height}, the original ${before.width}x${before.height}`);
}

async function putStored(db: SupabaseClient, key: string, file: string, contentType: string) {
  const size = statSync(file).size;
  if (size > LARGE_MEDIA_BYTES) { await tusUpload({ bucket: BUCKET, object: key, file, contentType }); return; }
  const bytes = readFileSync(file);
  guardMediaBytes(bytes, contentType, key);
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(key, { upsert: true });
  if (error || !data) throw new Error(`sign upload ${key}: ${error?.message}`);
  const r = await db.storage.from(BUCKET).uploadToSignedUrl(key, data.token, bytes, { contentType, upsert: true });
  if (r.error) throw new Error(`upload ${key}: ${r.error.message}`);
}

type AssetRow = { id: string; story_id: string; source: string; sha256: string; revision: number; stage: string | null; storage_path: string | null; metadata: Record<string, unknown> | null };

/**
 * Moves a Story asset to its re-encoded bytes and records John's platform decisions again for them. The database clears
 * every channel whenever the sha256 changes; this re-records exactly what John decided on the old bytes: approvals
 * (with a note saying why) and change requests (with his note), nothing else. A channel John touches while the fix runs
 * is left as he set it.
 */
async function carryForward(db: SupabaseClient, owner: () => Promise<SupabaseClient>, a: AssetRow, sha256: string, bytes: number, why: string, extra: Record<string, unknown>): Promise<{ carried: string[]; warnings: string[] }> {
  type Ch = { channel: string; status: string; approved_sha256: string | null; note: string; updated_at?: string };
  const before = must(await db.from("gtm_story_asset_channels").select("channel,status,approved_sha256,note").eq("asset_id", a.id), "decisions") as Ch[];
  const keep = before.filter((c) => (c.status === "approved" && c.approved_sha256 === a.sha256) || (c.status === "rejected" && c.note.trim())).map((c) => ({ ...c }));
  // The owner session first, so the window between clearing and re-recording is as short as it can be.
  const o = keep.length ? await owner() : null;
  const updated = must(await db.from("gtm_story_assets").update({
    sha256, metadata: { ...(a.metadata ?? {}), bytes, reencoded: { from_sha256: a.sha256, at: new Date().toISOString(), why, ...extra } },
  }).eq("id", a.id).eq("sha256", a.sha256).select("revision"), `move ${a.id} to its re-encoded bytes`) as { revision: number }[];
  if (!updated?.length) throw new Error(`${a.id} changed while it was being fixed; run the audit again`);
  const cleared = must(await db.from("gtm_story_asset_channels").select("channel,status,updated_at").eq("asset_id", a.id), "decisions after the move") as Ch[];
  const carried: string[] = [];
  const warnings: string[] = [];
  for (const c of keep) {
    // Re-read just before re-recording: if John decided this channel in the meantime, his decision stands.
    const now = must(await db.from("gtm_story_asset_channels").select("status,updated_at").eq("asset_id", a.id).eq("channel", c.channel).maybeSingle(), "decision") as Ch | null;
    const then = cleared.find((x) => x.channel === c.channel);
    if (!now || now.status !== "pending" || now.updated_at !== then?.updated_at) { warnings.push(`${a.id}:${c.channel}: John decided it while the fix ran; left as he set it`); continue; }
    const status = c.status === "approved" ? "approved" : "rejected";
    const note = c.status === "approved"
      ? [c.note.trim(), `Approval carried forward by the media audit: ${why}`].filter(Boolean).join(" | ").slice(0, 5000)
      : c.note.trim().slice(0, 5000);
    const { error } = await o!.rpc("gtm_decide_story_asset", { p_asset_id: a.id, p_channel: c.channel, p_status: status, p_note: note, p_expected_sha256: sha256, p_expected_revision: updated[0].revision });
    if (error) warnings.push(`${a.id}:${c.channel}: ${status === "approved" ? "approval" : "change request"} not carried (${error.message}); John must decide it again`);
    else carried.push(`${a.id}:${c.channel}${status === "rejected" ? " (changes requested)" : ""}`);
  }
  const story = must(await db.from("gtm_stories").select("third_party_who").eq("id", a.story_id).maybeSingle(), "story") as { third_party_who: string | null } | null;
  if (story?.third_party_who && a.stage === "final") warnings.push(`${a.story_id}: ${story.third_party_who}'s sign-off is logged against the old bytes; the picture is unchanged, but record it again with gtm release ${a.story_id} --note if it is required`);
  return { carried, warnings };
}

/** The workspace file a Story asset was staged from, replaced by the fixed bytes when it is exactly the old file. */
function replaceSource(a: AssetRow, fixed: string, oldSha: string): string | undefined {
  const ws = process.env.GTM_WORKSPACE ?? resolve(homedir(), "Projects/john-workspace");
  const cal = process.env.GTM_CALENDAR ?? join(ws, "2-work/content-engine/calendar.yaml");
  const abs = a.source.startsWith("/") ? a.source : resolve(join(cal, ".."), a.source);
  if (!existsSync(abs) || sha256File(abs) !== oldSha) return undefined;
  keepOriginal(abs, oldSha);
  writeFileSync(abs, readFileSync(fixed));
  return abs;
}

/** The agent note a finding left on its asset is resolved with what was done. */
async function resolveNotes(db: SupabaseClient, p: MediaProblem, action: string) {
  for (const ref of p.refs.filter((r) => r.kind === "story-asset" || r.kind === "story-proxy")) {
    await db.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: `Fixed by gtm media audit --fix: ${action}.` }).eq("asset_id", ref.id).is("resolved_at", null).like("body", "[unplayable-video]%");
  }
}

/** Fix one finding. Never throws: the result says what happened. */
export async function fixProblem(db: SupabaseClient, p: MediaProblem, opts: { dryRun?: boolean; owner: () => Promise<SupabaseClient>; log?: (l: string) => void }): Promise<FixResult> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const kind = p.kind ?? "video";
  const res: FixResult = { key: p.key, kind, action: "", ok: false };
  const dir = mkdtempSync(join(tmpdir(), "gtm-media-fix-"));
  try {
    let url: string;
    if (p.where === "zernio") url = p.url!;
    else {
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(p.key, 3600);
      if (error || !data) throw new Error(`sign ${p.key}: ${error?.message}`);
      url = data.signedUrl;
    }
    const name = basename((p.where === "zernio" ? new URL(url).pathname : p.key));
    const ext = extname(name).toLowerCase() || (kind === "video" ? ".mp4" : ".png");
    const src = join(dir, `in${ext}`);
    await download(url, src);
    res.sha256Before = sha256File(src);
    let out = join(dir, `out${kind === "video" ? ".mp4" : ext}`);
    let contentType = MIME[ext] ?? (kind === "video" ? "video/mp4" : "image/png");
    let v: (Verification & { audio: string; remuxed: boolean }) | undefined;
    // The Story rows on this key, read before anything is written. A row whose sha256 is not the stored bytes but whose
    // key names it (keys are <asset>-<sha16>) is a fix that replaced the bytes and was cut off before moving the row.
    const assets = p.where === "storage"
      ? must(await db.from("gtm_story_assets").select("id,story_id,source,sha256,revision,stage,storage_path,metadata").or(`storage_path.eq."${p.key}",metadata->>proxy_path.eq."${p.key}"`), "assets") as AssetRow[]
      : [];
    const stale = assets.filter((a) => a.storage_path === p.key && a.sha256 !== res.sha256Before);
    const interrupted = stale.filter((a) => p.key.includes(a.sha256.slice(0, 16)));
    for (const a of stale) if (!interrupted.includes(a)) throw new Error(`${a.id}: its sha256 ${a.sha256.slice(0, 12)} is not the stored bytes and its key does not name it; restage it rather than fix it here`);
    const fine = kind === "video" ? !webPlayableProblemsFile(src).length : imageBytesProblems(readFileSync(src)).length === 0;
    if ((kind === "video" && fine && (p.source === "audit" || !p.browser?.decode)) || (interrupted.length && fine)) {
      // Nothing wrong with the bytes now: finish an interrupted fix if there is one, then clear the finding.
      res.action = interrupted.length ? "already fine; finished an interrupted fix (asset row moved to the stored bytes)" : p.source === "audit" ? "already playable (fixed elsewhere)" : "the bytes are fine (the player's failure was not a decode error)";
      if (opts.dryRun) { res.ok = true; return res; }
      const carried: string[] = []; const warnings: string[] = [];
      for (const a of interrupted) {
        const r2 = await carryForward(db, opts.owner, a, res.sha256Before, statSync(src).size, `reconciled after an interrupted media fix: storage already held the re-encoded bytes (was ${p.problems.join("; ")})`, {});
        carried.push(...r2.carried); warnings.push(...r2.warnings);
      }
      if (carried.length) res.approvals_carried = carried;
      if (warnings.length) res.warnings = warnings;
      res.ok = true;
    } else if (interrupted.length) {
      throw new Error(`${interrupted.map((a) => a.id).join(", ")}: the stored bytes are not the row's and still fail; restage the source`);
    }
    if (res.ok) { /* handled above */ }
    else if (kind === "video") {
      {
        res.action = "re-encoded to H.264 High yuv420p, AAC, faststart";
        if (opts.dryRun) { res.ok = true; res.action = `would be ${res.action}`; return res; }
        v = healTo(src, out);
        if (v.remuxed) res.action = "remuxed with faststart (streams copied, picture bit-identical)";
        res.frames = v.frames; res.psnr = v.psnr === Infinity ? "inf" : Number(v.psnr.toFixed(2));
      }
    } else {
      const bytes = readFileSync(src);
      const format = sniffImage(bytes);
      const wrongTypeOnly = !!IMAGE_TYPES[format] && imageBytesProblems(bytes, IMAGE_TYPES[format]).length === 0;
      if (wrongTypeOnly) {
        res.action = `re-uploaded unchanged as ${IMAGE_TYPES[format]} (the bytes were right, the stored content type was not)`;
        contentType = IMAGE_TYPES[format]; out = src;
      } else {
        res.action = "converted to an sRGB PNG of the same size";
        if (opts.dryRun) { res.ok = true; res.action = `would be ${res.action}`; return res; }
        convertImage(src, out); contentType = "image/png";
      }
      if (opts.dryRun) { res.ok = true; res.action = `would be ${res.action}`; return res; }
    }
    if (res.ok) {
      if (!opts.dryRun) {
        await db.from("gtm_sync_state").delete().eq("key", problemKey(p.key));
        await resolveNotes(db, p, res.action);
      }
      return res;
    }
    res.sha256After = sha256File(out);
    const why = kind === "video"
      ? `${v!.remuxed ? "remuxed with faststart, streams copied" : "re-encoded"} for browser playback (was ${p.problems.join("; ")}); same ${v!.frames} frames, ${res.psnr} dB luma PSNR, so the picture John approved is unchanged`
      : `${res.action} (was ${p.problems.join("; ")})`;

    if (p.where === "zernio") {
      const post = await getPost(p.post!.id).catch((e) => {
        if (e instanceof ZernioError && e.status === 404) return { status: "deleted" };
        throw e;
      }) as unknown as { scheduledFor?: string; status: string; mediaItems?: Array<Record<string, unknown>> };
      if (!["scheduled", "draft", "pending", "failed"].includes(post.status)) {
        // Gone out (or gone): nothing left to replace, so the finding is closed rather than left forever.
        res.action = `post ${p.post!.id} is ${post.status}; nothing left to replace, finding closed`;
        if (!opts.dryRun) await db.from("gtm_sync_state").delete().eq("key", problemKey(p.key));
        res.ok = true;
        return res;
      }
      const fresh = await uploadMedia(readFileSync(out), name.replace(/\.[^.]+$/, kind === "video" ? ".mp4" : extname(out)), contentType);
      const index = Number(p.key.split(":")[2]);
      const items = (post.mediaItems ?? []).map((m, i) => (index >= 1000 ? (i === index - 1000 ? { ...m, thumbnail: fresh } : m) : i === index ? { ...m, url: fresh } : m));
      // Only the media is sent: the schedule (and its timezone) is never touched.
      await zernio(`/posts/${p.post!.id}`, { method: "PUT", body: { mediaItems: items } });
      const after = await getPost(p.post!.id) as unknown as { scheduledFor?: string; mediaItems?: Array<{ url?: string; thumbnail?: string }> };
      // Zernio may re-host what it is given (a thumbnail comes back under its own URL), so the check is that the old file
      // is gone from the post and what it carries now probes clean.
      const now = index >= 1000 ? after.mediaItems?.[index - 1000]?.thumbnail : after.mediaItems?.[index]?.url;
      if (!now || now === url) throw new Error(`post ${p.post!.id} still carries the old media after the update`);
      const { remoteImageProblems, remoteMeta, remoteVideoProblems, httpRangeReader } = await import("./media-guard");
      const left = kind === "video" ? await remoteVideoProblems(now, now.split("?")[0]) : await remoteMeta(now).then((m) => remoteImageProblems(httpRangeReader(now), m.size ?? 0, m.contentType));
      if (left.length) throw new Error(`post ${p.post!.id} now carries ${now}, which still fails: ${left.join("; ")}`);
      const instant = (x?: string) => (x ? Date.parse(x) : null);
      if (instant(after.scheduledFor) !== instant(post.scheduledFor)) throw new Error(`post ${p.post!.id} moved from ${post.scheduledFor} to ${after.scheduledFor}`);
      if ((after.mediaItems?.length ?? 0) !== (post.mediaItems?.length ?? 0)) throw new Error(`post ${p.post!.id} has ${after.mediaItems?.length} media items after the update, ${post.mediaItems?.length} before`);
      res.zernio = { post: p.post!.id, scheduledFor: after.scheduledFor ?? null, url: now };
    } else {
      await putStored(db, p.key, out, contentType);
      // Hashed as it streams back (a master can be several GB): storage must serve exactly the fixed bytes.
      const stored = await db.storage.from(BUCKET).createSignedUrl(p.key, 3600);
      const back = await fetch(stored.data!.signedUrl, { cache: "no-store" });
      if (!back.ok || !back.body) throw new Error(`${p.key} could not be read back after the upload (${back.status})`);
      const h = hashingStream(back.body);
      const reader = h.stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      if (h.digest().sha256 !== res.sha256After) throw new Error(`${p.key} does not serve the fixed bytes after the upload`);
      if (res.sha256After !== res.sha256Before) {
        const carried: string[] = [];
        const warnings: string[] = [];
        for (const a of assets) {
          if (a.storage_path === p.key) {
            if (a.sha256 !== res.sha256Before) { warnings.push(`${a.id}: row sha ${a.sha256.slice(0, 12)} did not match the stored bytes; left as is`); continue; }
            const r = await carryForward(db, opts.owner, a, res.sha256After, statSync(out).size, why, kind === "video" ? { frames: v!.frames, psnr_luma: res.psnr } : {});
            carried.push(...r.carried); warnings.push(...r.warnings);
            const replaced = replaceSource(a, out, res.sha256Before);
            if (replaced) res.source_replaced = replaced;
          } else {
            must(await db.from("gtm_story_assets").update({ metadata: { ...(a.metadata ?? {}), proxy_sha256: res.sha256After, proxy_bytes: statSync(out).size } }).eq("id", a.id), `proxy of ${a.id}`);
          }
        }
        res.approvals_carried = carried;
        if (warnings.length) res.warnings = warnings;
      }
    }
    must(await db.from("gtm_sync_state").delete().eq("key", problemKey(p.key)), `clear ${p.key}`);
    await resolveNotes(db, p, res.action);
    res.ok = true;
    log(`fixed ${p.key}: ${res.action}${res.frames ? ` (${res.frames} frames, ${res.psnr} dB luma PSNR)` : ""}${res.approvals_carried?.length ? `; approvals carried: ${res.approvals_carried.join(", ")}` : ""}${res.zernio ? `; Zernio post ${res.zernio.post} keeps ${res.zernio.scheduledFor}` : ""}`);
    return res;
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    log(`could not fix ${p.key}: ${res.error}`);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
