import test from "node:test";
import assert from "node:assert/strict";
import { reelCover } from "../lib/publish-item";

// John, 2026-10-16: a clip's cover is never a slide. The image bound beside one video goes out as the Reel cover.
const video = { id: "s-video", kind: "video" as const, storage_path: "stories/s/s-video-0123456789abcdef.mp4" };
const cover = { id: "s-cover-9x16", kind: "image" as const, storage_path: "stories/s/s-cover-9x16-0123456789abcdef.png" };
const item = { media: [video.storage_path], story_assets: [video.id, cover.id, "s-instagram-copy"] };

test("the image bound beside one video is its Reel cover", () => {
  assert.equal(reelCover(item, [video, cover], [{ type: "video" }]), cover.storage_path);
});

test("no cover for slides, two images, or an image that is itself posted", () => {
  assert.equal(reelCover(item, [video, cover], [{ type: "image" }, { type: "image" }]), null);
  assert.equal(reelCover(item, [video, cover, { ...cover, id: "s-cover-4x5" }].map((a) => a), [{ type: "video" }]), cover.storage_path);
  assert.equal(reelCover({ ...item, story_assets: [...item.story_assets, "s-cover-4x5"] }, [video, cover, { ...cover, id: "s-cover-4x5", storage_path: "x.png" }], [{ type: "video" }]), null);
  assert.equal(reelCover({ ...item, media: [cover.storage_path] }, [cover], [{ type: "image" }]), null);
});
