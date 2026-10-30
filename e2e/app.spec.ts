// End-to-end: the owner signs in and sees the seeded numbers on every page, a non-owner is bounced
// back to /login, and the old /review link lands on /content.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { admin, PASSWORD, USERS, type Who } from "../test/support/seed.ts";
import { addDays, mondayOf } from "../lib/week.ts";
import { WHY, PILLARS, REGENERA, PERSONAL, CHANNELS, INSPIRATION } from "../lib/guide/content.ts";
import { REDFLAGS } from "../lib/engage/redflags.ts";

async function login(page: Page, who: Who) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function expectKpi(page: Page, label: string, value: string) {
  const card = page.getByText(label, { exact: true }).locator("xpath=ancestor::*[contains(@class,'p-5')][1]");
  await expect(card, label).toContainText(value);
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true });
}

test("a non-owner and a user_metadata impostor land back on /login", async ({ page }) => {
  for (const who of ["member", "impostor"] as const) {
    await page.context().clearCookies();
    await login(page, who);
    // Prove the probe is a signed-in non-owner: the session cookie exists before we try the pages.
    await expect.poll(async () => (await page.context().cookies()).some((c) => /^sb-.*-auth-token/.test(c.name)), { message: `${who} session cookie` }).toBe(true);
    await page.waitForURL("**/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    for (const path of ["/", "/costs", "/content"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
    await expect(page.getByText("Fixture upcoming approved")).toHaveCount(0);
  }
});

test("a gtm_team member (Abe) gets the Signal Desk only: every other page sends them back to /signals", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "team");
  await expect.poll(async () => (await page.context().cookies()).some((c) => /^sb-.*-auth-token/.test(c.name)), { message: "team session cookie" }).toBe(true);
  await page.goto("/signals");
  await expect(page).toHaveURL(/\/signals$/);
  await expect(page.getByRole("heading", { name: "Fixture grid strain story" })).toBeVisible();
  // The sidebar offers Signals alone.
  await expect(page.getByRole("link", { name: "Signals" })).toBeVisible();
  for (const name of ["Review", "Ideas", "Outreach", "Writing desk", "Calendar", "CRM", "Costs"]) await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  for (const path of ["/", "/content", "/costs", "/calendar", "/funnel", "/inspiration", "/ideas", "/outreach", "/outreach/write", "/guide", "/engage", "/stories/fx-story"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/signals$/);
  }
  await expect(page.getByText("Fixture upcoming approved")).toHaveCount(0);
  // A crafted view name must not crash the page.
  const res = await page.goto("/signals?view=constructor");
  expect(res?.status()).toBe(200);
});

test("the owner queues a signal as a repost and it moves to Queued", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/signals");
  const card = page.getByRole("heading", { name: "Fixture grid strain story" }).locator("xpath=ancestor::*[contains(@class,'p-5')][1]");
  await card.getByRole("button", { name: "Repost with my take" }).click();
  await expect.poll(async () => (await admin().from("gtm_signal_stories").select("status,requested_format").eq("id", "00000000-0000-4000-8000-0000000000f1").single()).data).toEqual({ status: "queued", requested_format: "repost" });
  await page.goto("/signals?view=queued");
  await expect(page.getByText("Queued as repost.")).toBeVisible();
  // Leave the fixture as seeded for any later spec.
  await admin().from("gtm_signal_stories").update({ status: "new", requested_format: null }).eq("id", "00000000-0000-4000-8000-0000000000f1");
});

