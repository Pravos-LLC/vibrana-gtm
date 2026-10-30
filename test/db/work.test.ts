// The work board (gtm_work_items, `gtm work`) against the real LOCAL database: John's notes wait until a job covers
// them; add derives the piece from the notes; stage and resolve move a job along on their own; the
// owner reads it through RLS and nobody else does.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const store = await import("../../lib/work/store.ts");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let notes: { a: string; b: string; fresh: string; studio: string };

before(async () => {
  await seed();
  const db = admin();
  const fb = await db.from("gtm_story_feedback").insert([
    { asset_id: "fx-story-copy", channel: "linkedin", body: "Tighten the hook", created_at: ago(20) },
    { asset_id: "fx-story-copy", channel: "linkedin", body: "Shorter close", created_at: ago(10) },
    { asset_id: "fx-story-copy", channel: "linkedin", body: "Just typed", created_at: ago(1) },
  ]).select("id,body");
  assert.equal(fb.error, null);
  const sc = await db.from("gtm_storyboard_comments").insert({ storyboard_id: "sb-fx-story-enhance-plan", version: 1, kind: "note", body: "Swap the sheep", created_at: ago(15) }).select("id").single();
  assert.equal(sc.error, null);
  const id = (body: string) => fb.data!.find((r) => r.body === body)!.id as string;
  notes = { a: id("Tighten the hook"), b: id("Shorter close"), fresh: id("Just typed"), studio: sc.data!.id as string };
});

const waitingIds = async () => (await store.waitingNotes(admin())).map((n) => n.note_id);

test("waiting: John's notes older than five minutes that no job covers, from /content; a retired /studio comment never waits", async () => {
  const w = await waitingIds();
  for (const id of [notes.a, notes.b]) assert.ok(w.includes(id), `${id} waits`);
  assert.ok(!w.includes(notes.studio), "a comment on a retired storyboard is not agent work");
  assert.ok(!w.includes(notes.fresh), "a note left a minute ago is not waiting yet");
});

test("add: the piece and a default title come from the notes; covered notes stop waiting; ids are checked", async () => {
  const db = admin();
  const r = await store.addWork(db, { notes: [notes.a, notes.b], eta: "45m", agent: "content-engine" });
  assert.deepEqual([r.item.story_id, r.item.asset_id, r.item.storyboard_id, r.item.title, r.item.status, r.item.agent], ["fx-story", "fx-story-copy", null, "Fixture Story: 2 notes", "queued", "content-engine"]);
  const eta = new Date(r.item.eta_at!).getTime() - Date.now();
  assert.ok(eta > 40 * 60_000 && eta <= 45 * 60_000, "ETA about 45 minutes out");
  const w = await waitingIds();
  assert.ok(!w.includes(notes.a) && !w.includes(notes.b), "covered notes are no longer waiting");
  await assert.rejects(store.addWork(db, { notes: ["00000000-0000-4000-8000-000000000999"] }), /no such note/);
  await assert.rejects(store.addWork(db, { notes: ["not-a-uuid"] }), /not a note id/);
  await assert.rejects(store.addWork(db, {}), /give --notes/);
  const again = await store.addWork(db, { notes: [notes.a], title: "Second agent" });
  assert.deepEqual(again.alsoCoveredBy.map((x) => x.id), [r.item.id], "a second job on the same note is reported");
  await store.doneWork(db, again.item.id);
});

test("update: a short id works; blocked needs a reason, which leaving blocked clears; the ETA can be cleared", async () => {
  const db = admin();
  const [item] = (await store.listWork(db)).items.filter((w) => w.title === "Fixture Story: 2 notes");
  const short = item.id.slice(0, 8);
  const w = await store.updateWork(db, short, { status: "working", note: "Recutting the hook", eta: "30m" });
  assert.deepEqual([w.status, w.last_update], ["working", "Recutting the hook"]);
  await assert.rejects(store.updateWork(db, short, { status: "blocked" }), /needs --note/);
  const b = await store.updateWork(db, short, { status: "blocked", note: "Needs the raw track" });
  assert.deepEqual([b.status, b.blocked_reason], ["blocked", "Needs the raw track"]);
  const back = await store.updateWork(db, short, { status: "working", eta: "none" });
  assert.deepEqual([back.blocked_reason, back.eta_at], ["", null]);
  await assert.rejects(store.updateWork(db, short, {}), /nothing to change/);
  await assert.rejects(store.updateWork(db, short, { status: "thinking" }), /--status is one of/);
});

