// Contract tests: the real `gtm` CLI in a subprocess, against a temp calendar, with every external
// service (Zernio, Twenty, Wise, Supabase) answered by test/support/fetch-mock.ts. An unmocked
// request throws inside the CLI, so nothing here can reach a live service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Call, Route } from "./support/fetch-mock.ts";
import { addDays, isoWeek } from "../lib/week.ts";
import { mp4 } from "./support/mp4.ts";
import { png } from "./support/image";
const CARD = png({ note: "card" });

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOCK = fileURLToPath(new URL("./support/fetch-mock.ts", import.meta.url));
const Z = "https://zernio.test/api/v1";
const REST = "https://db.test/rest/v1/";
const TZ = "Europe/Berlin";

/** Wall-clock date and HH:MM in the calendar timezone, `minutes` from now. */
function at(minutes: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(Date.now() + minutes * 60_000)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const FUTURE = at(60 * 24 * 30);
/** The UTM campaign label for FUTURE (ISO week), computed so these tests do not rot every week. */
const FUTURE_WEEK = (() => { const w = isoWeek(FUTURE.date); return `${w.year}-w${String(w.week).padStart(2, "0")}`; })();

type Entry = { id: string; format?: string; noCopy?: boolean; status?: string; week?: number; date?: string; time?: string; channels?: string[]; copy?: string; media?: string[]; zernio_post_id?: string | null };
function calendarYaml(items: Entry[]) {
  const lines = ["# managed by the content engine; comments must survive every write", `timezone: ${TZ}`, "accounts:", "  linkedin: acc-li", "  youtube: acc-yt", "  instagram: acc-ig", "items:"];
  for (const i of items) {
    lines.push(`  - id: ${i.id} # keep`, `    week: ${i.week ?? 1}`, `    date: ${i.date ?? FUTURE.date}`, `    time: "${i.time ?? FUTURE.time}"`, "    pillar: proof", `    title: Title ${i.id}`,
      `    format: ${i.format ?? "text"}`, `    channels: [${(i.channels ?? ["linkedin"]).join(", ")}]`, ...(i.noCopy ? [] : [`    copy: ${i.copy ?? "copy.md"}`]), `    status: ${i.status ?? "approved"}`);
    if (i.media) lines.push(`    media: [${i.media.join(", ")}]`);
    if (i.zernio_post_id !== undefined) lines.push(`    zernio_post_id: ${i.zernio_post_id}`);
  }
  return lines.join("\n") + "\n";
}

type Run = { code: number | null; stdout: string; stderr: string; calls: Call[]; calendar: string; before: string; item: (id: string) => any; dir: string };
function gtm(args: string[], opts: { items?: Entry[]; calendar?: string; routes?: Route[]; files?: Record<string, string | Buffer>; env?: Record<string, string>; keep?: boolean } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "gtm-cli-"));
  const cal = join(dir, "calendar.yaml");
  const before = opts.calendar ?? calendarYaml(opts.items ?? []);
  writeFileSync(cal, before);
  for (const [f, body] of Object.entries({ "copy.md": "Hello from the calendar.", ...opts.files })) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  const routes = (opts.routes ?? []).map((r) => (r.snapshot === "calendar" ? { ...r, snapshot: cal } : r));
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  const log = join(dir, "calls.jsonl");
  const res = spawnSync(process.execPath, ["--import", "tsx", "--import", MOCK, join(ROOT, "cli/gtm.ts"), ...args.map((a) => a.replace("{dir}", dir))], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: dir, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE, GTM_SKIP_ENV_FILES: "1", GTM_CALENDAR_SOURCE: "file",
      GTM_CALENDAR: cal, GTM_FETCH_MOCK: join(dir, "routes.json"), GTM_FETCH_LOG: log, GTM_ENRICHMENT_DIR: join(dir, "enrichment"),
      ZERNIO_API_URL: Z, ZERNIO_API_KEY: "zk_test", NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
      TWENTY_BASE: "https://twenty.test", TWENTY_API_KEY: "tw_test", WISE_API_TOKEN: "wise_test", WISE_PROFILE_ID: "42",
      WISE_PRIVATE_KEY_PATH: join(dir, "missing.pem"), GTM_WORKSPACE: dir, ...opts.env,
    } as unknown as NodeJS.ProcessEnv,
  });
  const calendar = readFileSync(cal, "utf8");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, calls, calendar, before, dir, item: (id) => (parse(calendar).items as any[]).find((i) => i.id === id) };
}
const created = (id = "z-1") => ({ method: "POST", url: `${Z}/posts`, json: { post: { _id: id, status: "scheduled", platforms: [] }, warnings: [] }, snapshot: "calendar" }) satisfies Route;
const body = (c: Call) => JSON.parse(c.body ?? "null");

