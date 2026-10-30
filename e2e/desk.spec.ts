// The writing desk (/outreach/write): John writes each cold email himself beside the dossier. The queue by score with
// today's progress, the prefilled composer and its autosave, advisory hints (British spelling flagged, his dashes never),
// the Gmail link, Mark sent with a confirm from the keyboard (counted, then on to the next person), J/K and / search,
// the client-check warning, skip with a reason, the daily target, his profile and gold examples, and AI drafts shown
// for reference with his own rewrite as the starting text. A second test covers the guest stream (VIB-463): the stream
// switch (G), both meters (clients 1/5, guests 1/2) and their targets, each stream's sender, the route-aware composer
// (email, LinkedIn note, intermediary), a LinkedIn-route Mark sent, the template and its slots, advisory guest hints, the
// follow-up due chip and Mark follow-up sent (which does not count), and that a guest never appears in the client queue.
// Synthetic fixtures only (test/support/seed.ts).
import { test, expect, type Page } from "@playwright/test";
import { admin, DESK_IDS, DOSSIER_FIXTURE, dossierRow, GUEST_IDS, PASSWORD, seedDesk, USERS } from "../test/support/seed.ts";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
const deskDraft = async (person: string) => (await admin().from("gtm_outreach_drafts").select("*").eq("batch", "desk").eq("person", person).maybeSingle()).data;

