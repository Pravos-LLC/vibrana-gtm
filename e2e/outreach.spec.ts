// Outreach review (/outreach): the owner reviews personalized cold emails like posts in /content. The latest batch by
// default, a model trial side by side, edit in place, Accept (siblings rejected, no second confirmation), Send back with
// a note from the keyboard, the status filter and the batch picker. Findings are advisory and never block Accept.
// Synthetic fixtures only (test/support/seed.ts).
import { test, expect, type Page } from "@playwright/test";
import { admin, OUTREACH_FIXTURE, OUTREACH_IDS, PASSWORD, USERS } from "../test/support/seed.ts";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
const row = async (id: string) => (await admin().from("gtm_outreach_drafts").select("*").eq("id", id).single()).data!;

test("Outreach: edit and accept one trial variant (the other is rejected), send one back with a note from the keyboard, filter and switch batch", async ({ page }) => {
  const db = admin();
  try {
    await login(page);
    await page.getByRole("link", { name: "Outreach", exact: true }).click();
    await expect(page).toHaveURL(/\/outreach$/);
    await expect(page.getByLabel("Batch")).toHaveValue("fx-batch-2");
    const cards = page.getByTestId("outreach-card");
    await expect(cards).toHaveCount(3);

    // The trial: two variants side by side, the trigger in one line, findings as chips that do not block Accept.
    const trial = cards.filter({ hasText: "Tria Fixture" });
    await expect(trial.getByTestId("outreach-trigger")).toContainText("Tria Co opened a second office");
    const a = trial.locator('[data-variant="model-a"]'), b = trial.locator('[data-variant="model-b"]');
    await expect(a).toBeVisible();
    await expect(b).toBeVisible();
    await expect(b.getByText("fixture-block: Fixture blocking finding")).toBeVisible();
    await b.getByText("Claims and sources (1)").click();
    await expect(b.getByRole("link", { name: "https://trial.example/news" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "test-results/screenshots/outreach.png", fullPage: true });

    // Edit model-b, see the diff, accept: model-a is rejected as "other variant chosen".
    const body = b.getByLabel("Email body");
    await body.fill("Fixture body for Tria, edited by John.");
    await expect(b.getByText("Unsaved edit. Accept saves it.")).toBeVisible();
    await b.getByRole("button", { name: "Show changes from the agent's draft" }).click();
    await expect(b.getByTestId("outreach-diff")).toContainText("edited by John");
    await b.getByRole("button", { name: "Back to editing" }).click();
    await b.getByRole("button", { name: "Accept model-b" }).click();
    await expect(b.getByTestId("outreach-status")).toHaveText("Accepted");
    await expect(a.getByTestId("outreach-status")).toHaveText("Rejected");
    await expect(a).toContainText("other variant chosen");
    await expect.poll(async () => (await row(OUTREACH_IDS.trialB)).status).toBe("accepted");
    const accepted = await row(OUTREACH_IDS.trialB);
    expect([accepted.body, accepted.original_body]).toEqual(["Fixture body for Tria, edited by John.", "Fixture body for Tria (model-b)."]);
    expect([(await row(OUTREACH_IDS.trialA)).status, (await row(OUTREACH_IDS.trialA)).note]).toEqual(["rejected", "other variant chosen"]);
    const { data: kept } = await db.from("gtm_outreach_draft_versions").select("reason,body").eq("draft_id", OUTREACH_IDS.trialB);
    expect(kept).toEqual([{ reason: "edited", body: "Fixture body for Tria (model-b)." }]);

    // Keyboard: undecided prospects come first; J/K move between prospects, N opens the note, Cmd/Ctrl+Enter sends it back.
    await page.reload();
    await expect(cards.first()).toContainText("Sola Fixture");
    // With streamed pages, visible server HTML can precede the global keyboard listener.
    // A completed local interaction proves hydration before exercising document shortcuts.
    await cards.first().getByRole("button", { name: "Show changes from the agent's draft" }).click();
    await expect(cards.first().getByTestId("outreach-diff")).toBeVisible();
    await cards.first().getByRole("button", { name: "Back to editing" }).click();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await expect(cards.nth(1)).toHaveClass(/ring-2/);
    await page.keyboard.press("k");
    await expect(cards.first()).toHaveClass(/ring-2/);
    await page.keyboard.press("n");
    const note = page.getByLabel("Note to the agent");
    await expect(note).toBeFocused();
    await note.fill("Lead with the second office, drop the case study.");
    await note.press("ControlOrMeta+Enter");
    const solo = cards.filter({ hasText: "Sola Fixture" });
    await expect(solo.getByTestId("outreach-status")).toHaveText("Sent back");
    await expect(page.getByTestId("toast")).toContainText("An agent will pick this up");
    await expect.poll(async () => (await row(OUTREACH_IDS.solo)).status).toBe("regenerate");
    expect((await row(OUTREACH_IDS.solo)).note).toBe("Lead with the second office, drop the case study.");

    // Status filter, then the older batch.
    await page.getByRole("link", { name: /^Sent back/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Sola Fixture");
    await page.getByLabel("Batch").selectOption("fx-batch-1");
    await expect(page).toHaveURL(/batch=fx-batch-1/);
    await expect(page.getByText("Nothing sent back in fx-batch-1.")).toBeVisible();
    await page.getByRole("link", { name: "Show all" }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Olda Fixture");
  } finally {
    const ids = OUTREACH_FIXTURE.map((f) => f.id);
    await db.from("gtm_outreach_drafts").delete().in("id", ids);
    await db.from("gtm_outreach_drafts").insert(OUTREACH_FIXTURE, { defaultToNull: false });
  }
});
