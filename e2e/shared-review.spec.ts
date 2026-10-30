import { test, expect } from "@playwright/test";
import { admin, signedIn, sql, PASSWORD, USERS } from "../test/support/seed";
import { mp4 } from "../test/support/mp4";
import { digest } from "../lib/story";
import { loadPieceReview, completePieceFix } from "../lib/piece-review";
const id = "shared-browser-piece",
  textId = `${id}-text`,
  videoId = `${id}-video`;
test("shared review persists two decisions, blocks on accepted note, completes the scoped fix and keeps stale edits", async ({
  page,
  context,
}) => {
  const db = admin();
  await db.from("gtm_stories").insert({
    id,
    title: "Shared browser piece",
    link_url: "https://example.com/shared",
  });
  const video = mp4();
  const path = `stories/${id}/video.mp4`;
  await db.storage
    .from("content-review")
    .upload(path, video, { contentType: "video/mp4", upsert: true });
  await db.from("gtm_story_assets").insert([
    {
      id: textId,
      story_id: id,
      title: "Shared caption candidate",
      kind: "copy",
      source: "caption.md",
      sha256: digest("One caption"),
      body: "One caption",
    },
    {
      id: videoId,
      story_id: id,
      title: "Shared video candidate",
      kind: "video",
      source: "video.mp4",
      sha256: digest(video),
      storage_path: path,
      stage: "final",
    },
  ]);
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill(USERS.owner.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.goto(`/content/shared?piece=${id}`);
    const card = page.getByTestId(`shared-${id}`);
    await card.getByRole("radio").nth(0).check();
    await card.getByRole("radio").nth(1).check();
    await card.getByRole("checkbox", { name: "linkedin" }).check();
    await card.getByRole("checkbox", { name: "youtube" }).check();
    await card.getByRole("button", { name: "Use these shared assets" }).click();
    await expect(
      card.getByLabel("Shared caption", { exact: true }),
    ).toHaveValue("One caption");
    await card
      .getByRole("button", { name: "Approve video", exact: true })
      .click();
    await expect(
      card.getByRole("region", { name: "video decision" }),
    ).toContainText("Approved");
    await card
      .getByLabel("Text note", { exact: true })
      .fill("Change One to Shared");
    await card.getByRole("button", { name: "Accept text with note" }).click();
    await expect(
      card.getByRole("region", { name: "text decision" }),
    ).toContainText("Waiting for fix");
    await page.reload();
    await expect(
      card.getByRole("region", { name: "text decision" }),
    ).toContainText("Waiting for fix");
    let s = (await loadPieceReview(db, id))!;
    await db
      .from("gtm_story_assets")
      .update({ body: "Shared caption", sha256: digest("Shared caption") })
      .eq("id", textId);
    s = (await loadPieceReview(db, id))!;
    await completePieceFix(db, {
      fixId: s.fixes[0].id,
      fingerprint: s.text.fingerprint,
      revision: s.text.asset.revision,
      actor: "browser-test",
      verification: "Exact single authorised word diff checked",
      onlyAuthorisedChanges: true,
    });
    await page.reload();
    await expect(
      card.getByRole("region", { name: "text decision" }),
    ).toContainText("Approved");
    await expect(
      card.getByRole("region", { name: "video decision" }),
    ).toContainText("Approved");
    // Synthetic provider outcome through the same durable RPCs; never contacts a live provider.
    s = (await loadPieceReview(db, id))!;
    const owner = await signedIn("owner");
    const released = await owner.rpc("gtm_set_piece_dispatch", {
      p_story_id: id,
      p_expected: { text: s.text.fingerprint, video: s.video.fingerprint },
      p_enabled: true,
    });
    expect(released.error).toBeNull();
    await db.from("gtm_seasons").insert({
      id: "shared-browser-season",
      title: "Synthetic",
      starts_on: "2026-01-01",
      ends_on: "2099-12-31",
    });
    const date = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const prepared = await db.rpc("gtm_prepare_piece_delivery", {
      p_story_id: id,
      p_channel: "linkedin",
      p_date: date,
      p_time: "14:00",
      p_timezone: "UTC",
      p_expected: { text: s.text.fingerprint, video: s.video.fingerprint },
      p_pillar: "proof",
    });
    expect(prepared.error).toBeNull();
    const delivery = prepared.data;
    const claimed = await db.rpc("gtm_claim_piece_delivery", {
      p_id: delivery.id,
    });
    expect(claimed.error).toBeNull();
    const started = await db.rpc("gtm_start_piece_send", {
      p_id: delivery.id,
      p_token: claimed.data.claim_token,
      p_request: { content: "Shared caption" },
    });
    expect(started.error).toBeNull();
    const published = await db.rpc("gtm_record_piece_delivery", {
      p_id: delivery.id,
      p_token: claimed.data.claim_token,
      p_provider_id: "synthetic-browser-post",
      p_state: "published",
      p_url: "https://example.test/published",
      p_error: null,
      p_published_at: new Date().toISOString(),
    });
    expect(published.error).toBeNull();
    await page.reload();
    await expect(card).toContainText("published");
    await expect(
      card.getByRole("link", { name: "Open publication" }),
    ).toHaveAttribute("href", "https://example.test/published");
    const frozen = await context.newPage();
    await frozen.goto(`/content/delivery/${delivery.id}`);
    await expect(
      frozen.getByRole("heading", { name: "Frozen channel version" }),
    ).toBeVisible();
    await expect(
      frozen.getByRole("heading", { name: "Shared text" }).locator(".."),
    ).toContainText("Shared caption");
    await frozen.close();
    // Shared cards obey the status filter and count in the toolbar (review #147 B3, #151 B2).
    await page.goto(`/content?status=needs-approval&piece=${id}`);
    await expect(page.getByTestId(`shared-${id}`)).toHaveCount(0);
    await page.goto(`/content?status=approved&piece=${id}`);
    await expect(page.getByTestId(`shared-${id}`)).toBeVisible();
    // Pause and resume without a second Approve; the blocker names the pause while it lasts.
    await card.getByRole("button", { name: "Pause scheduling" }).click();
    await expect(card.getByLabel("Publishing blockers")).toContainText("Scheduling is paused for this piece");
    await card.getByRole("button", { name: "Resume scheduling" }).click();
    await expect(card.getByLabel("Publishing blockers")).not.toContainText("Scheduling is paused");
    // A piece with deliveries cannot leave shared review; it says so instead of failing silently.
    await card.getByRole("button", { name: "Leave shared review" }).click();
    await card.getByRole("button", { name: "Confirm: back to per-platform review" }).click();
    await expect(card.getByRole("alert")).toBeVisible();
    expect(await loadPieceReview(db, id)).not.toBeNull();
    await page.goto(`/content/shared?piece=${id}`);
    await card
      .getByLabel("Shared caption", { exact: true })
      .fill("Unsaved words stay here");
    await db
      .from("gtm_story_assets")
      .update({
        body: "Another saved draft",
        sha256: digest("Another saved draft"),
      })
      .eq("id", textId);
    await card.getByRole("button", { name: "Refresh saved state" }).click();
    await expect(
      card.getByRole("region", { name: "text decision" }),
    ).toContainText("Needs approval");
    await expect(
      card.getByLabel("Shared caption", { exact: true }),
    ).toHaveValue("Unsaved words stay here");
    await card.getByRole("button", { name: "Save shared text" }).click();
    await expect(card.getByRole("alert")).toContainText("changed while");
    await page.reload();
    const other = await context.newPage();
    await other.goto(`/content/shared?piece=${id}`);
    await card
      .getByLabel("Shared caption", { exact: true })
      .fill("New human draft");
    await card.getByRole("button", { name: "Save shared text" }).click();
    await expect(
      card.getByRole("region", { name: "text decision" }),
    ).toContainText("Needs approval");
    await expect(
      card.getByRole("region", { name: "video decision" }),
    ).toContainText("Approved");
    await page.goto(`/content?status=needs-approval&piece=${id}`);
    await expect(page.getByTestId(`shared-${id}`)).toBeVisible();
    await page.goto(`/content/shared?piece=${id}`);
    const oldCard = other.getByTestId(`shared-${id}`);
    await oldCard
      .getByLabel("Shared caption", { exact: true })
      .fill("Stale tab edit");
    await oldCard.getByRole("button", { name: "Save shared text" }).click();
    await expect(oldCard.getByRole("alert")).toContainText("changed while");
    await expect(
      oldCard.getByLabel("Shared caption", { exact: true }),
    ).toHaveValue("Stale tab edit");
    await other.close();
    await db
      .from("gtm_stories")
      .update({ third_party_who: "Shared browser partner" })
      .eq("id", id);
    await db
      .from("gtm_reviewer_invites")
      .insert({
        token_sha256: "f".repeat(64),
        party: "Shared browser partner",
        expires_at: "2099-01-01T00:00:00Z",
      });
    await page.goto(`/content?piece=${id}`);
    await expect(page.getByTestId(`shared-${id}`)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Shared review overview" }),
    ).toContainText("Video approved 1/1");
    await expect(
      page.getByText("Shared browser partner", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Shared third-party review" })
        .getByRole("button", { name: "Share for review", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("region", { name: "Shared third-party review" })
      .getByText("Links sent (1 active)", { exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Shared third-party review" })
        .getByRole("button", { name: "Revoke", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve text", exact: true }),
    ).toHaveCount(1);
  } finally {
    sql(
      "delete from public.gtm_piece_delivery_attempts where story_id='shared-browser-piece' or delivery_id in(select id from public.gtm_piece_deliveries where story_id='shared-browser-piece'); delete from public.gtm_piece_deliveries where story_id='shared-browser-piece'; delete from public.gtm_content_items where story_id='shared-browser-piece'",
    );
    await db.from("gtm_stories").delete().eq("id", id);
    await db.from("gtm_seasons").delete().eq("id", "shared-browser-season");
    await db
      .from("gtm_reviewer_invites")
      .delete()
      .eq("party", "Shared browser partner");
  }
});
