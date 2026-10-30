import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mediaChecks, problemKey, recordAudit, refsFor, runAudit, withMediaChecks, type MediaProblem } from "../lib/media-audit";
import { fixProblem } from "../lib/media-fix";
import { ffmpegAvailable } from "../lib/video-heal";
import { webPlayableProblems } from "../lib/video-playable";
import { digest } from "../lib/story";
import { mp4 } from "./support/mp4";
import { png } from "./support/image";

type Row = Record<string, any>;

/** An in-memory Supabase: tables with eq/in/like/is/or filters, and a content-review bucket served over fake HTTP. */
function fakeDb(tables: Record<string, Row[]>, objects: Map<string, { bytes: Buffer; type: string; updated?: string }>) {
  const rpcs: Array<{ fn: string; args: Row }> = [];
  let clock = 0;
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: "select" | "delete" | "update"; patch?: Row } = { kind: "select" };
    let single = false;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === "delete") tables[table] = rows().filter((r) => !hit.includes(r));
      if (op.kind === "update") for (const r of hit) {
        // gtm_story_asset_changed: new bytes bump the revision and clear every channel decision.
        if (table === "gtm_story_assets" && op.patch?.sha256 && op.patch.sha256 !== r.sha256) {
          r.revision = (r.revision ?? 1) + 1;
          for (const c of tables.gtm_story_asset_channels ?? []) if (c.asset_id === r.id) Object.assign(c, { status: "pending", approved_sha256: null, note: "", updated_at: `t${++clock}` });
        }
        Object.assign(r, op.patch);
      }
      return { data: single ? hit[0] ?? null : hit, error: null };
    };
    const chain: any = {
      select: () => chain, eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), chain),
      not: (c: string, _o: string, _v: unknown) => (filters.push((r) => r[c] != null), chain),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
      like: (c: string, v: string) => (filters.push((r) => String(r[c]).startsWith(v.replace(/%$/, ""))), chain),
      or: (expr: string) => {
        const keys = [...expr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        return (filters.push((r) => keys.includes(r.storage_path) || keys.includes(r.metadata?.proxy_path)), chain);
      },
      order: () => chain, maybeSingle: () => ((single = true), chain),
      delete: () => ((op = { kind: "delete" }), chain), update: (patch: Row) => ((op = { kind: "update", patch }), chain),
      upsert: (row: Row) => { const i = rows().findIndex((r) => r.key === row.key && row.key !== undefined); if (i >= 0) rows()[i] = row; else rows().push(row); return Promise.resolve({ data: null, error: null }); },
      insert: (row: Row) => { rows().push(Array.isArray(row) ? row[0] : row); return Promise.resolve({ data: null, error: null }); },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return chain;
  };
  const url = (key: string) => `https://storage.test/storage/v1/object/sign/content-review/${key}?token=t`;
  const bucket = {
    list: async (dir: string) => {
      const names = new Map<string, Row>();
      for (const [k, o] of objects) {
        if (dir && !k.startsWith(`${dir}/`)) continue;
        const rest = dir ? k.slice(dir.length + 1) : k;
        const [head, ...tail] = rest.split("/");
        names.set(head, tail.length ? { name: head, id: null } : { name: head, id: k, updated_at: o.updated ?? "2026-10-13T00:00:00Z", metadata: { size: o.bytes.length, mimetype: o.type } });
      }
      return { data: [...names.values()], error: null };
    },
    createSignedUrls: async (paths: string[]) => ({ data: paths.filter((p) => objects.has(p)).map((p) => ({ path: p, signedUrl: url(p), error: null })), error: null }),
    createSignedUrl: async (p: string) => (objects.has(p) ? { data: { signedUrl: url(p) }, error: null } : { data: null, error: { message: "Object not found" } }),
    createSignedUploadUrl: async () => ({ data: { token: "u" }, error: null }),
    uploadToSignedUrl: async (key: string, _t: string, bytes: Buffer, o: { contentType: string }) => { objects.set(key, { bytes: Buffer.from(bytes), type: o.contentType }); return { data: null, error: null }; },
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const key = decodeURIComponent(new URL(String(input)).pathname.replace(/^\/storage\/v1\/object\/sign\/content-review\//, ""));
    const o = objects.get(key);
    if (!o) return new Response("not found", { status: 404 });
    const range = new Headers(init?.headers).get("range")?.match(/bytes=(\d+)-(\d+)/);
    if (!range) return new Response(new Uint8Array(o.bytes), { status: 200, headers: { "content-type": o.type } });
    const s = Number(range[1]), e = Math.min(Number(range[2]) + 1, o.bytes.length);
    return new Response(new Uint8Array(o.bytes.subarray(s, e)), { status: 206, headers: { "content-type": o.type, "content-range": `bytes ${s}-${e - 1}/${o.bytes.length}` } });
  }) as typeof fetch;
  const db = { from: query, storage: { from: () => bucket }, rpc: async (fn: string, args: Row) => { rpcs.push({ fn, args }); return { data: null, error: null }; } } as unknown as SupabaseClient;
  return { db, fetchImpl, rpcs, tables };
}

