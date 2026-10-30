// The writing desk against the real LOCAL database: dossier and profile imports (a re-import keeps John's skip), the
// queue and its states, one person's desk (AI drafts by Twenty id or company domain, his own rewrite as the prefill),
// autosave into a desk draft with history, two people at one company, mark sent (accepted, counted, queued for the
// runbook as sent), LinkedIn invite, undo, skip, the daily target, and that a sent email can no longer change. The guest
// stream (VIB-463): its own imports, sender, target and profile; mark sent by route (email, LinkedIn, intermediary), the
// single follow-up that never counts, and that the two streams never see each other's people. Synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, DESK_IDS, DESK_PROFILE, DOSSIER_FIXTURE, GUEST_FIXTURE, GUEST_IDS, GUEST_PROFILE, OUTREACH_IDS, seed, seedDesk } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const store = await import("../../lib/outreach/desk-store.ts");
const outreach = await import("../../lib/outreach/store.ts");
const { sentToday } = await import("../../lib/outreach/desk.ts");

before(async () => { await seed(); await seedDesk(); });

const actor = "owner@gtm.test";
const edit = (over: Partial<{ to: string; subject: string; body: string; linkedin_note: string }> = {}) => ({ to: "topa@top.example", subject: "A subject", body: "Hey Topa,\n\nMy words.", linkedin_note: "", ...over });
const versions = async (id: string) => (await admin().from("gtm_outreach_draft_versions").select("reason,body,actor").eq("draft_id", id).order("created_at")).data ?? [];

test("imports: dossiers upsert by person and keep John's skip; the profile replaces the stored one and keeps the target", async () => {
  const db = admin();
  const skipped = DOSSIER_FIXTURE.find((d) => d.twenty_person_id === DESK_IDS.skip)!;
  const file = JSON.stringify([{ ...skipped, prospect: { ...skipped.prospect, title: "CEO" } }, { ...DOSSIER_FIXTURE[0], twenty_person_id: "fx-p-new", domain: "new.example" }]);
  const dry = await store.importDossiers(db, file, { dryRun: true });
  assert.deepEqual([dry.inserted, dry.updated], [["fx-p-new"], [DESK_IDS.skip]]);
  assert.equal((await db.from("gtm_outreach_dossiers").select("twenty_person_id").eq("twenty_person_id", "fx-p-new")).data?.length, 0, "a dry run writes nothing");
  await store.importDossiers(db, file);
  const row = (await db.from("gtm_outreach_dossiers").select("title,skip_reason,skipped_at").eq("twenty_person_id", DESK_IDS.skip).single()).data!;
  assert.deepEqual([row.title, row.skip_reason, !!row.skipped_at], ["CEO", "Fixture skip", true]);
  await db.from("gtm_outreach_dossiers").delete().eq("twenty_person_id", "fx-p-new");

  await store.setDailyTarget(db, 7, actor);
  const r = await store.importProfile(db, JSON.stringify({ ...DESK_PROFILE, positioning: "Changed" }));
  assert.equal(r.gold_examples, 2);
  const settings = await store.deskSettings(db);
  assert.deepEqual([settings.daily_target, settings.profile.positioning], [7, "Changed"]);
  await assert.rejects(store.setDailyTarget(db, 0, actor), /1 to 200/);
  await seedDesk();
});

test("the queue: highest score first, with states; one person's desk shows AI drafts about them, not a colleague's", async () => {
  const db = admin();
  const q = await store.deskQueue(db);
  assert.deepEqual(q.map((i) => [i.twenty_person_id, i.state]), [[DESK_IDS.top, "to_write"], [DESK_IDS.tria, "to_write"], [DESK_IDS.trib, "to_write"], [DESK_IDS.wara, "to_write"], [DESK_IDS.skip, "skipped"]]);
  assert.deepEqual([q[3].client_ok, q[0].email], [false, "topa@top.example"]);

  // trial.example has two AI drafts with no Twenty id (they match by domain), and John's own rewrite for Tria by id.
  await db.from("gtm_outreach_drafts").insert({ batch: "fx-batch-2", domain: "trial.example", variant: "john", subject: "Tria, his subject", body: "His rewrite for Tria.", linkedin_note: "His note", prospect: { first_name: "Tria", twenty_person_id: DESK_IDS.tria } });
  const tria = await store.deskPerson(db, DESK_IDS.tria, DESK_PROFILE);
  assert.deepEqual(tria.reference.map((r) => r.variant).sort(), ["john", "model-a", "model-b"]);
  assert.deepEqual([tria.start.from, tria.start.subject, tria.start.body, tria.start.to], ["own", "Tria, his subject", "His rewrite for Tria.", "tria@trial.example"]);
  const trib = await store.deskPerson(db, DESK_IDS.trib, DESK_PROFILE);
  assert.deepEqual(trib.reference.map((r) => r.variant).sort(), ["model-a", "model-b"], "John's rewrite for Tria is not Trib's");
  assert.deepEqual([trib.start.from, trib.start.body], ["blank", `Hey Trib,\n\n\n\n${DESK_PROFILE.signature}`]);
  await assert.rejects(store.deskPerson(db, "nobody", DESK_PROFILE), /No dossier/);
  await assert.rejects(store.deskPerson(db, "bad id!", DESK_PROFILE), /not a Twenty person id/);
});

