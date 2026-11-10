// The writing desk against the real LOCAL database: dossier and profile imports (a re-import keeps John's skip), the
// queue and its states, one person's desk (AI drafts by Twenty id or company domain, his own rewrite as the prefill),
// autosave into a desk draft with history, two people at one company, mark sent (accepted, counted, queued for the
// runbook as sent), LinkedIn invite, undo, skip, the daily target, and that a sent email can no longer change. The guest
// stream (VIB-463): its own imports, sender, target and profile; mark sent by route (email, LinkedIn, intermediary), the
// single follow-up that never counts, and that the two streams never see each other's people. The network stream (VIB-522):
// its seeded row, imports, mark sent by email or LinkedIn, the follow-up, no AI angles, and three-way isolation. Synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, DESK_IDS, DESK_PROFILE, DOSSIER_FIXTURE, GUEST_FIXTURE, GUEST_IDS, GUEST_PROFILE, NETWORK_FIXTURE, NETWORK_IDS, NETWORK_PROFILE, OUTREACH_IDS, seed, seedDesk } from "../support/seed.ts";
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
  await db.from("gtm_outreach_tracks").delete().in("track", ["client", "guest", "network"]);
  const empty = await store.deskTracks(db);
  assert.deepEqual([empty.client.daily_target, empty.client.from_address, empty.guest.daily_target, empty.guest.from_address, empty.guest.profile], [5, "user-045d73df3c9a@example.com", 2, "user-8dd8662c2f5a@example.com", {}]);
  assert.deepEqual([empty.network.daily_target, empty.network.from_address, empty.network.profile], [15, "user-f538cb95fc21@example.com", {}], "the network falls back to 15 from its runtime sender");
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
  await assert.rejects(store.importDossiers(db, takeover, { track: "guest" }), /already filed under another track/);
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

// ---- the network stream (VIB-522) --------------------------------------------------------------------------------------

test("network: the seeded row, its own imports and profile; a network id never changes stream", async () => {
  const db = admin();
  const t = await store.deskTracks(db);
  assert.deepEqual([t.network.daily_target, t.network.from_address, t.network.profile.signature], [15, "user-f538cb95fc21@example.com", NETWORK_PROFILE.signature]);
  assert.equal(await store.setDailyTarget(db, 12, actor, "network"), 12);
  assert.deepEqual([(await store.deskSettings(db, "network")).daily_target, (await store.deskSettings(db, "guest")).daily_target, (await store.deskSettings(db)).daily_target], [12, 2, 5], "only the network target moved");
  const file = JSON.stringify([{ ...NETWORK_FIXTURE[0], network: { ...NETWORK_FIXTURE[0].network, context: "Changed context" } }]);
  await assert.rejects(store.importDossiers(db, file, { track: "guest" }), /is a network, but this is a guest import/);
  await assert.rejects(store.importDossiers(db, JSON.stringify(GUEST_FIXTURE), { track: "network" }), /is a guest, but this is a network import/);
  const r = await store.importDossiers(db, file, { track: "network" });
  assert.deepEqual([r.inserted, r.updated], [[], [NETWORK_IDS.email]]);
  const row = (await db.from("gtm_outreach_dossiers").select("track,score,dossier").eq("twenty_person_id", NETWORK_IDS.email).single()).data!;
  assert.deepEqual([row.track, row.score, row.dossier.network.context, row.dossier.network.tier], ["network", 85, "Changed context", "T1"]);
  await assert.rejects(store.importDossiers(db, JSON.stringify([{ ...NETWORK_FIXTURE[0], twenty_person_id: GUEST_IDS.email }]), { track: "network" }), /already filed under another track/);
  const p = await store.importProfile(db, JSON.stringify({ ...NETWORK_PROFILE, positioning: "Network changed" }), { track: "network" });
  assert.equal(p.gold_examples, 1);
  assert.deepEqual([(await store.deskSettings(db, "network")).profile.positioning, (await store.deskSettings(db, "guest")).profile.positioning, (await store.deskSettings(db, "network")).daily_target], ["Network changed", GUEST_PROFILE.positioning, 12], "the other streams are untouched and the target is kept");
  await seedDesk();
});

