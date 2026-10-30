// VIB-428 against the real LOCAL database: "not spam" redrafts with John's word passed to the model, commenter
// profiles are read once and reused, and a learning run turns John's decisions into lessons that the next
// draft carries. The model and Apify are fakes; nothing leaves the machine.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, OPENROUTER_API_KEY: "" });
const actions = await import("../../lib/engage/actions.ts");
const learn = await import("../../lib/engage/learn.ts");
const profile = await import("../../lib/engage/profile.ts");
const run = await import("../../lib/engage/run.ts");
const DB: Route = { url: l.url, passthrough: true };
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });
before(seed);

const row = (external_id: string, extra: Record<string, unknown> = {}) => ({
  kind: "comment", source: "poll", platform: "linkedin", account_id: "acc-li", platform_post_id: "urn:li:ugcPost:fx-learn", external_id,
  author_id: `urn:li:person:${external_id}`, author_username: `reader-${external_id}`, author_name: "Pat Reader", text: "Would love to explore a partnership.",
  commented_at: new Date().toISOString(), status: "new", ...extra,
});

async function reset() {
  const db = admin();
  await db.from("gtm_comments").delete().like("external_id", "vl-%");
  await db.from("gtm_engage_lessons").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db.from("gtm_comment_runs").delete().eq("kind", "learn");
  return db;
}

test("not spam: the row leaves spam, John's word reaches the model, the redraft lands, the correction is kept", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const { data } = await db.from("gtm_comments").insert(row("vl-spam", { status: "drafted", classification: "spam", stance: "spam", draft_reason: "solicits a partnership" })).select("id").single();
  const seen: string[] = [];
  const write = async (input: Parameters<typeof run.draftNew>[1] extends infer O ? O extends { write?: infer W } ? W extends (i: infer I, ...a: never[]) => unknown ? I : never : never : never) => {
    seen.push(...input.targets.map((t) => t.john_says ?? ""));
    // The model insists it is spam: John's word must still win.
    return [{ comment_id: data!.id, classification: "spam" as const, reply: "", reason: "still looks promotional", stance: "spam" as const, objection: "" }];
  };
  const r = await actions.markNotSpam(db, data!.id, "owner@test", { write: write as never });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["this is not spam"]);
  const after = (await db.from("gtm_comments").select("status,classification,reclassified_from,stance,draft,draft_reason,acted_by").eq("id", data!.id).single()).data!;
  assert.equal(after.status, "drafted");
  assert.equal(after.classification, "needs_john");
  assert.equal(after.reclassified_from, "spam");
  assert.equal(after.stance, null);
  assert.equal(after.draft, "[JOHN: write the reply]");
  assert.match(after.draft_reason, /John: this is not spam/);
  // A second tap is refused: it is no longer spam.
  const again = await actions.markNotSpam(db, data!.id, "owner@test", { write: write as never });
  assert.equal(again.ok, false);
});

test("not spam: two taps at once make one model call; the loser is told it is already handled", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const { data } = await db.from("gtm_comments").insert(row("vl-race", { status: "drafted", classification: "spam" })).select("id").single();
  let calls = 0;
  const write = (async (input: { targets: { id: string }[] }) => { calls++; await new Promise((r) => setTimeout(r, 200)); return [{ comment_id: input.targets[0].id, classification: "reply", reply: "Glad it landed, Pat.", reason: "", stance: "supportive", objection: "" }]; }) as never;
  const [a, b] = await Promise.all([actions.markNotSpam(db, data!.id, "phone", { write }), actions.markNotSpam(db, data!.id, "laptop", { write })]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(calls, 1);
  assert.equal((await db.from("gtm_comments").select("draft").eq("id", data!.id).single()).data!.draft, "Glad it landed, Pat.");
});

