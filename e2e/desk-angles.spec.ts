import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

let script: string;
let styles = "";
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["test/support/desk-angle-harness.tsx"], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, alias: { "next/link": path.resolve("test/support/desk-link.tsx") } });
  script = result.outputFiles[0].text;
  const root = path.resolve(".next/static");
  if (fs.existsSync(root)) for (const file of fs.readdirSync(root, { recursive: true }) as string[]) if (file.endsWith(".css")) styles += fs.readFileSync(path.join(root, file), "utf8");
});

test.beforeEach(async ({ page }) => {
  await page.route("http://writing-desk.test/**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="dark"><head><style>${styles}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto("http://writing-desk.test/");
  await page.addScriptTag({ content: script });
});

test("angles load into one readable composer; arrows, edits, autosave and Gmail stay in sync", async ({ page }) => {
  await page.getByTestId("desk-generate-angles").click();
  const subject = page.getByLabel("Subject", { exact: true });
  const body = page.getByLabel("Email body");
  await expect(subject).toHaveValue("fixture subject 1");
  await expect(body).toHaveValue(/Hi Riley,\n\nThis is fixture opening 1\./);
  await expect(body).toHaveValue(/Jo Fixture\nFounder, Fixture Co\nfixture.example\n\nP.S. Fixture resource\./);
  expect(await body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
  expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 2)).toBe(true);
  await expect(page.getByTestId("desk-angle-tab-light_touch")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use this angle" })).toHaveCount(0);

  await body.fill("Hi Riley,\n\nMy edit on the first angle.\n\nJo Fixture");
  await page.getByRole("button", { name: "Next angle", exact: true }).click();
  await expect(subject).toHaveValue("fixture subject 2");
  await expect(page.getByLabel("LinkedIn note", { exact: true })).toHaveValue("Fixture LinkedIn note 2.");
  await page.getByRole("button", { name: "Previous angle", exact: true }).click();
  await expect(body).toHaveValue("Hi Riley,\n\nMy edit on the first angle.\n\nJo Fixture");
  await page.getByTestId("desk-angle-tab-useful_value").click();
  await expect(subject).toHaveValue("fixture subject 3");
  await expect(page.getByTestId("desk-save-state")).toHaveText("Saved");
  const href = await page.getByTestId("desk-gmail").getAttribute("href");
  const gmail = new URL(href!);
  expect(gmail.searchParams.get("su")).toBe("fixture subject 3");
  expect(gmail.searchParams.get("body")).toContain("\n\nP.S. Fixture resource.");
  const saved = await page.evaluate(() => window.deskFixture.saved);
  expect(saved.some((edit) => edit.body.includes("My edit on the first angle."))).toBe(true);
  await page.screenshot({ path: "test-results/screenshots/desk-angle-composer.png", fullPage: true });
});

test("failed saves block switching and keep the human edit", async ({ page }) => {
  await page.getByTestId("desk-generate-angles").click();
  const body = page.getByLabel("Email body");
  await expect(body).toHaveValue(/fixture opening 1/);
  await page.evaluate(() => { window.deskFixture.failSave = true; });
  await body.fill("A human edit that must survive a failed save.");
  await page.getByRole("button", { name: "Next angle", exact: true }).click();
  await expect(body).toHaveValue("A human edit that must survive a failed save.");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("fixture subject 1");
  await expect(page.getByTestId("desk-angle-tab-light_touch")).toHaveAttribute("aria-pressed", "true");
});

test("generation does not overwrite typing or leak angles into another person's composer", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.generationDelay = 700; });
  await page.getByTestId("desk-generate-angles").click();
  await page.getByLabel("Email body").fill("I typed this while generation was running.");
  await expect(page.getByTestId("desk-angle-status")).toContainText("Choose an angle");
  await expect(page.getByLabel("Email body")).toHaveValue("I typed this while generation was running.");
  await page.getByTestId("desk-angle-tab-direct_fit").click();
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("fixture subject 2");
  await page.getByRole("button", { name: /Devi Fixture/ }).click();
  await expect(page.getByTestId("desk-angle-tab-direct_fit")).toHaveCount(0);
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("");
});

test("a late generation response cannot populate a different person's composer", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.generationDelay = 700; });
  await page.getByTestId("desk-generate-angles").click();
  await page.getByRole("button", { name: /Devi Fixture/ }).click();
  await expect(page.getByTestId("desk-name")).toHaveText("Devi Fixture");
  await expect.poll(() => page.evaluate(() => window.deskFixture.generationsFinished)).toBe(1);
  await expect(page.getByTestId("desk-angle-tab-light_touch")).toHaveCount(0);
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("");
});


test("typing during the initial save is preserved when generation completes", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.saveDelay = 700; });
  const body = page.getByLabel("Email body");
  await body.fill("An unsaved opening before generating.");
  await page.getByTestId("desk-generate-angles").click();
  await expect.poll(() => page.evaluate(() => window.deskFixture.savesStarted)).toBeGreaterThan(0);
  await body.fill("I kept typing while the initial save was pending.");
  await expect(page.getByTestId("desk-angle-status")).toContainText("Choose an angle");
  await expect(body).toHaveValue("I kept typing while the initial save was pending.");
  await expect(page.getByTestId("desk-angle-tab-light_touch")).toHaveAttribute("aria-pressed", "false");
});


