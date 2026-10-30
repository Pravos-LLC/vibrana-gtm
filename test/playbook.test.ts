// Playbook tags (VIB-421): the vendored taxonomy, the guard that rejects unknown ids, the choice of rows to
// tag, the run against a mocked database and model, the OpenRouter request shape, and the CLI contract.
// Nothing here reaches a service.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
delete process.env.OPENROUTER_API_KEY;

const { TAXONOMY, HOOK_IDS, STORYLINE_IDS, CTA_IDS, ctaAwareness } = await import("../lib/playbook/taxonomy.ts");
const { bodyHash, checkTags, openRouterTagger, selectRowsToTag, tagPlaybook, tagsCurrent, tagSchema, COLUMN_MISSING } = await import("../lib/playbook/tag.ts");
const { adminDb } = await import("../lib/db.ts");
import type { RawTags, TagRow, Tagger } from "../lib/playbook/tag.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; });

const GOOD: RawTags = { hook: "news-peg", storyline: "news-take", cta: "open-question", rationale: "Opens on this week's release, ends asking readers which risk they see.", confidence: "high" };
const row = (over: Partial<TagRow>): TagRow => ({ id: "x", title: "X", pillar: "perspective", format: "text", channels: ["linkedin"], status: "published", body: "Copy.", ...over });
const stored = (body: string | null, over: Record<string, unknown> = {}) => ({ ...GOOD, cta_awareness: "use", body_hash: bodyHash(body), taxonomy_version: 1, model: "m", tagged_at: "2026-10-11T00:00:00Z", ...over });

// ---- the taxonomy --------------------------------------------------------------------------------------------

test("taxonomy: vendored file parses, ids are unique per list, every CTA has an awareness flag", () => {
  for (const list of [TAXONOMY.hooks, TAXONOMY.storylines, TAXONOMY.ctas, TAXONOMY.formats]) {
    const ids = list.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const e of list) assert.match(e.id, /^[a-z0-9-]+$/);
  }
  for (const c of TAXONOMY.ctas) assert.ok(["use", "limit", "avoid"].includes(c.awareness), c.id);
  assert.equal(ctaAwareness("comment-keyword"), "avoid");
  assert.equal(ctaAwareness("soft-link"), "limit");
  assert.equal(ctaAwareness("open-question"), "use");
  assert.equal(ctaAwareness("nope"), null);
});

// ---- the guard -----------------------------------------------------------------------------------------------

test("guard: accepts live ids and adds the CTA's awareness flag", () => {
  const r = checkTags(GOOD);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.tags, { hook: "news-peg", storyline: "news-take", cta: "open-question", cta_awareness: "use", rationale: GOOD.rationale, confidence: "high" });
});