test("not spam survives other drafting paths: the daily draft honors it and the old-comment sweep leaves it", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const old = new Date(Date.now() - 10 * 86400_000).toISOString();
  await db.from("gtm_comments").insert(row("vl-strand", { status: "new", reclassified_from: "spam", commented_at: old, platform_post_id: "urn:li:ugcPost:fx-strand" }));
  const seen: (string | null | undefined)[] = [];
  // The daily path: the global old-comment sweep runs first.
  await run.draftNew(db, { write: (async (input: { targets: { id: string; john_says?: string | null }[] }) => {
    seen.push(...input.targets.map((t) => t.john_says));
    return input.targets.map((t) => ({ comment_id: t.id, classification: "spam", reply: "", reason: "promo", stance: "spam", objection: "" }));
  }) as never });
  const r = await db.from("gtm_comments").select("status").eq("external_id", "vl-strand").single();
  assert.notEqual(r.data!.status, "skipped", "the old-comment sweep never discards John's override");
  const fresh = (await db.from("gtm_comments").select("*").eq("external_id", "vl-strand").single()).data;
  await run.draftNew(db, { rows: [fresh], write: (async (input: { targets: { id: string; john_says?: string | null }[] }) => {
    seen.push(...input.targets.map((t) => t.john_says));
    return input.targets.map((t) => ({ comment_id: t.id, classification: "spam", reply: "", reason: "promo", stance: "spam", objection: "" }));
  }) as never });
  assert.ok(seen.includes("this is not spam"));
  assert.equal((await db.from("gtm_comments").select("classification").eq("external_id", "vl-strand").single()).data!.classification, "needs_john");
});

test("not spam: when the redraft fails the card still opens for John to write", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const { data } = await db.from("gtm_comments").insert(row("vl-fail", { status: "drafted", classification: "spam" })).select("id").single();
  const r = await actions.markNotSpam(db, data!.id, "owner@test", { write: (async () => { throw new Error("openrouter 503"); }) as never });
  assert.equal(r.ok, true);
  const after = (await db.from("gtm_comments").select("status,classification,reclassified_from,draft_reason").eq("id", data!.id).single()).data!;
  assert.deepEqual([after.status, after.classification, after.reclassified_from], ["drafted", "needs_john", "spam"]);
  assert.match(after.draft_reason, /redraft failed: openrouter 503/);
});

test("links: the page a comment links to reaches the model as data and its summary lands on the row; a dead link costs nothing", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  await db.from("gtm_comments").insert([
    row("vl-link", { text: "Wrote this up: https://example.com/low-tech-high-tech", platform_post_id: "urn:li:ugcPost:fx-link" }),
    row("vl-dead", { text: "And https://dead.example.com/x", platform_post_id: "urn:li:ugcPost:fx-link" }),
  ]);
  const reads: string[] = [];
  const read = async (url: string) => { reads.push(url); return url.includes("dead") ? null : { url, title: "Low tech and high tech", text: "Speed without observation burns living capital." }; };
  const pages: unknown[] = [];
  await run.draftNew(db, { read, only: { platform: "linkedin", platform_post_id: "urn:li:ugcPost:fx-link" }, write: (async (input: { targets: { id: string; pages?: unknown[] }[] }) => {
    pages.push(...input.targets.map((t) => t.pages ?? null));
    return input.targets.map((t) => ({ comment_id: t.id, classification: "reply", stance: "supportive", objection: "", reply: "That line about living capital stuck with me.", reason: "read it",
      links: t.pages?.length ? [{ url: "https://example.com/low-tech-high-tech", summary: "Argues low tech and high tech are one spectrum — both need observation." }] : [] }));
  }) as never });
  assert.deepEqual(reads.sort(), ["https://dead.example.com/x", "https://example.com/low-tech-high-tech"]);
  assert.deepEqual(pages.filter(Boolean), [[{ url: "https://example.com/low-tech-high-tech", title: "Low tech and high tech", text: "Speed without observation burns living capital." }]]);
  const rows = (await db.from("gtm_comments").select("external_id,status,linked").like("external_id", "vl-%").order("external_id")).data!;
  assert.deepEqual(rows.find((r) => r.external_id === "vl-link")!.linked, [{ url: "https://example.com/low-tech-high-tech", title: "Low tech and high tech", summary: "Argues low tech and high tech are one spectrum, both need observation." }]);
  assert.equal(rows.find((r) => r.external_id === "vl-dead")!.linked, null);
  assert.ok(rows.every((r) => r.status === "drafted"));
});

