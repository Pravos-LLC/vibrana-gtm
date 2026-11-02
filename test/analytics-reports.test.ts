// Analytics reports (/performance/reports): the document gate, publishing, the link email and the
// "last week has no report" alert the hourly cron sends.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test", RESEND_API_KEY: "re_test", REPORT_TZ: "Asia/Makassar" });
const { validateReportDoc, reportSlug } = await import("../lib/analytics-reports/doc.ts");
const { publishReport, deliverReports, lastWeekStart, cockpitOrigin } = await import("../lib/analytics-reports/store.ts");
const { linkHtml } = await import("../lib/analytics-reports/email.ts");
const { adminDb } = await import("../lib/db.ts");
const route = await import("../app/api/cron/analytics-reports/route.ts");

const REST = "https://db.test/rest/v1/";
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/analytics-report.json", import.meta.url), "utf8"));
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; delete process.env.CRON_SECRET; delete process.env.GTM_COCKPIT_URL; });

test("the sample report document is valid and its slug is its kind and Monday", () => {
  assert.deepEqual(validateReportDoc(fixture()), []);
  assert.equal(reportSlug(fixture()), "weekly-2026-10-26");
});

test("validateReportDoc names each problem: bad confidence, mismatched rows, non-https links, em dashes", () => {
  const d = fixture();
  d.blocks[5].items[0].confidence = "very high";
  d.blocks[3].rows[1].push("extra");
  d.sources[0].url = "http://example.com";
  d.headline = "A line — with an em dash";
  d.blocks.push({ type: "html", title: "Raw", body: "<script>" });
  const problems = validateReportDoc(d).join("\n");
  assert.match(problems, /blocks\[5\]\.items\[0\]\.confidence: must be one of high, medium, low/);
  assert.match(problems, /blocks\[3\]\.rows\[1\]: has 4 cells for 3 columns/);
  assert.match(problems, /sources\[0\]\.url: must be an https URL/);
  assert.match(problems, /em dash/);
  assert.match(problems, /blocks\[9\]\.type: must be/);
  assert.deepEqual(validateReportDoc([]), ["document must be a JSON object"]);
});

test("a line series must have one value per x label", () => {
  const d = fixture();
  d.blocks[2].series[0].values.pop();
  assert.match(validateReportDoc(d).join("\n"), /has 3 values for 4 x labels/);
});

test("publish refuses an invalid document or a period that does not start on a Monday, and writes nothing", async () => {
  const m = use([]);
  const bad = fixture(); bad.summary = [];
  await assert.rejects(publishReport(adminDb(), bad), /summary: needs at least 1/);
  const tue = fixture(); tue.period = { start: "2026-10-27", end: "2026-11-02" };
  await assert.rejects(publishReport(adminDb(), tue), /not a Monday/);
  assert.equal(m.calls.length, 0);
});

test("publish upserts on (kind, period_start) and keeps the email record unless --resend", async () => {
  const m = use([{ method: "POST", url: REST + "gtm_analytics_reports", json: { id: "r1", slug: "weekly-2026-10-26", emailed_at: null } }]);
  const r = await publishReport(adminDb(), fixture());
  assert.equal(r.slug, "weekly-2026-10-26");
  assert.match(m.calls[0].url, /on_conflict=kind%2Cperiod_start/);
  const row = JSON.parse(m.calls[0].body!);
  assert.equal(row.title, "Week 4 review");
  assert.ok(!("emailed_at" in row), "a republish does not clear emailed_at");
  await publishReport(adminDb(), fixture(), { resend: true });
  assert.equal(JSON.parse(m.calls[1].body!).emailed_at, null);
});

test("the dry run validates and writes nothing", async () => {
  const m = use([]);
  assert.deepEqual(await publishReport(adminDb(), fixture(), { dryRun: true }), { dryRun: true, slug: "weekly-2026-10-26" });
  assert.equal(m.calls.length, 0);
});

test("lastWeekStart is the Monday before this week, by the date in Bali", () => {
  assert.equal(lastWeekStart(new Date("2026-11-02T01:00:00Z")), "2026-10-26"); // Monday 09:00 Bali
  assert.equal(lastWeekStart(new Date("2026-11-01T17:00:00Z")), "2026-10-26"); // Monday 01:00 Bali, still Sunday in UTC
  assert.equal(lastWeekStart(new Date("2026-11-01T15:00:00Z")), "2026-10-19"); // Sunday 23:00 Bali
});

