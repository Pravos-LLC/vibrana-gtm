// Cold outreach drafts (/outreach, gtm outreach): import validation and normalization, what an import does to each
// existing row, the notes export, the action queues, batches and prospect grouping, and edit checks. Pure functions only;
// the database paths are in test/db/outreach.test.ts. Synthetic data only: .example domains and made-up people.
import { test } from "node:test";
import assert from "node:assert/strict";

const { batchesOf, editProblems, groupByProspect, isEdited, noteExport, normalizeImport, parseImport, planImport, queueRows, sameEdit, editOf } = await import("../lib/outreach/model.ts");
type Draft = import("../lib/outreach/model.ts").Draft;

const entry = (over: Record<string, unknown> = {}) => ({
  batch: "b-2026-10-16", domain: "acme.example", variant: "model-a", prospect: { first_name: "Ada", last_name: "Example", email: "ada@acme.example", linkedin_url: "https://www.linkedin.com/in/ada-example" },
  trigger: { what: "Opened a second office", date: "2026-10-01", url: "https://acme.example/news" }, strategy: { problem: "p", proof: "q", door: "d" },
  subject: "A subject", body: "A body", linkedin_note: "Hi Ada", followups: [{ day: 3, subject: "", body: "Bump", topic: "nudge" }],
  claims: [{ claim: "c", source_url: "https://acme.example/news", quote: "q" }], findings: [{ level: "advice", code: "long", detail: "d" }], model: "model-a", ...over,
});
let seq = 0;
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
  batch: "b-2026-10-16", domain: "acme.example", variant: "model-a", prospect: { first_name: "Ada", last_name: "Example", email: "ada@acme.example", linkedin_url: "https://www.linkedin.com/in/ada-example", score: 70 },
  trigger: {}, strategy: {}, subject: "S", body: "B", original_subject: "S", original_body: "B", linkedin_note: "Hi", followups: [], claims: [], findings: [],
  model: "model-a", version: 1, status: "pending", note: "", decided_by: null, decided_at: null, edited_by: null, edited_at: null, linkedin_status: "none", email_status: "none", ...over,
});

test("normalizeImport: lowercase domain without www, 'main' when no variant, the original is the draft unless given, empty collections", () => {
  const d = normalizeImport({ batch: " b1 ", domain: "WWW.Acme.Example", subject: "S", body: "B" });
  assert.deepEqual([d.batch, d.domain, d.variant, d.original_subject, d.original_body, d.followups, d.claims, d.findings, d.prospect], ["b1", "acme.example", "main", "S", "B", [], [], [], {}]);
  assert.equal(normalizeImport({ ...entry(), original_body: "agent" }).original_body, "agent");
});

test("parseImport: every problem is reported with its draft, nothing half-parsed; duplicates in one file are refused", () => {
  assert.equal(parseImport(JSON.stringify([entry(), entry({ variant: "model-b" })])).length, 2);
  assert.throws(() => parseImport("{}"), /JSON array/);
  assert.throws(() => parseImport("nope"), /not JSON/);
  const bad = (() => { try { parseImport(JSON.stringify([
    entry({ linkedin_note: "x".repeat(301) }), entry({ domain: "not a domain", variant: "b" }), entry({ variant: "c", subject: "" }),
    entry({ variant: "d", findings: [{ level: "fatal" }] }), entry({ variant: "e", followups: "day 3" }), entry(), 7,
  ])); return ""; } catch (e) { return (e as Error).message; } })();
  for (const re of [/acme.example\/model-a: linkedin_note is 301 characters/, /domain "not a domain" is not a hostname/, /acme.example\/c: no subject/, /level 'block' or 'advice'/, /followups must be an array/, /listed twice/, /entry 7: not an object/]) assert.match(bad, re);
});

test("planImport: new is inserted; sent back is regenerated; untouched pending is refreshed; accepted, rejected or edited is kept", () => {
  const incoming = parseImport(JSON.stringify(["new.example", "regen.example", "fresh.example", "acc.example", "rej.example", "edit.example"].map((domain) => entry({ domain }))));
  const existing = [
    draft({ domain: "regen.example", status: "regenerate", note: "shorter" }), draft({ domain: "fresh.example" }),
    draft({ domain: "acc.example", status: "accepted" }), draft({ domain: "rej.example", status: "rejected" }), draft({ domain: "edit.example", edited_at: "2026-10-16T01:00:00Z" }),
    draft({ domain: "regen.example", variant: "model-b", status: "regenerate" }), // another variant: not this key
  ];
  const plan = planImport(incoming, existing);
  assert.deepEqual(plan.map((a) => [a.draft.domain, a.kind, a.kind === "keep" ? a.reason : ""]), [
    ["new.example", "insert", ""], ["regen.example", "regenerate", ""], ["fresh.example", "refresh", ""],
    ["acc.example", "keep", "John accepted it"], ["rej.example", "keep", "John rejected it"], ["edit.example", "keep", "John edited it"],
  ]);
});

