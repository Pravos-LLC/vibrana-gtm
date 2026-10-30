// Third-party review links end to end: John makes a link; the partner opens it and is on the page (no account, no login),
// sees only their pieces (never a rough cut, John's notes or any other page), comments, asks for changes and approves each
// video. Revoking the link shuts it at once.
import { test, expect, type Page } from "@playwright/test";
import { admin, PASSWORD, USERS } from "../test/support/seed.ts";
import { createInvite } from "../lib/reviewer/invites.ts";

const PARTY = "Fixture Partner";




test.describe.configure({ mode: "serial" });
let link = "";

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true });
}

async function ownerLogin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/");
}

test("a link is made for a named third party only", async () => {
  await expect(createInvite(admin(), { party: "Nobody Named", by: "e2e" })).rejects.toThrow(/No piece names/);
});

test("John shares a piece in one step: the modal makes the link and sends it by WhatsApp or Gmail", async ({ page }) => {
  await ownerLogin(page);
  await page.goto("/content");
  const piece = page.locator("section#s1-90-fx-partner-final");
  await piece.getByRole("button", { name: "Share for review" }).click();
  const dialog = page.getByRole("dialog", { name: `Share for review with ${PARTY}` });
  await expect(dialog.getByText("A new private link")).toBeVisible();
  const url = (await dialog.locator("code").textContent())!;
  expect(new URL(url).origin).toBe(`http://127.0.0.1:${process.env.GTM_E2E_PORT ?? 3100}`);
  expect(new URL(url).pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
  link = new URL(url).pathname;
  const message = dialog.getByLabel("Message");
  await expect(message, "focus moves into the dialog once the link is ready").toBeFocused();
  await expect(message).toHaveValue(new RegExp(`^Hi Fixture Partner, "Fixture partner final" is ready for your review:\\n${url.replaceAll(".", "\\.")}`));
  await dialog.getByLabel("WhatsApp number (optional)").fill("+57 300 123 4567");
  await dialog.getByLabel("Email (optional)").fill("partner@example.com");
  const wa = await dialog.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/573001234567\?text=Hi%20Fixture/);
  expect(decodeURIComponent(wa!)).toContain(url);
  const gmail = new URL((await dialog.getByRole("link", { name: "Send with Gmail" }).getAttribute("href"))!);
  expect(gmail.host).toBe("mail.google.com");
  expect(gmail.searchParams.get("to")).toBe("partner@example.com");
  expect(gmail.searchParams.get("authuser")).toBe("user-f538cb95fc21@example.com");
  expect(gmail.searchParams.get("body")).toContain(url);
  await shot(page, "share-for-review-modal");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(piece.getByRole("button", { name: "Share for review" }), "focus returns to the button").toBeFocused();
  // The number is remembered for the next share.
  await piece.getByRole("button", { name: "Share for review" }).click();
  await expect(page.getByRole("dialog").getByLabel("WhatsApp number (optional)")).toHaveValue("+57 300 123 4567");
  // Reopening shows the same unused link instead of making another.
  await expect(page.getByRole("dialog").locator("code")).toHaveText(url);
  const { count } = await admin().from("gtm_reviewer_invites").select("id", { count: "exact", head: true }).is("claimed_at", null);
  expect(count, "one link made, however often the modal opens").toBe(1);
});

test("the partner opens the link and is on the page: no login, only their pieces", async ({ page }) => {
  await page.goto(link);
  await expect(page.getByText(`Shared for review with ${PARTY}`)).toBeVisible();
  await expect(page.getByLabel("Email"), "nothing to sign in to").toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture partner final" })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /shorts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" }), "the buttons are right there").toHaveCount(1);
  await expect(page.getByRole("heading", { name: "What it will be posted with" }), "a short has one video and no posts to read").toHaveCount(0);
  await expect(page.getByText("Fixture partner caption about the river.")).toHaveCount(0);
  // The rough cut is listed as in production, with no media.
  await expect(page.getByRole("heading", { name: "Fixture partner rough" })).toBeVisible();
  await expect(page.getByText("The final version will appear here")).toBeVisible();
  // Nothing else: no John note, no other piece, no cockpit navigation.
  for (const hidden of ["Fixture John private note", "Fixture Story", "Fixture Newsletter", "Review", "Calendar", "Signals"]) {
    await expect(page.getByText(hidden, { exact: true }), hidden).toHaveCount(0);
  }
  await shot(page, "reviewer-shared");
});