test("profiles: one read per author, reused for their next comment, unknown handles marked so they are not re-read", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const ids = ((await db.from("gtm_comments").insert([row("vl-p1", { author_username: "pat-reader" }), row("vl-p2", { author_username: "nobody-here" }), row("vl-p3", { author_username: null })]).select("id")).data ?? []).map((x) => x.id);
  const asked: string[][] = [];
  const read = async (_platform: string, handles: string[]) => {
    asked.push(handles);
    return new Map([["pat-reader", { headline: "Founder, Example Co", company: "Example Co", website: "https://example.test", followers: 10366, profileUrl: "https://www.linkedin.com/in/pat-reader", picture: "https://media.test/200.jpg" }]]);
  };
  // Scoped to these rows (the seed has queued comments of its own).
  const r = await profile.enrichAuthors(db, { read, ids });
  assert.deepEqual(asked.map((a) => [...a].sort()), [["nobody-here", "pat-reader"]]);
  assert.deepEqual([r.read, r.missing, r.reused], [1, 2, 0]);
  const got = Object.fromEntries(((await db.from("gtm_comments").select("external_id,author_followers,author_website,author_headline,author_enriched_at").like("external_id", "vl-p%")).data ?? []).map((x) => [x.external_id, x]));
  assert.equal(got["vl-p1"].author_followers, 10366);
  assert.equal(got["vl-p1"].author_website, "https://example.test");
  assert.ok(got["vl-p2"].author_enriched_at && got["vl-p3"].author_enriched_at, "tried rows are marked");
  // The same person comments again: copied from the first read, no second Apify run.
  const p4 = (await db.from("gtm_comments").insert(row("vl-p4", { author_username: "Pat-Reader" })).select("id").single()).data!;
  const r2 = await profile.enrichAuthors(db, { read, ids: [p4.id] });
  assert.equal(asked.length, 1);
  assert.equal(r2.reused, 1);
  assert.equal((await db.from("gtm_comments").select("author_headline").eq("external_id", "vl-p4").single()).data!.author_headline, "Founder, Example Co");
});