test("autosave creates the desk draft once, keeps every replaced text, and two people at one company each get their own", async () => {
  const db = admin();
  const first = await store.saveDesk(db, DESK_IDS.top, edit({ body: "Hey Topa,\n\nFirst pass." }), actor, DESK_PROFILE);
  assert.deepEqual([first.batch, first.variant, first.person, first.domain, first.status, first.original_body], ["desk", "john", DESK_IDS.top, "top.example", "pending", `Hey Topa,\n\n\n\n${DESK_PROFILE.signature}`]);
  assert.deepEqual([first.prospect.twenty_person_id, first.prospect.email, first.trigger.what], [DESK_IDS.top, "topa@top.example", "Topa Co posted a Head of AI Operations role"]);
  const same = await store.saveDesk(db, DESK_IDS.top, edit({ body: "Hey Topa,\n\nFirst pass." }), actor, DESK_PROFILE);
  assert.equal(same.updated_at, first.updated_at, "an unchanged save writes nothing");
  const second = await store.saveDesk(db, DESK_IDS.top, edit(), actor, DESK_PROFILE);
  assert.equal(second.id, first.id);
  assert.deepEqual(await versions(first.id), [{ reason: "edited", body: "Hey Topa,\n\nFirst pass.", actor }]);
  await assert.rejects(store.saveDesk(db, DESK_IDS.top, edit({ linkedin_note: "x".repeat(301) }), actor), /LinkedIn allows 300/);

  const tria = await store.saveDesk(db, DESK_IDS.tria, edit({ to: "tria@trial.example", body: "Hey Tria" }), actor);
  const trib = await store.saveDesk(db, DESK_IDS.trib, edit({ to: "trib@trial.example", body: "Hey Trib" }), actor);
  assert.notEqual(tria.id, trib.id);
  assert.deepEqual([tria.domain, trib.domain], ["trial.example", "trial.example"]);
  assert.equal((await store.deskQueue(db)).find((i) => i.twenty_person_id === DESK_IDS.trib)!.state, "written");
});

test("mark sent: accepts and marks the email, counts today, leaves the colleague alone, and the text is final; undo puts it back", async () => {
  const db = admin();
  await assert.rejects(store.markDeskEmailSent(db, DESK_IDS.top, edit({ subject: "" }), actor), /Add a subject/);
  const sent = await store.markDeskEmailSent(db, DESK_IDS.top, edit({ body: "Hey Topa,\n\nFinal words." }), actor, DESK_PROFILE);
  assert.deepEqual([sent.status, sent.email_status, sent.body, sent.decided_by], ["accepted", "sent", "Hey Topa,\n\nFinal words.", actor]);
  assert.ok(sent.email_sent_at);
  const q = await store.deskQueue(db);
  assert.equal(q.find((i) => i.twenty_person_id === DESK_IDS.top)!.state, "sent");
  assert.equal(sentToday(q, "Asia/Makassar"), 1);
  await assert.rejects(store.saveDesk(db, DESK_IDS.top, edit({ body: "too late" }), actor), /already sent/);
  await assert.rejects(store.markDeskEmailSent(db, DESK_IDS.top, edit({ body: "Hey Topa,\n\nFinal words." }), actor), /already marked sent/);

  // Both people at trial.example can be ready at once; neither rejects the other.
  const tria = await store.markDeskLinkedinSent(db, DESK_IDS.tria, edit({ to: "tria@trial.example", body: "Hey Tria", linkedin_note: "Hi Tria" }), actor);
  const trib = await store.markDeskEmailSent(db, DESK_IDS.trib, edit({ to: "trib@trial.example", body: "Hey Trib" }), actor);
  assert.deepEqual([tria.status, tria.linkedin_status, tria.email_status, trib.status, trib.email_status], ["accepted", "sent", "none", "accepted", "sent"]);
  assert.ok(tria.linkedin_sent_at);
  // The pipeline's AI drafts at trial.example are untouched (they are not the same person's variants).
  assert.equal((await outreach.getDraft(db, OUTREACH_IDS.trialA)).status, "pending");

  // The runbook reads desk drafts like any other: Tria's email still waits in the email queue.
  const emailQueue = await outreach.actionQueue(db, "email", "desk");
  assert.deepEqual(emailQueue.map((r) => r.email), ["tria@trial.example"]);

  const undone = await store.unmarkDeskEmailSent(db, DESK_IDS.trib);
  assert.deepEqual([undone.email_status, undone.email_sent_at], ["none", null]);
  assert.equal((await store.deskQueue(db)).find((i) => i.twenty_person_id === DESK_IDS.trib)!.state, "written");
  await assert.rejects(store.unmarkDeskEmailSent(db, DESK_IDS.wara), /not marked sent/);
});

