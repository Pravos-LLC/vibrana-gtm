import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStoryApproval, assertStoryImage, digest, stageStory, type StoryAsset, type StoryChannel } from "../lib/story";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Calendar, Item } from "../lib/calendar";
import { mp4 } from "./support/mp4";
import { png } from "./support/image";
import { catalogHash, fileHash, type PackagingBrief } from "../lib/packaging/model";
import { TOOLKIT_VERSION } from "../lib/packaging/catalog";

test("Story scheduling needs current, channel-specific approval for every bound asset", () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-story-test-"));
  try {
    writeFileSync(join(dir, "copy.md"), "Approved copy");
    writeFileSync(join(dir, "video.mp4"), "video bytes");
    const link = "https://brand.example.com/case-studies/sample-extra-38";
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    const item: Item = {
      id: "orion-linkedin", week: 40, date: "2026-10-01", pillar: "proof", title: "Orion", format: "video",
      channels: ["linkedin"], copy: "copy.md", media: ["video.mp4"], link, story_id: "orion",
      story_assets: ["copy", "video", "link"], status: "approved",
    };
    const make = (id: string, kind: StoryAsset["kind"], source: string, sha256: string): StoryAsset =>
      ({ id, story_id: "orion", title: id, kind, source, sha256, revision: 1, storage_path: null, body: null, url: null, metadata: {} });
    const assets = [
      make("copy", "copy", "copy.md", digest("Approved copy")),
      make("video", "video", "video.mp4", digest("video bytes")),
      make("link", "link", link, digest(link)),
    ];
    const reviews: StoryChannel[] = assets.map((a) => ({ asset_id: a.id, channel: "linkedin", status: "approved", approved_sha256: a.sha256, note: "" }));
    const snapshot = assertStoryApproval(cal, item, assets, reviews);
    assert.equal(snapshot.get(join(dir, "video.mp4"))?.toString(), "video bytes");
    assert.throws(() => assertStoryApproval(cal, item, assets, reviews.map((r) => r.asset_id === "video" ? { ...r, status: "rejected" } : r)), /not approved/);
    assert.throws(() => assertStoryApproval(cal, item, assets, reviews.map((r) => ({ ...r, channel: "instagram" }))), /not approved/);
    assert.throws(() => assertStoryApproval(cal, { ...item, story_assets: ["copy", "video"] }, assets, reviews), /not bound/);
    assert.throws(() => assertStoryImage(cal, item, assets, join(dir, "unapproved-cover.jpg")), /cover .* not bound/);
    writeFileSync(join(dir, "copy.md"), "Changed after approval");
    assert.equal(snapshot.get(join(dir, "copy.md"))?.toString(), "Approved copy");
    assert.throws(() => assertStoryApproval(cal, item, assets, reviews), /changed after approval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Story staging uploads the bytes it hashed even if a source changes during database work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-story-stage-"));
  const previous = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    const video = join(dir, "video.mp4");
    writeFileSync(video, mp4({ payload: "reviewed video" }));
    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, "id: orion\ntitle: Orion\nlink: https://example.com/story\nassets:\n  - id: video\n    title: Video\n    kind: video\n    source: video.mp4\n    channels: [youtube]\n");
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    let uploaded: Buffer | undefined;
    let storedSha: string | undefined;
    const ok = { data: [], error: null };
    const db = {
      from(table: string) {
        return {
          select() {
            return {
              in() { if (table === "gtm_story_assets") writeFileSync(video, mp4({ payload: "changed video" })); return Promise.resolve(ok); },
              eq() { return Promise.resolve(ok); },
            };
          },
          upsert(row: { sha256?: string }) { if (table === "gtm_story_assets") storedSha = row.sha256; return Promise.resolve({ data: null, error: null }); },
          insert(row: { sha256?: string }) { if (table === "gtm_story_assets") storedSha = row.sha256; return Promise.resolve({ data: null, error: null }); },
        };
      },
      storage: { from() { return {
        createSignedUploadUrl() { return Promise.resolve({ data: { token: "test" }, error: null }); },
        uploadToSignedUrl(_key: string, _token: string, bytes: Buffer) { uploaded = Buffer.from(bytes); return Promise.resolve({ data: null, error: null }); },
      }; } },
    } as unknown as SupabaseClient;
    await stageStory(db, manifest, cal);
    assert.deepEqual(uploaded, mp4({ payload: "reviewed video" }));
    assert.equal(storedSha, digest(uploaded!));
  } finally {
    if (previous === undefined) delete process.env.GTM_WORKSPACE;
    else process.env.GTM_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Story staging refuses an MP4 a browser cannot play, before any database write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-story-unplayable-"));
  const previous = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    writeFileSync(join(dir, "video.mp4"), mp4({ profile: 244 }));
    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, "id: orion\ntitle: Orion\nlink: https://example.com/story\nassets:\n  - id: video\n    title: Video\n    kind: video\n    source: video.mp4\n    channels: [youtube]\n");
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    const db = { from() { throw new Error("touched the database"); } } as unknown as SupabaseClient;
    // --no-heal: refused as before.
    await assert.rejects(stageStory(db, manifest, cal, false, false, undefined, { heal: false }), /video \(video\.mp4\) will not play in a browser: H\.264 profile is High 4:4:4/);
    await assert.rejects(stageStory(null, manifest, cal, true, false, undefined, { heal: false }), /will not play/);
    // Self-heal is on by default, but these are not real frames: the re-encode fails, so staging still refuses (or,
    // without ffmpeg, it refuses outright). Either way the database is never touched.
    await assert.rejects(stageStory(db, manifest, cal), /re-encode of video\.mp4 failed|ffprobe video\.mp4|will not play/);
  } finally {
    if (previous === undefined) delete process.env.GTM_WORKSPACE;
    else process.env.GTM_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Story staging writes a stage only when the manifest or --stage names one, so a plain restage keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-story-stage-"));
  const previous = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    writeFileSync(join(dir, "video.mp4"), mp4({ payload: "cut" }));
    writeFileSync(join(dir, "copy.md"), "Caption");
    const manifest = join(dir, "story.yaml");
    const write = (stageLine: string) => writeFileSync(manifest, `id: orion\ntitle: Orion\nlink: https://example.com/story\n${stageLine}assets:\n  - { id: video, title: Video, kind: video, source: video.mp4, channels: [youtube] }\n  - { id: copy, title: Copy, kind: copy, source: copy.md, channels: [youtube] }\n`);
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    const run = async (stage?: string) => {
      const rows: Record<string, unknown>[] = [];
      const ok = { data: [], error: null };
      const db = {
        from(table: string) {
          return {
            select() { return { in: () => Promise.resolve(ok), eq: () => Promise.resolve(ok) }; },
            upsert(row: Record<string, unknown>) { if (table === "gtm_story_assets") rows.push(row); return Promise.resolve({ data: null, error: null }); },
            insert(row: Record<string, unknown>) { if (table === "gtm_story_assets") rows.push(row); return Promise.resolve({ data: null, error: null }); },
          };
        },
        storage: { from() { return { createSignedUploadUrl: () => Promise.resolve({ data: { token: "t" }, error: null }), uploadToSignedUrl: () => Promise.resolve({ data: null, error: null }) }; } },
      } as unknown as SupabaseClient;
      await stageStory(db, manifest, cal, false, false, stage);
      return rows.map((r) => [r.id, "stage" in r ? r.stage : "(kept)"]);
    };
    write("");
    assert.deepEqual(await run(), [["video", "(kept)"], ["copy", "(kept)"]]);
    assert.deepEqual(await run("final"), [["video", "final"], ["copy", "(kept)"]]);
    write("stage: rough-cut\n");
    assert.deepEqual(await run(), [["video", "rough-cut"], ["copy", "(kept)"]]);
    writeFileSync(manifest, "id: orion\ntitle: Orion\nlink: https://example.com/story\nassets:\n  - { id: copy, title: Copy, kind: copy, source: copy.md, channels: [youtube], stage: rough-cut }\n");
    await assert.rejects(run(), /only video and image assets have a stage/);
  } finally {
    if (previous === undefined) delete process.env.GTM_WORKSPACE;
    else process.env.GTM_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pipeline Story: --stage applies to new or changed media only, a production asset never enters /content, and staging records progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-story-pipeline-"));
  const previous = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    const cut = mp4({ payload: "rough cut v4" });
    writeFileSync(join(dir, "video.mp4"), cut);
    writeFileSync(join(dir, "thumb.png"), png({ w: 1920, h: 1080, note: "thumbnail" }));
    writeFileSync(join(dir, "board.png"), png({ note: "storyboard" }));
    writeFileSync(join(dir, "copy.md"), "Caption");
    const manifest = join(dir, "story.yaml");
    const packagingBrief: PackagingBrief = {
      schema: 1, story: "sn", brand: "sample-author", theme: "dark", template: "clear-conversation", ready: true,
      audience: "Builders", promise: "Community language data", thumbnail: "Their language", opening: { text: "Their language", spoken: "Their language", source: "copy.md" },
      payoff: { source: "copy.md", seconds: 1, explanation: "Community recording" }, title: "Their language", description: "Caption",
      sources: [{ path: "copy.md", role: "copy" }], portraits: [], shapes: ["landscape"], selection: "Conversation",
    };
    writeFileSync(join(dir, "packaging-brief.json"), JSON.stringify(packagingBrief));
    writeFileSync(join(dir, "packaging-manifest.json"), JSON.stringify({
      schema: 1, story: "sn", toolkit: TOOLKIT_VERSION, catalogHash: catalogHash(), brief: "packaging-brief.json",
      briefHash: fileHash(join(dir, "packaging-brief.json")), brand: packagingBrief.brand, theme: packagingBrief.theme, template: packagingBrief.template,
      inputs: [{ path: "copy.md", sha256: fileHash(join(dir, "copy.md")) }],
      assets: [{ path: "thumb.png", sha256: fileHash(join(dir, "thumb.png")), width: 1920, height: 1080, role: "cover" }],
    }));
    const write = (extra: string) => writeFileSync(manifest, [
      "id: sn", "title: Their language", "link: https://example.com/story", "pipeline: short", "series: example-shorts", "third_party: example_approver / Example Series", "assets:",
      "  - { id: video, title: Video, kind: video, source: video.mp4, channels: [youtube, instagram] }",
      "  - { id: thumb, title: YouTube thumbnail, kind: image, source: thumb.png, channels: [youtube], packaging: packaging-manifest.json, label: v1, review_points: [{ t: 9, label: \"B4 GPU rack\" }] }",
      "  - { id: copy, title: Copy, kind: copy, source: copy.md, channels: [youtube] }", extra, "",
    ].join("\n"));
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    // The rough cut is staged and approved as a stage; everything up to the final is done.
    const existing = [{ id: "video", kind: "video", sha256: digest(cut), storage_path: `stories/sn/video-${digest(cut).slice(0, 16)}.mp4`, metadata: { label: "v4" }, stage: "rough-cut", story_id: "sn" }];
    const stageRows = [["paper-edit", "approved"], ["rough-cut", "approved"], ["enhance-plan", "approved"], ["broll", "done"], ["motion", "done"], ["finish", "done"]].map(([stage, status]) => ({ stage, status }));
    const run = async () => {
      const writes: Record<string, Record<string, unknown>[]> = {};
      const data = (table: string) => ({ gtm_story_assets: existing, gtm_stories: [{ pipeline: "short" }], gtm_story_stages: stageRows }[table] ?? []);
      const db = {
        from(table: string) {
          const result = { data: data(table), error: null };
          return {
            select() { return { in: () => Promise.resolve(result), eq: () => Promise.resolve(result) }; },
            upsert(row: Record<string, unknown> | Record<string, unknown>[]) { (writes[table] ??= []).push(...[row].flat()); return Promise.resolve({ data: null, error: null }); },
            insert(row: Record<string, unknown>) { (writes[table] ??= []).push(row); return Promise.resolve({ data: null, error: null }); },
            update(row: Record<string, unknown>) { (writes[table] ??= []).push(row); const q = { eq: () => q, select: () => q, maybeSingle: () => Promise.resolve({ data: { id: row.id }, error: null }) }; return q; },
          };
        },
        storage: { from() { return { createSignedUploadUrl: () => Promise.resolve({ data: { token: "t" }, error: null }), uploadToSignedUrl: () => Promise.resolve({ data: null, error: null }) }; } },
      } as unknown as SupabaseClient;
      const result = await stageStory(db, manifest, cal, false, false, "final", { changes: "YouTube thumbnail" });
      return { result, writes };
    };
    // A storyboard is a production asset: it never goes into /content, bound to no platform or to "plan".
    write("  - { id: board, title: B-roll + Motion plan, kind: image, source: board.png, channels: [] }");
    await assert.rejects(run(), /board: bound to no platform, so it is a production asset/);
    write("  - { id: board, title: B-roll + Motion plan, kind: image, source: board.png, channels: [plan] }");
    await assert.rejects(run(), /"plan" is not a platform/);
    write("");
    const { result, writes } = await run();
    const assets = Object.fromEntries(writes.gtm_story_assets.map((r) => [r.id, r]));
    assert.equal("stage" in assets.video, false, "the unchanged rough cut keeps its stage");
    assert.equal(assets.thumb.stage, "final");
    assert.deepEqual([(assets.thumb.metadata as Record<string, unknown>).changes, (assets.thumb.metadata as Record<string, unknown>).label], ["YouTube thumbnail", "v1"]);
    assert.equal((assets.video.metadata as Record<string, unknown>).changes, undefined, "unchanged bytes keep their own description");
    assert.deepEqual(writes.gtm_stories.map((r) => [r.pipeline, r.series, r.third_party_who]), [["short", "example-shorts", "example_approver / Example Series"]]);
    assert.deepEqual(writes.gtm_story_stages?.map(r => [r.stage, r.status]), [["packaging", "done"]], "staging fills the new agent packaging stage; the final remains platform approvals");
    assert.equal((result as { warnings?: string[] }).warnings, undefined);
  } finally {
    if (previous === undefined) delete process.env.GTM_WORKSPACE;
    else process.env.GTM_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