test("learning: John's decisions become lessons, the next draft carries them and records its lesson set; nothing new, no model call", async () => {
  mock = installFetchMock([DB]);
  const db = await reset();
  const now = new Date().toISOString();
  const ins = (await db.from("gtm_comments").insert([
    row("vl-sent", { status: "sent", sent_at: now, acted_at: now, draft: "I'd want to understand how you measure it.", final_text: "That's incredible Pat, would love to dig into the work.", classification: "reply" }),
    row("vl-skip", { status: "skipped", acted_at: now, draft: "Thanks for this.", classification: "reply" }),
    row("vl-relabel", { status: "sent", sent_at: now, acted_at: now, draft: "[JOHN: write the reply]", final_text: "Let's talk, Pat.", classification: "needs_john", reclassified_from: "spam" }),
  ]).select("id,external_id")).data!;
  const id = (e: string) => ins.find((x) => x.external_id === e)!.id;
  let calls = 0;
  const write = async (input: { lessons: unknown[]; signals: { id: string; john: { action: string } }[] }) => {
    calls++;
    assert.deepEqual(input.signals.map((s) => s.john.action).sort(), ["edited", "edited", "skipped"]);
    return [
      { keep_id: "", kind: "voice" as const, lesson: "React warmly to their specific work before anything else", evidence: [id("vl-sent")] },
      { keep_id: "", kind: "classification" as const, lesson: "A partnership offer from a peer is not spam", evidence: [id("vl-relabel")] },
      { keep_id: "", kind: "voice" as const, lesson: "This one cites nothing real", evidence: ["not-a-comment"] },
    ];
  };
  const r = await learn.learnFromDecisions(db, { write });
  assert.equal(r.signals, 3);
  assert.equal(r.added.length, 2, "a lesson citing no real decision is dropped");
  const lessons = await learn.activeLessons(db);
  assert.equal(lessons.length, 2);

  // Drafting now carries the lessons and John's send as an example, and records the lesson set.
  await db.from("gtm_comments").insert(row("vl-new", { text: "How did you start?" }));
  let prompt: { lessons?: { lesson: string }[]; examples?: { sent: string }[] } | null = null;
  const d = await run.draftNew(db, {
    rows: [(await db.from("gtm_comments").select("*").eq("external_id", "vl-new").single()).data],
    write: (async (input: typeof prompt & { targets: { id: string }[] }) => { prompt = input; return [{ comment_id: input.targets[0].id, classification: "reply", reply: "We started small.", reason: "", stance: "question", objection: "" }]; }) as never,
  });
  assert.equal(d.drafted, 1);
  assert.deepEqual(prompt!.lessons!.map((x) => x.lesson).sort(), ["A partnership offer from a peer is not spam", "React warmly to their specific work before anything else"]);
  assert.ok(prompt!.examples!.some((e) => e.sent.startsWith("That's incredible Pat")));
  const drafted = (await db.from("gtm_comments").select("lesson_set").eq("external_id", "vl-new").single()).data!;
  assert.equal(drafted.lesson_set, learn.lessonSetId(lessons));

  // No decision since the run: no model call.
  const again = await learn.learnFromDecisions(db, { write });
  assert.equal(again.skipped, true);
  assert.equal(calls, 1);

  // A later run that drops a learned lesson retires it; John's own lesson is never touched.
  await learn.addLesson(db, "voice", "Never mention pricing in a comment");
  await db.from("gtm_comments").update({ acted_at: new Date(Date.now() + 1000).toISOString() }).eq("external_id", "vl-skip");
  const keepOne = lessons.find((x) => x.kind === "classification")!;
  const r3 = await learn.learnFromDecisions(db, { write: async () => [{ keep_id: keepOne.id, kind: "classification", lesson: "ignored", evidence: [] }] });
  assert.equal(r3.retired.length, 1);
  const active = (await learn.activeLessons(db)).map((x) => x.lesson).sort();
  assert.deepEqual(active, ["A partnership offer from a peer is not spam", "Never mention pricing in a comment"]);

  // The score: the baseline set had one edited send and one relabel.
  const score = await learn.learningScore(db);
  assert.ok(score.length >= 1);
  await reset();
});

test("links: a dry run never reads pages (no Firecrawl credits spent by classify or --dry-run)", async () => {
  mock = installFetchMock([DB, { url: "https://api.firecrawl.dev/", json: { success: true, data: { markdown: "page", metadata: { statusCode: 200 } } } }]);
  const db = await reset();
  await db.from("gtm_comments").insert(row("vl-dry", { text: "https://example.com/a", platform_post_id: "urn:li:ugcPost:fx-dry" }));
  process.env.FIRECRAWL_API_KEY = "would-spend";
  const write = (async (input: { targets: { id: string }[] }) => input.targets.map((t) => ({ comment_id: t.id, classification: "reply", stance: "supportive", objection: "", reply: "Thanks!", reason: "" }))) as never;
  try {
    const fresh = (await db.from("gtm_comments").select("*").eq("external_id", "vl-dry")).data!;
    await run.draftNew(db, { rows: fresh, dryRun: true, write });
    assert.equal(mock.calls.filter((c) => c.url.startsWith("https://api.firecrawl.dev/")).length, 0, "a dry run spends no Firecrawl credit");
    // The same row for real does read it: the check above is not passing for want of a key or a link.
    await run.draftNew(db, { rows: fresh, write });
    assert.equal(mock.calls.filter((c) => c.url.startsWith("https://api.firecrawl.dev/")).length, 1);
  } finally { process.env.FIRECRAWL_API_KEY = ""; }
  await reset();
});
