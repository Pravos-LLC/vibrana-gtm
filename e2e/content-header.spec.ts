import { test, expect } from "@playwright/test";
import { PASSWORD, USERS } from "../test/support/seed";

test("compact content overview opens one accessible panel at a time without changing filters", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/content?status=all");
  const overview = page.getByRole("region", { name: "Season overview", exact: true });
  const season = overview.getByRole("button", { name: "Season analysis", exact: true });
  const findings = overview.getByRole("button", { name: /^Findings \(\d+\)$/ });
  const external = overview.getByRole("button", { name: /^External review/ });
  for (const button of [season, findings, external]) await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(overview.getByRole("button", { name: "Edit season" })).toHaveCount(0);
  const url = page.url();
  await season.focus();
  await page.keyboard.press("Enter");
  await expect(season).toHaveAttribute("aria-expanded", "true");
  await expect(overview.getByRole("button", { name: "Edit season" })).toBeVisible();
  // All top-row controls precede the open panel's controls in keyboard order.
  await page.keyboard.press("Tab");
  await expect(findings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(external).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(overview.getByRole("button", { name: "Edit season" })).toBeFocused();
  await findings.click();
  await expect(season).toHaveAttribute("aria-expanded", "false");
  await expect(findings).toHaveAttribute("aria-expanded", "true");
  const count = Number((await findings.innerText()).match(/\d+/)![0]);
  const rows = overview.getByRole("region", { name: /^Findings \(/ }).getByRole("listitem");
  await expect(rows).toHaveCount(count);
  await external.click();
  await expect(findings).toHaveAttribute("aria-expanded", "false");
  await expect(external).toHaveAttribute("aria-expanded", "true");
  await external.click();
  await expect(external).toHaveAttribute("aria-expanded", "false");
  expect(page.url()).toBe(url);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const search = page.getByRole("searchbox", { name: "Search the season" });
    await expect(search).toBeVisible();
    const box = await search.boundingBox();
    if (viewport.width >= 1024) expect(box!.y + box!.height).toBeLessThan(viewport.height);
    const overviewBox = await overview.boundingBox();
    expect(overviewBox!.x + overviewBox!.width).toBeLessThanOrEqual(viewport.width);
  }
  expect(pageErrors).toEqual([]);
});