test("schedule: exact Zernio request, pending marker written first, then scheduled + post id; comments kept; IG never gets a linked first comment", () => {
  const r = gtm(["schedule", "w1-a"], {
    items: [{ id: "w1-a", channels: ["linkedin", "instagram", "newsletter"], media: ["img/card.png"] }],
    files: { "copy.md": "---\nfirst_comment: https://brand.example.com/x\n---\nBase copy.\n--- channel: instagram ---\nIG copy #ai", "img/card.png": CARD },
    routes: [
      { method: "POST", url: `${Z}/media/presign`, json: { uploadUrl: "https://r2.test/put/1", publicUrl: "https://cdn.test/card.png" } },
      { method: "PUT", url: "https://r2.test/put/1", status: 200 },
      created("z-1"),
    ],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`), [`POST ${Z}/media/presign`, "PUT https://r2.test/put/1", `POST ${Z}/posts`]);
  assert.deepEqual(body(r.calls[0]), { filename: "card.png", contentType: "image/png", size: CARD.length });
  assert.equal(r.calls[1].headers["content-type"], "image/png");
  assert.deepEqual(Buffer.from(r.calls[1].body!, "base64"), CARD);
  const post = r.calls[2];
  assert.equal(post.headers["idempotency-key"], "gtm-w1-a");
  assert.equal(post.headers.authorization, "Bearer zk_test");
  assert.equal(post.headers["content-type"], "application/json");
  assert.deepEqual(body(post), {
    content: "Base copy.",
    platforms: [
      // Our own links carry UTM tags (lib/utm.ts): platform, social, the ISO week of the date, the item id.
      { platform: "linkedin", accountId: "acc-li", platformSpecificData: { firstComment: "https://brand.example.com/x?utm_source=linkedin&utm_medium=social&utm_campaign=" + FUTURE_WEEK + "&utm_content=w1-a" } },
      { platform: "instagram", accountId: "acc-ig", customContent: "IG copy #ai" },
    ],
    timezone: TZ, scheduledFor: `${FUTURE.date}T${FUTURE.time}:00`,
    mediaItems: [{ type: "image", url: "https://cdn.test/card.png" }],
    metadata: { calendarId: "w1-a" },
  });
  assert.equal((parse(post.snapshot!).items as any[])[0].zernio_post_id, "pending", "pending is on disk while the post is created");
  assert.deepEqual([r.item("w1-a").status, r.item("w1-a").zernio_post_id], ["scheduled", "z-1"]);
  assert.ok(r.calendar.includes("# managed by the content engine") && r.calendar.includes("# keep"));
  assert.deepEqual(JSON.parse(r.stdout), [{
    id: "w1-a", zernioPostId: "z-1", zernioStatus: "scheduled", scheduledFor: `${FUTURE.date}T${FUTURE.time}:00`, draft: false,
    warnings: ["w1-a: instagram does not get first_comment because it contains a link; LinkedIn and YouTube still receive it."],
  }]);
});

test("schedule: ig_story sends contentType story, no caption, instagram only", () => {
  const r = gtm(["schedule", "st-1", "--dry-run"], {
    items: [{ id: "st-1", format: "ig_story", channels: ["instagram"], noCopy: true, media: ["img/s.png"] }],
    files: { "img/s.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) },
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout)[0].body;
  assert.deepEqual(out.platforms, [{ platform: "instagram", accountId: "acc-ig", platformSpecificData: { contentType: "story" } }]);
  assert.equal(out.content, "");
  const bad = gtm(["schedule", "st-2", "--dry-run"], { items: [{ id: "st-2", format: "ig_story", channels: ["instagram", "linkedin"], noCopy: true }] });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /ig_story items must target instagram only/);
});

test("schedule: format document composes the page images into one PDF document", () => {
  const r = gtm(["schedule", "doc-1", "--dry-run"], {
    items: [{ id: "doc-1", format: "document", channels: ["linkedin"], media: ["a.png", "b.png"] }],
    files: { "copy.md": "Post.", "a.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]), "b.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  });
  assert.notEqual(r.code, 0, "invalid PNG bytes must fail PDF embedding, not be sent as images");
});

test("schedule --now publishes immediately and ignores a past calendar time", () => {
  const r = gtm(["schedule", "x", "--now"], {
    items: [{ id: "x", date: "2020-01-01", time: "08:30" }],
    routes: [{ method: "POST", url: `${Z}/posts`, json: { post: { _id: "z-now", status: "published", platforms: [{ platform: "linkedin", platformPostUrl: "https://www.linkedin.com/feed/update/1" }] }, warnings: [] }, snapshot: "calendar" }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].headers["idempotency-key"], "gtm-x-now");
  assert.deepEqual(body(r.calls[0]), {
    content: "Hello from the calendar.",
    platforms: [{ platform: "linkedin", accountId: "acc-li" }],
    timezone: TZ, publishNow: true, mediaItems: [], metadata: { calendarId: "x" },
  });
  assert.equal(r.item("x").status, "published");
  assert.equal(r.item("x").zernio_post_id, "z-now");
  assert.equal(r.item("x").urls.linkedin, "https://www.linkedin.com/feed/update/1");
});

test("schedule refuses anything not approved: no request, calendar untouched", () => {
  for (const status of ["idea", "drafted", "scheduled", "published", "failed", "skipped"]) {
    const r = gtm(["schedule", "x"], { items: [{ id: "x", status }], routes: [created()] });
    assert.equal(r.code, 1, status);
    assert.match(r.stderr, new RegExp(`x is ${status}; only approved items can be scheduled`));
    assert.equal(r.calls.length, 0);
    assert.equal(r.calendar, r.before);
  }
});

test("schedule --week picks only approved items in that season week, by date; --iso-week by calendar week", () => {
  // A season that starts on FUTURE.date: its week 1 holds FUTURE, week 2 holds FUTURE + 7 days. Stored weeks are noise.
  const season = { id: "season-x", title: "X", description: "", starts_on: FUTURE.date, ends_on: addDays(FUTURE.date, 60), pillars: [], created_at: "x", updated_at: "x" };
  const routes: Route[] = [{ method: "GET", url: REST + "gtm_seasons", json: [season] }];
  const next = addDays(FUTURE.date, 7);
  const items = [{ id: "a", week: 9 }, { id: "b", status: "drafted" }, { id: "c", week: 3 }, { id: "d", week: 1, date: next }, { id: "e", status: "scheduled", zernio_post_id: "old" }];
  const r = gtm(["schedule", "--week", "1", "--dry-run"], { items, routes });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x: any) => x.id), ["a", "c"]);
  const second = gtm(["schedule", "--week", "2", "--dry-run"], { items, routes });
  assert.deepEqual(JSON.parse(second.stdout).map((x: any) => x.id), ["d"]);
  const iso = gtm(["schedule", "--iso-week", String(isoWeek(next).week), "--dry-run"], { items });
  assert.equal(iso.code, 0, iso.stderr);
  assert.deepEqual(JSON.parse(iso.stdout).map((x: any) => x.id), ["d"]);
  assert.equal(iso.calls.length, 0, "--iso-week needs no season");
  const none = gtm(["schedule", "--week", "4"], { items, routes });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /nothing to schedule/);
  assert.ok(!none.calls.some((c) => c.method !== "GET"));
});

// The live Season 1 shape: stored weeks are ISO weeks (some wrong), ideas filed under 2027 weeks 1 to 6.
const S1 = { id: "season-1", title: "Season 1", description: "", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: [], created_at: "x", updated_at: "x" };
const S1_ITEMS = [
  { id: "orion-personal-substack", week: 40, date: "2026-10-04", time: "14:06", status: "scheduled" },
  { id: "monday-before-start", week: 41, date: "2026-10-05", time: "09:00", status: "drafted" },
  { id: "regenera-li-document", week: 40, date: "2026-10-06", time: "08:30", status: "scheduled" },
  { id: "week-two", week: 42, date: "2026-10-13", time: "14:00", status: "drafted" },
  { id: "last-day", week: 50, date: "2026-12-11", time: "14:00", status: "drafted" },
  { id: "idea-2027", week: 1, date: "2027-01-05", time: "18:00", status: "idea" },
];

test("plan --week 1 is Season 1's first week (the 2026-10-06 rows), the same as --iso-week 41; never 2027 week 1", () => {
  const ids = (r: Run) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout).items.map((i: any) => i.id); };
  const list = gtm(["plan", "--week", "1", "--json"], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: [S1] }] });
  assert.deepEqual(ids(list), ["monday-before-start", "regenera-li-document"]);
  assert.deepEqual(JSON.parse(list.stdout).week, { kind: "season", season: { id: "season-1", starts_on: "2026-10-06", ends_on: "2026-12-11" }, week: 1, from: "2026-10-05", to: "2026-10-11" });
  const named = gtm(["plan", "--week", "1", "--season", "season-1", "--json"], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: S1 }] });
  assert.deepEqual(ids(named), ["monday-before-start", "regenera-li-document"]);
  assert.match(named.calls[0].url, /id=eq\.season-1/);
  assert.deepEqual(ids(gtm(["plan", "--iso-week", "41", "--json"], { items: S1_ITEMS })), ["monday-before-start", "regenera-li-document"]);
  assert.deepEqual(ids(gtm(["plan", "--iso-week", "2026-W41", "--json"], { items: S1_ITEMS })), ["monday-before-start", "regenera-li-document"]);
  assert.deepEqual(ids(gtm(["plan", "--iso-week", "1", "--json"], { items: S1_ITEMS })), ["idea-2027"]);
  const last = gtm(["plan", "--week", "10", "--json"], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: [S1] }] });
  assert.deepEqual(ids(last), ["last-day"]);
  const human = gtm(["plan", "--week", "1"], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: [S1] }] });
  assert.match(human.stdout, /Week of 2026-10-05 \(season-1 week 1, ISO week 41\)/);
  for (const bad of [["--week", "11"], ["--week", "0"], ["--week", "1", "--iso-week", "41"], ["--iso-week", "54"], ["--season", "season-1"]]) {
    const r = gtm(["plan", ...bad], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: [S1] }] });
    assert.equal(r.code, 1, bad.join(" "));
  }
  assert.match(gtm(["plan", "--week", "11"], { items: S1_ITEMS, routes: [{ method: "GET", url: REST + "gtm_seasons", json: [S1] }] }).stderr, /give 1 to 10/);
});

test("schedule refuses past or under-5-minute times unless --allow-past", () => {
  for (const [label, when] of [["yesterday", at(-24 * 60)], ["2 minutes away", at(2)]] as const) {
    const r = gtm(["schedule", "x"], { items: [{ id: "x", ...when }], routes: [created()] });
    assert.equal(r.code, 1, label);
    assert.match(r.stderr, /in the past \(or under 5 min away\)/, label);
    assert.equal(r.calls.length, 0, label);
    assert.equal(r.calendar, r.before, label);
  }
  const soon = gtm(["schedule", "x"], { items: [{ id: "x", ...at(15) }], routes: [created()] });
  assert.equal(soon.code, 0, soon.stderr);
  const forced = gtm(["schedule", "x", "--allow-past"], { items: [{ id: "x", ...at(-24 * 60) }], routes: [created()] });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(forced.calls.length, 1);
});

test("a 4xx from Zernio proves nothing was created: pending is cleared", () => {
  const r = gtm(["schedule", "x"], { items: [{ id: "x" }], routes: [{ method: "POST", url: `${Z}/posts`, status: 422, json: { error: "bad" }, snapshot: "calendar" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Zernio 422 on \/posts/);
  assert.equal((parse(r.calls[0].snapshot!).items as any[])[0].zernio_post_id, "pending");
  assert.equal(r.item("x").zernio_post_id, null);
  assert.equal(r.item("x").status, "approved");
});

test("a 5xx or a network failure leaves pending, and the next run refuses to post again", () => {
  for (const route of [{ status: 502, body: "bad gateway" }, { error: "ETIMEDOUT" }]) {
    const r = gtm(["schedule", "x"], { items: [{ id: "x" }], routes: [{ method: "POST", url: `${Z}/posts`, ...route }] });
    assert.equal(r.code, 1);
    assert.equal(r.item("x").zernio_post_id, "pending", JSON.stringify(route));
    const again = gtm(["schedule", "x"], { calendar: r.calendar, routes: [created()] });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /zernio_post_id: pending/);
    assert.equal(again.calls.length, 0);
  }
});

test("a 2xx without a post id is left pending for a human to check", () => {
  const r = gtm(["schedule", "x"], { items: [{ id: "x" }], routes: [{ method: "POST", url: `${Z}/posts`, json: { message: "queued" } }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /returned no post id \(left as pending/);
  assert.equal(r.item("x").zernio_post_id, "pending");
});

test("schedule refuses an item that already has a Zernio post", () => {
  const r = gtm(["schedule", "x"], { items: [{ id: "x", zernio_post_id: "z-9" }], routes: [created()] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already has Zernio post z-9/);
  assert.equal(r.calls.length, 0);
});

test("--dry-run makes no request, uploads nothing and writes nothing", () => {
  const r = gtm(["schedule", "x", "--dry-run"], {
    items: [{ id: "x", channels: ["youtube"], media: ["clip.mp4"] }],
    files: { "copy.md": "---\nyoutube_title: Six weeks\nyoutube_tags: ai, ops ,\nyoutube_category: Science & Technology\n---\nDescription", "clip.mp4": "not really a video" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  assert.equal(r.calendar, r.before);
  const [out] = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.body.platforms, [{ platform: "youtube", accountId: "acc-yt", platformSpecificData: { title: "Six weeks", visibility: "public", madeForKids: false, categoryId: "28" } }]);
  assert.deepEqual(out.body.tags, ["ai", "ops"]);
  assert.match(out.body.mediaItems[0].url, /^file:\/\/.*clip\.mp4$/);
  assert.equal(out.body.mediaItems[0].type, "video");
});

test("schedule --dry-run: instagram_thumb_offset_ms becomes Instagram's thumbOffset only", () => {
  const r = gtm(["schedule", "x", "--dry-run"], {
    items: [{ id: "x", channels: ["instagram", "linkedin"], media: ["clip.mp4"] }],
    files: { "copy.md": "---\ninstagram_thumb_offset_ms: 500\n---\nA clip.", "clip.mp4": "not really a video" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  const [out] = JSON.parse(r.stdout);
  assert.deepEqual(out.body.platforms, [
    { platform: "instagram", accountId: "acc-ig", platformSpecificData: { thumbOffset: 500 } },
    { platform: "linkedin", accountId: "acc-li" },
  ]);
});

for (const bad of ["-500", "1.5", "half"]) {
  test(`schedule rejects instagram_thumb_offset_ms: ${bad}`, () => {
    const r = gtm(["schedule", "x", "--dry-run"], {
      items: [{ id: "x", channels: ["instagram"], media: ["clip.mp4"] }],
      files: { "copy.md": `---\ninstagram_thumb_offset_ms: ${bad}\n---\nA clip.`, "clip.mp4": "not really a video" },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /instagram_thumb_offset_ms must be a non-negative integer/);
    assert.equal(r.calls.length, 0);
  });
}

test("schedule --dry-run: a block-scalar first_comment reaches the LinkedIn payload as its text, not \"|-\"", () => {
  const r = gtm(["schedule", "li", "--dry-run"], {
    items: [{ id: "li", channels: ["linkedin"] }],
    files: { "copy.md": "---\nstatus: drafted\nfirst_comment: |-\n  The full essay, with the three loops:\n\n  https://brand.example.com/essays/loops\n---\nPost body without a link." },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  const [out] = JSON.parse(r.stdout);
  assert.deepEqual(out.body.platforms, [{
    platform: "linkedin", accountId: "acc-li",
    platformSpecificData: { firstComment: "The full essay, with the three loops:\n\nhttps://brand.example.com/essays/loops?utm_source=linkedin&utm_medium=social&utm_campaign=" + FUTURE_WEEK + "&utm_content=li" },
  }]);
  assert.equal(out.body.content, "Post body without a link.");
});

test("--draft creates a Zernio draft under its own idempotency key and leaves the calendar untouched", () => {
  const ok = gtm(["schedule", "x", "--draft"], { items: [{ id: "x" }], routes: [created("draft-1")] });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.calls[0].headers["idempotency-key"], "gtm-x-draft");
  assert.equal(body(ok.calls[0]).isDraft, true);
  assert.equal(ok.calls[0].snapshot, ok.before, "no pending marker for a draft");
  assert.equal(ok.calendar, ok.before);
  assert.equal(JSON.parse(ok.stdout)[0].draft, true);
  const failed = gtm(["schedule", "x", "--draft"], { items: [{ id: "x" }], routes: [{ method: "POST", url: `${Z}/posts`, status: 400, body: "no" }] });
  assert.equal(failed.code, 1);
  assert.equal(failed.calendar, failed.before);
});

test("schedule refuses manual-only items and unmapped channels before any request", () => {
  const manual = gtm(["schedule", "x"], { items: [{ id: "x", channels: ["newsletter"] }], routes: [created()] });
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /only targets manual channels/);
  const unmapped = gtm(["schedule", "x"], { items: [{ id: "x", channels: ["tiktok"] }], routes: [created()] });
  assert.equal(unmapped.code, 1);
  assert.match(unmapped.stderr, /no Zernio account mapped for channel tiktok/);
  assert.equal(manual.calls.length + unmapped.calls.length, 0);
});

test("sync --only accepts exactly the five parts and rejects anything else before doing work", () => {
  for (const only of ["bogus", "status,bogus", "accounts", "schedule"]) {
    const r = gtm(["sync", "--only", only], { items: [{ id: "x" }] });
    assert.equal(r.code, 1, only);
    assert.match(r.stderr, /unknown sync part .* \(allowed: status, stats, crm, enrichment, costs\)/, only);
    assert.equal(r.calls.length, 0, only);
  }
});

test("sync exits 1 when any part errors, and still runs the others", () => {
  const r = gtm(["sync", "--only", "enrichment,crm"], {
    items: [{ id: "x" }],
    routes: [
      { method: "POST", url: REST + "gtm_enrichment_runs", status: 201 },
      { method: "POST", url: "https://twenty.test/graphql", status: 500, json: { errors: [{ message: "down" }] } },
    ],
  });
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.enrichment, { runs: 0 });
  assert.match(out.crm.error, /Twenty: .*down/);
  const ok = gtm(["sync", "--only", "enrichment"], { items: [{ id: "x" }], routes: [{ method: "POST", url: REST + "gtm_enrichment_runs", status: 201 }] });
  assert.equal(ok.code, 0, ok.stderr);
});

test("status mirrors the calendar, then writes Zernio outcomes back into calendar.yaml", () => {
  const r = gtm(["status"], {
    items: [{ id: "pub", status: "scheduled", zernio_post_id: "p1" }, { id: "gone", status: "scheduled", zernio_post_id: "p2" }],
    routes: [
      { method: "POST", url: REST + "gtm_content_items", status: 201 },
      {method:"GET",url:REST+"gtm_piece_deliveries",json:[]},{method:"GET",url:REST+"gtm_piece_delivery_attempts",json:[]},
      // Answers both the mirror's id listing and syncStatus's open-items query.
      { method: "GET", url: REST + "gtm_content_items", json: [{ id: "pub", zernio_post_id: "p1", status: "scheduled" }, { id: "gone", zernio_post_id: "p2", status: "scheduled" }] },
      { method: "GET", url: `${Z}/posts/p1`, json: { post: { _id: "p1", status: "published", platforms: [{ platform: "linkedin", accountId: "a", platformPostUrl: "https://li/p1", publishedAt: "2026-10-06T06:30:00.000Z" }] } } },
      { method: "GET", url: `${Z}/posts/p2`, status: 404, body: "" },
      { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
    ],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.item("pub").status, r.item("pub").urls, r.item("pub").published_at], ["published", { linkedin: "https://li/p1" }, "2026-10-06T06:30:00.000Z"]);
  assert.deepEqual([r.item("gone").status, r.item("gone").zernio_post_id], ["failed", null]);
  assert.ok(r.calendar.includes("# keep"));
});

test("push on an empty calendar is skipped with zero requests", () => {
  const r = gtm(["push"], { calendar: "timezone: Europe/Berlin\nitems: []\n" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).skipped, "calendar has no items");
  assert.equal(r.calls.length, 0);
});

test("check reports missing files, unmapped channels and em dashes with exit 1", () => {
  const r = gtm(["check", "--json"], {
    items: [{ id: "a", copy: "missing.md" }, { id: "b", channels: ["tiktok"] }, { id: "c", copy: "dash.md", media: ["nope.png", "https://cdn.test/ok.png"] }],
    files: { "dash.md": "One — two" },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stdout), { items: 3, problems: ["a: copy missing missing.md", "b: no account for tiktok", "c: media missing nope.png", "c: em dash in copy"], warnings: [] });
  const clean = gtm(["check"], { items: [{ id: "a" }] });
  assert.equal(clean.code, 0, clean.stdout);
});

test("channel link rules: a URL in an Instagram caption or a LinkedIn body fails check and schedule, before any request", () => {
  const items = [{ id: "ig", channels: ["instagram"], copy: "ig.md" }, { id: "li", channels: ["linkedin"], copy: "li.md" }, { id: "ok", channels: ["linkedin", "instagram"], copy: "ok.md" }];
  const files = {
    "ig.md": "New case study: brand.example.com/case-studies/orion",
    "li.md": "Read more at https://brand.example.com/orion",
    "ok.md": "---\nfirst_comment: https://brand.example.com/orion\n---\nNo links here, write to user-f538cb95fc21@example.com",
  };
  const r = gtm(["check", "--json"], { items, files });
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.problems, [
    "ig: instagram caption contains a link (brand.example.com/case-studies/orion). Instagram captions never carry links; remove it (point to the bio instead).",
    "li: linkedin body contains a link (https://brand.example.com/orion). Move it to first_comment frontmatter; Zernio posts that as the first comment.",
  ]);
  assert.deepEqual(out.warnings, ["ok: instagram does not get first_comment because it contains a link; LinkedIn and YouTube still receive it."]);
  for (const id of ["ig", "li"]) {
    const s = gtm(["schedule", id], { items, files, routes: [created()] });
    assert.equal(s.code, 1, id);
    assert.match(s.stderr, new RegExp(`${id}: (instagram caption|linkedin body) contains a link`));
    assert.equal(s.calls.length, 0, "refused before any upload or Zernio call");
    assert.equal(s.calendar, s.before);
  }
  const ok = gtm(["schedule", "ok", "--dry-run"], { items, files });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout)[0].body.platforms, [
    { platform: "linkedin", accountId: "acc-li", platformSpecificData: { firstComment: "https://brand.example.com/orion?utm_source=linkedin&utm_medium=social&utm_campaign=" + FUTURE_WEEK + "&utm_content=ok" } },
    { platform: "instagram", accountId: "acc-ig" },
  ]);
});

test("check: YouTube link advice is a warning, never a failure", () => {
  const r = gtm(["check", "--json"], {
    items: [{ id: "yt", channels: ["youtube"], copy: "yt.md", media: ["teaser-9x16.mp4"] }],
    files: { "yt.md": "---\nyoutube_title: Orion\n---\nWatch the case study: https://brand.example.com/orion", "teaser-9x16.mp4": Buffer.from([0]) },
  });
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.problems, []);
  assert.match(out.warnings[0], /^yt: youtube video is vertical\/square and 3 min or less, so it publishes as a Short/);
});

test("check and schedule reject an escaped-quote time (the Orion \"15:00\" bug)", () => {
  const r = gtm(["check", "--json"], { items: [{ id: "a", time: '\\"15:00\\"' }] });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stdout).problems, ['a: bad time "\\"15:00\\"" (expected HH:MM, 24h, written as time: "15:00")']);
  const s = gtm(["schedule", "a", "--dry-run", "--allow-past"], { items: [{ id: "a", time: '\\"15:00\\"' }] });
  assert.equal(s.code, 1);
  assert.match(s.stderr, /a: bad time/);
  assert.equal(s.calls.length, 0);
});

test("costs --dry-run reads Wise only and writes nothing to the cockpit", () => {
  const r = gtm(["costs", "--dry-run", "--since", "2026-09-01"], {
    routes: [
      { method: "GET", url: "https://api.wise.com/v4/profiles/42/balances", json: [{ id: 1, currency: "EUR" }] },
      { method: "GET", url: "https://api.wise.com/v1/profiles/42/balance-statements/1/", json: { transactions: [
        { referenceNumber: "CARD-7", date: "2026-09-02T00:00:00Z", amount: { value: -18 }, details: { type: "CARD", description: "x", merchant: { name: "Vercel Inc", category: "Computer Programming" } } },
      ] } },
    ],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.wise.com/")));
  assert.deepEqual(JSON.parse(r.stdout), [{ id: "CARD-7:EUR", date: "2026-09-02", currency: "EUR", amount: 18, amount_eur: 18, merchant: "Vercel Inc", vendor: "Vercel", category: "infra", gtm: false }]);
});

test("unknown commands print help and exit 1; no command exits 0", () => {
  const bad = gtm(["frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /^gtm <command>/);
  assert.equal(gtm([]).code, 0);
});

test("accounts and plan print human output; plan flags overdue items", () => {
  const acc = gtm(["accounts"], { routes: [{ url: `${Z}/accounts`, json: { hasAnalyticsAccess: false, accounts: [{ _id: "acc-li", platform: "linkedin", username: "john", isActive: true, needsReconnection: true, followersCount: 5 }] } }] });
  assert.equal(acc.code, 0, acc.stderr);
  assert.match(acc.stdout, /analytics access: false\nlinkedin\s+john\s+5 followers\s+acc-li\s+NEEDS RECONNECT/);
  const past = at(-3 * 24 * 60);
  const plan = gtm(["plan", "--iso-week", String(isoWeek(past.date).week)], { items: [{ id: "late", ...past, status: "drafted" }, { id: "done", ...past, status: "published" }, { id: "w2", week: isoWeek(past.date).week }] });
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /Week of \d{4}-\d{2}-\d{2} \(ISO week \d+\)\n.*late\s+Title late\s+OVERDUE\n.*done\s+Title done\n$/);
  assert.doesNotMatch(plan.stdout, /w2/);
  const json = gtm(["plan", "--json"], { items: [{ id: "late", ...at(-3 * 24 * 60), status: "drafted" }] });
  assert.deepEqual(JSON.parse(json.stdout).overdue, ["late"]);
  assert.equal(plan.calls.length + json.calls.length, 0);
});

test("enrichment pushes every run's progress.json with the column mapping", () => {
  const r = gtm(["enrichment"], {
    files: { "enrichment/run-a/progress.json": JSON.stringify({ status: "complete", selected: 10, submitted: 9, returned: 8, noResult: 1, saved: 7, conflicted: 1, failed: 0, creditsConsumed: 42, at: "2026-09-01T00:00:00Z" }), "enrichment/no-progress/other.json": "{}" },
    routes: [{ method: "POST", url: REST + "gtm_enrichment_runs", status: 201 }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.calls[0].body!), [{ run: "run-a", status: "complete", selected: 10, submitted: 9, returned: 8, no_result: 1, saved: 7, conflicted: 1, failed: 0, credits: 42, cap_usd: null, at: "2026-09-01T00:00:00Z" }]);
});

test("crm prints the funnel and stores the snapshot", () => {
  const r = gtm(["crm"], { routes: [
    { url: "https://twenty.test/graphql", json: { data: { people: { totalCount: 3 }, companies: { totalCount: 1 }, messages: { totalCount: 0 }, opportunities: { edges: [{ node: { stage: "SIGNED" } }] } } } },
    { method: "POST", url: REST + "gtm_crm_snapshots", status: 201 },
  ] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^people\s+3$/m);
  assert.match(r.stdout, /opportunities { SIGNED: 1 }/);
});

test("crm --json carries the meeting capture block; capture objects absent in Twenty means not installed, exit 0", () => {
  const data = { people: { totalCount: 3 }, companies: { totalCount: 1 }, messages: { totalCount: 0 }, opportunities: { edges: [] }, notes: { totalCount: 2 } };
  const routes = [
    // 9 funnel counts + companies + messages + opportunities + the capture notes count, then the capture objects.
    { url: "https://twenty.test/graphql", times: 13, json: { data } },
    { url: "https://twenty.test/graphql", status: 400, json: { errors: [{ message: 'Cannot query field "meetingProposals" on type "Query".' }] } },
    { method: "POST", url: REST + "gtm_crm_snapshots", status: 201 },
  ];
  const r = gtm(["crm", "--json"], { routes });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.meeting_capture.installed, false);
  assert.equal(out.meeting_capture.notes7d, 2);
  assert.deepEqual(out.meeting_capture.missing.sort(), ["meetingCaptureRun", "meetingProposal"]);
  const stored = JSON.parse(r.calls.at(-1)!.body!);
  assert.equal(stored.metrics.meeting_capture.installed, false);
  const human = gtm(["crm"], { routes });
  assert.match(human.stdout, /^meeting capture\s+not installed \(meetingProposal, meetingCaptureRun\)$/m);
});

test("gtm review is retired and points to /content and gtm story", () => {
  for (const args of [["review"], ["review", "status"], ["review", "publish", "x/round-1"]]) {
    const r = gtm(args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gtm review was retired: John reviews content at \/content/);
    assert.match(r.stderr, /gtm story feedback/);
  }
  const help = gtm([]).stdout;
  assert.doesNotMatch(help, /^  review /m, "no review command in the help");
  assert.match(help, /review happens in \/content/);
});

test("story stage --dry-run hashes local files and writes nothing", () => {
  const r = gtm(["story", "stage", "{dir}/story.yaml", "--dry-run"], {
    items: [{ id: "x" }],
    files: { "copy.md": "Story copy", "story.yaml": "id: fx\ntitle: Fixture\nlink: https://example.com/fx\nassets:\n  - { id: copy, title: Copy, kind: copy, source: copy.md, channels: [linkedin] }\n  - { id: link, title: Link, kind: link, source: https://example.com/fx, channels: [linkedin] }\n" },
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.assets.map((a: any) => [a.id, a.kind, a.bytes]), [["copy", "copy", 10], ["link", "link", 22]]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.calendar, r.before);
});

test("story stage --stage marks the media's stage (not a positional), overriding the manifest; text never gets one", () => {
  const files = {
    "copy.md": "Story copy", "cut.mp4": mp4({ payload: "rough cut" }),
    "story.yaml": "id: fx\ntitle: Fixture\nlink: https://example.com/fx\nstage: rough-cut\nassets:\n  - { id: video, title: Video, kind: video, source: cut.mp4, channels: [youtube] }\n  - { id: copy, title: Copy, kind: copy, source: copy.md, channels: [youtube] }\n",
  };
  const manifest = gtm(["story", "stage", "{dir}/story.yaml", "--dry-run"], { items: [{ id: "x" }], files });
  assert.equal(manifest.code, 0, manifest.stderr);
  assert.deepEqual(JSON.parse(manifest.stdout).assets.map((a: any) => [a.id, a.stage]), [["video", "rough-cut"], ["copy", undefined]]);
  const final = gtm(["story", "stage", "{dir}/story.yaml", "--stage", "final", "--dry-run"], { items: [{ id: "x" }], files });
  assert.equal(final.code, 0, final.stderr);
  assert.deepEqual(JSON.parse(final.stdout).assets.map((a: any) => [a.id, a.stage]), [["video", "final"], ["copy", undefined]]);
  assert.equal(final.calls.length, 0);
  const bad = gtm(["story", "stage", "{dir}/story.yaml", "--stage", "Rough Cut", "--dry-run"], { items: [{ id: "x" }], files });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /invalid stage "Rough Cut"/);
});

// ---- gtm season ----------------------------------------------------------------------------------------

const SEASON_ROW = { id: "season-1", title: "Season 1", description: "old", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: ["build", "proof"], created_at: "x", updated_at: "x" };

test("gtm season prints the overview and analysis as JSON, from the season rows and the calendar", () => {
  const r = gtm(["season", "season-1", "--json"], {
    items: [{ id: "a", date: "2026-10-13", status: "drafted" }],
    routes: [
      { method: "GET", url: REST + "gtm_seasons", json: SEASON_ROW },
      { method: "GET", url: REST + "gtm_stories", json: [] },
    ],
  });
  assert.equal(r.code, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  assert.equal(a.seasonId, "season-1");
  assert.equal(a.pipeline.pieces, 1);
  assert.equal(a.pipeline.unstagedCards, 1);
  assert.equal(a.dateRange.weeks, 10);
  assert.ok(a.checks.some((c: { id: string }) => c.id === "not-staged"));
});

test("gtm season prints a readable report without --json", () => {
  const r = gtm(["season", "season-1"], { items: [{ id: "a", date: "2026-10-13", status: "drafted" }], routes: [{ method: "GET", url: REST + "gtm_seasons", json: SEASON_ROW }, { method: "GET", url: REST + "gtm_stories", json: [] }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Season 1 {2}\(season-1\)/);
  assert.match(r.stdout, /PIPELINE/);
  assert.match(r.stdout, /PILLAR MIX/);
});

test("gtm season fails plainly for an unknown season", () => {
  const r = gtm(["season", "nope"], { items: [], routes: [{ method: "GET", url: REST + "gtm_seasons", json: null }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no season "nope"/);
});

test("gtm season set validates, then updates only the given fields", () => {
  const routes: Route[] = [{ method: "GET", url: REST + "gtm_seasons", json: SEASON_ROW }, { method: "PATCH", url: REST + "gtm_seasons", json: { ...SEASON_ROW, title: "New title" } }];
  const ok = gtm(["season", "set", "season-1", "--title", " New title ", "--pillars", "proof,lists,proof"], { items: [], routes });
  assert.equal(ok.code, 0, ok.stderr);
  const patch = ok.calls.find((c) => c.method === "PATCH")!;
  const body = JSON.parse(patch.body!);
  assert.equal(body.title, "New title");
  assert.deepEqual(body.pillars, ["lists", "proof"]);
  assert.equal(body.description, "old");
  assert.equal(body.starts_on, "2026-10-06");
  for (const bad of [["--ends", "2026-10-01"], ["--starts", "2026-02-30"], ["--pillars", "proof,vibes"], ["--title", " "]]) {
    const r = gtm(["season", "set", "season-1", ...bad], { items: [], routes });
    assert.equal(r.code, 1, bad.join(" "));
    assert.ok(!r.calls.some((c) => c.method === "PATCH"), `${bad.join(" ")} must not write`);
  }
  const none = gtm(["season", "set", "season-1"], { items: [], routes });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /nothing to change/);
});

test("calendar export quotes times (a YAML 1.1 reader keeps \"14:00\" as text) and writes the week from the date", () => {
  const row = {
    id: "regenera-li-document", week: 40, date: "2026-10-06", time: "14:00", pillar: "proof", title: "t", format: "text", channels: ["linkedin"], status: "drafted",
    link: null, cta: null, zernio_post_id: null, published_at: null, urls: {}, story_id: null, story_assets: [], publication: null,
    body: "b", media: [], approved_hash: null, copy_path: null,
  };
  const r = gtm(["calendar", "export"], { env: { GTM_CALENDAR_SOURCE: "db" }, routes: [{ method: "GET", url: REST + "gtm_content_items", json: [row] }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /time: "14:00"/);
  const item = parse(r.stdout, { version: "1.1" }).items[0];
  assert.equal(item.time, "14:00");
  assert.equal(item.week, 41);
});

test("gtm pipeline prints every format's stages; one format as JSON; an unknown one fails plainly", () => {
  const all = gtm(["pipeline"]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /^short: Short$/m);
  assert.match(all.stdout, /paper-edit\s+agent/);
  assert.match(all.stdout, /rough-cut\s+John \(\/content\)/);
  assert.doesNotMatch(all.stdout, /enhance-plan|storyboard|\/studio/);
  const one = gtm(["pipeline", "carousel", "--json"]);
  assert.deepEqual(JSON.parse(one.stdout).stages.map((s: { key: string }) => s.key), ["copy", "final"]);
  const bad = gtm(["pipeline", "podcast"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown pipeline "podcast"/);
});

test("gtm story progress needs a story (or --series), a stage and a status", () => {
  const r = gtm(["story", "progress", "s1-13-sample-piece-13", "paper-edit"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: gtm story progress <story-id \| --series S> <stage>/);
  assert.equal(r.calls.length, 0, "nothing is read or written before the arguments are whole");
});

test("gtm story stage --changes needs a sentence", () => {
  const r = gtm(["story", "stage", "{dir}/story.yaml", "--changes"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--changes needs a sentence/);
});

test("gtm idea add stores one idea with the flags given (flag values never read as the title); a bad idea writes nothing", () => {
  const saved = { id: "00000000-0000-4000-8000-0000000000a1", slug: "before-after-an-inquiry", title: "Before after an inquiry", status: "shortlisted", kind: "content", pillar: "proof", tags: ["meridian", "short"] };
  const r = gtm(["idea", "add", "Before after an inquiry", "--kind", "content", "--pillar", "proof", "--status", "shortlisted", "--impact", "4", "--effort", "m", "--summary", "Split screen.", "--source", "https://brand.example.com/case-studies/x", "--tags", "Meridian, short", "--json"],
    { routes: [{ method: "POST", url: REST + "gtm_ideas", status: 201, json: saved }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).slug, "before-after-an-inquiry");
  const sent = body(r.calls.find((c) => c.url.startsWith(REST + "gtm_ideas"))!);
  assert.deepEqual(
    { slug: sent.slug, title: sent.title, kind: sent.kind, pillar: sent.pillar, status: sent.status, impact: sent.impact, effort: sent.effort, summary: sent.summary, source_url: sent.source_url, tags: sent.tags, created_by: sent.created_by },
    { slug: "before-after-an-inquiry", title: "Before after an inquiry", kind: "content", pillar: "proof", status: "shortlisted", impact: 4, effort: "m", summary: "Split screen.", source_url: "https://brand.example.com/case-studies/x", tags: ["meridian", "short"], created_by: "cli" },
  );
  const bad = gtm(["idea", "add", "Bad one", "--impact", "9", "--kind", "campaign"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /kind must be one of[\s\S]*impact is a whole number/);
  assert.equal(bad.calls.length, 0);
});

test("gtm idea seed --dry-run checks the seed file and touches nothing; gtm idea without a subcommand prints usage", () => {
  const r = gtm(["idea", "seed", join(ROOT, "config/ideas-seed.json"), "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.ok(out.would_add.includes("sample-planning-worksheet"));
  assert.equal(r.calls.length, 0);
  const usage = gtm(["idea"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /usage: gtm idea add <title>/);
});

// gtm outreach (cold outreach drafts reviewed in /outreach). Synthetic data only: .example domains, made-up people.
const OUTREACH = REST + "gtm_outreach_drafts";
const outreachEntry = (domain: string, over: Record<string, unknown> = {}) => ({
  batch: "b-test", domain, variant: "model-a", prospect: { first_name: "Ada", email: `ada@${domain}`, linkedin_url: "https://www.linkedin.com/in/ada-example" },
  subject: `Subject ${domain}`, body: `Body ${domain}`, linkedin_note: "Hi Ada", model: "model-a", ...over,
});
const outreachRow = (domain: string, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${domain.length.toString().padStart(12, "0")}`, created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
  batch: "b-test", domain, variant: "model-a", prospect: { first_name: "Ada", email: `ada@${domain}`, linkedin_url: "https://www.linkedin.com/in/ada-example" },
  trigger: {}, strategy: {}, subject: "Old subject", body: "Old body", original_subject: "Old subject", original_body: "Old body", linkedin_note: "Hi", followups: [], claims: [], findings: [],
  model: "model-a", version: 1, status: "pending", note: "", decided_by: null, decided_at: null, edited_by: null, edited_at: null, linkedin_status: "none", email_status: "none", ...over,
});

test("gtm outreach import --dry-run reads what exists and writes nothing: new, sent back, accepted", () => {
  const file = JSON.stringify([outreachEntry("new.example"), outreachEntry("regen.example"), outreachEntry("acc.example")]);
  const r = gtm(["outreach", "import", "{dir}/drafts.json", "--dry-run", "--json"], {
    files: { "drafts.json": file },
    routes: [{ method: "GET", url: OUTREACH, json: [outreachRow("regen.example", { status: "regenerate", note: "Shorter" }), outreachRow("acc.example", { status: "accepted" })] }],
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.inserted, out.regenerated, out.kept], [["b-test/new.example/model-a"], ["b-test/regen.example/model-a"], [{ key: "b-test/acc.example/model-a", reason: "John accepted it" }]]);
  assert.deepEqual(r.calls.map((c) => c.method), ["GET"]);
});

test("gtm outreach import: inserts the new, replaces a sent-back draft only while it is still sent back (version + 1, pending), never touches an accepted one", () => {
  const file = JSON.stringify([outreachEntry("new.example"), outreachEntry("regen.example", { original_body: "Agent body" }), outreachEntry("acc.example")]);
  const r = gtm(["outreach", "import", "{dir}/drafts.json", "--json"], {
    files: { "drafts.json": file },
    routes: [
      { method: "GET", url: OUTREACH, json: [outreachRow("regen.example", { status: "regenerate", note: "Shorter", version: 2 }), outreachRow("acc.example", { status: "accepted" })] },
      { method: "POST", url: OUTREACH, status: 201, json: [{ id: "x" }] },
      { method: "PATCH", url: OUTREACH, json: [{ id: "y" }] },
    ],
  });
  assert.equal(r.code, 0, r.stderr);
  const writes = r.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => c.method), ["POST", "PATCH"]);
  const inserted = body(writes[0]);
  assert.deepEqual(inserted.map((d: { domain: string; original_body: string }) => [d.domain, d.original_body]), [["new.example", "Body new.example"]]);
  const patch = writes[1];
  const sent = body(patch);
  assert.deepEqual([sent.version, sent.status, sent.note, sent.body, sent.original_body, sent.edited_at], [3, "pending", "", "Body regen.example", "Agent body", null]);
  assert.match(decodeURIComponent(patch.url), /status=eq\.regenerate/);
  assert.match(decodeURIComponent(patch.url), /version=eq\.2/);
  assert.deepEqual(JSON.parse(r.stdout).kept, [{ key: "b-test/acc.example/model-a", reason: "John accepted it" }]);
});