test("guard: rejects unknown ids in any slot, unknown confidence, and an empty answer; never repairs them", () => {
  for (const [over, re] of [
    [{ hook: "question" }, /unknown hook "question"/],
    [{ storyline: "tension" }, /unknown storyline "tension"/],
    [{ cta: "buy-now" }, /unknown cta "buy-now"/],
    [{ hook: "news-peg ", cta: "Open-Question" }, /unknown hook.*unknown cta/],
    [{ confidence: "certain" }, /unknown confidence/],
    [{ hook: undefined }, /unknown hook undefined/],
  ] as const) {
    const r = checkTags({ ...GOOD, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(!r.ok ? r.reason : "", re);
  }
  assert.deepEqual(checkTags(null), { ok: false, reason: "no answer" });
  // A hook id is not a storyline id: the lists are separate.
  assert.equal(checkTags({ ...GOOD, storyline: "news-peg" }).ok, false);
});

test("guard: a retired id is rejected, so stored tags using it are tagged again", () => {
  const hook = TAXONOMY.hooks.find((h) => h.id === "news-peg")!;
  hook.retired = true;
  try {
    assert.match(String(!checkTags(GOOD).ok && (checkTags(GOOD) as { reason: string }).reason), /unknown hook "news-peg"/);
    assert.deepEqual(selectRowsToTag([row({ playbook_tags: stored("Copy.") })]).length, 1);
  } finally { delete hook.retired; }
  assert.ok(checkTags(GOOD).ok);
});

test("guard: the rationale loses em dashes, newlines and length", () => {
  const r = checkTags({ ...GOOD, rationale: `Opens on news—then asks.\n2025–2026 range. ${"x".repeat(400)}` });
  assert.ok(r.ok);
  const t = r.ok ? r.tags.rationale : "";
  assert.ok(!/[—–\n]/.test(t));
  assert.match(t, /^Opens on news, then asks\. 2025-2026 range\./);
  assert.equal(t.length, 240);
});

// ---- selection -----------------------------------------------------------------------------------------------

test("selection: only approved, scheduled and published rows with copy, untagged or with a changed body", () => {
  const rows = [
    row({ id: "untagged" }),
    row({ id: "current", playbook_tags: stored("Copy.") }),
    row({ id: "edited", body: "New copy.", playbook_tags: stored("Copy.") }),
    row({ id: "unresolvable", playbook_tags: stored("Copy.", { hook: "retired-hook" }) }),
    row({ id: "no-hash", playbook_tags: { hook: "news-peg", storyline: "news-take", cta: "none", confidence: "high" } }),
    row({ id: "approved", status: "approved" }),
    row({ id: "scheduled", status: "scheduled" }),
    row({ id: "drafted", status: "drafted" }),
    row({ id: "idea", status: "idea" }),
    row({ id: "failed", status: "failed" }),
    row({ id: "skipped", status: "skipped" }),
    row({ id: "no-body", body: null }),
    row({ id: "blank-body", body: "  \n " }),
  ];
  assert.deepEqual(selectRowsToTag(rows).map((r) => r.id), ["untagged", "edited", "unresolvable", "no-hash", "approved", "scheduled"]);
  assert.deepEqual(selectRowsToTag(rows, { all: true }).map((r) => r.id), ["untagged", "current", "edited", "unresolvable", "no-hash", "approved", "scheduled"]);
});

test("selection: trailing whitespace is not a copy change", () => {
  assert.ok(tagsCurrent(stored("Copy."), "Copy.\n"));
  assert.ok(!tagsCurrent(stored("Copy."), "Copy!"));
  assert.ok(!tagsCurrent(null, "Copy."));
});

// ---- the run -------------------------------------------------------------------------------------------------

const ITEMS = [row({ id: "a", body: "Alpha" }), row({ id: "b", body: "Beta", playbook_tags: stored("Beta") }), row({ id: "c", status: "approved", body: "Gamma" })];
const fake = (answers: Record<string, Partial<RawTags> | Error>): { tag: Tagger; seen: string[] } => {
  const seen: string[] = [];
  return { seen, tag: async (r) => { seen.push(r.id); const a = answers[r.id] ?? GOOD; if (a instanceof Error) throw a; return { raw: { ...GOOD, ...a }, model: "test/model" }; } };
};

test("run: tags due rows, saves tags with the body hash, leaves current rows alone", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: ITEMS },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  const { tag, seen } = fake({});
  const r = await tagPlaybook(adminDb(), { tag, now: new Date("2026-10-11T06:00:00Z") });
  assert.deepEqual(seen, ["a", "c"]);
  assert.deepEqual(r.tagged.map((t) => t.id), ["a", "c"]);
  const get = m.calls.find((c) => c.method === "GET")!;
  assert.match(decodeURIComponent(get.url), /select=id,title,pillar,format,channels,status,body,playbook_tags/);
  assert.match(decodeURIComponent(get.url), /status=in\.\(approved,scheduled,published\)/);
  const patches = m.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.match(patches[0].url, /id=eq\.a/);
  const saved = JSON.parse(patches[0].body!).playbook_tags;
  assert.deepEqual(saved, { hook: "news-peg", storyline: "news-take", cta: "open-question", cta_awareness: "use", rationale: GOOD.rationale, confidence: "high", body_hash: bodyHash("Alpha"), taxonomy_version: 1, model: "test/model", tagged_at: "2026-10-11T06:00:00.000Z" });
  assert.deepEqual(Object.keys(JSON.parse(patches[0].body!)), ["playbook_tags"], "only the tags column is written: never status, body or approval");
});

