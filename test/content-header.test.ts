import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Findings } from "../components/review/season-panel";
import { ContentDetails, ContentDetail, SeasonDetailsStatus } from "../components/review/content-details";
import type { Check, SeasonAnalysis } from "../lib/season-analysis";

for (const count of [0, 1, 4, 19]) {
  test(`findings render ${count} rows once, sorted by severity, with working platform links`, () => {
    const checks: Check[] = Array.from({ length: count }, (_, i) => ({ id: `check-${i}`, severity: (["info", "warn", "block"] as const)[i % 3], status: "fail", message: `Unique finding ${i}.`, storyId: `piece-${i}`, platform: "youtube" }));
    const summary = { block: checks.filter((c) => c.severity === "block").length, warn: checks.filter((c) => c.severity === "warn").length, info: checks.filter((c) => c.severity === "info").length };
    const html = renderToStaticMarkup(createElement(Findings, { a: { checks, summary } as SeasonAnalysis }));
    assert.equal((html.match(/<li /g) ?? []).length, count);
    for (const c of checks) {
      assert.equal(html.split(c.message).length - 1, 1);
      assert.ok(html.includes(`/content?piece=${c.storyId}&amp;channel=youtube`));
    }
    if (!count) assert.ok(html.includes("No findings for this season."));
    if (count >= 3) {
      assert.ok(html.indexOf("Unique finding 2.") < html.indexOf("Unique finding 1."));
      assert.ok(html.indexOf("Unique finding 1.") < html.indexOf("Unique finding 0."));
    }
    assert.ok(!html.includes("<details"));
  });
}

test("information-only findings remain visible", () => {
  const a = { checks: [{ id: "info", severity: "info", status: "review", message: "A human should check this." }], summary: { block: 0, warn: 0, info: 1 } } as SeasonAnalysis;
  assert.ok(renderToStaticMarkup(createElement(Findings, { a })).includes("A human should check this."));
});

test("details start closed and do not render interactive panel children", () => {
  const html = renderToStaticMarkup(createElement(ContentDetails, { children: createElement(ContentDetail, { name: "test", label: "Details", children: createElement("button", null, "Hidden action") }) }));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('aria-controls='));
  assert.ok(html.includes('hidden=""'));
  assert.ok(!html.includes("Hidden action"));
});

for (const state of ["loading", "unavailable"] as const) {
  test(`${state} season analysis is not reported as zero findings`, () => {
    const html = renderToStaticMarkup(createElement(ContentDetails, { children: createElement(SeasonDetailsStatus, { state }) }));
    assert.ok(html.includes(state === "loading" ? "Loading season analysis" : "Could not load the season analysis"));
    assert.ok(!html.includes("Findings (0)"));
    assert.ok(html.includes(`role="${state === "loading" ? "status" : "alert"}"`));
  });
}
