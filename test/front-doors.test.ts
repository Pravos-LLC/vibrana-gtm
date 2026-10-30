// Front doors (lib/front-doors.ts): the weekly funnel per front door, counted from the site's tables.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });

const { buildFrontDoors, finalJudge, loadFrontDoors, weekLabel } = await import("../lib/front-doors.ts");
const { adminDb } = await import("../lib/db.ts");

const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

// 2026-10-16 is a Friday in ISO week 42 (Monday 2026-10-12).
const TODAY = "2026-10-16";
const judged = (status: string, ...overall: (number | null)[]) => ({ status, attempts: overall.map((o) => (o == null ? { judge: null } : { judge: { overall: o } })) });

test("weekLabel uses ISO weeks, including the year boundary", () => {
  assert.equal(weekLabel("2026-10-16T08:00:00Z"), "2026-W42");
  assert.equal(weekLabel("2027-01-01"), "2026-W53");
});

test("finalJudge takes the last attempt that has a score", () => {
  assert.equal(finalJudge(judged("stored", 3.2, 4.5)), 4.5);
  assert.equal(finalJudge(judged("failed", 3.5, null)), 3.5);
  assert.equal(finalJudge({ status: "failed", attempts: [{ judge: { overall: "4" } }] }), null);
  assert.equal(finalJudge(null), null);
});

test("counts each table into its ISO week and front door", () => {
  const r = buildFrontDoors({
    assessments: [
      { created_at: "2026-10-16T09:00:00Z", entry_point: "landing", analysis_meta: judged("stored", 4.5) },
      { created_at: "2026-10-12T00:30:00Z", entry_point: "landing", analysis_meta: judged("failed", 3, 3.5) },
      { created_at: "2026-10-13T00:00:00Z", entry_point: null, analysis_meta: null },
      { created_at: "2026-10-07T10:00:00Z", entry_point: "email", analysis_meta: judged("stored", 4) },
      { created_at: "2026-08-01T10:00:00Z", entry_point: "landing", analysis_meta: null }, // outside the window
      { created_at: "2026-10-16T11:00:00Z", entry_point: "video", analysis_meta: null, assessment_type: "eu-ai-act" },
      { created_at: "2026-10-16T12:00:00Z", entry_point: "eu-ai-act", analysis_meta: null, assessment_type: "eu-ai-act" },
    ],
    events: [
      { created_at: "2026-10-14T10:00:00Z", event: "call_click", entry_point: "landing" },
      { created_at: "2026-10-14T11:00:00Z", event: "call_click", entry_point: "roi" },
      { created_at: "2026-10-15T11:00:00Z", event: "roi_lead", entry_point: "roi" },
      { created_at: "2026-10-15T11:00:00Z", event: "something_else", entry_point: "roi" },
    ],
    inquiries: [
      { created_at: "2026-10-15T09:00:00Z", entry_point: null },
      { created_at: "2026-10-15T09:00:00Z", entry_point: "email" },
    ],
    optOuts: [{ opted_out_at: "2026-10-13T09:00:00Z" }, { opted_out_at: "2026-10-06T09:00:00Z" }],
  }, { today: TODAY, weeks: 2 });

  assert.deepEqual(r.weeks.map((w) => [w.week, w.start]), [["2026-W42", "2026-10-12"], ["2026-W41", "2026-10-05"]]);
  const [now, prev] = r.weeks;
  assert.deepEqual(now.total, { completions: 3, euAssessments: 2, roiLeads: 1, sprintInquiries: 2, callClicks: 2 });
  assert.deepEqual(now.doors.landing, { completions: 2, euAssessments: 0, roiLeads: 0, sprintInquiries: 0, callClicks: 1 });
  assert.deepEqual(now.doors.unknown, { completions: 1, euAssessments: 0, roiLeads: 0, sprintInquiries: 0, callClicks: 0 });
  // A sprint request without a recorded door came through the sprint form.
  assert.equal(now.doors.sprint.sprintInquiries, 1);
  assert.equal(now.doors.email.sprintInquiries, 1);
  assert.equal(now.doors.roi.roiLeads, 1);
  assert.equal(now.unsubscribes, 1);
  // Mean of each assessment's final score: 4.5 (stored) and 3.5 (failed after two tries).
  assert.deepEqual(now.quality, { stored: 1, failed: 1, none: 1, meanJudge: 4, judged: 2 });
  assert.deepEqual(prev.total, { completions: 1, euAssessments: 0, roiLeads: 0, sprintInquiries: 0, callClicks: 0 });
  assert.deepEqual(prev.quality, { stored: 1, failed: 0, none: 0, meanJudge: 4, judged: 1 });
  // EU AI Act assessments count by their own door and stay out of report quality.
  assert.equal(now.doors.video.euAssessments, 1);
  assert.equal(now.doors["eu-ai-act"].euAssessments, 1);
  assert.deepEqual(r.active, ["landing", "eu-ai-act", "video", "roi", "sprint", "email", "unknown"]);
});

test("an empty window is all zeros with no mean", () => {
  const r = buildFrontDoors({ assessments: [], events: [], inquiries: [], optOuts: [] }, { today: TODAY, weeks: 3 });
  assert.equal(r.weeks.length, 3);
  assert.equal(r.weeks[0].quality.meanJudge, null);
  assert.deepEqual(r.active, []);
});

test("loadFrontDoors reads only non-personal columns since the window start, and reports a table it can't read", async () => {
  const routes: Route[] = [
    { method: "GET", url: `${REST}assessments?`, json: [{ created_at: "2026-10-14T00:00:00Z", entry_point: "landing", analysis_meta: judged("stored", 5) }] },
    { method: "GET", url: `${REST}funnel_events?`, status: 404, json: { code: "42P01", message: 'relation "public.funnel_events" does not exist' } },
    { method: "GET", url: `${REST}engagement_inquiries?`, json: [{ created_at: "2026-10-14T00:00:00Z", entry_point: "sprint" }] },
    { method: "GET", url: `${REST}email_opt_outs?`, json: [] },
  ];
  mock = installFetchMock(routes);
  const r = await loadFrontDoors(adminDb(), { today: TODAY, weeks: 8 });

  const urls = mock.calls.map((c) => decodeURIComponent(c.url));
  const a = urls.find((u) => u.includes("/assessments?"))!;
  assert.match(a, /select=created_at,entry_point,analysis_meta,assessment_type/);
  assert.match(a, /created_at=gte\.2026-08-24T00:00:00Z/);
  // The selected columns (not the sort keys) never include a contact or company field.
  const selects = urls.map((u) => new URL(u).searchParams.get("select") ?? "");
  assert.ok(selects.every((sel) => !/email|company|website|name/.test(sel)), `no personal columns selected: ${selects.join(" | ")}`);
  const q = urls.find((u) => u.includes("/engagement_inquiries?"))!;
  assert.match(q, /intent=eq\.ai_build_sprint/);
  assert.match(q, /entry_point:metadata->>entry_point/);

  assert.equal(r.weeks[0].total.completions, 1);
  assert.equal(r.weeks[0].total.sprintInquiries, 1);
  assert.equal(r.weeks[0].quality.meanJudge, 5);
  assert.deepEqual(r.errors.map((e) => e.table), ["funnel_events"]);
});
