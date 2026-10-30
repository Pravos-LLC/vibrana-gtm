import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopy, validate, localDateTime } from "../lib/calendar.ts";
import { classify, loadRegistry } from "../lib/costs.ts";

test("parseCopy splits frontmatter, base text and per-channel overrides", () => {
  const c = parseCopy(`---\nyoutube_title: "Six weeks"\nfirst_comment: https://brand.example.com/x\n---\nBase text.\n\nMore.\n--- channel: instagram ---\nIG text #ai\n--- channel: youtube ---\nYT text`);
  assert.equal(c.meta.youtube_title, "Six weeks");
  assert.equal(c.meta.first_comment, "https://brand.example.com/x");
  assert.equal(c.base, "Base text.\n\nMore.");
  assert.equal(c.perChannel.instagram, "IG text #ai");
  assert.equal(c.perChannel.youtube, "YT text");
});

test("parseCopy without overrides returns whole body", () => {
  const c = parseCopy("Just a post.");
  assert.equal(c.base, "Just a post.");
  assert.deepEqual(c.perChannel, {});
});

test("validate catches duplicate ids, bad dates and statuses", () => {
  const base = { week: 1, pillar: "p", title: "t", format: "text", channels: ["linkedin"] };
  const problems = validate([
    { ...base, id: "a", date: "2026-10-01", status: "drafted" },
    { ...base, id: "a", date: "2026-10-1", status: "posted" as any },
  ]);
  assert.ok(problems.some((p) => p.includes("duplicate id a")));
  assert.ok(problems.some((p) => p.includes("bad date")));
  assert.ok(problems.some((p) => p.includes("bad status")));
});

test("localDateTime defaults to 08:30", () => {
  assert.equal(localDateTime({ date: "2026-10-06" } as any), "2026-10-06T08:30:00");
});

test("classify matches registry vendors and flags unknown software", () => {
  const reg = loadRegistry();
  assert.deepEqual(classify(reg, "Anthropic* Claude Sub", "Computer Software Stores"), { vendor: "Claude (Anthropic)", category: "ai-models", gtm: false });
  assert.equal(classify(reg, "Openai *Chatgpt Subscr", null)?.vendor, "ChatGPT / Codex (OpenAI)");
  assert.equal(classify(reg, "Cursor Usage  Aug", null)?.vendor, "Cursor");
  assert.equal(classify(reg, "Stripe-Z.ai", null)?.vendor, "Z.ai");
  assert.equal(classify(reg, "Mosaic Ai Labs, Inc", null)?.gtm, true);
  assert.equal(classify(reg, "Fullenrich", null)?.category, "gtm-data");
  assert.equal(classify(reg, "Some New Tool", "Computer Software Stores")?.category, "unclassified");
  assert.equal(classify(reg, "Gooseberry Restaurant", "Eating Places, Restaurants"), null);
});

test("classify ignores non-software merchants even when the name matches a vendor", () => {
  const reg = loadRegistry();
  assert.equal(classify(reg, "Apollo Bar & Grill", "Eating Places, Restaurants"), null);
  assert.equal(classify(reg, "Sakana Sushi", "Eating Places, Restaurants"), null);
  assert.equal(classify(reg, "Promotion Store", "Computer Software Stores")?.vendor, null);
  assert.equal(classify(reg, "Grok Xai", "Computer Software Stores")?.vendor, "Grok (xAI)");
  assert.equal(classify(reg, "Treg.to", "Computer Software Stores")?.vendor, "Treg");
});

test("zonedToUtc handles CET and CEST", async () => {
  const { zonedToUtc } = await import("../lib/calendar.ts");
  assert.equal(zonedToUtc("2026-12-31", "09:00", "Europe/Berlin").toISOString(), "2026-12-31T08:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-06", "08:30", "Europe/Berlin").toISOString(), "2026-10-06T06:30:00.000Z");
});

test("classify does not surface unknown merchants without a Wise category", () => {
  assert.equal(classify(loadRegistry(), "Mystery Merchant", null), null);
});