test("network: three-way isolation of queues and actions", async () => {
  const db = admin();
  const queues = { client: await store.deskQueue(db, "client"), guest: await store.deskQueue(db, "guest"), network: await store.deskQueue(db, "network") };
  assert.deepEqual(queues.network.map((i) => [i.twenty_person_id, i.track, i.state, i.route ?? null]), [
    [NETWORK_IDS.email, "network", "to_write", "email"], [NETWORK_IDS.linkedin, "network", "to_write", "linkedin"], [NETWORK_IDS.followup, "network", "to_write", "email"],
  ]);
  const ids = new Set(Object.values(NETWORK_IDS));
  assert.ok(!queues.client.some((i) => ids.has(i.twenty_person_id)) && !queues.guest.some((i) => ids.has(i.twenty_person_id)), "no network person in the client or guest queue");
  assert.ok(!queues.network.some((i) => i.track !== "network"), "and only network people in the network queue");
  await assert.rejects(store.saveDesk(db, NETWORK_IDS.email, gedit({ body: "x" }), actor, NETWORK_PROFILE, "guest"), /network stream, not the guest stream/);
  await assert.rejects(store.saveDesk(db, GUEST_IDS.email, gedit({ body: "x" }), actor, NETWORK_PROFILE, "network"), /guest stream, not the network stream/);
  await assert.rejects(store.markDeskSent(db, DESK_IDS.top, edit(), actor, NETWORK_PROFILE, "network"), /client stream, not the network stream/);
  await assert.rejects(store.markDeskLinkedinSent(db, NETWORK_IDS.linkedin, gedit({ linkedin_note: "Hi Ned" }), actor, NETWORK_PROFILE, "network"), /Mark invite sent is for the client stream/);
  await assert.rejects(store.deskPerson(db, NETWORK_IDS.email, NETWORK_PROFILE, "client"), /network stream, not the client stream/);
});

