import { test, expect } from "@playwright/test";
import { PASSWORD, USERS } from "../test/support/seed";

test("sidebar navigation stays in the document and closes the mobile drawer", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
  // Count document requests after login. A client transition must only fetch RSC data.
  let documents = 0;
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Outreach inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-disconnected")).toBeVisible();
  expect(documents).toBe(0);
  await page.screenshot({ path: "test-results/screenshots/outreach-inbox.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Content review", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inbox", exact: true })).not.toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("needs-approval");
});

test("non-owners cannot open inbox content", async ({ page }) => {
  await page.goto("/outreach/inbox");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("HQ inbox is not connected")).toHaveCount(0);
});