test("wrong password shows the auth error and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.owner.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/invalid login credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("owner", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "owner");
    await page.waitForURL((u) => u.pathname === "/");
  });

  test("Today shows what needs John, what goes out and the CRM state", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await expectKpi(page, "Overdue posts", "1");
    // The weekly report's open changes and the Sunday candidates waiting are Today tiles.
    await expectKpi(page, "Report: change to decide", "1");
    await expectKpi(page, "Candidates waiting", "2");
    // Next 7 days: the approved post is ready, the idea is not.
    await expectKpi(page, "Not ready, next 7 days", "1");
    await expect(page.getByText("of 2 going out")).toBeVisible();
    await expect(page.getByText("Fixture upcoming approved")).toBeVisible();
    await expect(page.getByText("Fixture overdue drafted").first()).toBeVisible();
    await expect(page.getByText("Fixture later")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View", exact: true })).toHaveAttribute("href", "https://www.linkedin.com/feed/update/fixture");
    // E2E points Twenty at a closed port: the CRM panels say so instead of failing the page.
    await expect(page.getByText(/Twenty could not be read/).first()).toBeVisible();
    await shot(page, "today");
  });

  test("Performance: one week at a time, each platform in its own units, stepping weeks back and forth", async ({ page }) => {
    // The seeded LinkedIn post went out 4 days ago (06:30 UTC, the same date in Bali); open its week.
    const posted = new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10);
    const week = mondayOf(posted);
    const igSameWeek = mondayOf(new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10)) === week;
    await page.goto(`/performance?week=${posted}`);
    const tiles = page.getByTestId("tiles");
    // Engagements are counts, so they add across platforms: LinkedIn 30+5+3+2, plus Instagram's 10 if it fell in the same week.
    await expect(tiles.getByText("Engagements", { exact: true }).locator("xpath=ancestor::*[contains(@class,'p-5')][1]")).toContainText(igSameWeek ? "50" : "40");
    for (const label of ["Conversations", "Net followers", "Saves + sends"]) await expect(tiles.getByText(label, { exact: true })).toBeVisible();
    const rows = page.getByTestId("platform-rows");
    await expect(rows).toContainText("1,200");
    await expect(rows).toContainText("impressions");
    await expect(rows).toContainText("per impression");
    // Reach is never a cross-platform number.
    await expect(page.getByText("Reach (views/impressions)")).toHaveCount(0);
    await expect(page.getByTestId("report-strip").or(page.getByTestId("funnel-strip")).first()).toBeVisible();
    await expect(page.getByTestId("funnel-strip")).toContainText("Later-phase signal");

    const label = page.getByTestId("week-label");
    const before = (await label.textContent()) ?? "";
    await page.getByTestId("week-prev").click();
    await expect(page).toHaveURL(new RegExp(`week=${addDays(week, -7)}`));
    await expect(label).not.toHaveText(before);
    await page.getByTestId("week-next").click();
    await expect(page).toHaveURL(new RegExp(`week=${week}`));
    await expect(label).toHaveText(before);
    // Compare with the 4-week median keeps the week (the current week carries no week= parameter).
    await page.getByRole("link", { name: "4-week median" }).click();
    await expect(page).toHaveURL(/compare=median4/);
    await expect(label).toHaveText(before);
    await expect(page.getByText("vs 4-week median").first()).toBeVisible();
    await shot(page, "performance");

    // One platform; then the post itself.
    await page.goto(`/performance?week=${posted}&platform=linkedin`);
    await expect(page.getByRole("heading", { name: "Performance: LinkedIn" })).toBeVisible();
    await page.goto("/performance/post/zp-1?platform=linkedin");
    await expect(page.getByTestId("post-title")).toHaveText("Fixture published");
    await expect(page.getByTestId("post-figures")).toContainText("1,200");
    await expect(page.getByTestId("post-copy")).toBeVisible();
    await shot(page, "performance-post");
  });

  test("Performance: the owner adds the week's YouTube stats in the sheet and they land in gtm_manual_metrics", async ({ page }) => {
    // Today in John's timezone (REPORT_TZ, Bali), as the dashboard picks the current week.
    const week = mondayOf(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date()));
    await admin().from("gtm_manual_metrics").delete().eq("week_start", week).eq("channel", "youtube");
    await page.goto("/performance");
    await page.getByRole("button", { name: "Add week's stats" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Channel").selectOption("youtube");
    await sheet.getByLabel("Impressions", { exact: true }).fill("abc");
    await sheet.getByRole("button", { name: "Save stats" }).click();
    await expect(sheet.getByRole("alert")).toContainText("enter a number");
    await sheet.getByLabel("Impressions", { exact: true }).fill("1,240");
    await sheet.getByLabel(/click-through rate/).fill("4.2");
    await sheet.getByRole("button", { name: "Save stats" }).click();
    await expect(sheet.getByRole("status")).toContainText("Saved YouTube");
    await expect.poll(async () => (await admin().from("gtm_manual_metrics").select("metrics,entered_by").eq("week_start", week).eq("channel", "youtube").maybeSingle()).data)
      .toEqual({ metrics: { impressions: 1240, ctr: 4.2 }, entered_by: USERS.owner.email });
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("manual-rows")).toContainText("1,240 impressions");
    await admin().from("gtm_manual_metrics").delete().eq("week_start", week).eq("channel", "youtube");
  });

  test("CRM shows the latest snapshot and enrichment runs, with snapshot opportunities when Twenty is down", async ({ page }) => {
    await page.goto("/funnel");
    await expect(page.getByRole("heading", { name: "CRM", exact: true })).toBeVisible();
    await expectKpi(page, "Enrichment attempted", "321");
    await expectKpi(page, "Enriched", "173");
    await expectKpi(page, "Contacted", "27");
    await expectKpi(page, "Warm / hot", "9");
    await expect(page.getByText("61 companies")).toBeVisible();
    await expectKpi(page, "signed", "2");
    await expectKpi(page, "proposal", "3");
    await expect(page.getByRole("cell", { name: "fx-run-1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "777" })).toBeVisible();
    await expect(page.getByText("4 capture notes in 7 days")).toBeVisible();
    await expect(page.getByText("1 note seen but not finished after 24h")).toBeVisible();
    await expect(page.getByText("Not onboarded")).toBeVisible();
    await shot(page, "funnel");
  });

  test("Costs shows seeded spend, vendors and unclassified charges", async ({ page }) => {
    await page.goto("/costs");
    await expectKpi(page, "Last 30 days, all tools", "€74");
    await expectKpi(page, "Last 30 days, GTM + content", "€49");
    await expectKpi(page, "Active vendors", "3");
    await expect(page.getByRole("cell", { name: "Old Fixture Tool" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unclassified software charges" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Mystery Fixture SaaS", exact: true })).toBeVisible();
    await shot(page, "costs");
  });

  test("the Stories index redirects to Content review; a Story's own page still opens", async ({ page }) => {
    await page.goto("/stories");
    await expect(page).toHaveURL(/\/content$/);
    await page.goto("/stories/fx-story");
    await expect(page.getByText("Fixture copy").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Content review" }).first()).toHaveAttribute("href", "/content");
    await shot(page, "story");
  });

  test("Calendar opens on the current week by default, and remembers the last view chosen", async ({ page }) => {
    // A bare /calendar with no remembered view is the week (John, 2026-10-17).
    await page.goto("/calendar");
    const todayLabel = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "Europe/Berlin" });
    await expect(page.getByRole("heading", { name: todayLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Week", exact: true })).toHaveAttribute("aria-current", "page");
    // Choosing Month is remembered: the next bare visit opens the month.
    await page.getByRole("link", { name: "Month", exact: true }).click();
    await expect(page).toHaveURL(/\/calendar\?view=month$/);
    await expect(page.getByRole("link", { name: "Month", exact: true })).toHaveAttribute("aria-current", "page");
    await expect.poll(async () => (await page.context().cookies()).find((c) => c.name === "gtm_calendar_view")?.value).toBe("month");
    await page.goto("/calendar");
    await expect(page.getByRole("link", { name: "Month", exact: true })).toHaveAttribute("aria-current", "page");
    // An address that names a view still wins over the remembered one.
    await page.goto("/calendar?view=week");
    await expect(page.getByRole("link", { name: "Week", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("Calendar month view opens on the current month and moves between months", async ({ page }) => {
    await page.goto("/calendar?view=month");
    // Opens on today's month (Europe/Berlin), not a hardcoded one, with every post draggable to another day.
    const monthName = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "Europe/Berlin" });
    await expect(page.getByText(new RegExp(`${monthName} · Europe/Berlin · \\d+ posts?`))).toBeVisible();
    await expect(page.getByText("drag a post to another day").first()).toBeVisible();
    await page.getByRole("link", { name: "Next month" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=month&month=\d{4}-\d{2}$/);
    await page.getByRole("link", { name: "This month" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=month$/);
    await shot(page, "calendar-month");
  });

  test("Calendar week view opens on the current week and moves between weeks", async ({ page }) => {
    await page.goto("/calendar?view=week");
    // Opens on today's week (Europe/Berlin), not a hardcoded date: today's day label is on the grid.
    const todayLabel = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "Europe/Berlin" });
    await expect(page.getByRole("heading", { name: todayLabel, exact: true })).toBeVisible();
    await expect(page.getByText(/Europe\/Berlin · \d+ posts?/)).toBeVisible();
    await page.getByRole("link", { name: "Next week" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=week&week=\d{4}-\d{2}-\d{2}/);
    await page.getByRole("link", { name: "This week" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=week$/);
    await shot(page, "calendar");
  });

  test("Calendar list view groups the whole calendar and filters it", async ({ page }) => {
    await page.goto("/calendar");
    await page.getByRole("link", { name: "List" }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(page.getByRole("heading", { name: "Overdue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Went out" })).toBeVisible();
    for (const t of ["Fixture overdue drafted", "Fixture upcoming approved", "Fixture later", "Fixture published"]) await expect(page.getByText(t, { exact: true })).toBeVisible();
    await page.getByLabel("Any channel").selectOption("instagram");
    await expect(page).toHaveURL(/channel=instagram/);
    await expect(page.getByText("Fixture later", { exact: true })).toBeVisible();
    await expect(page.getByText("Fixture upcoming approved", { exact: true })).toHaveCount(0);
    await page.getByLabel("Search titles and captions").fill("approved body");
    await page.getByLabel("Search titles and captions").press("Enter");
    await expect(page.getByText("No posts match.")).toBeVisible();
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=list$/);
    await page.getByText("Fixture upcoming approved", { exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Fixture approved body.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Publish now" })).toBeEnabled();
    await shot(page, "calendar-list");
  });

  test("Inspiration lists seeded references and filters by kind", async ({ page }) => {
    await page.goto("/inspiration");
    const grid = page.getByTestId("inspiration-grid");
    await expect(grid.getByText("Fixture motion graphics")).toBeVisible();
    await expect(grid.getByText("Fixture newsletter reference")).toBeVisible();
    await page.getByRole("link", { name: "newsletter", exact: true }).click();
    await expect(page).toHaveURL(/kind=newsletter/);
    await expect(grid.getByText("Fixture motion graphics")).toHaveCount(0);
    await expect(grid.getByText("Fixture newsletter reference")).toBeVisible();
    await expect(page.getByRole("form", { name: "Add inspiration" })).toBeVisible();
    await shot(page, "inspiration");
  });

  test("Substack export: publication, title fields, permanent image URL, no H1 or footer in the paste", async ({ page }) => {
    await page.goto("/stories/fx-newsletter");
    const panel = page.getByTestId("substack-export");
    await expect(panel.getByTestId("substack-publication")).toHaveText("Regenera");
    await expect(panel.getByText("Fixture newsletter title")).toBeVisible();
    await expect(panel.getByText("Fixture subtitle")).toBeVisible();
    const preview = panel.getByTestId("substack-preview");
    await expect(preview.locator("h1")).toHaveCount(0);
    await expect(preview.getByText("Fixture disclosure footer.")).toHaveCount(0);
    await expect(preview.locator("img")).toHaveAttribute("src", "https://pub.example.test/fx/header.jpg");
    await expect(panel.getByText("will break after pasting")).toHaveCount(0);
    await shot(page, "substack-export");
  });

  test("the retired /review screen redirects to /content", async ({ page }) => {
    for (const path of ["/review", "/review/00000000-0000-0000-0000-000000000000?t=1500"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/content(\?|$)/);
      await expect(page.getByRole("heading", { level: 1, name: "Content review" })).toBeVisible();
    }
    // The sidebar's "Review" now points at /content; nothing links to the retired screen.
    await expect(page.locator('a[href^="/review"]')).toHaveCount(0);
  });

  test("Content Guide: every chapter renders, the pillar and voice controls work, the plan is live", async ({ page }) => {
    await page.goto("/guide");
    await expect(page.getByRole("heading", { level: 1, name: WHY.inquiries[0].question })).toBeVisible();
    for (const h of ["Four pillars", "The stories we tell", "Voice", "The asset library", "Channel playbook", "Inspiration board", "The pipeline", "The next ten weeks"]) {
      await expect(page.getByRole("heading", { level: 2, name: h, exact: true })).toBeVisible();
    }
    for (const s of [REGENERA, PERSONAL]) await expect(page.locator(`#${s.slug}`).getByRole("heading", { level: 2, name: s.name, exact: true })).toBeVisible();
    const pillars = page.locator("#pillars");
    const build = PILLARS.find(p => p.slug === "build")!;
    await pillars.getByRole("tab", { name: new RegExp(build.name) }).click();
    await expect(pillars.getByRole("tab", { name: new RegExp(build.name) })).toHaveAttribute("aria-selected", "true");
    await expect(pillars.getByRole("img", { name: `Voice dial: ${build.dial_label}` })).toBeVisible();
    await expect(pillars.getByText(`${build.name}: real posts`)).toBeVisible();
    const voice = page.locator("#voice");
    await voice.getByRole("button", { name: "Before", exact: true }).click();
    await expect(voice.getByText("site register pasted into a personal post")).toBeVisible();
    await expect(page.locator("#channels")).toContainText(CHANNELS.channels.find(c => c.slug === "instagram")!.link_rule);
    await expect(page.locator("#inspiration")).toContainText(INSPIRATION[0].title);
    // The plan reads gtm_content_items: the seeded upcoming item shows, colour-coded, in its week.
    await expect(page.locator("#plan").getByText("Fixture upcoming approved")).toBeVisible();
    await expect(page.getByRole("link", { name: "Content Guide" })).toHaveAttribute("aria-current", "page");
    await shot(page, "guide");
  });

  test("Content Guide on a phone: no sideways scroll, the drawer opens and closes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/guide");
    await expect(page.getByRole("heading", { level: 1, name: WHY.inquiries[0].question })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.locator("aside").getByRole("link", { name: "Calendar", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("aside").getByRole("link", { name: "Calendar", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("aside").getByRole("link", { name: "Calendar", exact: true })).toBeHidden();
    await shot(page, "guide-phone-drawer");
  });

  test("sign out returns to /login and pages are gated again", async ({ page }) => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
    await page.goto("/costs");
    await expect(page).toHaveURL(/\/login$/);
    await shot(page, "login");
  });
});

test("engage: the owner clears the reply queue on a phone; a failed send says so and nothing is lost", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/engage");
  const cards = page.getByTestId("engage-card");
  await expect(cards).toHaveCount(3);
  // The quick approval comes first; the card that needs John carries a word and an icon, not just a color.
  await expect(cards.first()).toContainText("How did you measure adoption in week one?");
  const linkedin = cards.filter({ hasText: "Which team went first?" });
  await expect(linkedin.getByText("Needs you")).toBeVisible();
  await expect(linkedin.getByRole("button", { name: "Copy reply and open" })).toBeDisabled();
  await expect(linkedin.getByText(/Fill in the \[JOHN/)).toBeVisible();
  await shot(page, "engage-mobile");

  // Zernio is a closed port in this run: Approve fails, the card says why and the row is kept as failed.
  const ig = cards.first();
  await ig.getByLabel("Reply as John").fill("We counted who finished the first assessment.");
  await ig.getByRole("button", { name: "Approve and send" }).click();
  await expect(ig.getByRole("alert")).toContainText("Zernio did not send it");
  await expect.poll(async () => (await admin().from("gtm_comments").select("status,final_text").eq("id", "00000000-0000-4000-8000-0000000000e1").single()).data)
    .toEqual({ status: "failed", final_text: "We counted who finished the first assessment." });

  await ig.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Skipped" })).toBeVisible();
  await expect.poll(async () => (await admin().from("gtm_comments").select("status").eq("id", "00000000-0000-4000-8000-0000000000e1").single()).data?.status).toBe("skipped");
  await page.goto("/engage?view=done");
  await expect(page.getByRole("status").filter({ hasText: "Sent, edited" })).toBeVisible();

  await admin().from("gtm_comments").update({ status: "drafted", final_text: null, error: null, note: null }).eq("id", "00000000-0000-4000-8000-0000000000e1");
});

test("engage: a red flag sits above the queue with a word and an icon, and links to the post's whole thread", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/engage");
  const flag = page.getByTestId("red-flag").first();
  await expect(flag).toContainText("Backlash");
  await expect(flag).toContainText("2 hostile or bad faith");
  await expect(flag).toContainText("Core objection: fixture objection about AI hype");
  await expect(flag).toContainText(`Recommended: ${REDFLAGS.actions.hide_and_report}`);
  await shot(page, "engage-red-flags");
  await flag.getByRole("link", { name: /See the \d+ comments/ }).click();
  await expect(page).toHaveURL(/post=instagram%7Cig-post-1/);
  await expect(page.getByText("All comments on one post.")).toBeVisible();
  await expect(page.getByTestId("engage-cards").getByText("Fixture Troll 1")).toBeVisible();
  await expect(page.getByText("How did you measure adoption in week one?")).toBeVisible();
});

test("engage: a card shows who wrote it; John overrules a spam label and the card opens for a reply (VIB-428)", async ({ page }) => {
  const ID = "00000000-0000-4000-8000-0000000000e4";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/engage");
  const card = page.getByTestId("engage-card").filter({ hasText: "Fixture Partner" });
  // Spam goes last, and the card says who this is: headline, followers, website, a link to the profile.
  await expect(page.getByTestId("engage-card").last()).toContainText("Fixture Partner");
  await expect(card.getByText("Looks like spam")).toBeVisible();
  await expect(card.getByTestId("engage-who")).toContainText("Founder, Example Network");
  await expect(card.getByTestId("engage-who")).toContainText("10.4k followers");
  await expect(card.getByRole("link", { name: "example.com", exact: true })).toHaveAttribute("href", "https://example.com/network");
  await expect(card.getByRole("link", { name: "Fixture Partner" })).toHaveAttribute("href", "https://www.linkedin.com/in/fixture-partner/");
  await expect(card.getByLabel("Reply as John")).toHaveCount(0);
  // Their link is clickable, and what it says is on the card (read and summarized by the drafting run).
  const link = card.getByRole("link", { name: "https://example.com/network/essay" });
  await expect(link).toHaveAttribute("href", "https://example.com/network/essay");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(card.getByTestId("engage-linked")).toContainText("Low tech and high tech");
  await expect(card.getByTestId("engage-linked")).toContainText("soil and servers sit on one spectrum");
  await shot(page, "engage-spam-profile");

  // No model in this run: the redraft fails, and the card still opens for John to write the reply.
  await card.getByRole("button", { name: "Not spam" }).click();
  await expect(card.getByText("Not spam (you)")).toBeVisible();
  await expect(card.getByText("Looks like spam")).toHaveCount(0);
  await expect(card.getByLabel("Reply as John")).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve and send" })).toBeDisabled();
  await expect.poll(async () => (await admin().from("gtm_comments").select("status,classification,reclassified_from").eq("id", ID).single()).data)
    .toEqual({ status: "drafted", classification: "needs_john", reclassified_from: "spam" });
  await shot(page, "engage-not-spam");

  // Learning: John's lessons, the score per lesson set, and the draft next to what he sent.
  await page.goto("/engage?view=learning");
  const learning = page.getByTestId("engage-learning");
  await expect(learning.getByText("Fixture lesson: react to their specific point first")).toBeVisible();
  await expect(learning.getByTestId("engage-learning-score")).toContainText("No lessons yet (baseline)");
  await expect(learning.getByText("Thanks for watching!")).toBeVisible();
  await shot(page, "engage-learning");

  await admin().from("gtm_comments").update({ status: "drafted", classification: "spam", reclassified_from: null, stance: "spam", note: null, acted_at: null, acted_by: null, draft: null }).eq("id", ID);
});

test("candidates: the owner edits one, rejects one with a reason and sends one to Content review", async ({ page }) => {
  const CAROUSEL = "00000000-0000-4000-8000-0000000000c1";
  const TEXT = "00000000-0000-4000-8000-0000000000c2";
  const db = admin();
  const seeded = (await db.from("gtm_content_candidates").select("*").in("id", [CAROUSEL, TEXT])).data ?? [];
  // Send to Review needs a season covering the candidates' week.
  await db.from("gtm_seasons").insert({ id: "season-9", title: "Fixture candidates season", starts_on: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10), ends_on: new Date(Date.now() + 120 * 86400_000).toISOString().slice(0, 10) });
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await expectKpi(page, "Candidates waiting", "2");
  await page.goto("/signals?view=candidates");
  const cards = page.getByTestId("candidate-card");
  await expect(cards).toHaveCount(2);
  const carousel = page.locator(`[data-id="${CAROUSEL}"]`);
  // Format chip, pillar, platform glyphs, rubric score, the slide strip at 4:5, the slot that needs John.
  await expect(carousel.getByText("Carousel", { exact: true })).toBeVisible();
  await expect(carousel.getByText("Lists", { exact: true })).toBeVisible();
  await expect(carousel.getByRole("img", { name: "Instagram" })).toBeVisible();
  await expect(carousel.getByText("rubric 84")).toBeVisible();
  await expect(carousel.getByRole("list", { name: "7 slides" }).getByRole("listitem")).toHaveCount(7);
  await expect(carousel.getByText("1 place needs your take")).toBeVisible();
  await shot(page, "candidates");

  // Edit inline: the change is stored next to the agent's frozen draft.
  await carousel.getByRole("button", { name: "Edit" }).click();
  await carousel.getByLabel("Caption (LinkedIn)").fill("Five patterns we keep seeing. Orion adopted reflection first.");
  await carousel.getByRole("button", { name: "Save edits" }).click();
  await expect(carousel.getByText("1 edit by you")).toBeVisible();
  await expect.poll(async () => (await db.from("gtm_content_candidates").select("body,edits").eq("id", CAROUSEL).single()).data?.edits?.length).toBe(1);

  // Reject the text post with a reason; the reason lands on the signal as a taste label.
  const text = page.locator(`[data-id="${TEXT}"]`);
  await text.getByRole("button", { name: "Reject" }).click();
  await text.getByLabel("Reason").selectOption("timing");
  await text.getByRole("button", { name: "Reject" }).click();
  await expect(text.getByRole("status")).toContainText("Rejected: Not timely anymore");
  await expect.poll(async () => (await db.from("gtm_signal_feedback").select("action,reason").eq("candidate_id", TEXT)).data).toEqual([{ action: "reject", reason: "timing" }]);

  // Send to Review: a Story with drafted items appears in Content review; nothing is approved.
  await carousel.getByRole("button", { name: "Send to Review" }).click();
  await expect(carousel.getByRole("status")).toContainText("Sent to review");
  const staged = (await db.from("gtm_content_candidates").select("status,gtm_story_id,content_item_ids").eq("id", CAROUSEL).single()).data!;
  expect(staged.status).toBe("accepted");
  const items = (await db.from("gtm_content_items").select("status,approved_hash").in("id", staged.content_item_ids)).data ?? [];
  expect(items.map((i) => [i.status, i.approved_hash])).toEqual([["drafted", null], ["drafted", null]]);
  await page.goto("/content");
  // The staged piece is one of Content review's pieces (its filter lists it by name).
  await expect(page.locator(`option[value="${staged.gtm_story_id}"]`)).toHaveText("Fixture five agent patterns");

  // Leave the fixtures as seeded for any later spec.
  await db.from("gtm_content_items").delete().in("id", staged.content_item_ids);
  await db.from("gtm_stories").delete().eq("id", staged.gtm_story_id!);
  await db.from("gtm_signal_feedback").delete().eq("candidate_id", TEXT);
  await db.from("gtm_content_candidates").upsert(seeded);
  await db.from("gtm_seasons").delete().eq("id", "season-9");
});

test("the owner holds a piece pending third-party approval, sees the badge, then releases it", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  await page.goto("/stories/fx-story");
  await page.getByRole("button", { name: "Pending third-party approval" }).click();
  await page.getByLabel("Who (optional)").fill("example_approver / Example Series");
  await page.getByLabel("Note (optional)").fill("They only ever see the final cut");
  await page.getByRole("button", { name: "Hold for approval" }).click();
  const hold = page.getByRole("status", { name: "Third-party hold" });
  await expect(hold).toContainText("Publishing blocked until example_approver / Example Series approves the final");
  await expect(hold).toContainText("They only ever see the final cut");
  await expect.poll(async () => (await db.from("gtm_stories").select("hold_who,hold_note").eq("id", "fx-story").single()).data).toEqual({ hold_who: "example_approver / Example Series", hold_note: "They only ever see the final cut" });
  // It survives a reload: the hold is stored, not page state.
  await page.reload();
  await expect(page.getByRole("status", { name: "Third-party hold" })).toContainText("example_approver / Example Series");
  await shot(page, "story-held");
  await page.getByRole("button", { name: "example_approver / Example Series approved the final" }).click();
  await expect(page.getByRole("button", { name: "Pending third-party approval" })).toBeVisible();
  await expect.poll(async () => (await db.from("gtm_stories").select("held_at").eq("id", "fx-story").single()).data?.held_at).toBeNull();
});

test("a rough cut wears its stage badge and says approving a stage schedules nothing", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const id = "fx-story-rough";
  await db.from("gtm_story_assets").insert({ id, story_id: "fx-story", title: "Fixture rough cut", kind: "video", source: "rough.mp4", sha256: "e".repeat(64), storage_path: "stories/fx-story/rough.mp4", stage: "rough-cut" });
  await db.from("gtm_story_asset_channels").insert({ asset_id: id, channel: "linkedin" });
  try {
    await page.goto("/stories/fx-story");
    await expect(page.getByText("Rough cut · no B-roll · no Motion").first()).toBeVisible();
    await expect(page.getByText("Approving a stage never schedules; only the final does").first()).toBeVisible();
    await shot(page, "story-rough-cut");
  } finally {
    await db.from("gtm_story_assets").delete().eq("id", id);
  }
});

test("content stages: approve the rough cut once (nothing scheduled), then the final once for both platforms, one text for both, example_approver on the final", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const story = "s1-90-fx-short";
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const cap = (who: string) => `${who} caption for the short.`;
  await db.from("gtm_stories").delete().eq("id", story);
  await db.from("gtm_stories").insert({ id: story, title: "W9 Thu Dec 3 | Fixture short", link_url: "https://example.com/short", pipeline: "short", series: "fx-series", third_party_who: "example_approver / Example Series" });
  await db.from("gtm_story_assets").insert([
    { id: `${story}-video`, story_id: story, title: "Video 9:16", kind: "video", source: "media/fx-short-9x16.mp4", sha256: sha("rough"), storage_path: `stories/${story}/rough.mp4`, stage: "rough-cut", metadata: { label: "v4" } },
    { id: `${story}-youtube`, story_id: story, title: "YouTube text", kind: "copy", source: "posts/fx/youtube.md", sha256: sha(cap("YouTube")), body: cap("YouTube"), metadata: {} },
    { id: `${story}-instagram`, story_id: story, title: "Instagram caption", kind: "copy", source: "posts/fx/instagram.md", sha256: sha(cap("Instagram")), body: cap("Instagram"), metadata: {} },
  ]);
  await db.from("gtm_story_asset_channels").insert([
    { asset_id: `${story}-video`, channel: "youtube" }, { asset_id: `${story}-video`, channel: "instagram" },
    { asset_id: `${story}-youtube`, channel: "youtube" }, { asset_id: `${story}-instagram`, channel: "instagram" },
  ]);
  await db.from("gtm_story_stages").insert([{ story_id: story, stage: "paper-edit", status: "done" }, { story_id: story, stage: "rough-cut", status: "review" }]);
  const channels = async () => Object.fromEntries(((await db.from("gtm_story_asset_channels").select("asset_id,channel,status").like("asset_id", `${story}%`)).data ?? []).map((r) => [`${r.asset_id.replace(`${story}-`, "")}:${r.channel}`, r.status]));
  try {
    // The first draft is the rough cut: no paper-edit or storyboard gate sits in front of it.
    await page.goto(`/content?piece=${story}`);
    const piece = page.getByRole("region", { name: "Fixture short" });
    await expect(piece.getByRole("link", { name: /Studio/i })).toHaveCount(0);
    await expect(piece.getByText("Rough cut · v4", { exact: true }).first()).toBeVisible();
    await expect(piece.getByText("no B-roll", { exact: true })).toBeVisible();
    await expect(piece.getByText("no Motion", { exact: true })).toBeVisible();
    await expect(piece.getByText("Publishing blocked until example_approver / Example Series approves the final")).toBeVisible();
    await expect(piece.getByRole("button", { name: /approved the final/ })).toHaveCount(0);
    const percent = await page.getByText(/% approved for publishing/).textContent();
    await piece.getByRole("button", { name: "Approve rough cut" }).click();
    await expect(piece.getByText(/Nothing is scheduled\./).first()).toBeVisible();
    await expect.poll(async () => (await db.from("gtm_story_stages").select("status").eq("story_id", story).eq("stage", "rough-cut").single()).data?.status).toBe("approved");
    expect(await channels()).toEqual({ "video:youtube": "pending", "video:instagram": "pending", "youtube:youtube": "pending", "instagram:instagram": "pending" });
    await expect(page.getByText(/% approved for publishing/)).toHaveText(percent!);
    expect((await db.from("gtm_content_items").select("id").eq("story_id", story)).data).toEqual([]);
    await shot(page, "content-rough-cut-approved");
    // B-roll and Motion are agent work: nothing to review until the final is staged.
    await page.reload();
    await expect(piece.locator("img")).toHaveCount(0);

    // The final: one approval for the video across both platforms, then one approval for the text.
    await db.from("gtm_story_stages").upsert(["broll", "motion", "finish"].map((stage) => ({ story_id: story, stage, status: "done" })));
    await db.from("gtm_story_assets").update({ sha256: sha("final"), storage_path: `stories/${story}/final.mp4`, stage: "final", metadata: {} }).eq("id", `${story}-video`);
    await page.reload();
    await piece.getByRole("button", { name: "Approve final for Instagram and YouTube" }).click();
    await expect.poll(channels).toMatchObject({ "video:youtube": "approved", "video:instagram": "approved" });
    // One text for both platforms (John, 2026-10-16): one Approve covers the text everywhere.
    await expect(piece.getByRole("tab", { name: /Instagram/ })).toHaveCount(0);
    await piece.getByRole("group", { name: "Post text" }).getByRole("button", { name: "Approve text for Instagram and YouTube" }).click();
    await expect.poll(channels).toMatchObject({ "instagram:instagram": "approved", "youtube:youtube": "approved" });

    // example_approver signs off on the final, logged against its bytes.
    await piece.getByRole("button", { name: "example_approver / Example Series approved the final" }).click();
    await expect.poll(async () => (await db.from("gtm_story_stage_decisions").select("party,stage").eq("story_id", story).eq("party", "third_party")).data).toEqual([{ party: "third_party", stage: "final" }]);
    await shot(page, "content-final-approved");
  } finally {
    await db.from("gtm_stories").delete().eq("id", story);
  }
});

test("approve with note: the note rides on the approval as a fix before scheduling; a final staged before a later storyboard approval is hidden", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const story = "s1-95-fx-awn";
  const body = "Fixture caption with one British colour.";
  await db.from("gtm_stories").delete().eq("id", story);
  await db.from("gtm_stories").insert({ id: story, title: "W9 Sat Dec 5 | Fixture approve with note", link_url: "https://example.com/awn" });
  await db.from("gtm_story_assets").insert({ id: `${story}-linkedin`, story_id: story, title: "LinkedIn text", kind: "copy", source: "posts/awn/linkedin.md", sha256: createHash("sha256").update(body).digest("hex"), body, metadata: {} });
  await db.from("gtm_story_asset_channels").insert({ asset_id: `${story}-linkedin`, channel: "linkedin" });
  try {
    await page.goto(`/content?piece=${story}&channel=linkedin`);
    const piece = page.getByRole("region", { name: "Fixture approve with note" });
    await piece.getByLabel("Note to the agent about the LinkedIn text").fill("colour should be color");
    await piece.getByRole("button", { name: "Approve LinkedIn text with note" }).click();
    await expect(piece.getByText("Waiting for fix. You approved this with a note.")).toBeVisible();
    // It is the agent's turn: no second Approve, the note and who closes it are on screen, and the badge says so.
    await expect(piece.getByText(/The agent closes it: it applies your note/)).toBeVisible();
    await expect(piece.getByRole("button", { name: /^Approve LinkedIn text/ })).toHaveCount(0);
    await expect(piece.getByTestId("waiting-on")).toHaveText("Waiting on the agent (fix): LinkedIn text");
    await expect.poll(async () => (await db.from("gtm_story_asset_channels").select("status").eq("asset_id", `${story}-linkedin`).single()).data?.status).toBe("approved");
    const notes = (await db.from("gtm_story_feedback").select("body,resolved_at").eq("asset_id", `${story}-linkedin`)).data ?? [];
    expect(notes.length).toBe(1);
    expect(notes[0].body).toMatch(/^\[approved with note: fix before scheduling\] part=text channels=linkedin assets=s1-95-fx-awn-linkedin\ncolour should be color$/);
    expect(notes[0].resolved_at).toBeNull();
    await page.reload();
    await expect(piece.getByText("Approved with note", { exact: true })).toBeVisible();
    await expect(piece.getByText("colour should be color")).toBeVisible();
    await expect(piece.getByRole("button", { name: /^Approve LinkedIn text/ })).toHaveCount(0);
    await expect(piece.getByTestId("waiting-on")).toHaveText("Waiting on the agent (fix): LinkedIn text");
    // Under "Needs approval" it is not listed (it waits on the agent); under "Waiting for fix" it is.
    await page.goto(`/content?status=needs-approval&piece=${story}`);
    await expect(piece).toHaveCount(0);
    await page.goto(`/content?status=waiting-fix&piece=${story}`);
    await expect(piece).toBeVisible();
    await shot(page, "content-approved-with-note");

    // John approves a storyboard after this final was staged: the final predates his direction, so /content leaves it out.
    await db.from("gtm_story_stage_decisions").insert({ story_id: story, stage: "storyboard", party: "john", decision: "approved", note: "approved in /studio", assets: [] });
    await page.reload();
    await expect(piece).toHaveCount(0);
    await expect(page.getByText(/Fixture approve with note is not shown: staged before you approved the storyboard/)).toBeVisible();
  } finally {
    await db.from("gtm_stories").delete().eq("id", story);
  }
});

test("a status filter says why a piece is listed: the badge names the waiting parts, the matching Substack card opens first, and unused header options never gate it", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const story = "s1-93-fx-substack-alt";
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const post = "Fixture post about the AI bill.";
  const essay = "# Fixture essay\n\n![Header](assets/header-a.jpg)\n\nThe body.\n";
  await db.from("gtm_stories").delete().eq("id", story);
  await db.from("gtm_stories").insert({ id: story, title: "W9 Fri Dec 4 | Fixture substack options", link_url: "https://example.com/alt" });
  expect((await db.from("gtm_story_assets").insert([
    { id: `${story}-linkedin`, story_id: story, title: "LinkedIn text", kind: "copy", source: "posts/alt/linkedin.md", sha256: sha(post), body: post, metadata: {} },
    { id: `${story}-substack`, story_id: story, title: "Substack draft", kind: "copy", source: "drafts/alt/substack.md", sha256: sha(essay), body: essay, metadata: {} },
    ...["a", "b", "c"].map((x) => ({ id: `${story}-header-${x}`, story_id: story, title: `Header ${x}`, kind: "image", source: `drafts/alt/assets/header-${x}.jpg`, sha256: sha(`header-${x}`), storage_path: `stories/${story}/header-${x}.jpg`, metadata: {} })),
  ])).error).toBeNull();
  await db.from("gtm_story_asset_channels").insert([
    { asset_id: `${story}-linkedin`, channel: "linkedin" },
    ...["substack", "header-a", "header-b", "header-c"].map((x) => ({ asset_id: `${story}-${x}`, channel: "newsletter" })),
  ]);
  const rows = async () => Object.fromEntries(((await db.from("gtm_story_asset_channels").select("asset_id,status").like("asset_id", `${story}-%`)).data ?? []).map((r) => [r.asset_id.replace(`${story}-`, ""), r.status]));
  try {
    await page.goto(`/content?piece=${story}&channel=linkedin`);
    const piece = page.getByRole("region", { name: "Fixture substack options" });
    await piece.getByRole("button", { name: "Approve LinkedIn text" }).click();
    await expect.poll(rows).toMatchObject({ linkedin: "approved" });

    // The live complaint (kb-tokenmaxxing): listed under Needs approval while the tab on screen says Approved.
    await page.goto(`/content?status=needs-approval&piece=${story}`);
    await expect(piece.getByTestId("waiting-on")).toHaveText("Waiting on John: Substack essay, Substack image");
    const card = piece.getByTestId("newsletter-card");
    await expect(card).toHaveAttribute("data-matched", "true");
    // The card that matched sits above the approved LinkedIn tab, so it is the first thing on the piece.
    const cardTop = (await card.boundingBox())!.y;
    const linkedinTop = (await piece.getByRole("button", { name: "Unapprove" }).first().boundingBox())!.y;
    expect(cardTop).toBeLessThan(linkedinTop);
    // The two headers the essay does not use are options: shown, never asked for.
    await expect(card.getByTestId("newsletter-alternatives")).toContainText("Alternative images (2)");
    await expect(card.getByRole("button", { name: /Approve images/ })).toHaveCount(0);
    await shot(page, "content-filter-names-the-waiting-part");

    await card.getByRole("button", { name: "Approve essay" }).click();
    await expect(piece.getByTestId("waiting-on")).toHaveText("Waiting on John: Substack image");
    await card.getByRole("button", { name: "Approve header image" }).click();
    await expect.poll(rows).toMatchObject({ substack: "approved", "header-a": "approved" });
    // Approved with nothing left waiting, so it leaves the Needs approval list at once (John, 2026-10-18: "Fully approved
    // content" was still listed under that filter until a reload).
    await expect(piece).toHaveCount(0);
    // The options were never decided, and they keep nothing waiting.
    expect(await rows()).toMatchObject({ "header-b": "pending", "header-c": "pending" });
    await page.goto(`/content?status=needs-approval&piece=${story}`);
    await expect(piece).toHaveCount(0);
    await page.goto(`/content?status=approved&piece=${story}`);
    await expect(piece).toBeVisible();
    await expect(piece.getByTestId("waiting-on")).toHaveCount(0);

    // The essay goes live on Substack: John pastes the link and its card leaves /content; the LinkedIn card stays.
    await card.getByTestId("mark-published").click();
    const form = card.getByTestId("mark-published-form");
    await form.getByRole("textbox").fill("https://nowhere");
    await form.getByRole("button", { name: "Mark published" }).click();
    await expect(form.getByRole("alert")).toContainText("Paste the full https link");
    await form.getByRole("textbox").fill("https://sample_author.substack.com/p/fixture-essay");
    await form.getByRole("button", { name: "Mark published" }).click();
    await expect(page.getByTestId("newsletter-card")).toHaveCount(0);
    await expect(piece).toBeVisible();
    const marked = (await db.from("gtm_story_assets").select("metadata").eq("id", `${story}-substack`).single()).data?.metadata as { published_url?: string } | undefined;
    expect(marked?.published_url).toBe("https://sample_author.substack.com/p/fixture-essay");
  } finally {
    await db.from("gtm_stories").delete().eq("id", story);
  }
});

test("one video in several formats: a note on one format covers them all, stored once; \"Only this format\" keeps it to one; one Approve covers every format", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const story = "s1-96-fx-reel";
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const formats = [["video-4x5", "linkedin", "4x5"], ["video-9x16", "instagram", "9x16"], ["video-9x16-youtube", "youtube", "9x16-youtube"]] as const;
  await db.from("gtm_stories").delete().eq("id", story);
  await db.from("gtm_stories").insert({ id: story, title: "W9 Sun Dec 6 | Fixture reel", link_url: "https://example.com/reel" });
  await db.from("gtm_story_assets").insert([
    ...formats.map(([id, , f]) => ({ id: `${story}-${id}`, story_id: story, title: `Video ${f}`, kind: "video", source: `output/reel-${f}.mp4`, sha256: sha(`${f}-1`), storage_path: `stories/${story}/${f}-1.mp4`, stage: "final", metadata: {} })),
    ...formats.map(([, ch]) => ({ id: `${story}-${ch}`, story_id: story, title: `${ch} text`, kind: "copy", source: `posts/reel/${ch}.md`, sha256: sha(`${ch} caption`), body: `${ch} caption`, metadata: {} })),
  ]);
  await db.from("gtm_story_asset_channels").insert(formats.flatMap(([id, ch]) => [{ asset_id: `${story}-${id}`, channel: ch }, { asset_id: `${story}-${ch}`, channel: ch }]));
  const videos = async () => Object.fromEntries(((await db.from("gtm_story_asset_channels").select("asset_id,channel,status").like("asset_id", `${story}-video%`)).data ?? []).map((r) => [r.asset_id.replace(`${story}-`, ""), r.status]));
  const restage = async (n: number) => { for (const [id, , f] of formats) await db.from("gtm_story_assets").update({ sha256: sha(`${f}-${n}`), storage_path: `stories/${story}/${f}-${n}.mp4` }).eq("id", `${story}-${id}`); };
  try {
    // A note on the LinkedIn 4:5 cut: every format is sent back, and the note is stored once, naming all three.
    await page.goto(`/content?piece=${story}&channel=linkedin`);
    const piece = page.getByRole("region", { name: "Fixture reel" });
    const media = piece.getByRole("group", { name: /^Video 4:5 for LinkedIn/ });
    await media.getByLabel("Note to the agent about the video 4:5").fill("Center the overnight line.");
    await expect(media.getByLabel("Only this format")).not.toBeChecked();
    await media.getByRole("button", { name: "Request changes" }).click();
    await expect.poll(videos).toEqual({ "video-4x5": "rejected", "video-9x16": "rejected", "video-9x16-youtube": "rejected" });
    const notes = (await db.from("gtm_story_feedback").select("asset_id,channel,body").like("asset_id", `${story}%`)).data ?? [];
    expect(notes).toEqual([{ asset_id: `${story}-video-4x5`, channel: null, body: `[note for all formats] assets=${story}-video-4x5,${story}-video-9x16,${story}-video-9x16-youtube\nCenter the overnight line.` }]);
    // Every format leaves /content together until the new versions are staged; the text stays to review.
    await expect(piece.getByText("Media sent back for changes")).toBeVisible();
    await expect(piece.getByRole("group", { name: /^Video / })).toHaveCount(0);
    await expect(piece.getByRole("group", { name: "Post text" })).toBeVisible();
    await shot(page, "content-note-all-formats");

    // "Only this format": the note and the send-back stay on the YouTube cut.
    await restage(2);
    await db.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: "centered" }).like("asset_id", `${story}%`);
    await page.goto(`/content?piece=${story}&channel=youtube`);
    const yt = piece.getByRole("group", { name: /^Video 9:16 for YouTube/ });
    await yt.getByLabel("Note to the agent about the video 9:16").fill("Only the YouTube end card is cut off.");
    await yt.getByLabel("Only this format").check();
    await yt.getByRole("button", { name: "Request changes" }).click();
    await expect.poll(videos).toEqual({ "video-4x5": "pending", "video-9x16": "pending", "video-9x16-youtube": "rejected" });
    const open = (await db.from("gtm_story_feedback").select("asset_id,channel,body").like("asset_id", `${story}%`).is("resolved_at", null)).data ?? [];
    expect(open).toEqual([{ asset_id: `${story}-video-9x16-youtube`, channel: "youtube", body: "Only the YouTube end card is cut off." }]);

    // One Approve covers every format.
    await restage(3);
    await page.goto(`/content?piece=${story}&channel=instagram`);
    await piece.getByRole("group", { name: /^Video 9:16 for Instagram/ }).getByRole("button", { name: "Approve final for LinkedIn and Instagram and YouTube" }).click();
    await expect.poll(videos).toEqual({ "video-4x5": "approved", "video-9x16": "approved", "video-9x16-youtube": "approved" });
  } finally {
    await db.from("gtm_stories").delete().eq("id", story);
  }
});

test("what changed: a jump point seeks the video, and the panel says what is unchanged since the rough-cut approval", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const story = "s1-91-fx-seek";
  const clip = readFileSync(new URL("../test/fixtures/clip.mp4", import.meta.url));
  const sha = createHash("sha256").update(clip).digest("hex");
  const key = `stories/${story}/${story}-video-${sha.slice(0, 16)}.mp4`;
  await db.from("gtm_stories").delete().eq("id", story);
  await db.storage.from("content-review").upload(key, clip, { contentType: "video/mp4", upsert: true });
  await db.from("gtm_stories").insert({ id: story, title: "W9 Fri Dec 4 | Fixture seek", link_url: "https://example.com/seek" });
  const inputs = { keep: "a".repeat(64), dialogue: "b".repeat(64) };
  // v1 (a rough cut John approved as a stage), then v1.1 with B-roll, the same edit and dialogue, and a jump point.
  await db.from("gtm_story_assets").insert({ id: `${story}-video`, story_id: story, title: "Video 9:16", kind: "video", source: "media/seek-9x16.mp4", sha256: "c".repeat(64), storage_path: key, stage: "rough-cut", metadata: { inputs } });
  await db.from("gtm_story_assets").update({ sha256: sha, stage: "final", metadata: { inputs: { ...inputs, broll: "d".repeat(64) }, changes: "B-roll B1 to B7", review_points: [{ t: 1.5, label: "B4 GPU rack" }] } }).eq("id", `${story}-video`);
  await db.from("gtm_story_assets").insert({ id: `${story}-youtube`, story_id: story, title: "YouTube text", kind: "copy", source: "posts/seek/youtube.md", sha256: createHash("sha256").update("Seek caption.").digest("hex"), body: "Seek caption.", metadata: {} });
  await db.from("gtm_story_asset_channels").insert([{ asset_id: `${story}-video`, channel: "youtube" }, { asset_id: `${story}-youtube`, channel: "youtube" }]);
  await db.from("gtm_story_stage_decisions").insert({ story_id: story, stage: "rough-cut", party: "john", decision: "approved", assets: [{ asset_id: `${story}-video`, sha256: "c".repeat(64), revision: 1 }] });
  try {
    await page.goto(`/content?piece=${story}`);
    // The agent's changelog is out of the default view (John, 2026-10-13): it sits in a closed History disclosure.
    const changed = page.getByRole("region", { name: "What changed" });
    await expect(changed).toBeHidden();
    await page.getByRole("region", { name: "Fixture seek" }).getByText("History", { exact: true }).first().click();
    await expect(changed).toContainText("New since v1 (your rough cut approval)");
    await expect(changed).toContainText("v1.1: B-roll B1 to B7");
    await expect(changed).toContainText("Unchanged since your rough cut approval: Edit (keep.json), Dialogue audio");
    await changed.getByRole("button", { name: "Jump to 0:01: B4 GPU rack" }).click();
    const video = page.getByRole("region", { name: "Fixture seek" }).locator("video").first();
    await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(1.4);
    await shot(page, "content-what-changed");
  } finally {
    await db.from("gtm_stories").delete().eq("id", story);
  }
});