const KEY = "stories/s1-14/s1-14-video-9x16-aaaa.mp4";

test("the audit probes every stored video and image from headers, links each bad file to its Story, and records a BLOCK", async () => {
  const objects = new Map([
    [KEY, { bytes: mp4({ profile: 244, faststart: false }), type: "video/mp4" }],
    ["stories/s1-14/s1-14-ok-bbbb.mp4", { bytes: mp4(), type: "video/mp4" }],
    ["stories/s1-29/slide-04-cccc.png", { bytes: png(), type: "image/jpeg" }],
    ["stories/s1-29/slide-05-dddd.png", { bytes: png(), type: "image/png" }],
    ["storyboards/broll/x-0.0-1.0.mp4", { bytes: mp4(), type: "video/mp4" }],
  ]);
  const tables: Record<string, Row[]> = {
    gtm_story_assets: [{ id: "s1-14-video", story_id: "s1-14", kind: "video", storage_path: KEY, metadata: {} }, { id: "s1-29-slide-04", story_id: "s1-29", kind: "image", storage_path: "stories/s1-29/slide-04-cccc.png", metadata: {} }],
    gtm_content_items: [{ id: "s1-14-linkedin", story_id: "s1-14", media: [KEY], status: "approved", zernio_post_id: null }],
    gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_sync_state: [], gtm_story_feedback: [],
  };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const r = await runAudit(db, { zernio: false, fetch: fetchImpl });
  assert.equal(r.probed, 5); assert.equal(r.videos, 3); assert.equal(r.images, 2);
  assert.deepEqual(r.bad.map((b) => b.key), [KEY, "stories/s1-29/slide-04-cccc.png"]);
  assert.match(r.bad[0].problems.join(), /High 4:4:4/);
  assert.match(r.bad[1].problems.join(), /stored as image\/jpeg but the bytes are PNG/);
  assert.deepEqual(r.bad[0].refs.map((x) => `${x.kind}:${x.id}`), ["story-asset:s1-14-video", "calendar:s1-14-linkedin"]);

  const rec = await recordAudit(db, r);
  assert.deepEqual(rec, { flagged: 2, cleared: 0, notes: 2 });
  assert.ok(tables.gtm_sync_state.some((x) => x.key === problemKey(KEY)));
  assert.match(tables.gtm_story_feedback.find((f) => f.asset_id === "s1-14-video")!.body, /^\[unplayable-video\] BLOCK: .* will not play in a browser/);
  assert.equal(tables.gtm_story_feedback.find((f) => f.asset_id === "s1-14-video")!.author, "agent");
  await recordAudit(db, r);
  assert.equal(tables.gtm_story_feedback.length, 2, "a note is written once");

  // Fixed in storage: the next run clears the finding.
  objects.set(KEY, { bytes: mp4(), type: "video/mp4" });
  objects.set("stories/s1-29/slide-04-cccc.png", { bytes: png(), type: "image/png" });
  const again = await runAudit(db, { zernio: false, fetch: fetchImpl, since: "2027-01-01T00:00:00Z" });
  assert.equal(again.storage, 2, "a recent-only run still re-probes every flagged file");
  assert.deepEqual(again.bad, []);
  assert.equal((await recordAudit(db, again)).cleared, 2);
  assert.ok(!tables.gtm_sync_state.some((x) => String(x.key).startsWith("media.unplayable.")));
});

