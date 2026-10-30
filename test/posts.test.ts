import test from "node:test";
import assert from "node:assert/strict";
import { filterPosts, groupForList, reviewHref, type Post } from "../lib/posts.ts";
import { captionFor, parsePostFilters, thumbFor } from "../lib/posts-parse.ts";
import { mondayOf } from "../lib/week.ts";

const post = (over: Partial<Post>): Post => ({
  id: "p", date: "2026-10-10", time: "08:30", title: "A post", channels: ["linkedin"], status: "drafted", pillar: "proof", format: "text",
  storyId: null, publication: null, caption: "", thumb: null, mediaKind: null, urls: {}, handsOn: false, linkProblems: [], ...over,
});

test("filters: unknown values are dropped, the search is trimmed and capped", () => {
  assert.deepEqual(parsePostFilters({ channel: "tiktok", status: "nope", pillar: "Proof!", q: "  wave  " }), { q: "wave", channel: "", status: "", pillar: "" });
  assert.deepEqual(parsePostFilters({ channel: ["instagram", "x"], status: "approved", pillar: "build" }), { q: "", channel: "instagram", status: "approved", pillar: "build" });
  assert.equal(parsePostFilters({ q: "x".repeat(300) }).q.length, 100);
});

test("filters: channel, status, pillar and search across title and caption all narrow", () => {
  const posts = [
    post({ id: "a", channels: ["linkedin"], status: "approved", title: "The Wave", caption: "surf" }),
    post({ id: "b", channels: ["instagram"], status: "drafted", pillar: "build", caption: "The wave again" }),
    post({ id: "c", channels: ["youtube"], status: "published", title: "Other" }),
  ];
  const ids = (f: Partial<ReturnType<typeof parsePostFilters>>) => filterPosts(posts, { q: "", channel: "", status: "", pillar: "", ...f }).map((p) => p.id);
  assert.deepEqual(ids({}), ["a", "b", "c"]);
  assert.deepEqual(ids({ q: "WAVE" }), ["a", "b"]);
  assert.deepEqual(ids({ channel: "instagram" }), ["b"]);
  assert.deepEqual(ids({ status: "published" }), ["c"]);
  assert.deepEqual(ids({ pillar: "build", q: "wave" }), ["b"]);
});

test("filters: killed (skipped) posts are hidden unless the status filter asks for them", () => {
  const posts = [post({ id: "live" }), post({ id: "killed", status: "skipped" })];
  const ids = (status: string) => filterPosts(posts, { q: "", channel: "", status, pillar: "" }).map((p) => p.id);
  assert.deepEqual(ids(""), ["live"]);
  assert.deepEqual(ids("skipped"), ["killed"]);
});

test("caption: the channel's own section wins over the shared text, frontmatter is stripped", () => {
  const body = "---\nfirst_comment: x\n---\nShared text\n--- channel: instagram ---\nIG text";
  assert.equal(captionFor(body, "instagram"), "IG text");
  assert.equal(captionFor(body, "linkedin"), "Shared text");
  assert.equal(captionFor(null, "linkedin"), "");
});

test("thumbnail: a cover image beats a video poster, which beats a loose media image", () => {
  const assets = new Map([
    ["vid", { id: "vid", kind: "video", storage_path: "v.mp4", metadata: { poster_path: "v-poster.jpg" } }],
    ["cover", { id: "cover", kind: "image", storage_path: "cover.png", metadata: {} }],
    ["copy", { id: "copy", kind: "copy", storage_path: null, metadata: {} }],
  ]);
  assert.deepEqual(thumbFor({ story_assets: ["vid", "cover", "copy"], media: [], format: "video" }, assets), { path: "cover.png", kind: "video" });
  assert.deepEqual(thumbFor({ story_assets: ["vid", "copy"], media: [], format: "video" }, assets), { path: "v-poster.jpg", kind: "video" });
  assert.deepEqual(thumbFor({ story_assets: [], media: ["a.pdf", "slide.webp"], format: "document" }, assets), { path: "slide.webp", kind: "document" });
  assert.deepEqual(thumbFor({ story_assets: null, media: null, format: "text" }, assets), { path: null, kind: null });
});

test("list groups: overdue, upcoming by week, then what went out newest first", () => {
  const today = "2026-10-07";
  const g = groupForList([
    post({ id: "old-drafted", date: "2026-10-01" }),
    post({ id: "old-pub", date: "2026-10-02", status: "published" }),
    post({ id: "old-skip", date: "2026-10-03", status: "skipped" }),
    post({ id: "newer-pub", date: "2026-10-05", status: "published" }),
    post({ id: "this-week", date: "2026-10-08" }),
    post({ id: "next-week", date: "2026-10-13" }),
  ], today, mondayOf);
  assert.deepEqual(g.overdue.map((p) => p.id), ["old-drafted"]);
  assert.deepEqual(g.weeks.map((w) => [w.monday, w.posts.map((p) => p.id)]), [["2026-10-05", ["this-week"]], ["2026-10-12", ["next-week"]]]);
  assert.deepEqual(g.done.map((p) => p.id), ["newer-pub", "old-skip", "old-pub"]);
});

test("review link: season pieces open on /content for their platform, other Stories on their own page", () => {
  assert.equal(reviewHref({ storyId: "s1-02-sample-piece-02", channels: ["instagram"] }), "/content?piece=s1-02-sample-piece-02&platform=instagram");
  assert.equal(reviewHref({ storyId: "sample-extra-38", channels: ["newsletter"] }), "/stories/sample-extra-38");
  assert.equal(reviewHref({ storyId: null, channels: ["linkedin"] }), null);
});