test("network: mark sent by route (email or LinkedIn note), any route counts, the note is final; the follow-up never counts", async () => {
  const db = admin();
  const { followUpDue } = await import("../../lib/outreach/desk.ts");
  const person = await store.deskPerson(db, NETWORK_IDS.email, NETWORK_PROFILE, "network");
  assert.deepEqual([person.start.to, person.start.body], ["nia@nia.example", `Hey Nia,\n\n\n\n${NETWORK_PROFILE.signature}`], "a blank composer with the network signature");
  await assert.rejects(store.markDeskSent(db, NETWORK_IDS.email, gedit({ to: "nia@nia.example", body: "Hey Nia," }), actor, NETWORK_PROFILE, "network"), /Add a subject/);
  const email = await store.markDeskSent(db, NETWORK_IDS.email, gedit({ to: "nia@nia.example", subject: "Catching up", body: "Hey Nia,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  assert.deepEqual([email.track, email.route, email.status, email.email_status, email.prospect.twenty_person_id, !!email.email_sent_at], ["network", "email", "accepted", "sent", NETWORK_IDS.email, true],
    "an email is stamped where the Twenty write-back looks (email_sent_at, prospect.twenty_person_id)");
  await assert.rejects(store.markDeskSent(db, NETWORK_IDS.linkedin, gedit({ body: "Hey Ned" }), actor, NETWORK_PROFILE, "network"), /LinkedIn note is empty/);
  const li = await store.markDeskSent(db, NETWORK_IDS.linkedin, gedit({ linkedin_note: "Hi Ned, good to see your news." }), actor, NETWORK_PROFILE, "network");
  assert.deepEqual([li.route, li.linkedin_status, li.email_status, li.domain], ["linkedin", "sent", "none", "ned-fixture.network.invalid"]);
  await assert.rejects(store.saveDesk(db, NETWORK_IDS.linkedin, gedit({ linkedin_note: "changed" }), actor, NETWORK_PROFILE, "network"), /note was already sent/);
  let q = await store.deskQueue(db, "network");
  assert.deepEqual(q.filter((i) => i.state === "sent").map((i) => i.twenty_person_id), [NETWORK_IDS.email, NETWORK_IDS.linkedin]);
  assert.equal(sentToday(q, "Asia/Makassar", "network"), 2, "the email and the LinkedIn note both count");
  const undo = await store.unmarkDeskSent(db, NETWORK_IDS.linkedin, "network");
  assert.deepEqual([undo.linkedin_status, undo.linkedin_sent_at, undo.status], ["none", null, "accepted"]);
  // Accepted, not sent, with a LinkedIn URL and note: exactly what the cold LinkedIn runbook picks up, were it a client.
  assert.ok(!(await outreach.actionQueue(db, "linkedin", "desk")).some((r) => r.id === undo.id), "a network note never reaches the cold LinkedIn queue");
  assert.ok(!(await outreach.actionQueue(db, "email", "desk")).some((r) => r.domain === "nia.example" || r.domain === "noa.example"), "nor the cold email queue");
  assert.equal(sentToday(await store.deskQueue(db, "network"), "Asia/Makassar", "network"), 1);

  // The follow-up, 8 days after Noa's email.
  await assert.rejects(store.markDeskFollowUpSent(db, NETWORK_IDS.followup, "network"), /first message sent/);
  const sent = await store.markDeskSent(db, NETWORK_IDS.followup, gedit({ to: "noa@noa.example", subject: "S", body: "Hey Noa,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  await db.from("gtm_outreach_drafts").update({ email_sent_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }).eq("id", sent.id);
  q = await store.deskQueue(db, "network");
  assert.ok(followUpDue(q.find((i) => i.twenty_person_id === NETWORK_IDS.followup)!, "Asia/Makassar"), "8 days on, no reply: due");
  const fu = await store.markDeskFollowUpSent(db, NETWORK_IDS.followup, "network");
  assert.deepEqual([fu.follow_up_status, !!fu.follow_up_sent_at], ["sent", true]);
  assert.equal(sentToday(await store.deskQueue(db, "network"), "Asia/Makassar", "network"), 1, "the follow-up did not count (only Nia's email)");
  assert.equal((await store.unmarkDeskFollowUpSent(db, NETWORK_IDS.followup, "network")).follow_up_status, "none");
  await assert.rejects(store.markDeskFollowUpSent(db, DESK_IDS.top, "client"), /Follow-ups are for the guest and network streams/);
});

// ---- the network desk's history leg (VIB-522): re-imports and replies --------------------------------------------------

/** The network stream as the seed leaves it: the fixture's three people, nobody skipped, no desk drafts. */
async function resetNetwork() {
  const db = admin();
  await db.from("gtm_outreach_drafts").delete().eq("batch", "desk").eq("track", "network");
  await db.from("gtm_outreach_dossiers").delete().eq("track", "network").not("twenty_person_id", "in", `(${Object.values(NETWORK_IDS).join(",")})`);
  await db.from("gtm_outreach_dossiers").update({ skipped_at: null, skip_reason: "", skipped_by: null }).eq("track", "network");
  await store.importDossiers(db, JSON.stringify(NETWORK_FIXTURE), { track: "network" });
}

test("network re-import: dossiers, scores and queue order update; drafts, sends, replies, follow-ups and skips never change", async () => {
  const db = admin();
  await resetNetwork();
  const { followUpDue } = await import("../../lib/outreach/desk.ts");
  // John's work on the desk before the re-import: Nia emailed and replied, Noa emailed and followed up, Ned's note written then skipped.
  await store.markDeskSent(db, NETWORK_IDS.email, gedit({ to: "nia@nia.example", subject: "Catching up", body: "Hey Nia,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  await store.markDeskReplied(db, NETWORK_IDS.email, "network");
  await store.markDeskSent(db, NETWORK_IDS.followup, gedit({ to: "noa@noa.example", subject: "Long time", body: "Hey Noa,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  await store.markDeskFollowUpSent(db, NETWORK_IDS.followup, "network");
  await store.saveDesk(db, NETWORK_IDS.linkedin, gedit({ linkedin_note: "Hi Ned, my own note." }), actor, NETWORK_PROFILE, "network");
  await store.skipPerson(db, NETWORK_IDS.linkedin, "Fixture: not now", actor, "network");
  const drafts = async () => (await db.from("gtm_outreach_drafts").select("*").eq("batch", "desk").eq("track", "network").order("person")).data!;
  const skips = async () => (await db.from("gtm_outreach_dossiers").select("twenty_person_id,skipped_at,skip_reason,skipped_by").eq("track", "network").order("twenty_person_id")).data!;
  const beforeDrafts = await drafts(), beforeSkips = await skips();
  assert.equal(beforeDrafts.length, 3);

  // The new export: every score moves (Nia from first to last), the warm and history keys arrive, and Rio is new.
  const RIO = "00000000-0000-4000-8000-00000000ae04";
  const warm = (score: number, rank: number) => ({ score, rank, parts: { relationship: 25, recency: 20, role: 15, reach: score - 60 > 0 ? score - 60 : 0, connector: 0 } });
  const [nia, ned, noa] = NETWORK_FIXTURE;
  const file = JSON.stringify([
    { ...nia, score: 10, network: { ...nia.network, warm: warm(10, 4), last_channel: "gmail", last_exchanged_at: "2026-03-04", last_thread_url: "https://mail.google.com/mail/?authuser=jo@fixture.example#all/18c2f0a1b2c3d4e5", history: { linkedin: { sent: 0, received: 0 }, gmail: { sent: 7, received: 5 } }, connected_on: null } },
    { ...ned, score: 99, prospect: { ...ned.prospect, title: "Managing Partner", company: "Ned Ventures" }, network: { ...ned.network, warm: warm(99, 1), last_thread_url: "https://www.linkedin.com/messaging/thread/2-Fixture==/", connected_on: "2019-05-02" } },
    { ...noa, score: 65, network: { ...noa.network, warm: warm(65, 3) } },
    { ...nia, twenty_person_id: RIO, domain: "rio.example", score: 80, prospect: { ...nia.prospect, first_name: "Rio", email: "rio@rio.example" }, network: { ...nia.network, warm: warm(80, 2), context: "Fixture: Rio" } },
  ]);
  const r = await store.importDossiers(db, file, { track: "network" });
  assert.deepEqual([r.inserted, [...r.updated].sort()], [[RIO], [NETWORK_IDS.email, NETWORK_IDS.linkedin, NETWORK_IDS.followup].sort()]);

  assert.deepEqual(await drafts(), beforeDrafts, "every desk draft is byte for byte what it was: text, sent, replied, follow-up");
  assert.deepEqual((await skips()).filter((s) => s.twenty_person_id !== RIO), beforeSkips, "Ned stays skipped, with his reason");
  const nedRow = (await db.from("gtm_outreach_dossiers").select("score,title,company,dossier").eq("twenty_person_id", NETWORK_IDS.linkedin).single()).data!;
  assert.deepEqual([nedRow.score, nedRow.title, nedRow.company, nedRow.dossier.network.warm.rank, nedRow.dossier.network.connected_on], [99, "Managing Partner", "Ned Ventures", 1, "2019-05-02"], "the dossier content and its denormalized columns update");

  const q = await store.deskQueue(db, "network");
  assert.deepEqual(q.map((i) => [i.name, i.score, i.state]), [["Ned Fixture", 99, "skipped"], ["Rio Fixture", 80, "to_write"], ["Noa Fixture", 65, "sent"], ["Nia Fixture", 10, "sent"]],
    "the queue follows the new scores, highest first, and each person keeps their state");
  const niaItem = q.find((i) => i.twenty_person_id === NETWORK_IDS.email)!;
  assert.ok(niaItem.email_replied_at && niaItem.email_status === "replied");
  await db.from("gtm_outreach_drafts").update({ email_sent_at: new Date(Date.now() - 9 * 86_400_000).toISOString() }).eq("person", NETWORK_IDS.email).eq("batch", "desk");
  assert.equal(followUpDue((await store.deskQueue(db, "network")).find((i) => i.twenty_person_id === NETWORK_IDS.email)!, "Asia/Makassar"), false, "replied: never follow-up due");
  const person = await store.deskPerson(db, NETWORK_IDS.email, NETWORK_PROFILE, "network");
  assert.deepEqual([person.start.subject, person.start.body], ["Catching up", "Hey Nia,\n\nMine."], "the composer still opens on what he wrote");
  await resetNetwork();
});

test("network Mark replied: a LinkedIn note's reply (no API) and an email's; the follow-up stops; undo; never on clients", async () => {
  const db = admin();
  await resetNetwork();
  const { followUpDue } = await import("../../lib/outreach/desk.ts");
  await assert.rejects(store.markDeskReplied(db, NETWORK_IDS.linkedin, "network"), /first message sent before its reply/);
  const li = await store.markDeskSent(db, NETWORK_IDS.linkedin, gedit({ linkedin_note: "Hi Ned, good to see your news." }), actor, NETWORK_PROFILE, "network");
  await db.from("gtm_outreach_drafts").update({ linkedin_sent_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }).eq("id", li.id);
  const ned = async () => (await store.deskQueue(db, "network")).find((i) => i.twenty_person_id === NETWORK_IDS.linkedin)!;
  assert.ok(followUpDue(await ned(), "Asia/Makassar"), "8 days, no reply: due");
  const replied = await store.markDeskReplied(db, NETWORK_IDS.linkedin, "network");
  assert.deepEqual([!!replied.linkedin_replied_at, replied.linkedin_status, replied.email_status, replied.email_sent_at ?? null], [true, "sent", "none", null], "a LinkedIn reply stamps no email");
  assert.equal(followUpDue(await ned(), "Asia/Makassar"), false, "a replied person is never follow-up due");
  assert.equal((await store.markDeskReplied(db, NETWORK_IDS.linkedin, "network")).linkedin_replied_at, replied.linkedin_replied_at, "marking twice keeps the first time");
  assert.equal(sentToday(await store.deskQueue(db, "network"), "Asia/Makassar", "network"), 0, "a reply is not a send");
  assert.equal((await store.unmarkDeskReplied(db, NETWORK_IDS.linkedin, "network")).linkedin_replied_at, null);
  await store.markDeskReplied(db, NETWORK_IDS.linkedin, "network");
  const unsent = await store.unmarkDeskSent(db, NETWORK_IDS.linkedin, "network");
  assert.deepEqual([unsent.linkedin_status, unsent.linkedin_replied_at], ["none", null], "un-sending the note clears its reply");

  const email = await store.markDeskSent(db, NETWORK_IDS.email, gedit({ to: "nia@nia.example", subject: "Catching up", body: "Hey Nia,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  const er = await store.markDeskReplied(db, NETWORK_IDS.email, "network");
  assert.deepEqual([er.email_status, !!er.email_replied_at, er.email_sent_at], ["replied", true, email.email_sent_at]);
  // A reply time the mailbox sync stored earlier is kept.
  await db.from("gtm_outreach_drafts").update({ email_status: "sent", email_replied_at: "2026-11-01T00:00:00Z" }).eq("id", email.id);
  assert.equal(Date.parse((await store.markDeskReplied(db, NETWORK_IDS.email, "network")).email_replied_at!), Date.parse("2026-11-01T00:00:00Z"));
  const back = await store.unmarkDeskReplied(db, NETWORK_IDS.email, "network");
  assert.deepEqual([back.email_status, back.email_replied_at], ["sent", null]);
  await assert.rejects(store.unmarkDeskReplied(db, NETWORK_IDS.email, "network"), /No reply is marked/);
  await assert.rejects(store.markDeskReplied(db, DESK_IDS.top, "client"), /client stream, not the network stream|for the guest and network streams/);
  await assert.rejects(store.markDeskReplied(db, DESK_IDS.top), /for the guest and network streams/);
  await resetNetwork();
});

test("network Not replied sticks: the mailbox sync never re-stamps a reply John cleared, even one read before he cleared it", async () => {
  const db = admin();
  await resetNetwork();
  const { syncOutcomes } = await import("../../lib/sales/outcomes.ts");
  const d = await store.markDeskSent(db, NETWORK_IDS.followup, gedit({ to: "noa@noa.example", subject: "Long time", body: "Hey Noa,\n\nMine." }), actor, NETWORK_PROFILE, "network");
  // Sent an hour ago, so her reply and his clearing it are both in the past.
  const sentAt = new Date(Date.now() - 3_600_000).toISOString();
  await db.from("gtm_outreach_drafts").update({ email_sent_at: sentAt }).eq("id", d.id);
  const later = (ms: number) => new Date(Date.parse(sentAt) + ms).toISOString();
  const conv = (replyAt: string) => ({ id: "t", draftId: d.id, company: "", subject: "Long time", status: "reply" as const, unread: false, lastAt: replyAt, snippet: "", sentAt, replyAt });
  const run = (replyAt: string, during?: () => PromiseLike<unknown>) => syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000, mailbox: "user-f538cb95fc21@example.com",
    reader: { list: async () => { await during?.(); return { conversations: [conv(replyAt)], nextPageToken: "", scanned: 1 }; } } as never });
  const row = async () => (await db.from("gtm_outreach_drafts").select("email_status,email_replied_at,email_reply_dismissed_at").eq("id", d.id).single()).data!;

  const first = later(60_000);
  await run(first);
  assert.deepEqual([(await row()).email_status, Date.parse((await row()).email_replied_at!)], ["replied", Date.parse(first)], "the sync records the reply");
  const cleared = await store.unmarkDeskReplied(db, NETWORK_IDS.followup, "network");
  assert.deepEqual([cleared.email_status, cleared.email_replied_at ?? null], ["sent", null]);
  assert.ok((await row()).email_reply_dismissed_at, "and remembers when he cleared it");
  await run(first);
  assert.deepEqual([(await row()).email_status, (await row()).email_replied_at], ["sent", null], "the next hourly run leaves his call alone");

  // He clears it while a run is between its read and its write: the write is refused on the database side.
  await store.markDeskReplied(db, NETWORK_IDS.followup, "network");
  await db.from("gtm_outreach_drafts").update({ email_replied_at: null, email_status: "sent", email_reply_dismissed_at: null }).eq("id", d.id);
  const racing = later(120_000);
  await run(racing, () => db.from("gtm_outreach_drafts").update({ email_reply_dismissed_at: later(180_000) }).eq("id", d.id));
  assert.deepEqual([(await row()).email_status, (await row()).email_replied_at], ["sent", null], "a dismissal that lands mid-run wins");

  // A reply that arrives after he cleared it is a new reply.
  const fresh = new Date(Date.now() + 60_000).toISOString();
  await run(fresh);
  assert.deepEqual([(await row()).email_status, Date.parse((await row()).email_replied_at!)], ["replied", Date.parse(fresh)]);
  await resetNetwork();
});
