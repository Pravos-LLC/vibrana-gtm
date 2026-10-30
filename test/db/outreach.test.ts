// Cold outreach drafts (gtm_outreach_drafts) against the real LOCAL database: John's decisions from /outreach (edit,
// accept with siblings rejected, reject, send back, undo), the import from the pipeline (regenerate keeps his note in the
// history, accepted and edited drafts are never overwritten), the notes export, the queues and the marks.
// Synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, OUTREACH_IDS, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const store = await import("../../lib/outreach/store.ts");
const { editOf } = await import("../../lib/outreach/model.ts");

before(async () => { await seed(); });

const versions = async (id: string) => (await admin().from("gtm_outreach_draft_versions").select("reason,version,body,status,note,actor").eq("draft_id", id).order("created_at")).data ?? [];

test("batches: newest first; list filters by batch and status", async () => {
  const db = admin();
  assert.deepEqual(await store.listBatches(db), ["fx-batch-2", "fx-batch-1"]);
  assert.deepEqual((await store.listDrafts(db, { batch: "fx-batch-2", status: "accepted" })).map((d) => d.domain), ["done.example"]);
  await assert.rejects(store.listDrafts(db, { status: "sent" }), /status must be one of/);
});

test("edit, then accept one trial variant with a further edit: the sibling is rejected, every replaced text is kept", async () => {
  const db = admin();
  const a = await store.getDraft(db, OUTREACH_IDS.trialA);
  const saved = await store.saveEdit(db, a.id, { ...editOf(a), body: "John's first pass." }, "owner@gtm.test");
  assert.deepEqual([saved.body, saved.original_body, saved.edited_by], ["John's first pass.", a.original_body, "owner@gtm.test"]);
  await assert.rejects(store.saveEdit(db, a.id, { ...editOf(a), linkedin_note: "x".repeat(301) }, "owner@gtm.test"), /LinkedIn allows 300/);
  const r = await store.acceptDraft(db, a.id, { ...editOf(saved), subject: "John's subject" }, "owner@gtm.test");
  assert.deepEqual([r.draft.status, r.draft.subject, r.draft.decided_by], ["accepted", "John's subject", "owner@gtm.test"]);
  assert.deepEqual(r.siblings.map((s) => [s.variant, s.status, s.note]), [["model-b", "rejected", "other variant chosen"]]);
  assert.deepEqual((await versions(a.id)).map((v) => [v.reason, v.body, v.actor]), [["edited", a.body, "owner@gtm.test"], ["edited", "John's first pass.", "owner@gtm.test"]]);
  // Switching to the other variant before anything is sent flips them.
  const back = await store.acceptDraft(db, OUTREACH_IDS.trialB, null, "owner@gtm.test");
  assert.deepEqual([back.draft.status, back.siblings[0].status], ["accepted", "rejected"]);
  await store.acceptDraft(db, a.id, null, "owner@gtm.test");
});

test("send back with a note saves the edit first; reject takes an optional reason; undo returns to pending", async () => {
  const db = admin();
  const solo = await store.getDraft(db, OUTREACH_IDS.solo);
  await assert.rejects(store.sendBack(db, solo.id, "  ", null, "owner@gtm.test"), /what should change/);
  const sent = await store.sendBack(db, solo.id, "Lead with the second office.", { ...editOf(solo), body: "Sola, his version." }, "owner@gtm.test");
  assert.deepEqual([sent.status, sent.note, sent.body], ["regenerate", "Lead with the second office.", "Sola, his version."]);
  const old = await store.rejectDraft(db, OUTREACH_IDS.old, "", "owner@gtm.test");
  assert.deepEqual([old.status, old.note], ["rejected", ""]);
  const reopened = await store.reopenDraft(db, OUTREACH_IDS.old);
  assert.deepEqual([reopened.status, reopened.decided_at], ["pending", null]);
});

