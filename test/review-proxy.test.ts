import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { needsReviewProxy, stageReviewProxy } from "../lib/review-proxy";
import { sha256File, webPlayableProblemsFile } from "../lib/large-media";
import { webPlayableProblems } from "../lib/video-playable";

test("short videos under the old 50 MiB limit get a smaller playable derivative without touching master or decisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-short-proxy-test-"));
  try {
    const abs = join(dir, "short.mp4");
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", abs]);
    assert.equal(made.status, 0, made.stderr?.toString());
    const free = Buffer.alloc(8); free.writeUInt32BE(8 + 5 * 1024 * 1024); free.write("free", 4, "latin1");
    appendFileSync(abs, free); appendFileSync(abs, Buffer.alloc(5 * 1024 * 1024));
    const bytes = statSync(abs).size, sha256 = sha256File(abs);
    assert.equal(needsReviewProxy(bytes), true);
    assert.equal(needsReviewProxy(1024), false);
    const uploads: Buffer[] = [];
    const db = { from: () => { throw new Error("must never write approval tables"); }, storage: { from: () => ({ upload: async (_key: string, data: Buffer) => { uploads.push(data); return { data: {}, error: null }; } }) } } as unknown as SupabaseClient;
    const meta = await stageReviewProxy(db, "story", { id: "short", abs, sha256, bytes });
    assert.ok(Number(meta.proxy_bytes) < bytes / 3);
    assert.equal(meta.proxy_master_sha256, sha256);
    assert.deepEqual(webPlayableProblems(uploads[0]), []);
    assert.deepEqual(webPlayableProblemsFile(abs), []);
    assert.equal(sha256File(abs), sha256);
    await assert.rejects(stageReviewProxy(db, "story", { id: "short", abs, sha256: "wrong", bytes }), /master changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