test("series review: the strip, keyboard review of one piece at a time, approve the rest at once, one note for all; nothing is scheduled", async ({ page }) => {
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const ids = ["s1-92-fx-sn-a", "s1-93-fx-sn-b", "s1-94-fx-sn-c"];
  await db.from("gtm_stories").delete().in("id", ids);
  for (const [i, id] of ids.entries()) {
    await db.from("gtm_stories").insert({ id, title: `W9 Fri Dec ${4 + i} | Fixture series ${"ABC"[i]}`, link_url: "https://example.com/series", pipeline: "short", series: "fx-sn-series", third_party_who: "example_approver / Example Series" });
    await db.from("gtm_story_assets").insert([
      { id: `${id}-video`, story_id: id, title: "Video 9:16", kind: "video", source: `media/${id}-9x16.mp4`, sha256: sha(`rough ${id}`), storage_path: `stories/${id}/rough.mp4`, stage: "rough-cut", metadata: {} },
      { id: `${id}-youtube`, story_id: id, title: "YouTube text", kind: "copy", source: `posts/${id}/youtube.md`, sha256: sha(`caption ${id}`), body: `caption ${id}`, metadata: {} },
    ]);
    await db.from("gtm_story_asset_channels").insert([{ asset_id: `${id}-video`, channel: "youtube" }, { asset_id: `${id}-youtube`, channel: "youtube" }]);
    await db.from("gtm_story_stages").insert([{ story_id: id, stage: "paper-edit", status: "approved" }, { story_id: id, stage: "rough-cut", status: "review" }]);
  }
  const roughCut = async () => ((await db.from("gtm_story_stages").select("story_id,status").in("story_id", ids).eq("stage", "rough-cut").order("story_id")).data ?? []).map((r) => r.status);
  try {
    await page.goto("/content?series=fx-sn-series");
    const strip = page.getByRole("region", { name: "Series Fx Sn Series" });
    await expect(strip.getByRole("row")).toHaveCount(4);
    await strip.getByRole("link", { name: "Review 3 rough cuts" }).click();
    await expect(page).toHaveURL(/series=fx-sn-series&stage=rough-cut&focus=1/);
    const nav = page.getByRole("navigation", { name: "Focused review" });
    await expect(nav).toContainText("1 of 3");
    // A approves the rough cut on screen; J moves on; K moves back.
    await page.keyboard.press("a");
    await expect.poll(roughCut).toEqual(["approved", "review", "review"]);
    // The decided piece has moved on to its next stage, so the rough-cut review now holds the other two.
    await expect(nav).toContainText("1 of 2");
    await page.keyboard.press("j");
    await expect(nav).toContainText("2 of 2");
    await page.keyboard.press("k");
    await expect(nav).toContainText("1 of 2");
    // The rest at once: each decision bound to its own bytes, nothing scheduled.
    await page.goto("/content?series=fx-sn-series");
    await strip.getByRole("button", { name: "Approve rough cut on all remaining" }).click();
    const confirm = page.getByRole("dialog", { name: "Approve rough cut on all remaining" });
    await expect(confirm).toContainText("Nothing will be scheduled");
    await confirm.getByRole("button", { name: "Approve 2" }).click();
    await expect(strip.getByRole("status")).toContainText("Rough cut approved on 2 of 2. Nothing was scheduled.");
    await expect.poll(roughCut).toEqual(["approved", "approved", "approved"]);
    expect((await db.from("gtm_story_asset_channels").select("status").in("asset_id", ids.map((id) => `${id}-video`))).data?.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
    expect((await db.from("gtm_content_items").select("id").in("story_id", ids)).data).toEqual([]);
    // One note for all three, one batch.
    await strip.getByRole("button", { name: "Note for all 3" }).click();
    await page.getByLabel("Note for the whole series").fill("End card sub-line is too small");
    await page.getByRole("button", { name: "Leave the note on all 3" }).click();
    await expect(strip.getByRole("status")).toContainText("Note left on 3 of 3");
    const notes = (await db.from("gtm_story_feedback").select("asset_id,batch_id").in("asset_id", ids.map((id) => `${id}-video`))).data ?? [];
    expect(notes.length).toBe(3);
    expect(new Set(notes.map((n) => n.batch_id)).size).toBe(1);
    expect(notes[0].batch_id).toBeTruthy();
    await shot(page, "content-series");
  } finally {
    await db.from("gtm_stories").delete().in("id", ids);
  }
});

test("ideas: the board groups by status; the owner adds one, parks it, and promotes a content idea into the candidates", async ({ page }) => {
  const db = admin();
  const seeded = (await db.from("gtm_ideas").select("*").eq("slug", "fixture-inbox-short").single()).data!;
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  try {
    await page.goto("/ideas");
    await expect(page.getByRole("link", { name: "Ideas", exact: true })).toBeVisible();
    await expect(page.getByTestId("ideas-shortlisted").getByText("Fixture inbox short")).toBeVisible();
    await expect(page.getByTestId("ideas-idea").getByText("Fixture comment experiment")).toBeVisible();
    await expect(page.getByTestId("ideas-parked").getByText("Fixture parked tool")).toBeVisible();
    await expect(page.getByTestId("ideas-summary")).toHaveText("3 of 3");
    await shot(page, "ideas");

    const form = page.getByRole("form", { name: "Add an idea" });
    await form.getByLabel("Title").fill("Fixture e2e idea");
    await form.getByLabel("Summary").fill("If we try this, something happens.");
    await form.getByRole("button", { name: "Add idea" }).click();
    await expect(page.getByTestId("ideas-idea").getByText("Fixture e2e idea")).toBeVisible();
    await page.getByLabel("Status of Fixture e2e idea").selectOption("parked");
    await expect(page.getByTestId("ideas-parked").getByText("Fixture e2e idea")).toBeVisible();
    await expect.poll(async () => (await db.from("gtm_ideas").select("status").eq("slug", "fixture-e2e-idea").single()).data?.status).toBe("parked");

    // A parked tool is built, not posted: no promotion.
    await expect(page.locator('[data-slug="fixture-parked-tool"]').getByRole("button", { name: "Promote to candidate" })).toHaveCount(0);
    const card = page.locator('[data-slug="fixture-inbox-short"]');
    await card.getByRole("button", { name: "Promote to candidate" }).click();
    await card.getByRole("button", { name: "Promote", exact: true }).click();
    const moved = page.getByTestId("ideas-in_production").locator('[data-slug="fixture-inbox-short"]');
    await expect(moved.getByRole("link", { name: /candidates, week of/ })).toBeVisible();
    await shot(page, "ideas-promoted");
    await moved.getByRole("link", { name: /candidates, week of/ }).click();
    await expect(page).toHaveURL(/\/signals\?view=candidates&week=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByText("Fixture inbox short").first()).toBeVisible();
    await expect(page.getByText("Split screen of one inquiry.").first()).toBeVisible();
  } finally {
    // Leave the fixtures as seeded for any later spec.
    await db.from("gtm_ideas").delete().eq("slug", "fixture-e2e-idea");
    await db.from("gtm_ideas").upsert(seeded);
    await db.from("gtm_content_candidates").delete().eq("slug", "idea-fixture-inbox-short");
  }
});

// Carousel s1-29 (2026-10-13): /content fired every slide of every piece at once, Storage answered the burst with HTTP 429
// (a JSON body, not an image), and the slides stayed blank. Here every stored object fails its first request with that
// 429; the players retry with fresh URLs, so nothing is left blank and nothing is reported. One slide is always refused
// with a 429: it is badged after its retries but, its bytes being fine, files nothing. One slide whose stored bytes are
// not an image is badged and becomes a BLOCK finding linked to its piece, with an agent note.
test("media burst: a 429 from Storage is retried so no slide or video stays blank; a rate-limited slide files nothing, a broken one is badged and becomes a BLOCK", async ({ page }) => {
  test.setTimeout(90_000);
  await page.context().clearCookies();
  await login(page, "owner");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const db = admin();
  const card = readFileSync(new URL("../test/fixtures/card.png", import.meta.url));
  const clip = readFileSync(new URL("../test/fixtures/clip.mp4", import.meta.url));
  const sha = (b: Buffer, n: string) => createHash("sha256").update(b).update(n).digest("hex");
  const stories = [1, 2, 3, 4, 5, 6].map((n) => `s1-8${n}-fx-burst`);
  const keys: string[] = [];
  const cleanup = async () => {
    await db.from("gtm_stories").delete().in("id", stories);
    if (keys.length) await db.storage.from("content-review").remove(keys);
    await db.from("gtm_sync_state").delete().like("key", "media.unplayable.%");
  };
  await cleanup();
  for (const [i, story] of stories.entries()) {
    await db.from("gtm_stories").insert({ id: story, title: `W9 Fri Dec ${i + 1} | Fixture burst ${i + 1}`, link_url: `https://example.com/${story}`, season_id: "fx-season" });
    for (let s = 1; s <= 4; s++) {
      const h = sha(card, `${story}-${s}`);
      const key = `stories/${story}/${story}-slide-0${s}-${h.slice(0, 16)}.png`;
      await db.storage.from("content-review").upload(key, card, { contentType: "image/png", upsert: true });
      keys.push(key);
      await db.from("gtm_story_assets").insert({ id: `${story}-slide-0${s}`, story_id: story, title: `Slide ${s}`, kind: "image", source: `media/${story}/slide-0${s}.png`, sha256: h, storage_path: key, stage: "final", metadata: {} });
      await db.from("gtm_story_asset_channels").insert({ asset_id: `${story}-slide-0${s}`, channel: "instagram" });
    }
    const vkey = `stories/${story}/${story}-video-${sha(clip, story).slice(0, 16)}.mp4`;
    await db.storage.from("content-review").upload(vkey, clip, { contentType: "video/mp4", upsert: true });
    keys.push(vkey);
    await db.from("gtm_story_assets").insert({ id: `${story}-video`, story_id: story, title: "Video", kind: "video", source: `media/${story}/video.mp4`, sha256: sha(clip, story), storage_path: vkey, stage: "final", metadata: {} });
    await db.from("gtm_story_asset_channels").insert({ asset_id: `${story}-video`, channel: "youtube" });
    for (const channel of ["instagram", "youtube"]) {
      const body = `Burst ${i + 1} ${channel} caption.`;
      await db.from("gtm_story_assets").insert({ id: `${story}-${channel}`, story_id: story, title: `${channel} text`, kind: "copy", source: `posts/${story}/${channel}.md`, sha256: createHash("sha256").update(body).digest("hex"), body, metadata: {} });
      await db.from("gtm_story_asset_channels").insert({ asset_id: `${story}-${channel}`, channel });
    }
  }
  const never = keys.find((k) => k.includes("s1-85-fx-burst-slide-01"))!;
  // A broken slide (stored without the guard, as the pre-guard uploads were): a JSON error body labelled image/png.
  const broken = keys.find((k) => k.includes("s1-86-fx-burst-slide-01"))!;
  await db.storage.from("content-review").upload(broken, Buffer.from('{"error":"not an image"}'), { contentType: "image/png", upsert: true });
  const seen = new Set<string>();
  let refused = 0;
  await page.route(/\/storage\/v1\/object\/sign\/content-review\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(encodeURI(never).replace(/%2F/g, "/")) || decodeURIComponent(path).endsWith(never) || !seen.has(path)) {
      seen.add(path); refused++;
      return route.fulfill({ status: 429, contentType: "application/json", body: '{"statusCode":"429","error":"too_many_connections","message":"SlowDown"}' });
    }
    return route.continue();
  });
  try {
    await page.goto("/content");
    for (const [i, story] of stories.entries()) {
      const region = page.getByRole("region", { name: `Fixture burst ${i + 1}` }).first();
      await region.scrollIntoViewIfNeeded();
      const img = region.locator("img[src*='content-review']:visible").first();
      if (story === "s1-85-fx-burst" || story === "s1-86-fx-burst") {
        await expect(region.getByTestId("media-fixing").first()).toHaveText("Won't load, fixing", { timeout: 20_000 });
        continue;
      }
      await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000, message: `${story} slide loads after the retry` }).toBeGreaterThan(0);
      await expect(region.getByTestId("media-fixing")).toHaveCount(0);
    }
    expect(refused).toBeGreaterThan(6);
    // Only the broken slide is a BLOCK (the rate-limited one has good bytes), linked to its piece, in the findings.
    await expect.poll(async () => (await db.from("gtm_sync_state").select("key").like("key", "media.unplayable.%")).data?.length ?? 0, { timeout: 40_000 }).toBe(1);
    const { data: note } = await db.from("gtm_story_feedback").select("body,author").eq("asset_id", "s1-86-fx-burst-slide-01");
    expect(note?.[0]?.author).toBe("agent");
    expect(note?.[0]?.body).toMatch(/^\[unplayable-video\] BLOCK: .*will not load in a browser/);
    await page.unroute(/\/storage\/v1\/object\/sign\/content-review\//);
    await page.goto("/content");
    await expect(page.getByText(/Won't load: s1-86-fx-burst-slide-01-[0-9a-f]+\.png in storage/).first()).toBeAttached();
    await shot(page, "content-media-burst");
  } finally {
    await cleanup();
  }
});