test("skip with a reason, unskip; a person with no domain or email cannot be filed", async () => {
  const db = admin();
  const s = await store.skipPerson(db, DESK_IDS.wara, "Current client", actor);
  assert.deepEqual([s.skip_reason, s.skipped_by, !!s.skipped_at], ["Current client", actor, true]);
  assert.equal((await store.deskQueue(db)).find((i) => i.twenty_person_id === DESK_IDS.wara)!.state, "skipped");
  const u = await store.unskipPerson(db, DESK_IDS.wara);
  assert.deepEqual([u.skip_reason, u.skipped_at], ["", null]);
  await db.from("gtm_outreach_dossiers").insert({ twenty_person_id: "fx-p-nodomain", name: "No Domain", dossier: { twenty_person_id: "fx-p-nodomain", prospect: { first_name: "No" } } });
  await assert.rejects(store.saveDesk(db, "fx-p-nodomain", edit({ to: "" }), actor), /no company domain or email/);
  const filed = await store.saveDesk(db, "fx-p-nodomain", edit({ to: "no@nodomain.example" }), actor);
  assert.equal(filed.domain, "nodomain.example");
});

// ---- the guest stream (VIB-463) ----------------------------------------------------------------------------------------

const gedit = (over: Partial<{ to: string; subject: string; body: string; linkedin_note: string }> = {}) => ({ to: "", subject: "", body: "", linkedin_note: "", ...over });

test("tracks: each stream has its own sender, target and profile; an empty table falls back to the defaults (5 clients, 2 guests)", async () => {
  const db = admin();
  const t = await store.deskTracks(db);
  assert.deepEqual([t.client.daily_target, t.client.from_address, t.guest.daily_target, t.guest.from_address], [5, "user-045d73df3c9a@example.com", 2, "user-8dd8662c2f5a@example.com"]);
  assert.deepEqual([t.client.profile.signature, t.guest.profile.signature], [DESK_PROFILE.signature, GUEST_PROFILE.signature]);
  assert.equal(await store.setDailyTarget(db, 4, actor, "guest"), 4);
  assert.deepEqual([(await store.deskSettings(db, "guest")).daily_target, (await store.deskSettings(db)).daily_target], [4, 5], "the guest target moved, the client's did not");
  await assert.rejects(store.setDailyTarget(db, 201, actor, "guest"), /1 to 200/);
  // Empty table: the old single desk row still answers for clients, then the defaults.
  await db.from("gtm_outreach_tracks").delete().in("track", ["client", "guest"]);
  const empty = await store.deskTracks(db);
  assert.deepEqual([empty.client.daily_target, empty.client.from_address, empty.guest.daily_target, empty.guest.from_address, empty.guest.profile], [5, "user-045d73df3c9a@example.com", 2, "user-8dd8662c2f5a@example.com", {}]);
  await db.from("gtm_outreach_desk").upsert({ id: true, daily_target: 9, profile: { signature: "Old" } }, { onConflict: "id" });
  assert.deepEqual([(await store.deskSettings(db)).daily_target, (await store.deskSettings(db)).profile.signature, (await store.deskSettings(db, "guest")).daily_target], [9, "Old", 2], "clients fall back to the old desk row");
  // Setting a target on an empty table makes the row with the track's own sender.
  await store.setDailyTarget(db, 3, actor, "guest");
  assert.deepEqual((await db.from("gtm_outreach_tracks").select("track,daily_target,from_address").eq("track", "guest").single()).data, { track: "guest", daily_target: 3, from_address: "user-8dd8662c2f5a@example.com" });
  await seedDesk();
});

