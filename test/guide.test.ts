import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS, CHANNELS, PHASE, PILLARS, PIPELINE, STORIES, VOICE, WHY, guide } from "../lib/guide/content.ts";
import { mergeBoard, youtubeThumb } from "../lib/guide/inspiration.ts";
import type { Inspiration } from "../lib/inspiration.ts";
import { groupWeeks, planStart, planWindow, thumbsFor, type PlanItem } from "../lib/guide/plan.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("guide content: four pillars whose shares add to 100, each with real examples and a contrast", () => {
  assert.deepEqual(PILLARS.map((p) => p.slug), ["proof", "perspective", "build", "lists"]);
  assert.equal(PILLARS.reduce((n, p) => n + p.share, 0), 100);
  for (const p of PILLARS) {
    assert.ok(p.examples.length >= 2, `${p.slug} has at least two real posts`);
    assert.ok(p.contrasts.length >= 1, `${p.slug} has a great-vs-weak contrast`);
    if (p.dial) assert.equal(p.dial.operator + p.dial.soul, 100);
  }
  assert.ok(PILLARS.find((p) => p.slug === "proof")?.speaks_as);
});

test("guide content: every chapter is populated", () => {
  assert.equal(STORIES.length, 5);
  assert.ok(WHY.wall.length >= 4);
  assert.ok(VOICE.banned_words.includes("leverage"));
  assert.ok(ASSETS.some((a) => a.slug === "carousels") && ASSETS.some((a) => a.slug === "motion"));
  assert.ok(PIPELINE.length >= 6);
  assert.deepEqual(Object.keys(guide()).sort(), ["assets", "channels", "inspiration", "personal", "phase", "pillars", "pipeline", "regenera", "signals", "stories", "version", "voice", "why"]);
});

test("guide content: editing guidance pairs a Do and a Don't with John's own line (2026-10-13)", () => {
  assert.ok((VOICE.editing?.items.length ?? 0) >= 5);
  for (const e of VOICE.editing!.items) {
    assert.ok(e.do && e.dont && e.before, "each item has a Do, a Don't and the agent's line");
    assert.equal(e.after.source, "", "synthetic examples never cite private sources");
  }
});

test("guide content: each pillar names its funnel role, awareness job and leading metric (VIB-422)", () => {
  const roles = Object.fromEntries(PILLARS.map((p) => [p.slug, p.funnel_role]));
  // STRATEGY.md funnel layer: Perspective and Lists reach, The Build shows how we think, Proof starts conversations.
  assert.deepEqual(roles, { proof: "conversation", perspective: "reach", build: "how_we_think", lists: "reach" });
  for (const p of PILLARS) {
    assert.ok(p.awareness_job.length > 20, `${p.slug} says what it is for in the awareness phase`);
    assert.ok(["conversations", "reach", "comments", "saves_sends"].includes(p.leading_metric.key), `${p.slug} leading metric`);
    assert.ok(p.leading_metric.label);
  }
  assert.equal(PHASE.slug, "awareness");
  assert.ok(PHASE.label);
  assert.deepEqual(PHASE.success.map((s) => s.key), ["conversations", "saves_sends", "net_followers"]);
  assert.equal(Object.values(PHASE.funnel_mix).reduce((a, b) => a + b, 0), 100);
  assert.ok(PHASE.rules.length > 0);
});

test("guide content: the channel link rules are the ones John set", () => {
  const rule = (slug: string) => CHANNELS.channels.find((c) => c.slug === slug)?.link_rule ?? "";
  assert.ok(rule("instagram"));
  assert.ok(rule("linkedin"));
  assert.ok(rule("youtube"));
  // John, 2026-10-06: there is no "no two videos in a row" rule; we design for engagement.
  assert.ok(!CHANNELS.format_mix.some((r) => /two video posts in a row/i.test(r)));
});