test("a thrown network save keeps edits and explains why switching or formatting did not run", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.getByTestId("desk-generate-angles").click();
  const body = page.getByLabel("Email body");
  await expect(body).toHaveValue(/fixture opening 1/);
  await page.evaluate(() => { window.deskFixture.throwSave = true; });
  await body.fill("My unsaved edit during a network failure.");
  await page.getByRole("button", { name: "Next angle", exact: true }).click();
  await expect(page.getByText("Could not save your draft.", { exact: false })).toBeVisible();
  await expect(body).toHaveValue("My unsaved edit during a network failure.");
  await page.getByRole("button", { name: "Format email", exact: true }).click();
  await expect(body).toHaveValue("My unsaved edit during a network failure.");
  await expect(page.getByTestId("desk-save-state")).toContainText("save");
  expect(failures).toEqual([]);
});

test("pending drafting shows truthful status, elapsed time and allows stopping without late edits", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.generationDelay = 2500; });
  await page.getByTestId("desk-generate-angles").click();
  const progress = page.getByTestId("desk-draft-progress");
  await expect(progress).toContainText("Drafting three openings");
  await expect(progress).toContainText("60s limit");
  await expect(progress).toContainText("You can keep writing");
  await page.screenshot({ path: "test-results/screenshots/desk-drafting-progress.png", fullPage: true });
  await page.getByLabel("Email body").fill("My short question stays here.");
  await page.getByRole("button", { name: "Stop waiting", exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByTestId("desk-generation-error")).toContainText("Stopped waiting");
  await expect.poll(() => page.evaluate(() => window.deskFixture.generationsFinished)).toBe(1);
  await expect(page.getByLabel("Email body")).toHaveValue("My short question stays here.");
  await expect(page.getByTestId("desk-angle-tab-light_touch")).toHaveCount(0);
});

test("a stalled request times out and retry accepts only the new result", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { window.deskFixture.generationDelay = 90000; });
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-draft-progress")).toContainText("Drafting three openings");
  await page.clock.fastForward(26000);
  await expect(page.getByTestId("desk-draft-progress")).toContainText("Still waiting");
  await page.clock.fastForward(35000);
  await expect(page.getByTestId("desk-generation-error")).toContainText("No drafts arrived within 60 seconds");
  await expect(page.getByTestId("desk-draft-progress")).toHaveCount(0);
  await page.evaluate(() => { window.deskFixture.generationDelay = 0; });
  await page.getByRole("button", { name: "Try drafting again", exact: true }).click();
  await page.clock.runFor(50);
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("fixture subject 1");
  await expect(page.getByTestId("desk-generation-error")).toHaveCount(0);
});

test("failed generation is visible and retry recovers", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.failGeneration = true; });
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-generation-error")).toContainText("Fixture generation failed.");
  await page.evaluate(() => { window.deskFixture.failGeneration = false; });
  await page.getByRole("button", { name: "Try drafting again", exact: true }).click();
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("fixture subject 1");
});

test("failed initial save explains why drafting never started", async ({ page }) => {
  await page.evaluate(() => { window.deskFixture.failSave = true; });
  await page.getByLabel("Email body").fill("My brief opening question?");
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-generation-error")).toContainText("Drafting did not start");
  expect(await page.evaluate(() => window.deskFixture.generationsFinished)).toBe(0);
});

test("offer override reaches generation, explains selection and preserves edited text until a new angle is chosen", async ({ page }) => {
  const body = page.getByLabel("Email body");
  await body.fill("My careful first message must survive an offer change.");
  await page.getByLabel("Offer choice").selectOption("eu-ai-act-readiness");
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-offer-selection")).toContainText("EU AI Act Readiness assessment");
  await expect(body).toHaveValue("My careful first message must survive an offer change.");
  expect(await page.evaluate(() => window.deskFixture.requestedOffer)).toBe("eu-ai-act-readiness");
  await page.getByTestId("desk-angle-tab-light_touch").click();
  await expect(body).toHaveValue(/fixture opening 1/);
  await body.fill("My edited EU invitation.");
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-angle-status")).toContainText("Choose an angle");
  await expect(body).toHaveValue("My edited EU invitation.");
  await page.getByLabel("Offer choice").selectOption("none");
  await expect(page.getByTestId("desk-offer-selection")).toContainText("Choice changed");
  await page.getByTestId("desk-generate-angles").click();
  await expect(page.getByTestId("desk-offer-selection")).toContainText("No offer: conversation opener");
  await expect(body).toHaveValue("My edited EU invitation.");
  await page.getByText("Devi Fixture", { exact: true }).click();
  await expect(page.getByLabel("Offer choice")).toHaveValue("auto");
});