test("guest imports: dossiers and profile go to their own stream; the wrong file, or a person on the other stream, is refused", async () => {
  const db = admin();
  const file = JSON.stringify([{ ...GUEST_FIXTURE[0], guest: { ...GUEST_FIXTURE[0].guest, pillar: "Changed pillar" } }, { ...GUEST_FIXTURE[0], twenty_person_id: "fx-g-new", domain: "new-guest.example" }]);
  await assert.rejects(store.importDossiers(db, file), /is a guest, but this is a client import/);
  await assert.rejects(store.importDossiers(db, JSON.stringify(DOSSIER_FIXTURE), { track: "guest" }), /is a row with no track, but this is a guest import/);
  const dry = await store.importDossiers(db, file, { dryRun: true, track: "guest" });
  assert.deepEqual([dry.inserted, dry.updated], [["fx-g-new"], [GUEST_IDS.email]]);
  await store.importDossiers(db, file, { track: "guest" });
  const rows = (await db.from("gtm_outreach_dossiers").select("twenty_person_id,track,score,dossier").in("twenty_person_id", [GUEST_IDS.email, "fx-g-new"]).order("twenty_person_id")).data!;
  assert.deepEqual(rows.map((r) => [r.twenty_person_id, r.track, r.score]), [[GUEST_IDS.email, "guest", 90], ["fx-g-new", "guest", 90]]);
  assert.equal(rows[0].dossier.guest.pillar, "Changed pillar");
  // A client id in a guest file would flip its stream: refused.
  const takeover = JSON.stringify([{ ...GUEST_FIXTURE[0], twenty_person_id: DESK_IDS.top }]);
  await assert.rejects(store.importDossiers(db, takeover, { track: "guest" }), /already filed under the other track/);
  await db.from("gtm_outreach_dossiers").delete().eq("twenty_person_id", "fx-g-new");

  const r = await store.importProfile(db, JSON.stringify({ ...GUEST_PROFILE, positioning: "Guest changed" }), { track: "guest" });
  assert.deepEqual([r.gold_examples, r.templates], [1, 2]);
  assert.deepEqual([(await store.deskSettings(db, "guest")).profile.positioning, (await store.deskSettings(db, "client")).profile.positioning], ["Guest changed", "Fixture positioning line."], "the client profile is untouched");
  await store.importProfile(db, JSON.stringify({ ...DESK_PROFILE, positioning: "Client changed" }));
  assert.deepEqual([(await store.deskSettings(db, "client")).profile.positioning, (await store.deskSettings(db, "guest")).profile.positioning], ["Client changed", "Guest changed"], "a client import writes the client track now");
  assert.equal((await store.deskSettings(db, "client")).daily_target, 5, "the target is kept");
  await seedDesk();
});