test("the link opens nothing else: every cockpit page asks for a login and the database shows an anonymous visitor nothing", async ({ page }) => {
  await page.goto(link);
  for (const path of ["/", "/content", "/studio", "/signals", "/calendar", "/costs", "/stories/fx-story", "/shared"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login$/);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.LOCAL_SUPABASE_URL!, process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  for (const table of ["gtm_stories", "gtm_story_assets", "gtm_story_feedback", "gtm_reviewer_invites", "gtm_content_items"]) {
    const { data } = await db.from(table).select("*").limit(5);
    expect(data ?? [], table).toEqual([]);
  }
  const { error } = await db.rpc("gtm_reviewer_decide_asset_by_link", { p_token_sha256: "1".repeat(64), p_asset_id: "fx-partner-video", p_decision: "approved", p_note: "", p_sha256: "1".repeat(64), p_revision: 1 });
  expect(error, "the browser cannot call the link function directly").not.toBeNull();
});

test("the owner opening the link sees the page without buttons and uses nothing up", async ({ browser }) => {
  const owner = await browser.newContext();
  const op = await owner.newPage();
  await ownerLogin(op);
  await op.goto(link);
  await expect(op.getByText(`Owner preview: exactly what ${PARTY} sees`)).toBeVisible();
  await expect(op.getByRole("heading", { name: "Fixture partner final" })).toBeVisible();
  await expect(op.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await owner.close();
});

test("the partner decides on the link, with no login, each video on its own; the Story is signed off when its video is approved (a short shows no post copy); nothing queues agent work", async ({ page }) => {
  await page.goto(link);

  // Each asset has its own controls. The video: a note, then a change request, then an approval of that same video.
  const video = page.locator('[data-asset="fx-partner-video"]');
  await expect(page.locator('[data-asset="fx-partner-copy"]'), "a short has no post to approve").toHaveCount(0);
  await video.getByRole("button", { name: "Add a note" }).click();
  await video.getByLabel("Your note").fill("Love the river shot.");
  await video.getByRole("button", { name: "Send note" }).click();
  await expect(video.getByText("Love the river shot.")).toBeVisible();

  await video.getByRole("button", { name: "Request changes" }).click();
  await video.getByLabel(/What would you like changed/).fill("Please hold the end card longer at 0:41.");
  await video.getByRole("button", { name: "Send change request" }).click();
  await expect(video.getByText("Please hold the end card longer at 0:41.")).toBeVisible();

  await video.getByRole("button", { name: "Approve" }).click();
  await expect(video.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByText("You approved this")).toHaveCount(1);
  const db = admin();
  await shot(page, "reviewer-approved");

  const { data: decisions } = await db.from("gtm_story_stage_decisions").select("party,who,decision,stage").eq("story_id", "s1-90-fx-partner-final").order("decided_at");
  expect(decisions).toEqual([
    { party: "third_party", who: PARTY, decision: "changes", stage: "final" },
    { party: "third_party", who: PARTY, decision: "approved", stage: "final" },
  ]);
  const { data: story } = await db.from("gtm_stories").select("held_at").eq("id", "s1-90-fx-partner-final").single();
  expect(story?.held_at, "the video is approved: the hold is released").toBeNull();
  const { data: rows } = await db.from("gtm_reviewer_asset_decisions").select("asset_id,decision,note").eq("story_id", "s1-90-fx-partner-final").order("decided_at");
  expect(rows).toEqual([
    { asset_id: "fx-partner-video", decision: "note", note: "Love the river shot." },
    { asset_id: "fx-partner-video", decision: "changes", note: "Please hold the end card longer at 0:41." },
    { asset_id: "fx-partner-video", decision: "approved", note: "" },
  ]);
  const { data: notes } = await db.from("gtm_story_feedback").select("body,author").eq("asset_id", "fx-partner-video").order("created_at");
  expect(notes, "a third party's decisions never become agent work").toEqual([{ body: "Fixture John private note", author: "john" }]);
});

test("revoking the link shuts it at once", async ({ page }) => {
  await admin().from("gtm_reviewer_invites").update({ revoked_at: new Date().toISOString() }).eq("party", PARTY);
  await page.goto(link);
  await expect(page.getByText("This link is no longer valid")).toBeVisible();
  await expect(page.getByText("Fixture partner final")).toHaveCount(0);
});
