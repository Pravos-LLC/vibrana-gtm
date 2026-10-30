// The work board (/work): the owner sees what agents are doing with their notes; the nav badge and the /content strip
// count it; a note nobody picked up shows as "Waiting for an agent".
import { test, expect, type Page } from "@playwright/test";
import { admin, PASSWORD, USERS } from "../test/support/seed.ts";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("Work board: in progress, ready for review and waiting, each linking to its piece; the nav badge and the /content strip", async ({ page }) => {
  const db = admin();
  // A John note left ten minutes ago that no job covers.
  const { data: note } = await db.from("gtm_story_feedback")
    .insert({ asset_id: "fx-partner-copy", channel: "instagram", body: "Fixture waiting note", created_at: new Date(Date.now() - 10 * 60_000).toISOString() }).select("id").single();
  try {
    await login(page);
    await page.goto("/work");
    const progress = page.getByTestId("work-inProgress");
    const row = progress.getByTestId("work-row").filter({ hasText: "Fixture Newsletter: 1 note" });
    await expect(row).toContainText("Working");
    await expect(row).toContainText("Rewriting the intro");
    await expect(row).toContainText(/about (25|30) min/);
    await expect(row).toContainText(/updated (just now|\dm ago)/);
    await expect(row.getByRole("link", { name: "Open in Review" })).toHaveAttribute("href", "/content?piece=fx-newsletter");
    await expect(page.getByTestId("work-review").getByTestId("work-row").filter({ hasText: "Fixture partner final: 1 note" })).toContainText("Staged");
    const waiting = page.getByTestId("work-waiting").getByTestId("work-row").filter({ hasText: "Fixture partner final" });
    await expect(waiting).toContainText("Waiting for an agent");

    // Nav badge: one job in progress, and pieces with a note nobody picked up.
    const nav = page.getByRole("link", { name: /^Work/ });
    await expect(nav.getByTestId("nav-badge")).toContainText("1 in progress");
    await expect(nav.getByTestId("nav-badge")).toContainText("waiting");

    // An agent picks the note up: it leaves "Waiting" and joins "In progress".
    await db.from("gtm_work_items").insert({ story_id: "s1-90-fx-partner-final", source_note_ids: [note!.id], title: "Fixture partner caption: 1 note", status: "queued", agent: "e2e" });
    await page.reload();
    await expect(page.getByTestId("work-inProgress").getByTestId("work-row").filter({ hasText: "Fixture partner caption: 1 note" })).toContainText("Queued");
    await expect(page.getByTestId("work-waiting").getByTestId("work-row").filter({ hasText: "Fixture partner final" })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "test-results/screenshots/work-board.png", fullPage: true });

    await page.goto("/content");
    const strip = page.getByTestId("work-strip");
    await expect(strip).toContainText("2 jobs in progress");
    await expect(strip).toHaveAttribute("href", "/work");
    await page.screenshot({ path: "test-results/screenshots/work-content-strip.png", clip: { x: 0, y: 0, width: 1280, height: 420 } });
  } finally {
    await db.from("gtm_work_items").delete().eq("agent", "e2e");
    if (note) await db.from("gtm_story_feedback").delete().eq("id", note.id);
  }
});