test("findings: a BLOCK per file at the top of the season analysis, linked to its piece", () => {
  const p: MediaProblem = { key: KEY, where: "storage", kind: "video", problems: ["H.264 profile is High 4:4:4 Predictive"], story_id: "s1-14", refs: [], source: "audit", detected_at: "2026-10-13T00:00:00Z" };
  const img: MediaProblem = { ...p, key: "stories/s1-29/slide-04.png", kind: "image", source: "browser", story_id: "s1-29" };
  const checks = mediaChecks([p, img]);
  assert.deepEqual(checks.map((c) => [c.severity, c.storyId]), [["block", "s1-14"], ["block", "s1-29"]]);
  assert.match(checks[0].message, /^Won't play: s1-14-video-9x16-aaaa\.mp4 in storage: H\.264 profile is High 4:4:4/);
  assert.match(checks[1].message, /^Won't load: slide-04\.png in storage: the page could not load it/);
  const a = withMediaChecks({ checks: [{ id: "x", severity: "warn" as const, status: "fail" as const, message: "m" }], summary: { block: 0, warn: 1, info: 0 } }, [p]);
  assert.equal(a.summary.block, 1); assert.equal(a.checks[0].id, `unplayable-video:${KEY}`);
  assert.deepEqual(refsFor({ assets: [], items: [], storyboards: [{ id: "sb-1", story_id: "s1-24" }], versions: [], broll: [] }, "storyboards/sb-1/base/x.mp4").story_id, "s1-24");
});

test("gtm media audit --fix replaces a Story video in place, under the same key, and carries John's approvals forward", { skip: !ffmpegAvailable() && "needs ffmpeg" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-fix-"));
  try {
    const clip = join(dir, "bad.mp4");
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv444p", clip]);
    assert.equal(r.status, 0);
    const bad = readFileSync(clip);
    const sha = digest(bad);
    const objects = new Map([[KEY, { bytes: bad, type: "video/mp4" }]]);
    const tables: Record<string, Row[]> = {
      gtm_story_assets: [{ id: "s1-14-video", story_id: "s1-14", source: "media/none.mp4", sha256: sha, revision: 3, stage: "final", storage_path: KEY, metadata: { bytes: bad.length } }],
      gtm_story_asset_channels: [
        { asset_id: "s1-14-video", channel: "linkedin", status: "approved", approved_sha256: sha, note: "" },
        { asset_id: "s1-14-video", channel: "instagram", status: "pending", approved_sha256: null, note: "" },
        { asset_id: "s1-14-video", channel: "youtube", status: "rejected", approved_sha256: null, note: "cut the last 3 s" },
      ],
      gtm_stories: [{ id: "s1-14", third_party_who: null }],
      gtm_sync_state: [{ key: problemKey(KEY), value: {} }], gtm_story_feedback: [{ asset_id: "s1-14-video", body: "[unplayable-video] BLOCK: x", resolved_at: null }],
    };
    const { db, fetchImpl, rpcs } = fakeDb(tables, objects);
    const real = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const p: MediaProblem = { key: KEY, where: "storage", kind: "video", problems: ["H.264 profile is High 4:4:4 Predictive"], story_id: "s1-14", refs: [{ kind: "story-asset", id: "s1-14-video", story_id: "s1-14" }], source: "audit", detected_at: "" };
      const res = await fixProblem(db, p, { owner: async () => db, log: () => {} });
      assert.equal(res.ok, true, res.error ?? "");
      const stored = objects.get(KEY)!.bytes;
      assert.deepEqual(webPlayableProblems(stored), [], "the same key now holds playable bytes");
      assert.equal(res.frames, 25);
      assert.equal(tables.gtm_story_assets[0].sha256, digest(stored), "the row follows the new bytes");
      assert.equal(tables.gtm_story_assets[0].metadata.reencoded.from_sha256, sha);
      assert.deepEqual(rpcs.map((x) => [x.fn, x.args.p_channel, x.args.p_status, x.args.p_expected_sha256]), [
        ["gtm_decide_story_asset", "linkedin", "approved", digest(stored)],
        ["gtm_decide_story_asset", "youtube", "rejected", digest(stored)],
      ], "John's approval and his change request are carried; the pending channel stays pending");
      assert.equal(rpcs[1].args.p_note, "cut the last 3 s", "his change request keeps his words");
      assert.match(rpcs[0].args.p_note, /carried forward by the media audit: re-encoded for browser playback/);
      assert.deepEqual(tables.gtm_sync_state, [], "the finding is cleared");
      assert.ok(tables.gtm_story_feedback[0].resolved_at, "the agent note is resolved");
    } finally { globalThis.fetch = real; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a scoped run (--keys, --no-zernio) or one cut short by its deadline never clears a finding it did not probe", async () => {
  const objects = new Map([[KEY, { bytes: mp4(), type: "video/mp4" }], ["stories/x/other.mp4", { bytes: mp4(), type: "video/mp4" }]]);
  const zernioRow = { key: problemKey("zernio:post1:0"), value: { key: "zernio:post1:0", where: "zernio", kind: "video", problems: ["High 4:4:4"], story_id: null, refs: [], source: "audit", detected_at: "2026-10-13T00:00:00Z" } };
  const tables: Record<string, Row[]> = { gtm_sync_state: [zernioRow], gtm_story_assets: [], gtm_content_items: [], gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_story_feedback: [] };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const scoped = await runAudit(db, { keys: [KEY], zernio: false, fetch: fetchImpl });
  assert.deepEqual(scoped.probedKeys, [KEY]);
  assert.equal((await recordAudit(db, scoped)).cleared, 0);
  assert.ok(tables.gtm_sync_state.some((x) => x.key === zernioRow.key), "the Zernio BLOCK survives a storage-only run");
  const cut = await runAudit(db, { zernio: false, fetch: fetchImpl, deadline: Date.now() - 1 });
  assert.equal(cut.probedKeys.length, 0); assert.ok(cut.unreadable.some((u) => u.key === "(bucket root)"), "nothing listed after the deadline");
  assert.equal((await recordAudit(db, cut)).cleared, 0);
});

test("--fix finishes a fix that replaced the bytes but was cut off before moving the asset row", { skip: !ffmpegAvailable() && "needs ffmpeg" }, async () => {
  const good = mp4();
  const oldSha = "ab".repeat(32);
  const key = `stories/s1-14/s1-14-video-${oldSha.slice(0, 16)}.mp4`;
  const objects = new Map([[key, { bytes: good, type: "video/mp4" }]]);
  const tables: Record<string, Row[]> = {
    gtm_story_assets: [{ id: "s1-14-video", story_id: "s1-14", source: "x.mp4", sha256: oldSha, revision: 2, stage: "final", storage_path: key, metadata: {} }],
    gtm_story_asset_channels: [{ asset_id: "s1-14-video", channel: "linkedin", status: "approved", approved_sha256: oldSha, note: "" }],
    gtm_stories: [{ id: "s1-14", third_party_who: null }], gtm_sync_state: [{ key: problemKey(key), value: {} }], gtm_story_feedback: [],
  };
  const { db, fetchImpl, rpcs } = fakeDb(tables, objects);
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const res = await fixProblem(db, { key, where: "storage", kind: "video", problems: ["High 4:4:4"], story_id: "s1-14", refs: [], source: "audit", detected_at: "" }, { owner: async () => db, log: () => {} });
    assert.equal(res.ok, true, res.error ?? "");
    assert.match(res.action, /finished an interrupted fix/);
    assert.equal(tables.gtm_story_assets[0].sha256, digest(good), "the row now names the stored bytes, so the publish gate passes");
    assert.deepEqual(rpcs.map((x) => [x.args.p_channel, x.args.p_status]), [["linkedin", "approved"]]);
    assert.deepEqual(tables.gtm_sync_state, []);
  } finally { globalThis.fetch = real; }
});

test("Storage saying 'too many connections' to a listing is waited out, not fatal", async () => {
  const { retryBusy } = await import("../lib/media-audit");
  let calls = 0;
  const r = await retryBusy(async () => (++calls < 3 ? { data: null, error: { message: "Too many connections issued to the database" } } : { data: [1], error: null }), async () => {});
  assert.equal(calls, 3); assert.deepEqual(r.data, [1]);
  const gone = await retryBusy(async () => ({ data: null, error: { message: "Object not found" } }), async () => {});
  assert.equal(gone.error?.message, "Object not found", "a real error is returned at once");
});

test("a storage folder that times out is retried, and one that keeps failing is reported without sinking the audit", async () => {
  const objects = new Map([["guide/a/x.mp4", { bytes: mp4(), type: "video/mp4" }], ["stories/s/y.mp4", { bytes: mp4({ profile: 244 }), type: "video/mp4" }]]);
  const tables: Record<string, Row[]> = { gtm_sync_state: [], gtm_story_assets: [], gtm_content_items: [], gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_story_feedback: [] };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const bucket = db.storage.from("content-review") as unknown as { list: (dir: string) => Promise<unknown> };
  const real = bucket.list;
  let flaky = 1;
  bucket.list = async (dir: string) => {
    if (dir === "stories/s" && flaky-- > 0) return { data: null, error: { message: "The connection to the database timed out" } };
    if (dir === "guide/a") return { data: null, error: { message: "The connection to the database timed out" } };
    return real(dir);
  };
  const r = await runAudit(db, { zernio: false, fetch: fetchImpl });
  assert.deepEqual(r.bad.map((b) => b.key), ["stories/s/y.mp4"], "the flaky folder was retried and probed");
  assert.deepEqual(r.unreadable.map((u) => u.key), ["guide/a/"], "the dead folder is reported");
  assert.match(r.unreadable[0].error, /timed out/);
});

test("signing that keeps failing reports those files and never clears their findings; listing stops at its share of the deadline", async () => {
  const objects = new Map([[KEY, { bytes: mp4(), type: "video/mp4" }]]);
  const flagged = { key: problemKey(KEY), value: { key: KEY, where: "storage", kind: "video", problems: ["High 4:4:4"], story_id: null, refs: [], source: "audit", detected_at: "2026-10-13T00:00:00Z" } };
  const tables: Record<string, Row[]> = { gtm_sync_state: [flagged], gtm_story_assets: [], gtm_content_items: [], gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_story_feedback: [] };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const bucket = db.storage.from("content-review") as unknown as { createSignedUrls: (p: string[]) => Promise<unknown> };
  bucket.createSignedUrls = async () => ({ data: null, error: { message: "The connection to the database timed out" } });
  const r = await runAudit(db, { zernio: false, fetch: fetchImpl });
  assert.ok(r.unreadable.some((u) => u.key === KEY && /could not sign/.test(u.error)));
  assert.ok(!r.probedKeys.includes(KEY));
  await recordAudit(db, r);
  assert.ok(tables.gtm_sync_state.some((x) => x.key === flagged.key), "an unsigned file keeps its BLOCK");
  const late = await runAudit(db, { zernio: false, fetch: fetchImpl, deadline: Date.now() - 1 });
  assert.ok(late.unreadable.some((u) => u.key === "(bucket root)" && /listing time ran out/.test(u.error)));
});

test("a file the last run could not read is probed first on the next run, even if it did not change", async () => {
  const objects = new Map([[KEY, { bytes: mp4({ profile: 244 }), type: "video/mp4", updated: "2026-01-01T00:00:00Z" }]]);
  const tables: Record<string, Row[]> = { gtm_sync_state: [{ key: "media.audit", value: { unreadable_keys: [KEY, "guide/a/", "zernio:p:0"] } }], gtm_story_assets: [], gtm_content_items: [], gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_story_feedback: [] };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const r = await runAudit(db, { zernio: false, fetch: fetchImpl, since: "2026-10-01T00:00:00Z" });
  assert.deepEqual(r.bad.map((b) => b.key), [KEY], "outside the 48 h window, but carried from the last run's unreadable list");
  await recordAudit(db, r);
  assert.deepEqual(tables.gtm_sync_state.find((x) => x.key === "media.audit")!.value.unreadable_keys, ["zernio:p:0"], "the file was read and the folder listed; the Zernio entry waits for a run that lists Zernio");
});

test("a scoped run never drops the cron's carried list; a folder that failed to list is listed in full next time", async () => {
  const OLD = "2026-01-01T00:00:00Z";
  const objects = new Map([
    ["stories/a/x.mp4", { bytes: mp4(), type: "video/mp4", updated: OLD }],
    ["guide/a/old.mp4", { bytes: mp4({ profile: 244 }), type: "video/mp4", updated: OLD }],
  ]);
  const tables: Record<string, Row[]> = { gtm_sync_state: [{ key: "media.audit", value: { unreadable_keys: ["stories/a/missed.mp4", "guide/a/"] } }], gtm_story_assets: [], gtm_content_items: [], gtm_storyboards: [], gtm_broll_shots: [], gtm_story_asset_versions: [], gtm_story_feedback: [] };
  const { db, fetchImpl } = fakeDb(tables, objects);
  const carried = () => tables.gtm_sync_state.find((x) => x.key === "media.audit")!.value.unreadable_keys as string[];
  // A --keys run on another file keeps the carried list.
  await recordAudit(db, await runAudit(db, { keys: ["stories/a/x.mp4"], zernio: false, fetch: fetchImpl }));
  assert.deepEqual(carried(), ["stories/a/missed.mp4", "guide/a/"]);
  // The next windowed run lists guide/a in full (its old file is found bad) and drops the folder entry once it listed.
  const r = await runAudit(db, { since: "2026-10-01T00:00:00Z", zernio: false, fetch: fetchImpl });
  assert.ok(r.bad.some((b) => b.key === "guide/a/old.mp4"), "the old file in the folder that failed to list is probed");
  await recordAudit(db, r);
  assert.deepEqual(carried(), [], "missed.mp4 is gone (not found) and guide/a/ listed fine");
});
