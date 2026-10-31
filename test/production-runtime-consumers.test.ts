import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { REQUIRED_CONTENT } from "../lib/content-overlay.mjs";
import { execFileSync } from "node:child_process";
import { publicationOf, substackExport } from "../lib/substack";
import { newsletterExport } from "../lib/newsletter-card";

const privatePublications = {
  publications: { fixture_owner: { label: "Fixture publication", url: "https://fixture-owner.example.test" }, hidden_other: { label: "Unselected canary", url: "https://unselected-canary.example.test" } },
  publicationChannels: { "personal-substack": "fixture_owner" },
};

test("configured publication identities round-trip without sample-ID rewrites or whole-registry client exposure", () => {
  assert.equal(publicationOf({ publication: "fixture_owner" }, privatePublications), "fixture_owner");
  assert.equal(publicationOf({ channel: "personal-substack" }, privatePublications), "fixture_owner");
  assert.equal(publicationOf({ publication: "__proto__" }, privatePublications), null);
  const body = "---\npublication: fixture_owner\n---\n# A fixture essay\n\nOnly the selected destination is presented.";
  const exported = substackExport(body, [], privatePublications);
  assert.equal(exported.publicationDetails?.url, "https://fixture-owner.example.test");
  assert.equal(JSON.stringify(exported).includes("unselected-canary"), false);
  const card = newsletterExport(body, [], privatePublications);
  assert.equal(card.editorUrl, "https://fixture-owner.example.test/publish/post?type=newsletter");
  assert.equal(JSON.stringify(card).includes("hidden_other"), false);
});

test("server calendar, publication validation, offer catalog, candidate policy, mailbox and senders resolve the pinned runtime data", () => {
  const root = mkdtempSync(resolve(tmpdir(), "runtime-consumer-fixture-"));
  try {
    const config = JSON.parse(readFileSync(resolve("config/runtime.sample.json"), "utf8"));
    config.calendar.accounts.linkedin = "fixture-real-account";
    config.publications = privatePublications.publications;
    config.publicationChannels = privatePublications.publicationChannels;
    config.offers.offers[0].url = "https://fixture-offer.example.test/assessment";
    config.candidates.min_score = 19;
    config.brand.websiteUrl = "https://fixture-brand.example.test/";
    config.mail.mailbox = "fixture-inbox@example.test";
    config.mail.trackFrom.client = "fixture-client@example.test";
    config.brand.personalFrontDoorId = "substack_fixture_personal";
    const { "sample-author": personal, ...otherProfiles } = config.packaging.profiles;
    config.packaging = { personalBrandId: "fixture_personal", profiles: { fixture_personal: { ...personal, name: "Fixture Show" }, ...otherProfiles } };
    const files: Record<string, string> = {};
    for (const name of REQUIRED_CONTENT) {
      const data = readFileSync(resolve("content/sample", name));
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), data);
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    const manifest = JSON.stringify({ schemaVersion: 1, revision: "f".repeat(40), files });
    writeFileSync(resolve(root, "manifest.json"), manifest);
    const bytes = JSON.stringify(config);
    writeFileSync(resolve(root, "runtime.json"), bytes, { mode: 0o600 });
    const script = `
      const calendar = await import('./lib/calendar-db.ts');
      const offers = await import('./lib/outreach/offers-server.ts');
      const candidates = await import('./lib/candidates/select.ts');
      const mailbox = await import('./lib/outreach/mailbox.ts');
      const config = await import('./lib/runtime-config.mjs');
      const manual = await import('./lib/analytics/manual.ts');
      const packaging = await import('./lib/packaging/server-catalog.ts');
      const model = await import('./lib/packaging/model.ts');
      console.log(JSON.stringify({
        account: calendar.calendarConfig().accounts.linkedin,
        publicationErrors: calendar.validateRow({id:'fixture-row',publication:'fixture_owner'}),
        samplePublicationErrors: calendar.validateRow({id:'fixture-row',publication:'sample_author'}),
        offer: offers.activeOffers(undefined, Date.parse('2026-10-31'))[0].url,
        score: candidates.candidatesConfig().min_score,
        mailbox: mailbox.MAILBOX,
        clientFrom: config.loadRuntimeConfig().mail.trackFrom.client,
        manualSlug: manual.manualChannels()[1].slug,
        packagingDefault: packaging.defaultPackagingBrand(),
        packagingOptions: packaging.packagingBrandOptions(),
        packagingRecognized: !model.briefProblems({schema:1,story:'fixture-row',brand:'fixture_personal'}).includes('unregistered brand'),
      }));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CONTENT_MODE: "private", NODE_ENV: "production", PRIVATE_OVERLAY_ROOT: root, PRIVATE_OVERLAY_REVISION: "f".repeat(40), PRIVATE_OVERLAY_DIGEST: createHash("sha256").update(manifest).digest("hex"), PRIVATE_RUNTIME_DIGEST: createHash("sha256").update(bytes).digest("hex") },
    }));
    assert.equal(result.account, "fixture-real-account");
    assert.deepEqual(result.publicationErrors, []);
    assert.equal(result.samplePublicationErrors.length, 1);
    assert.equal(result.offer, "https://fixture-offer.example.test/assessment");
    assert.equal(result.score, 19);
    assert.equal(result.mailbox, "fixture-inbox@example.test");
    assert.equal(result.clientFrom, "fixture-client@example.test");
    assert.equal(result.manualSlug, "substack_fixture_personal");
    assert.equal(result.packagingDefault, "fixture_personal");
    assert.equal(result.packagingRecognized, true);
    assert.deepEqual(result.packagingOptions[0], { id: "fixture_personal", name: "Fixture Show" });
    assert.equal(JSON.stringify(result.packagingOptions).includes("imagery"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