test("noteExport: John's note with the current text, and his edit only when he made one", () => {
  const plain = noteExport(draft({ status: "regenerate", note: "Lead with the office" }));
  assert.deepEqual([plain.note, plain.edited, plain.edited_body, plain.body], ["Lead with the office", false, null, "B"]);
  const edited = noteExport(draft({ status: "regenerate", note: "n", body: "B, his words", subject: "S2" }));
  assert.deepEqual([edited.edited, edited.edited_body, edited.edited_subject, edited.original_body], [true, "B, his words", "S2", "B"]);
});

test("queueRows: a guest's desk draft never reaches the client email or LinkedIn runbooks", () => {
  const rows = [draft({ domain: "a.example", status: "accepted" }), draft({ domain: "ada.guest.invalid", status: "accepted", track: "guest" } as never)];
  assert.deepEqual(queueRows(rows, "email").map((r) => r.domain), ["a.example"]);
  assert.deepEqual(queueRows(rows, "linkedin").map((r) => r.domain), ["a.example"]);
});

test("queueRows: only accepted drafts not yet acted on, with what the channel needs", () => {
  const rows = [
    draft({ domain: "a.example", status: "accepted" }),
    draft({ domain: "b.example", status: "accepted", linkedin_status: "sent", email_status: "queued" }),
    draft({ domain: "c.example", status: "accepted", prospect: { first_name: "No", email: null, linkedin_url: null } }),
    draft({ domain: "d.example", status: "pending" }),
    draft({ domain: "e.example", status: "accepted", linkedin_note: "  " }),
  ];
  assert.deepEqual(queueRows(rows, "linkedin").map((r) => r.domain), ["a.example"]);
  const email = queueRows(rows, "email");
  assert.deepEqual(email.map((r) => [r.domain, r.email, r.email_status]), [["a.example", "ada@acme.example", "none"], ["b.example", "ada@acme.example", "queued"], ["e.example", "ada@acme.example", "none"]]);
  assert.equal(email[0].name, "Ada Example");
});

test("batchesOf: newest batch first, by its newest draft", () => {
  assert.deepEqual(batchesOf([{ batch: "old", created_at: "2026-10-01" }, { batch: "new", created_at: "2026-10-15" }, { batch: "old", created_at: "2026-10-02" }]), ["new", "old"]);
});

test("groupByProspect: variants of one prospect together ('main' first), undecided prospects first, then by score", () => {
  const groups = groupByProspect([
    draft({ domain: "done.example", status: "accepted", prospect: { score: 99 } }),
    draft({ domain: "low.example", prospect: { score: 10 } }),
    draft({ domain: "trial.example", variant: "z-model", prospect: { score: 50 } }),
    draft({ domain: "trial.example", variant: "main", prospect: { score: 50 } }),
    draft({ domain: "trial.example", variant: "a-model", status: "rejected", prospect: { score: 50 } }),
  ]);
  assert.deepEqual(groups.map((g) => g.domain), ["trial.example", "low.example", "done.example"]);
  assert.deepEqual(groups[0].drafts.map((d) => d.variant), ["main", "a-model", "z-model"]);
});

test("editProblems and sameEdit: empty text and an over-long LinkedIn note are refused; an unchanged edit is the same", () => {
  const d = draft({ followups: [{ day: 3, body: "x" }] });
  const e = editOf(d);
  assert.deepEqual(editProblems(e), []);
  assert.ok(sameEdit(e, editOf(draft({ followups: [{ day: 3, body: "x" }] }))));
  assert.ok(!sameEdit(e, { ...e, followups: [{ day: 3, body: "y" }] }));
  assert.match(editProblems({ ...e, linkedin_note: "x".repeat(301) }).join(), /301 characters; LinkedIn allows 300/);
  assert.match(editProblems({ ...e, body: " " }).join(), /email is empty/);
  assert.ok(isEdited({ subject: "S", body: "B!", original_subject: "S", original_body: "B" }));
  assert.ok(!isEdited({ subject: "S", body: "B", original_subject: "S", original_body: "B" }));
});