test("gtm outreach import refuses a bad file outright and writes nothing", () => {
  const r = gtm(["outreach", "import", "{dir}/drafts.json"], { files: { "drafts.json": JSON.stringify([outreachEntry("a.example", { linkedin_note: "x".repeat(301) }), outreachEntry("Bad Domain")]) } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /a\.example\/model-a: linkedin_note is 301 characters[\s\S]*not a hostname/);
  assert.equal(r.calls.length, 0);
});

test("gtm outreach notes --out writes John's notes with his edit; queue email lists accepted drafts not yet sent", () => {
  const notes = gtm(["outreach", "notes", "--batch", "b-test", "--out", "{dir}/notes.json", "--json"], {
    keep: true,
    routes: [{ method: "GET", url: OUTREACH, json: [outreachRow("regen.example", { status: "regenerate", note: "Lead with the office", body: "His body" })] }],
  });
  assert.equal(notes.code, 0, notes.stderr);
  assert.match(decodeURIComponent(notes.calls[0].url), /status=eq\.regenerate/);
  assert.match(decodeURIComponent(notes.calls[0].url), /batch=eq\.b-test/);
  const written = JSON.parse(readFileSync(join(notes.dir, "notes.json"), "utf8"));
  rmSync(notes.dir, { recursive: true, force: true });
  assert.deepEqual(written.map((n: { domain: string; note: string; edited: boolean; edited_body: string | null; original_body: string }) => [n.domain, n.note, n.edited, n.edited_body, n.original_body]),
    [["regen.example", "Lead with the office", true, "His body", "Old body"]]);
  assert.equal(JSON.parse(notes.stdout).count, 1);

  const q = gtm(["outreach", "queue", "email", "--json"], {
    routes: [{ method: "GET", url: OUTREACH, json: [outreachRow("a.example", { status: "accepted" }), outreachRow("bb.example", { status: "accepted", email_status: "sent" })] }],
  });
  assert.equal(q.code, 0, q.stderr);
  assert.deepEqual(JSON.parse(q.stdout).map((x: { domain: string; email: string; subject: string }) => [x.domain, x.email, x.subject]), [["a.example", "ada@a.example", "Old subject"]]);
});

test("gtm outreach mark: a bad status or a non-accepted draft is refused; a good one patches only that status on the accepted row", () => {
  const bad = gtm(["outreach", "mark", "00000000-0000-4000-8000-000000000001", "--email", "opened"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--email is one of queued, sent, replied/);
  assert.equal(bad.calls.length, 0);
  const pending = gtm(["outreach", "mark", "00000000-0000-4000-8000-000000000001", "--linkedin", "sent"], { routes: [{ method: "GET", url: OUTREACH, json: outreachRow("p.example") }] });
  assert.equal(pending.code, 1);
  assert.match(pending.stderr, /is pending; only an accepted draft is acted on/);
  assert.ok(!pending.calls.some((c) => c.method === "PATCH"));
  const ok = gtm(["outreach", "mark", "00000000-0000-4000-8000-000000000001", "--linkedin", "sent", "--json"], {
    routes: [
      { method: "GET", url: OUTREACH, json: outreachRow("p.example", { status: "accepted" }) },
      { method: "PATCH", url: OUTREACH, json: [outreachRow("p.example", { status: "accepted", linkedin_status: "sent" })] },
    ],
  });
  assert.equal(ok.code, 0, ok.stderr);
  const patch = ok.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(body(patch), { linkedin_status: "sent" });
  assert.match(decodeURIComponent(patch.url), /status=eq\.accepted/);
  const usage = gtm(["outreach"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /usage: gtm outreach import <file.json>/);
});

// gtm outreach import-dossiers|import-profile (the writing desk). Synthetic data only.
const DOSSIERS = REST + "gtm_outreach_dossiers";
const TRACKS_TABLE = REST + "gtm_outreach_tracks";
const deskDossier = (id: string, over: Record<string, unknown> = {}) => ({
  twenty_person_id: id, domain: `${id}.example`, prospect: { first_name: "Ada", last_name: id, company: "Acme", email: `ada@${id}.example`, score: 70 },
  sources: [{ id: "S1", url: `https://${id}.example/news`, text: "Full text" }], brief: null, ...over,
});

test("gtm outreach import-dossiers --dry-run reads which exist and writes nothing", () => {
  const r = gtm(["outreach", "import-dossiers", "--file", "{dir}/d.json", "--dry-run", "--json"], {
    files: { "d.json": JSON.stringify([deskDossier("p-new"), deskDossier("p-old")]) },
    routes: [{ method: "GET", url: DOSSIERS, json: [{ twenty_person_id: "p-old", track: "client" }] }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { track: "client", dryRun: true, inserted: ["p-new"], updated: ["p-old"], total: 2 });
  assert.deepEqual(r.calls.map((c) => c.method), ["GET"]);
});

test("gtm outreach import-dossiers upserts by Twenty person id with the denormalized columns, and never sends a skip", () => {
  const r = gtm(["outreach", "import-dossiers", "--file", "{dir}/d.json"], {
    files: { "d.json": JSON.stringify([deskDossier("p-new")]) },
    routes: [{ method: "GET", url: DOSSIERS, json: [] }, { method: "POST", url: DOSSIERS, status: 201, json: [{ twenty_person_id: "p-new" }] }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inserted 1, updated 0 of 1 client dossiers/);
  const post = r.calls.find((c) => c.method === "POST")!;
  assert.match(decodeURIComponent(post.url), /on_conflict=twenty_person_id/);
  const [row] = body(post);
  assert.deepEqual([row.twenty_person_id, row.track, row.domain, row.name, row.company, row.score], ["p-new", "client", "p-new.example", "Ada p-new", "Acme", 70]);
  assert.equal(row.dossier.sources[0].text, "Full text");
  assert.ok(!("skipped_at" in row) && !("skip_reason" in row), "a re-import never touches John's skip");
});

test("gtm outreach import-dossiers refuses a bad file outright; import-profile needs a signature and keeps the target", () => {
  const bad = gtm(["outreach", "import-dossiers", "--file", "{dir}/d.json"], { files: { "d.json": JSON.stringify([deskDossier("p-a", { domain: "Bad Domain" }), deskDossier("p-a")]) } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /p-a: domain "bad domain" is not a hostname[\s\S]*p-a: listed twice/);
  assert.equal(bad.calls.length, 0);
  const noSig = gtm(["outreach", "import-profile", "--track", "client", "--file", "{dir}/p.json"], { files: { "p.json": JSON.stringify({ name: "Jo" }) } });
  assert.equal(noSig.code, 1);
  assert.match(noSig.stderr, /no signature/);
  const noTrack = gtm(["outreach", "import-profile", "--file", "{dir}/p.json"], { files: { "p.json": JSON.stringify({ name: "Jo", signature: "Jo" }) } });
  assert.equal(noTrack.code, 1);
  assert.match(noTrack.stderr, /needs --track client\|guest/);
  assert.equal(noTrack.calls.length, 0, "nothing is written without an explicit stream");
  const ok = gtm(["outreach", "import-profile", "--file", "{dir}/p.json", "--track", "client", "--json"], {
    files: { "p.json": JSON.stringify({ name: "Jo", signature: "Jo\nFounder", facts: [{ id: "f1", text: "t" }], assets: [{ id: "a1", url: "https://x.example" }], gold_examples: [{ subject: "s", body: "b" }, { subject: "s2", body: "b2" }] }) },
    routes: [{ method: "PATCH", url: TRACKS_TABLE, json: [{ track: "client" }] }],
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { track: "client", dryRun: false, facts: 1, proof: 0, assets: 1, gold_examples: 2, templates: 0 });
  assert.match(decodeURIComponent(ok.calls.find((c) => c.method === "PATCH")!.url), /track=eq\.client/, "the client profile goes to the client track");
  const patch = body(ok.calls.find((c) => c.method === "PATCH")!);
  assert.deepEqual(Object.keys(patch).sort(), ["profile", "profile_imported_at"], "the daily target is never overwritten");
  const usage = gtm(["outreach", "import-dossiers"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /usage: gtm outreach import-dossiers --file/);
});

const guestDossier = (id: string, over: Record<string, unknown> = {}) => ({
  twenty_person_id: id, domain: `${id.replace(/^guest-md:/, "")}.guest.invalid`, track: "guest", score: 90, route: "linkedin",
  prospect: { first_name: "Gia", last_name: id, company: "Gia Org", email: "", linkedin_url: "https://www.linkedin.com/in/gia-example" },
  guest: { template: "01", prompts: ["a", "b", "c"] }, ...over,
});

test("gtm outreach import-dossiers --track guest stamps the track and takes the guest score; a client file or a person on the other track is refused", () => {
  const r = gtm(["outreach", "import-dossiers", "--track", "guest", "--file", "{dir}/g.json"], {
    files: { "g.json": JSON.stringify([guestDossier("guest-md:gia")]) },
    routes: [{ method: "GET", url: DOSSIERS, json: [] }, { method: "POST", url: DOSSIERS, status: 201, json: [{ twenty_person_id: "guest-md:gia" }] }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inserted 1, updated 0 of 1 guest dossiers/);
  const [row] = body(r.calls.find((c) => c.method === "POST")!);
  assert.deepEqual([row.twenty_person_id, row.track, row.domain, row.score], ["guest-md:gia", "guest", "gia.guest.invalid", 90]);
  const wrong = gtm(["outreach", "import-dossiers", "--track", "guest", "--file", "{dir}/d.json"], { files: { "d.json": JSON.stringify([deskDossier("p-a")]) } });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /p-a: is a row with no track, but this is a guest import/);
  const takeover = gtm(["outreach", "import-dossiers", "--track", "guest", "--file", "{dir}/g.json"], {
    files: { "g.json": JSON.stringify([guestDossier("fx-g-a")]) }, routes: [{ method: "GET", url: DOSSIERS, json: [{ twenty_person_id: "fx-g-a", track: "client" }] }],
  });
  assert.equal(takeover.code, 1);
  assert.match(takeover.stderr, /already filed under the other track/);
  assert.equal(takeover.calls.filter((c) => c.method === "POST").length, 0);
  const bad = gtm(["outreach", "import-dossiers", "--track", "podcast", "--file", "{dir}/g.json"], { files: { "g.json": "[]" } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--track is client or guest/);
});

test("gtm outreach import-profile --track guest writes the guest track's profile, with its templates, and never the client's", () => {
  const r = gtm(["outreach", "import-profile", "--track", "guest", "--file", "{dir}/p.json", "--json"], {
    files: { "p.json": JSON.stringify({ name: "Jo", signature: "Jo\nHost", templates: { "01": "Subject: s\n\nHey {{first_name}}", "04": "t" } }) },
    routes: [{ method: "PATCH", url: TRACKS_TABLE, json: [{ track: "guest" }] }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { track: "guest", dryRun: false, facts: 0, proof: 0, assets: 0, gold_examples: 0, templates: 2 });
  const patch = r.calls.find((c) => c.method === "PATCH")!;
  assert.match(decodeURIComponent(patch.url), /track=eq\.guest/);
  assert.deepEqual(Object.keys(body(patch)).sort(), ["profile", "profile_imported_at"], "the guest target and sender are kept");
  const bad = gtm(["outreach", "import-profile", "--track", "guest", "--file", "{dir}/p.json"], { files: { "p.json": JSON.stringify({ signature: "x", templates: { "01": 5 } }) } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /templates must be an object of strings/);
});