test("deliver refuses to send without an https cockpit URL", async () => {
  use([]);
  process.env.GTM_COCKPIT_URL = "http://localhost:3000";
  assert.equal(cockpitOrigin(), null);
  await assert.rejects(deliverReports(adminDb(), { to: "owner@example.test", from: "Reports <r@example.test>" }), /https cockpit/);
});

test("deliver emails each unsent report once with its link, then marks it emailed; before Monday noon no alert check", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test/";
  const d = fixture();
  const m = use([
    { method: "GET", url: REST + "gtm_analytics_reports", json: [{ id: "r1", slug: "weekly-2026-10-26", title: d.title, headline: d.headline, period_start: "2026-10-26", period_end: "2026-11-01", doc: d }] },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em_1" } },
    { method: "PATCH", url: REST + "gtm_analytics_reports", json: [] },
  ]);
  const r = await deliverReports(adminDb(), { now: new Date("2026-11-02T01:00:00Z"), to: "owner@example.test", from: "Reports <r@example.test>" });
  assert.deepEqual(r, { sent: [{ slug: "weekly-2026-10-26", email_id: "em_1" }], missing: null, errors: [] });
  const mail = JSON.parse(m.calls.find((c) => c.url.startsWith("https://api.resend.com"))!.body!);
  assert.deepEqual(mail.to, ["owner@example.test"]);
  assert.match(mail.subject, /^Week 4 review: Sample/);
  assert.match(mail.html, /href="https:\/\/cockpit\.test\/performance\/reports\/weekly-2026-10-26"/);
  assert.match(mail.text, /Open the report: https:\/\/cockpit\.test\/performance\/reports\/weekly-2026-10-26/);
  assert.match(m.calls.find((c) => c.method === "PATCH")!.url, /id=eq\.r1/);
  assert.equal(m.calls.filter((c) => c.url.includes("gtm_sync_state")).length, 0);
});

test("from Monday noon in Bali, a week with no report gets one alert, recorded so it never repeats", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  const routes: Route[] = [
    { method: "GET", url: REST + "gtm_analytics_reports?select=id%2Cslug", json: [] },
    { method: "GET", url: REST + "gtm_analytics_reports?select=id&kind=eq.weekly&period_start=eq.2026-10-26", json: null },
    { method: "GET", url: REST + "gtm_sync_state", json: null },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em_missing" } },
    { method: "POST", url: REST + "gtm_sync_state", json: [] },
  ];
  const m = use(routes);
  const r = await deliverReports(adminDb(), { now: new Date("2026-11-02T04:30:00Z"), to: "owner@example.test", from: "r@example.test" });
  assert.deepEqual(r.missing, { week: "2026-10-26", email_id: "em_missing" });
  assert.match(JSON.parse(m.calls.find((c) => c.url.startsWith("https://api.resend.com"))!.body!).subject, /No weekly report for Oct 26 to Nov 1/);
  assert.equal(JSON.parse(m.calls.find((c) => c.method === "POST" && c.url.includes("gtm_sync_state"))!.body!).key, "analytics_report.missing.20261026");
  mock!.restore();

  const m2 = use([routes[0], routes[1], { method: "GET", url: REST + "gtm_sync_state", json: { key: "analytics_report.missing.20261026" } }]);
  const again = await deliverReports(adminDb(), { now: new Date("2026-11-02T05:40:00Z"), to: "owner@example.test", from: "r@example.test" });
  assert.equal(again.missing, null);
  assert.equal(m2.calls.filter((c) => c.url.startsWith("https://api.resend.com")).length, 0);
});

test("the link email escapes report text", () => {
  const html = linkHtml({ title: "T", headline: "<b>x</b> & y", period_start: "2026-10-26", period_end: "2026-11-01", doc: { summary: ["\"quoted\""] } }, "https://cockpit.test/r");
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.match(html, /&quot;quoted&quot;/);
});

test("analytics-reports cron: 401 without the right secret, and no work is done", async () => {
  const m = use([]);
  for (const auth of [undefined, "Bearer wrong"]) {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await route.GET(new Request("https://cockpit.test/api/cron/analytics-reports", { headers: auth ? { authorization: auth } : {} }));
    assert.equal(res.status, 401);
  }
  assert.equal(m.calls.length, 0);
});

test("the cron runs hourly in vercel.json", () => {
  const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
  assert.ok(crons.some((c) => c.path === "/api/cron/analytics-reports" && /^\d+ \* \* \* \*$/.test(c.schedule)));
});
