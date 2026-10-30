import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countFrames, ffmpegAvailable, healInPlace, MIN_PSNR } from "../lib/video-heal";
import { webPlayableProblems, webPlayableProblemsFile } from "../lib/video-playable";
import { digest, stageStory } from "../lib/story";
import type { Calendar } from "../lib/calendar";

const skip = !ffmpegAvailable() && "needs ffmpeg (CI installs it)";
// Originals go to a scratch directory here, never to ~/.cache.
process.env.GTM_UNPLAYABLE_DIR = mkdtempSync(join(tmpdir(), "gtm-unplayable-"));

/** A real two-second H.264 High 4:4:4 clip with AAC audio, moov at the end: the s1-14 failure. */
function badClip(file: string) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "18", "-c:a", "aac", "-shortest", file]);
  assert.equal(r.status, 0, r.stderr?.toString());
  assert.match(webPlayableProblemsFile(file).join(), /High 4:4:4/);
}

test("healInPlace re-encodes a 4:4:4 clip to a playable one with every frame and the picture kept", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-heal-"));
  try {
    const file = join(dir, "clip.mp4");
    badClip(file);
    const frames = countFrames(file);
    const lines: string[] = [];
    const r = healInPlace(file, (l) => lines.push(l))!;
    assert.deepEqual(webPlayableProblemsFile(file), [], "the file at the same path now plays");
    assert.equal(r.frames, frames); assert.equal(r.framesOut, frames);
    assert.ok(r.psnr >= MIN_PSNR, `PSNR ${r.psnr}`);
    assert.equal(r.audio, "copied", "AAC audio is copied untouched");
    assert.ok(existsSync(r.backup!) && r.backup!.startsWith(process.env.GTM_UNPLAYABLE_DIR!), "the original is kept, outside the workspace");
    assert.deepEqual(readdirSync(dir), ["clip.mp4"], "nothing new in the workspace folder");
    assert.match(lines.join("\n"), /re-encoded clip\.mp4 to H\.264 High yuv420p.*frames kept, PSNR/);
    assert.equal(healInPlace(file), null, "a playable file is left alone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gtm story stage heals an unplayable video and stages the playable bytes (dry run changes nothing)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-heal-stage-"));
  const previous = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    const video = join(dir, "video.mp4");
    badClip(video);
    const before = readFileSync(video);
    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, "id: orion\ntitle: Orion\nlink: https://example.com/story\nassets:\n  - { id: video, title: Video, kind: video, source: video.mp4, channels: [youtube] }\n");
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };

    const dry = await stageStory(null, manifest, cal, true) as { healed?: { id: string; action: string }[] };
    assert.deepEqual(dry.healed?.map((h) => [h.id, h.action]), [["video", "would re-encode to H.264 High yuv420p"]]);
    assert.deepEqual(readFileSync(video), before, "a dry run re-encodes nothing");

    const uploads = new Map<string, Buffer>();
    let storedSha: string | undefined;
    const ok = { data: [], error: null };
    const db = {
      from(table: string) {
        return {
          select() { return { in: () => Promise.resolve(ok), eq: () => Promise.resolve(ok) }; },
          upsert(row: { sha256?: string }) { if (table === "gtm_story_assets") storedSha = row.sha256; return Promise.resolve({ data: null, error: null }); },
          insert(row: { sha256?: string }) { if (table === "gtm_story_assets") storedSha = row.sha256; return Promise.resolve({ data: null, error: null }); },
        };
      },
      storage: { from() { return {
        createSignedUploadUrl() { return Promise.resolve({ data: { token: "t" }, error: null }); },
        uploadToSignedUrl(key: string, _t: string, bytes: Buffer) { uploads.set(key, Buffer.from(bytes)); return Promise.resolve({ data: null, error: null }); },
      }; } },
    } as unknown as SupabaseClient;
    const r = await stageStory(db, manifest, cal) as { healed?: { id: string; frames: number }[] };
    assert.equal(r.healed?.[0]?.id, "video");
    const mp4 = [...uploads].find(([k]) => k.endsWith(".mp4"))![1];
    assert.deepEqual(webPlayableProblems(mp4), [], "only playable bytes were uploaded");
    assert.equal(storedSha, digest(mp4), "the row records the sha of what was uploaded");
    assert.deepEqual(readFileSync(video), mp4, "the source now is the playable file, so a restage stages the same bytes");
    assert.ok(readdirSync(process.env.GTM_UNPLAYABLE_DIR!).some((f) => /^[0-9a-f]{8}-video\.mp4$/.test(f)), "the original is kept outside the workspace");
  } finally {
    if (previous === undefined) delete process.env.GTM_WORKSPACE; else process.env.GTM_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