test("auto-advance: a stage moves the job to staged; resolving its notes one by one ends it done, still listed for review", async () => {
  const db = admin();
  const [item] = (await store.listWork(db)).items.filter((w) => w.title === "Fixture Story: 2 notes");
  const staged = await store.advanceOnStage(db, "fx-story");
  assert.deepEqual(staged.map((x) => [x.id, x.to]), [[item.id, "staged"]]);
  assert.match(staged[0].note, /0 of 2 notes answered/);
  await db.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: "done" }).eq("id", notes.a);
  const one = await store.advanceOnResolve(db, [notes.a]);
  assert.deepEqual(one.map((x) => [x.to, x.note]), [["staged", "1 of 2 notes answered"]]);
  await db.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: "done" }).eq("id", notes.b);
  const two = await store.advanceOnResolve(db, [notes.b]);
  assert.deepEqual(two.map((x) => [x.to, x.note]), [["done", "All 2 notes answered"]]);
  const done = (await store.findWork(db, item.id));
  assert.ok(done.done_at && done.staged_at && !done.eta_at, "done, with its staged time kept");
  assert.deepEqual(await store.advanceOnStage(db, "fx-story"), [], "a done job is not moved again");
});

test("RLS: the owner reads the board and the waiting notes; a member reads nothing and writes nothing", async () => {
  const owner = await signedIn("owner");
  const member = await signedIn("member");
  assert.ok(((await owner.from("gtm_work_items").select("id")).data ?? []).length >= 2);
  assert.ok((await store.workCounts(owner)) !== null, "the nav badge counts load for the owner");
  assert.deepEqual((await member.from("gtm_work_items").select("id")).data, []);
  assert.deepEqual((await member.rpc("gtm_work_waiting_notes", { p_grace: "5 minutes" })).data, []);
  const write = await owner.from("gtm_work_items").insert({ title: "from the browser" });
  assert.ok(write.error, "the browser never writes work items");
});

test("CLI: gtm work add, update, done and list --json round-trip", () => {
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_SKIP_ENV_FILES: "1", GTM_AGENT: "cli-test" };
  const gtm = (...args: string[]) => {
    const r = spawnSync("node", ["--import", "tsx", "cli/gtm.ts", "work", ...args, "--json"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const added = gtm("add", "--notes", notes.fresh, "--title", "Fixture: the typed note", "--eta", "1h");
  assert.deepEqual([added.item.title, added.item.agent, added.item.story_id], ["Fixture: the typed note", "cli-test", "fx-story"]);
  const id = added.item.id.slice(0, 8);
  assert.equal(gtm("update", id, "--status", "rendering", "--note", "Rendering v3").status, "rendering");
  const done = gtm("done", id);
  assert.deepEqual([done.item.status, done.unanswered], ["done", [notes.fresh]], "done reports the note still unanswered");
  const list = gtm("list");
  assert.ok(list.items.some((w: { id: string }) => w.id === added.item.id));
  assert.ok(Array.isArray(list.waiting));
  const bad = spawnSync("node", ["--import", "tsx", "cli/gtm.ts", "work", "update", id, "--status", "blocked"], { cwd: ROOT, env, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /needs --note/);
});

test("CLI: gtm story resolve finishes the job once its last note is answered, and says so", async () => {
  const db = admin();
  const { data } = await db.from("gtm_story_feedback").insert({ asset_id: "fx-story-copy", channel: "linkedin", body: "One more", created_at: ago(30) }).select("id").single();
  const note = data!.id as string;
  const { item } = await store.addWork(db, { notes: [note], status: "working" });
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_SKIP_ENV_FILES: "1" };
  const r = spawnSync("node", ["--import", "tsx", "cli/gtm.ts", "story", "resolve", note, "Fixed", "--json"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.work.map((w: { id: string; to: string }) => [w.id, w.to]), [[item.id, "done"]]);
  assert.equal((await store.findWork(db, item.id)).status, "done");
});