test("Writing desk: write, autosave, mark sent from the keyboard, move through the queue, skip, set the target", async ({ page }) => {
  const db = admin();
  // John's own rewrite for Tria in a pipeline batch: the desk starts from his text.
  const own = (await db.from("gtm_outreach_drafts").insert({ batch: "fx-batch-2", domain: "trial.example", variant: "john", subject: "Tria, his own subject", body: "Hey Tria,\n\nHis own rewrite.", linkedin_note: "Hi Tria", prospect: { first_name: "Tria", twenty_person_id: DESK_IDS.tria } }).select("id").single()).data!;
  try {
    await login(page);
    await page.getByRole("link", { name: "Writing desk", exact: true }).click();
    await expect(page).toHaveURL(/\/outreach\/write/);
    await expect(page.getByTestId("desk-meter-client")).toContainText("Clients 0/5");
    await expect(page.getByTestId("desk-meter-guest")).toContainText("Guests 0/2");
    const queue = page.getByTestId("desk-queue");
    await expect(queue.getByRole("button")).toHaveCount(4); // To write: everyone but the skipped one
    await expect(page.getByTestId("desk-name")).toHaveText("Topa Fixture");
    // The tab names the person, on arrival and after a fresh load (Next rewrites the head on both).
    await expect(page).toHaveTitle("Desk: Topa Fixture");
    await page.reload();
    await expect(page.getByTestId("desk-name")).toHaveText("Topa Fixture");
    await expect(page).toHaveTitle("Desk: Topa Fixture");

    // The composer starts with "Hey Topa," and the signature only.
    const body = page.getByLabel("Email body");
    await expect(body).toHaveValue("Hey Topa,\n\n\n\nJo Fixture\nFounder, Fixture Co\nfixture.example");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("topa@top.example");

    // The dossier: research notes labeled as AI, the quote, a source's full text, the signal.
    const dossier = page.getByTestId("desk-dossier");
    await expect(dossier.getByTestId("desk-brief")).toContainText("Research notes (AI)");
    await expect(dossier.getByTestId("desk-brief")).toContainText("We need AI to reach every team, not just engineering.");
    await expect(dossier.getByTestId("desk-signal")).toContainText("Topa Co posted a Head of AI Operations role");
    await dossier.getByTestId("desk-sources").getByText("Head of AI Operations").click();
    await expect(dossier.getByText("Fixture source text for Topa")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "test-results/screenshots/desk.png", fullPage: false });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.screenshot({ path: "test-results/screenshots/desk-wide.png", fullPage: false });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Write. Hints are advice: British spelling is flagged, his dash is not.
    await page.getByLabel("Subject", { exact: true }).fill("Your AI operations hire");
    await body.fill("Hey Topa,\n\nSaw the Head of AI Operations role — a colour of thing I know well.\n\nJo Fixture\nFounder, Fixture Co\nfixture.example");
    await expect(page.getByTestId("desk-hints")).toContainText("British spelling: colour");
    await expect(page.getByTestId("desk-hints")).not.toContainText("dash");
    await expect(page.getByTestId("desk-save-state")).toHaveText("Saved");
    await expect.poll(async () => (await deskDraft(DESK_IDS.top))?.subject).toBe("Your AI operations hire");
    expect((await deskDraft(DESK_IDS.top))!.variant).toBe("john");

    // The LinkedIn note counts to 300; over it, nothing can be marked.
    const note = page.getByLabel("LinkedIn note");
    await note.fill("x".repeat(301));
    await expect(page.getByTestId("desk-note-count")).toHaveText("301/300");
    await expect(page.getByRole("button", { name: "Mark sent" })).toBeDisabled();
    await note.fill("Hi Topa, saw the AI operations role.");
    await expect(page.getByRole("button", { name: "Mark sent" })).toBeEnabled();

    // Gmail, as the sending mailbox.
    const href = await page.getByTestId("desk-gmail").getAttribute("href");
    const u = new URL(href!);
    expect([u.searchParams.get("authuser"), u.searchParams.get("to"), u.searchParams.get("su")]).toEqual(["user-045d73df3c9a@example.com", "topa@top.example", "Your AI operations hire"]);

    // Cmd/Ctrl+Enter marks it sent at once (no confirm): counted, then on to the next person still to write.
    await body.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("toast")).toContainText("Marked sent. 1 of 5 today.");
    await expect(page.getByTestId("desk-meter-client")).toContainText("Clients 1/5");
    await expect.poll(async () => (await deskDraft(DESK_IDS.top))?.email_status).toBe("sent");
    const sent = (await deskDraft(DESK_IDS.top))!;
    expect([sent.status, sent.linkedin_note]).toEqual(["accepted", "Hi Topa, saw the AI operations role."]);
    expect(sent.email_sent_at).toBeTruthy();

    // Tria: his own rewrite is the starting text; the AI drafts are there, collapsed, for reference.
    await expect(page.getByTestId("desk-name")).toHaveText("Tria Fixture");
    await expect(page).toHaveTitle("Desk: Tria Fixture");
    await expect(page).toHaveURL(new RegExp(`p=${DESK_IDS.tria}`));
    await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Tria, his own subject");
    await expect(body).toHaveValue("Hey Tria,\n\nHis own rewrite.");
    const ai = page.getByTestId("desk-ai-drafts");
    await expect(ai).toContainText("AI drafts (reference only)");
    await expect(ai.getByText(/^model-a/)).toBeVisible();
    await expect(ai.getByText("Fixture body for Tria (model-a).")).toBeHidden();

    // J/K walk the queue (Topa is sent, so it left "To write").
    await page.locator("body").click({ position: { x: 600, y: 8 } });
    await page.keyboard.press("j");
    await expect(page.getByTestId("desk-name")).toHaveText("Trib Fixture");
    await page.keyboard.press("k");
    await expect(page.getByTestId("desk-name")).toHaveText("Tria Fixture");

    // "/" searches; Wara's client check did not pass, so the desk says so in red.
    await page.keyboard.press("/");
    await expect(page.getByLabel("Search")).toBeFocused();
    await page.keyboard.type("wara");
    await queue.getByRole("button", { name: /Wara Fixture/ }).click();
    await expect(page.getByTestId("client-check")).toContainText("Fixture: a current client");

    // Skip with a reason.
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByLabel("Skip reason").fill("Current client");
    await page.getByLabel("Skip reason").press("Enter");
    await expect(page.getByTestId("desk-state")).toHaveText("Skipped");
    await expect.poll(async () => (await db.from("gtm_outreach_dossiers").select("skip_reason").eq("twenty_person_id", DESK_IDS.wara).single()).data?.skip_reason).toBe("Current client");
    await page.getByLabel("Search").fill("");
    await page.getByRole("button", { name: /^Skipped/ }).click();
    await expect(queue.getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: /^Sent/ }).click();
    await expect(queue.getByRole("button", { name: /Topa Fixture/ })).toBeVisible();

    // The daily target is John's to set.
    await page.getByRole("button", { name: "Clients target 5" }).click();
    await page.getByLabel("Daily target").fill("3");
    await page.getByLabel("Daily target").press("Enter");
    await expect(page.getByTestId("desk-meter-client")).toContainText("Clients 1/3");
    await expect(page.getByTestId("desk-meter-guest")).toContainText("Guests 0/2");
    await expect.poll(async () => (await db.from("gtm_outreach_tracks").select("daily_target").eq("track", "client").single()).data?.daily_target).toBe(3);
    expect((await db.from("gtm_outreach_tracks").select("daily_target").eq("track", "guest").single()).data?.daily_target, "the guest target did not move").toBe(2);

    // His profile and gold examples, beside the composer.
    await page.getByRole("tab", { name: "Your profile and examples" }).click();
    await expect(page.getByTestId("desk-profile")).toContainText("Fixture gold body.");
    await expect(page.getByTestId("desk-assets").getByRole("button", { name: "Copy link: Fixture readiness check" })).toBeVisible();

    // A reload keeps everything; /outreach links here.
    await page.reload();
    await expect(page.getByTestId("desk-meter-client")).toContainText("Clients 1/3");
    await page.goto("/outreach");
    await page.getByRole("link", { name: "Write your own at the writing desk" }).click();
    await expect(page).toHaveURL(/\/outreach\/write$/);
  } finally {
    await db.from("gtm_outreach_drafts").delete().eq("batch", "desk");
    await db.from("gtm_outreach_drafts").delete().eq("id", own.id);
    await db.from("gtm_outreach_dossiers").delete().in("twenty_person_id", DOSSIER_FIXTURE.map((d) => d.twenty_person_id));
    await db.from("gtm_outreach_dossiers").insert(DOSSIER_FIXTURE.map(dossierRow));
    await db.from("gtm_outreach_dossiers").update({ skipped_at: new Date().toISOString(), skip_reason: "Fixture skip", skipped_by: "owner@gtm.test" }).eq("twenty_person_id", DESK_IDS.skip);
    await seedDesk();
  }
});