test("run: a guard rejection or a model error is reported and nothing is written for that row", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: ITEMS },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  const { tag } = fake({ a: { cta: "dm-me" }, c: new Error("openrouter m: 502") });
  const r = await tagPlaybook(adminDb(), { tag });
  assert.deepEqual(r.rejected, [{ id: "a", title: "X", reason: 'unknown cta "dm-me"' }]);
  assert.deepEqual(r.errors, [{ id: "c", error: "openrouter m: 502" }]);
  assert.equal(m.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("run: --dry-run calls the model and writes nothing; --all includes current rows; --limit caps", async () => {
  const m = use([{ method: "GET", url: REST + "gtm_content_items", json: ITEMS }]);
  const { tag, seen } = fake({});
  const r = await tagPlaybook(adminDb(), { tag, dryRun: true, all: true, limit: 2 });
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(r.selected, 2);
  assert.equal(r.tagged.length, 2);
  assert.equal(m.calls.filter((c) => c.method !== "GET").length, 0);
});

test("run: nothing due means no model call and no key needed", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: [ITEMS[1]] }]);
  const r = await tagPlaybook(adminDb());
  assert.deepEqual({ selected: r.selected, tagged: r.tagged.length }, { selected: 0, tagged: 0 });
});

test("run: the deadline defers rows instead of starting a call it cannot finish", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: ITEMS }]);
  const { tag, seen } = fake({});
  const r = await tagPlaybook(adminDb(), { tag, deadline: Date.now() + 1000 });
  assert.deepEqual(seen, []);
  assert.deepEqual(r.deferred, ["a", "c"]);
});

const NO_COLUMN = { code: "42703", message: "column gtm_content_items.playbook_tags does not exist" };
test("run: before the column exists, a real run skips without calling the model", async () => {
  const m = use([{ method: "GET", url: REST + "gtm_content_items", status: 400, json: NO_COLUMN }]);
  const { tag, seen } = fake({});
  const r = await tagPlaybook(adminDb(), { tag });
  assert.equal(r.skipped, COLUMN_MISSING);
  assert.deepEqual(seen, []);
  assert.equal(m.calls.length, 1);
});

test("run: before the column exists, a dry run reads without it and treats every row as untagged", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", regex: false, status: 400, json: NO_COLUMN, times: 1 },
    { method: "GET", url: REST + "gtm_content_items", json: ITEMS.map(({ playbook_tags: _t, ...r }) => r) },
  ]);
  const { tag, seen } = fake({});
  const r = await tagPlaybook(adminDb(), { tag, dryRun: true });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.match(r.skipped ?? "", /^dry run only: .*does not exist yet/);
  assert.ok(!decodeURIComponent(m.calls[1].url).includes("playbook_tags"));
});

// ---- the model call ------------------------------------------------------------------------------------------

test("openRouterTagger: strict json_schema whose enums are exactly the taxonomy's live ids", async () => {
  let sent: any = null;
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) }, finish_reason: "stop" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const tag = openRouterTagger({ key: "or_test", model: "test/model", fetcher });
  const out = await tag(row({ body: "---\nchannel: linkedin\n---\nThe copy itself." }));
  assert.deepEqual(out, { raw: GOOD, model: "test/model" });
  const rf = sent.response_format;
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.strict, true);
  assert.deepEqual(rf.json_schema.schema, tagSchema());
  assert.deepEqual(rf.json_schema.schema.properties.hook.enum, HOOK_IDS);
  assert.deepEqual(rf.json_schema.schema.properties.storyline.enum, STORYLINE_IDS);
  assert.deepEqual(rf.json_schema.schema.properties.cta.enum, CTA_IDS);
  assert.deepEqual(sent.provider, { require_parameters: true });
  assert.match(sent.messages[1].content, /<copy>\nThe copy itself\.\n<\/copy>/, "frontmatter is not part of the copy");
  for (const c of TAXONOMY.ctas) assert.ok(sent.messages[0].content.includes(`- ${c.id}: ${c.name}.`), c.id);
});