test("track isolation: a guest never shows in the client queue or the reverse, and an action for the wrong stream is refused", async () => {
  const db = admin();
  const clients = await store.deskQueue(db, "client");
  const guests = await store.deskQueue(db, "guest");
  assert.ok(clients.every((i) => i.track === "client") && !clients.some((i) => i.twenty_person_id.startsWith("fx-g-") || i.twenty_person_id.startsWith("guest-md:")));
  assert.deepEqual(guests.map((i) => [i.twenty_person_id, i.track, i.state, i.route ?? null]), [
    [GUEST_IDS.email, "guest", "to_write", "email"], [GUEST_IDS.linkedin, "guest", "to_write", "linkedin"], [GUEST_IDS.inter, "guest", "to_write", "intermediary"], [GUEST_IDS.followup, "guest", "to_write", "email"],
  ], "tier A first by score");
  assert.equal(String(guests[2].not_in_twenty), "true");
  await assert.rejects(store.saveDesk(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", body: "x" }), actor, {}, "client"), /guest stream, not the client stream/);
  await assert.rejects(store.saveDesk(db, DESK_IDS.top, edit(), actor, {}, "guest"), /client stream, not the guest stream/);
  await assert.rejects(store.deskPerson(db, GUEST_IDS.email, GUEST_PROFILE, "client"), /guest stream/);
  await assert.rejects(store.markDeskSent(db, DESK_IDS.top, edit(), actor, {}, "guest"), /client stream/);
  await assert.rejects(store.skipPerson(db, GUEST_IDS.email, "x", actor, "client"), /guest stream/);
  await assert.rejects(store.markDeskFollowUpSent(db, GUEST_IDS.email, "client"), /guest stream/);
  await assert.rejects(store.markDeskLinkedinSent(db, GUEST_IDS.email, edit({ to: "gia@gia.example", body: "Hey Gia", linkedin_note: "Hi Gia" }), actor, {}, "guest"), /client stream/, "the client invite button never marks a guest: a guest goes by its route");
  // A saved guest draft carries the track, route and domain, and stays out of the client queue's drafts.
  const d = await store.saveDesk(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", subject: "S", body: "Hey Gia,\n\nMine." }), actor, GUEST_PROFILE, "guest");
  assert.deepEqual([d.track, d.route, d.domain, d.person, d.batch, d.original_body], ["guest", "email", "gia.example", GUEST_IDS.email, "desk", `Hey Gia,\n\n\n\n${GUEST_PROFILE.signature}`]);
  assert.equal((await store.deskQueue(db, "guest")).find((i) => i.twenty_person_id === GUEST_IDS.email)!.state, "written");
  assert.ok((await store.deskQueue(db, "client")).every((i) => i.state !== "written" || i.twenty_person_id !== GUEST_IDS.email));
  // The same text in each stream's drafts: a client's AI reference drafts never appear for a guest (and the reverse).
  assert.equal((await store.deskPerson(db, GUEST_IDS.email, GUEST_PROFILE, "guest")).reference.length, 0);
});

test("guest mark sent by route: email and intermediary set email_status, LinkedIn sets linkedin_status; each counts toward the guest target only", async () => {
  const db = admin();
  const { sentToday } = await import("../../lib/outreach/desk.ts");
  const clients0 = await store.deskQueue(db, "client");
  // Email: the same checks as a client's.
  await assert.rejects(store.markDeskSent(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", body: "x" }), actor, GUEST_PROFILE, "guest"), /Add a subject/);
  const email = await store.markDeskSent(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", subject: "S", body: "Hey Gia,\n\nMine." }), actor, GUEST_PROFILE, "guest");
  assert.deepEqual([email.status, email.email_status, email.linkedin_status, email.route, !!email.email_sent_at], ["accepted", "sent", "none", "email", true]);
  await assert.rejects(store.markDeskSent(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", subject: "S", body: "Hey Gia,\n\nMine." }), actor, GUEST_PROFILE, "guest"), /already marked sent|already sent/);
  await assert.rejects(store.saveDesk(db, GUEST_IDS.email, gedit({ to: "gia@gia.example", subject: "S", body: "too late" }), actor, GUEST_PROFILE, "guest"), /already sent/);

  // LinkedIn: the note, through the LinkedIn status; no address or subject needed.
  await assert.rejects(store.markDeskSent(db, GUEST_IDS.linkedin, gedit({ body: "Hey Lio" }), actor, GUEST_PROFILE, "guest"), /LinkedIn note is empty/);
  const li = await store.markDeskSent(db, GUEST_IDS.linkedin, gedit({ linkedin_note: "Hi Lio, a note." }), actor, GUEST_PROFILE, "guest");
  assert.deepEqual([li.status, li.linkedin_status, li.email_status, li.route, !!li.linkedin_sent_at, !!li.email_sent_at, li.linkedin_note], ["accepted", "sent", "none", "linkedin", true, false, "Hi Lio, a note."]);
  await assert.rejects(store.saveDesk(db, GUEST_IDS.linkedin, gedit({ linkedin_note: "changed" }), actor, GUEST_PROFILE, "guest"), /note was already sent/);

  // Intermediary: email_status sent with route intermediary; only the message is needed.
  await assert.rejects(store.markDeskSent(db, GUEST_IDS.inter, gedit(), actor, GUEST_PROFILE, "guest"), /message is empty/);
  const inter = await store.markDeskSent(db, GUEST_IDS.inter, gedit({ body: "Dear council office," }), actor, GUEST_PROFILE, "guest");
  assert.deepEqual([inter.email_status, inter.linkedin_status, inter.route, inter.domain, !!inter.email_sent_at], ["sent", "none", "intermediary", "ina-fixture.guest.invalid", true]);

  const guests = await store.deskQueue(db, "guest");
  const clientsBefore = sentToday(clients0, "Asia/Makassar", "client");
  assert.deepEqual(guests.filter((i) => i.state === "sent").map((i) => i.twenty_person_id).sort(), [GUEST_IDS.email, GUEST_IDS.inter, GUEST_IDS.linkedin].sort());
  assert.equal(sentToday(guests, "Asia/Makassar", "guest"), 3, "any route counts toward the guest target");
  assert.equal(sentToday(await store.deskQueue(db, "client"), "Asia/Makassar", "client"), clientsBefore, "and none toward the client target");

  // Undo is by route.
  const undoLi = await store.unmarkDeskSent(db, GUEST_IDS.linkedin, "guest");
  assert.deepEqual([undoLi.linkedin_status, undoLi.linkedin_sent_at], ["none", null]);
  const undoInter = await store.unmarkDeskSent(db, GUEST_IDS.inter, "guest");
  assert.deepEqual([undoInter.email_status, undoInter.email_sent_at], ["none", null]);
  assert.equal(sentToday(await store.deskQueue(db, "guest"), "Asia/Makassar", "guest"), 1);
  await assert.rejects(store.unmarkDeskSent(db, GUEST_IDS.linkedin, "guest"), /not marked sent/);
});

test("the follow-up: stamped by the database, undone cleanly, and never counts toward the target", async () => {
  const db = admin();
  const { sentToday, followUpDue } = await import("../../lib/outreach/desk.ts");
  await assert.rejects(store.markDeskFollowUpSent(db, GUEST_IDS.followup, "guest"), /first message sent/);
  // Eli was reached 8 days ago (the trigger stamps only when no time is given).
  const eight = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await store.saveDesk(db, GUEST_IDS.followup, gedit({ to: "eli@eli.example", subject: "S", body: "Hey Eli,\n\nMine." }), actor, GUEST_PROFILE, "guest");
  const sent = await store.markDeskSent(db, GUEST_IDS.followup, gedit({ to: "eli@eli.example", subject: "S", body: "Hey Eli,\n\nMine." }), actor, GUEST_PROFILE, "guest");
  await db.from("gtm_outreach_drafts").update({ email_sent_at: eight }).eq("id", sent.id);
  let q = (await store.deskQueue(db, "guest")).find((i) => i.twenty_person_id === GUEST_IDS.followup)!;
  assert.ok(followUpDue(q, "Asia/Makassar"), "8 days on, no reply, no follow-up: due");
  assert.equal(sentToday([q], "Asia/Makassar", "guest"), 0, "sent 8 days ago is not sent today");

  const fu = await store.markDeskFollowUpSent(db, GUEST_IDS.followup, "guest");
  assert.deepEqual([fu.follow_up_status, !!fu.follow_up_sent_at, Date.parse(fu.email_sent_at!)], ["sent", true, Date.parse(eight)], "the database stamps follow_up_sent_at and leaves email_sent_at alone");
  q = (await store.deskQueue(db, "guest")).find((i) => i.twenty_person_id === GUEST_IDS.followup)!;
  assert.deepEqual([followUpDue(q, "Asia/Makassar"), q.follow_up_status], [false, "sent"]);
  assert.equal(sentToday(await store.deskQueue(db, "guest"), "Asia/Makassar", "guest"), 1, "the follow-up sent just now did not count (only Gia's email from the last test)");
  assert.equal((await store.markDeskFollowUpSent(db, GUEST_IDS.followup, "guest")).follow_up_sent_at, fu.follow_up_sent_at, "marking twice keeps the first stamp");
  await assert.rejects(store.unmarkDeskSent(db, GUEST_IDS.followup, "guest"), /follow-up not sent first/);
  const undone = await store.unmarkDeskFollowUpSent(db, GUEST_IDS.followup, "guest");
  assert.deepEqual([undone.follow_up_status, undone.follow_up_sent_at], ["none", null]);
  await assert.rejects(store.unmarkDeskFollowUpSent(db, GUEST_IDS.followup, "guest"), /No follow-up is marked sent/);
  // A reply ends the follow-up.
  await outreach.markDraft(db, sent.id, { email: "replied" });
  q = (await store.deskQueue(db, "guest")).find((i) => i.twenty_person_id === GUEST_IDS.followup)!;
  assert.deepEqual([q.state, followUpDue(q, "Asia/Makassar")], ["sent", false]);
});