test("notes: what John sent back, with his edit; import replaces it (version + 1, pending, note kept in history) and never overwrites accepted or edited drafts", async () => {
  const db = admin();
  const notes = await store.regenerateNotes(db, "fx-batch-2");
  assert.deepEqual(notes.map((n) => [n.domain, n.note, n.edited, n.edited_body]), [["solo.example", "Lead with the second office.", true, "Sola, his version."]]);
  const entry = (domain: string, variant = "main") => ({ batch: "fx-batch-2", domain, variant, subject: `New subject ${domain}`, body: `New body ${domain}`, linkedin_note: "New note", model: "fixture-model-2" });
  // done.example is accepted; old.example (batch 1) is pending and untouched since its undo, so it refreshes.
  const file = JSON.stringify([entry("solo.example"), entry("done.example"), entry("trial.example", "model-a"), entry("fresh.example"), { ...entry("old.example"), batch: "fx-batch-1" }]);
  const dry = await store.importDrafts(db, file, { dryRun: true });
  assert.deepEqual([dry.inserted, dry.regenerated, dry.refreshed], [["fx-batch-2/fresh.example/main"], ["fx-batch-2/solo.example/main"], ["fx-batch-1/old.example/main"]]);
  assert.equal((await store.getDraft(db, OUTREACH_IDS.solo)).status, "regenerate", "a dry run writes nothing");
  const r = await store.importDrafts(db, file);
  assert.deepEqual([r.inserted, r.regenerated, r.refreshed, r.raced], [["fx-batch-2/fresh.example/main"], ["fx-batch-2/solo.example/main"], ["fx-batch-1/old.example/main"], []]);
  assert.deepEqual(r.kept.map((k) => k.key).sort(), ["fx-batch-2/done.example/main", "fx-batch-2/trial.example/model-a"]);
  const solo = await store.getDraft(db, OUTREACH_IDS.solo);
  assert.deepEqual([solo.status, solo.version, solo.note, solo.body, solo.original_body, solo.edited_at], ["pending", 2, "", "New body solo.example", "New body solo.example", null]);
  const regen = (await versions(solo.id)).at(-1)!;
  assert.deepEqual([regen.reason, regen.version, regen.body, regen.status, regen.note, regen.actor], ["regenerated", 1, "Sola, his version.", "regenerate", "Lead with the second office.", "pipeline"]);
  assert.equal((await store.getDraft(db, OUTREACH_IDS.done)).subject, "Fixture subject for Dona (main)", "accepted is never overwritten");
  assert.equal((await store.getDraft(db, OUTREACH_IDS.old)).subject, "New subject old.example", "an untouched pending draft is refreshed");
  assert.deepEqual(await store.regenerateNotes(db, "fx-batch-2"), []);
});

test("queues and marks: accepted drafts only; a status moves once acted on, and the prospect can no longer change", async () => {
  const db = admin();
  const li = await store.actionQueue(db, "linkedin", "fx-batch-2");
  assert.deepEqual(li.map((x) => x.domain).sort(), ["done.example", "trial.example"]);
  const email = await store.actionQueue(db, "email", "fx-batch-2");
  assert.ok(email.every((x) => x.email.endsWith(".example") && x.subject && x.body));
  await assert.rejects(store.markDraft(db, OUTREACH_IDS.solo, { email: "sent" }), /is pending; only an accepted draft/);
  await assert.rejects(store.markDraft(db, OUTREACH_IDS.done, { email: "opened" }), /--email is one of/);
  const marked = await store.markDraft(db, OUTREACH_IDS.trialA, { linkedin: "sent" });
  assert.equal(marked.linkedin_status, "sent");
  assert.deepEqual((await store.actionQueue(db, "linkedin", "fx-batch-2")).map((x) => x.domain), ["done.example"]);
  await assert.rejects(store.acceptDraft(db, OUTREACH_IDS.trialB, null, "owner@gtm.test"), /already contacted/);
  await assert.rejects(store.rejectDraft(db, OUTREACH_IDS.trialA, "", "owner@gtm.test"), /already contacted/);
  await assert.rejects(store.reopenDraft(db, OUTREACH_IDS.trialA), /already contacted/);
  const emailed = await store.markDraft(db, OUTREACH_IDS.done, { email: "sent" });
  await assert.rejects(store.saveEdit(db, emailed.id, { ...editOf(emailed), body: "too late" }, "owner@gtm.test"), /already sent/);
});