test("openRouterTagger: refusals, truncation and HTTP errors throw", async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(openRouterTagger({ key: "k", model: "m", fetcher: answer(200, { choices: [{ message: { refusal: "no" } }] }) })(row({})), /declined/);
  await assert.rejects(openRouterTagger({ key: "k", model: "m", fetcher: answer(200, { choices: [{ message: { content: "{" }, finish_reason: "length" }] }) })(row({})), /truncated/);
  await assert.rejects(openRouterTagger({ key: "k", model: "m", fetcher: answer(429, { error: { message: "slow down" } }) })(row({})), /429 slow down/);
  assert.throws(() => openRouterTagger({}), /OPENROUTER_API_KEY/);
});

// ---- the CLI -------------------------------------------------------------------------------------------------

test("gtm playbook tag --dry-run --json: lists what it would tag and writes nothing; bad usage exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-playbook-"));
  const routes: Route[] = [
    { method: "GET", url: REST + "gtm_content_items", json: [ITEMS[1]] },
  ];
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "--import", join(ROOT, "test/support/fetch-mock.ts"), join(ROOT, "cli/gtm.ts"), "playbook", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: dir, GTM_SKIP_ENV_FILES: "1", GTM_FETCH_MOCK: join(dir, "routes.json"), GTM_FETCH_LOG: join(dir, "calls.jsonl"), NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test", ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test", NODE_ENV: "test" },
  });
  const r = run("tag", "--dry-run", "--json");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual({ dryRun: out.dryRun, considered: out.considered, selected: out.selected }, { dryRun: true, considered: 1, selected: 0 });
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => c.method === "GET"));
  const bad = run("nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: gtm playbook tag/);
  assert.equal(run("tag", "--limit", "0").status, 1);
});

// ---- the report page's chips ---------------------------------------------------------------------------------

test("report chips: names from the taxonomy; an avoid CTA says so in words, not only in color", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { PlaybookChips } = await import("../components/reports/playbook-chips.tsx");
  const post = (cta: string, cta_awareness: "use" | "limit" | "avoid") => ({ playbook_tags: { hook: "news-peg", storyline: "news-take", cta, cta_awareness, confidence: "high" } }) as never;
  const ok = renderToStaticMarkup(createElement(PlaybookChips, { p: post("open-question", "use") }));
  assert.match(ok, /News peg/);
  assert.match(ok, /News plus a take/);
  assert.match(ok, /Open question/);
  assert.doesNotMatch(ok, /avoid in awareness/);
  const bad = renderToStaticMarkup(createElement(PlaybookChips, { p: post("comment-keyword", "avoid") }));
  assert.match(bad, /Comment a keyword to get it/);
  assert.match(bad, /avoid in awareness/);
  assert.equal(renderToStaticMarkup(createElement(PlaybookChips, { p: {} as never })), "", "an untagged post shows no chips");
});

// ---- review fixes (PR #57) -----------------------------------------------------------------------------------

test("calendar export: playbook tags never reach calendar.yaml", async () => {
  const { exportCalendar } = await import("../lib/calendar-db.ts");
  use([{ method: "GET", url: REST + "gtm_content_items", json: [{
    id: "tagged-post", week: 41, date: "2030-10-07", time: "15:00", pillar: "perspective", title: "Tagged", format: "text", channels: ["linkedin"],
    status: "approved", body: "Copy.", media: [], approved_hash: "a".repeat(64), urls: {}, story_assets: [], playbook_tags: stored("Copy."),
  }] }]);
  const yaml = await exportCalendar(adminDb());
  assert.match(yaml, /id: tagged-post/);
  assert.doesNotMatch(yaml, /playbook_tags|body_hash|rationale|news-peg/);
});

test("run: without OPENROUTER_API_KEY and with rows due, it skips and says so (no throw)", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: ITEMS }]);
  const r = await tagPlaybook(adminDb());
  assert.match(r.skipped ?? "", /OPENROUTER_API_KEY is not set; 2 items left untagged/);
  assert.deepEqual(r.tagged, []);
});

test("report writer prompt: avoid CTAs are cited by the count fact, the refs only name posts", async () => {
  const src = readFileSync(join(ROOT, "lib/reports/writer.ts"), "utf8");
  assert.match(src, /cite the count fact playbook\.week\.cta\.avoid as evidence/);
  assert.match(src, /playbook\.week\.avoid_refs \(a list of post refs, not a fact\)/);
});