test("guide-check: quotes match their sources, media keys exist, no em dashes", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/guide-check.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("gtm guide: whole guide, one section and one item, as JSON", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "cli/gtm.ts"), "guide", ...args, "--json"], {
    encoding: "utf8", cwd: ROOT, env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "gtm-guide-")), GTM_SKIP_ENV_FILES: "1", NODE_ENV: "test" },
  });
  const all = run();
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(all.stdout).version, 1);
  const proof = run("pillars", "proof");
  assert.equal(JSON.parse(proof.stdout).name, "Proof");
  const ig = run("channels", "instagram");
  assert.ok(JSON.parse(ig.stdout).link_rule);
  const phase = run("phase");
  assert.equal(JSON.parse(phase.stdout).slug, "awareness");
  const bad = run("nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown section/);
});

test("plan: starts on this week's Monday, or next Monday at the weekend", () => {
  assert.equal(planStart("2026-10-07"), "2026-10-05"); // Wednesday
  assert.equal(planStart("2026-10-04"), "2026-10-05"); // Sunday
  assert.equal(planStart("2026-10-03"), "2026-10-05"); // Saturday
  assert.deepEqual(planWindow("2026-10-04"), { from: "2026-10-05", to: "2026-12-13" });
});

test("plan: one piece fanned out to several channels is one entry", () => {
  const item = (id: string, channel: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, date: "2026-10-06", time: "09:00", pillar: "proof", format: "video", channels: [channel], status: "drafted", title: "Teaser", ...extra });
  const weeks = groupWeeks([item("a-li", "linkedin"), item("a-ig", "instagram", { status: "approved" }), item("b", "linkedin", { title: "Other", date: "2026-10-08" }), item("old", "linkedin", { date: "2026-09-01" })], "2026-10-04");
  assert.equal(weeks.length, 10);
  const tue = weeks[0].days[1];
  assert.equal(tue.entries.length, 1);
  assert.deepEqual(tue.entries[0].channels, ["linkedin", "instagram"]);
  assert.deepEqual(tue.entries[0].statuses, ["drafted", "approved"]);
  assert.equal(weeks[0].count, 2);
  assert.equal(weeks.reduce((n, w) => n + w.count, 0), 2, "items outside the window are dropped");
});

test("plan: thumbnail candidates are images first, then Story video posters; PDFs have none", () => {
  assert.deepEqual(thumbsFor(["stories/s1/v-abc.mp4", "calendar/x/deck.pdf", "calendar/x/slide-01.png"]), ["calendar/x/slide-01.png", "stories/s1/v-abc-poster.jpg"]);
  assert.deepEqual(thumbsFor(["calendar/x/deck.pdf"]), []);
  assert.deepEqual(thumbsFor(null), []);
});

test("inspiration: YouTube thumbnails", () => {
  assert.equal(youtubeThumb("https://www.youtube.com/watch?v=YsZ-lx_3eoM"), "https://i.ytimg.com/vi/YsZ-lx_3eoM/hqdefault.jpg");
  assert.equal(youtubeThumb("https://example.com"), null);
});

test("inspiration: featured seed first, a saved copy of a seed stays curated, new rows follow", () => {
  const seeds = [
    { url: "https://a", title: "A", kind: "video" as const, platform: "youtube", pillar: null, tags: [], why_we_like: "a", featured: true },
    { url: "https://b", title: "B", kind: "post" as const, platform: "x", pillar: null, tags: [], why_we_like: "b", image_url: "https://img/b" },
  ];
  const row = (url: string, created_at: string): Inspiration => ({ id: url, kind: "post", url, title: "", platform: null, tags: [], why_we_like: "w", thumbnail_path: "https://thumb", pillar: null, added_by: null, created_at });
  const board = mergeBoard(seeds, [row("https://new", "2026-10-04"), row("https://b", "2026-10-01")]);
  assert.deepEqual(board.map((b) => b.url), ["https://a", "https://new", "https://b"]);
  assert.equal(board[2].source, "curated");
  assert.equal(board[2].image_url, "https://img/b");
  assert.equal(board[1].source, "added");
  assert.equal(board[1].title, "https://new");
  assert.equal(board[1].image_url, "https://thumb");
});