test("Writing desk, two streams: switch with G, both meters, each stream's sender, a guest by email, by LinkedIn and through an intermediary, the template, the follow-up", async ({ page }) => {
  const db = admin();
  const eightDays = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const tenDays = new Date(Date.now() - 10 * 86_400_000).toISOString();
  // Eli was written to 8 days ago and has not replied: his follow-up is due. Topa's export is old: the dossier warns.
  await db.from("gtm_outreach_drafts").insert({ batch: "desk", domain: "eli.example", variant: "john", person: GUEST_IDS.followup, track: "guest", route: "email", status: "accepted", decided_by: "owner@gtm.test", decided_at: eightDays,
    email_status: "sent", email_sent_at: eightDays, subject: "Eli, an invitation", body: "Hey Eli,\n\nFixture first message.", prospect: { first_name: "Eli", twenty_person_id: GUEST_IDS.followup, email: "eli@eli.example" } });
  await db.from("gtm_outreach_dossiers").update({ built_at: tenDays }).eq("twenty_person_id", DESK_IDS.top);
  try {
    await login(page);
    await page.goto("/outreach/write");
    const queue = page.getByTestId("desk-queue");
    const clients = page.getByTestId("desk-meter-client"), guests = page.getByTestId("desk-meter-guest");
    await expect(page.getByRole("tab", { name: "Clients" })).toHaveAttribute("aria-selected", "true");
    await expect(clients).toContainText("Clients 0/5");
    await expect(guests).toContainText("Guests 0/2");
    await expect(queue.getByRole("button")).toHaveCount(4); // only clients, no guest
    await expect(queue.getByRole("button", { name: /Gia Fixture/ })).toHaveCount(0);
    await expect(page.getByTestId("desk-from")).toHaveText("user-045d73df3c9a@example.com");
    await expect(page.getByTestId("export-stale")).toContainText("10 days old"); // Topa's export

    // A client: one email, counted in the client meter only.
    await page.getByLabel("Subject", { exact: true }).fill("Your AI operations hire");
    await page.getByRole("button", { name: "Mark sent" }).click();
    await expect(clients).toContainText("Clients 1/5");
    await expect(guests).toContainText("Guests 0/2");

    // G switches to guests: their own sender, queue, route and dossier.
    await page.locator("body").click({ position: { x: 600, y: 8 } });
    await page.keyboard.press("g");
    await expect(page.getByRole("tab", { name: "Guests" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/t=guest/);
    await expect(page.getByTestId("desk-name")).toHaveText("Gia Fixture");
    await expect(page.getByTestId("desk-route")).toHaveText("Email");
    await expect(page.getByTestId("desk-from")).toHaveText("user-8dd8662c2f5a@example.com");
    await expect(queue.getByRole("button", { name: /Topa Fixture/ })).toHaveCount(0); // no client in the guest queue
    await expect(queue.getByRole("button")).toHaveCount(3); // Gia, Lio, Ina to write (Eli is sent)
    const href = new URL((await page.getByTestId("desk-gmail").getAttribute("href"))!);
    expect(href.searchParams.get("authuser")).toBe("user-8dd8662c2f5a@example.com");
    const dossier = page.getByTestId("desk-dossier");
    await expect(dossier.getByTestId("desk-guest")).toContainText("Fixture wisdom angle.");
    await expect(dossier.getByTestId("desk-guest")).toContainText("Fixture central question?");
    await expect(dossier.getByTestId("desk-guest")).toContainText("Fixture prompt three");
    await expect(dossier.getByTestId("desk-guest")).toContainText("Fixture warm path.");
    await expect(dossier.getByTestId("export-stale")).toHaveCount(0); // a fresh export

    // The template (profile.templates['01']): subject and first name filled, slots left for him; the body starts blank otherwise.
    const body = page.getByLabel("Email body");
    await expect(body).toHaveValue(/^Hey Gia,\n\n\n\nJo Fixture\nHost of The Fixture Show/);
    await page.getByTestId("desk-template").click();
    await expect(body).toHaveValue(/^Hey Gia,\n\n\{\{trigger: one dated, specific thing\}\}/);
    await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Leading the transition at Gia Org");
    await expect(page.getByTestId("desk-slot")).toHaveText("{{trigger: one dated, specific thing}}");
    await expect(page.getByTestId("desk-hints")).toContainText("1 template slot still to fill");

    // Advisory hints for a guest: wisdom keeper / elder and an em dash are flagged, never blocking.
    await body.fill("Hey Gia,\n\nYour talk made me think of a wisdom keeper \u2014 an elder of the craft.\n\nJo Fixture");
    await expect(page.getByTestId("desk-hints")).toContainText("only if the guest does");
    await expect(page.getByTestId("desk-hints")).toContainText("Em dash");
    await body.fill("Hey Gia,\n\nYour fixture talk made me want to ask: would you join the show?\n\nJo Fixture\nHost of The Fixture Show");
    await page.getByLabel("To", { exact: true }).fill("gia@gia.example");

    // Mark sent by email: the guest meter moves, the client meter does not.
    await body.press("ControlOrMeta+Enter");
    await expect(guests).toContainText("Guests 1/2");
    await expect(clients).toContainText("Clients 1/5");
    await expect.poll(async () => (await db.from("gtm_outreach_drafts").select("email_status,route,track").eq("person", GUEST_IDS.email).single()).data).toEqual({ email_status: "sent", route: "email", track: "guest" });

    // On to Lio, reached by LinkedIn: a note box with the 300 counter, no email fields; Mark sent goes through the LinkedIn status.
    await expect(page.getByTestId("desk-name")).toHaveText("Lio Fixture");
    await expect(page.getByTestId("desk-route")).toHaveText("LinkedIn");
    await expect(page.getByLabel("Email body")).toHaveCount(0);
    await page.getByLabel("LinkedIn note").fill("Hi Lio, a fixture note.");
    await expect(page.getByTestId("desk-note-count")).toHaveText("23/300");
    await page.getByRole("button", { name: "Mark sent" }).click();
    await expect(guests).toContainText("Guests 2/2");
    await expect(guests).toHaveAttribute("data-done", "true");
    await expect.poll(async () => (await db.from("gtm_outreach_drafts").select("linkedin_status,email_status,route,linkedin_sent_at").eq("person", GUEST_IDS.linkedin).single()).data).toMatchObject({ linkedin_status: "sent", email_status: "none", route: "linkedin" });
    // The guest stream is done: one click offers the clients.
    await expect(page.getByTestId("desk-jump")).toContainText("Guests are done for today (2/2). Clients are at 1/5.");

    // Ina goes through an intermediary: the contact line and the protocol notes are up front.
    await page.getByLabel("Search").fill("Ina");
    await queue.getByRole("button", { name: /Ina Fixture/ }).click();
    await expect(page.getByTestId("desk-route")).toHaveText("Via an intermediary");
    await expect(page.getByTestId("desk-contact")).toContainText("Fixture council office");
    // Every guest gets something to click: her LinkedIn is a link above the composer (the search fallback is covered in test/outreach-desk). Guests get the angles too.
    await expect(page.getByTestId("desk-contact").getByTestId("reach-linkedin")).toHaveAttribute("href", /linkedin\.com\/in\/ina/);
    await expect(page.getByTestId("desk-generate-angles")).toBeVisible();
    await expect(dossier.getByTestId("desk-protocol")).toContainText("final cut stays with the community");
    await page.getByLabel("Search").fill("");
    await page.getByRole("button", { name: /^Needs route/ }).click();
    await expect(queue.getByRole("button", { name: /Ina Fixture/ })).toBeVisible();

    // The follow-up due chip: Eli, sent 8 days ago, no reply. Marking it counts nothing.
    await expect(page.getByRole("button", { name: /^Follow-up due/ })).toContainText("1");
    await page.getByRole("button", { name: /^Follow-up due/ }).click();
    await queue.getByRole("button", { name: /Eli Fixture/ }).click();
    await expect(page.getByTestId("desk-followup-due")).toBeVisible();
    await page.getByTestId("desk-followup").click();
    await expect(page.getByTestId("desk-followup-sent")).toBeVisible();
    await expect.poll(async () => (await db.from("gtm_outreach_drafts").select("follow_up_status,follow_up_sent_at").eq("person", GUEST_IDS.followup).single()).data?.follow_up_status).toBe("sent");
    await expect(guests).toContainText("Guests 2/2"); // a follow-up never counts toward the target
    await expect(page.getByRole("button", { name: /^Follow-up due/ })).toContainText("0");

    // The jump: back to clients, whose sender and queue are their own; a reload keeps the stream from the link.
    await page.getByRole("tab", { name: "Clients" }).click();
    await expect(page).toHaveURL(/t=client/);
    await expect(page.getByTestId("desk-from")).toHaveText("user-045d73df3c9a@example.com");
    await expect(queue.getByRole("button", { name: /Gia Fixture/ })).toHaveCount(0);
    await page.goto(`/outreach/write?t=guest&p=${GUEST_IDS.followup}`);
    await expect(page.getByRole("tab", { name: "Guests" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("desk-name")).toHaveText("Eli Fixture");
    await expect(clients).toContainText("Clients 1/5");
    await expect(guests).toContainText("Guests 2/2");

    // Each stream's target is its own to set.
    await page.getByRole("button", { name: "Guests target 2" }).click();
    await page.getByLabel("Guests daily target").fill("3");
    await page.getByLabel("Guests daily target").press("Enter");
    await expect(guests).toContainText("Guests 2/3");
    await expect.poll(async () => (await db.from("gtm_outreach_tracks").select("daily_target").eq("track", "guest").single()).data?.daily_target).toBe(3);
    await expect(clients).toContainText("Clients 1/5");
  } finally {
    await db.from("gtm_outreach_drafts").delete().eq("batch", "desk");
    await db.from("gtm_outreach_dossiers").update({ built_at: DOSSIER_FIXTURE[0].built_at }).eq("twenty_person_id", DESK_IDS.top);
    await seedDesk();
  }
});

test("drafting endpoint preserves owner, origin, stream and client-exclusion gates", async ({ page }) => {
  const endpoint = "/outreach/write/angles";
  const signedOut = await page.request.post(endpoint, { data: { personId: DESK_IDS.top, track: "client" }, maxRedirects: 0 });
  expect(signedOut.status()).toBe(307);
  await login(page);
  const crossSite = await page.request.post(endpoint, { headers: { origin: "https://other.test" }, data: { personId: DESK_IDS.top, track: "client" } });
  expect(crossSite.status()).toBe(403);
  const malformed = await page.request.post(endpoint, { data: { personId: DESK_IDS.top, track: "unknown" } });
  expect(malformed.status()).toBe(400);
  const blocked = await page.request.post(endpoint, { data: { personId: DESK_IDS.wara, track: "client" } });
  expect(await blocked.json()).toMatchObject({ ok: false, error: expect.stringContaining("client check has not passed") });
  const wrongStream = await page.request.post(endpoint, { data: { personId: DESK_IDS.top, track: "guest" } });
  expect(await wrongStream.json()).toMatchObject({ ok: false });
});
