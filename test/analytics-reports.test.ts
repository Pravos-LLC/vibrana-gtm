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

const unsentRow = () => { const d = fixture(); return { id: "r1", slug: "weekly-2026-10-26", title: d.title, headline: d.headline, period_start: "2026-10-26", period_end: "2026-11-01", doc: d, updated_at: "2026-11-02T00:30:00Z" }; };
const MON_9AM_BALI = new Date("2026-11-02T01:00:00Z");
const opts = (now = MON_9AM_BALI) => ({ now, to: "owner@example.test", from: "Reports <r@example.test>" });

test("deliver claims each unsent report, emails its link once with an idempotency key, then saves the email id; before Monday noon no alert check", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test/";
  const m = use([
    { method: "GET", url: REST + "gtm_analytics_reports", json: [unsentRow()] },
    { method: "PATCH", url: REST + "gtm_analytics_reports", times: 1, json: [{ id: "r1" }] },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em_1" } },
    { method: "PATCH", url: REST + "gtm_analytics_reports", json: [] },
  ]);
  const r = await deliverReports(adminDb(), opts());
  assert.deepEqual(r, { sent: [{ slug: "weekly-2026-10-26", email_id: "em_1" }], missing: null, errors: [] });
  assert.match(m.calls[0].url, /emailed_at=is\.null/);
  assert.match(m.calls[0].url, /updated_at=gte\./, "--resend on an old week is picked up by updated_at");
  const claim = m.calls[1];
  assert.match(claim.url, /id=eq\.r1/); assert.match(claim.url, /emailed_at=is\.null/, "the claim only wins on an unclaimed row");
  const send = m.calls.find((c) => c.url.startsWith("https://api.resend.com"))!;
  assert.equal(send.headers["idempotency-key"], "analytics-report/r1/2026-11-02T00:30:00Z");
  const mail = JSON.parse(send.body!);
  assert.deepEqual(mail.to, ["owner@example.test"]);
  assert.match(mail.subject, /^Week 4 review: Sample/);
  assert.match(mail.html, /href="https:\/\/cockpit\.test\/performance\/reports\/weekly-2026-10-26"/);
  assert.match(mail.text, /Open the report: https:\/\/cockpit\.test\/performance\/reports\/weekly-2026-10-26/);
  assert.deepEqual(JSON.parse(m.calls.at(-1)!.body!), { email_id: "em_1" });
  assert.equal(m.calls.filter((c) => c.url.includes("gtm_sync_state")).length, 0);
});

test("a report another run already claimed is not sent", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  const m = use([
    { method: "GET", url: REST + "gtm_analytics_reports", json: [unsentRow()] },
    { method: "PATCH", url: REST + "gtm_analytics_reports", json: [] },
  ]);
  assert.deepEqual(await deliverReports(adminDb(), opts()), { sent: [], missing: null, errors: [] });
  assert.equal(m.calls.filter((c) => c.url.startsWith("https://api.resend.com")).length, 0);
});

test("a failed send releases the claim so the next hour retries", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  const m = use([
    { method: "GET", url: REST + "gtm_analytics_reports", json: [unsentRow()] },
    { method: "PATCH", url: REST + "gtm_analytics_reports", times: 1, json: [{ id: "r1" }] },
    { method: "POST", url: "https://api.resend.com/emails", status: 422, json: { message: "bad from" } },
    { method: "PATCH", url: REST + "gtm_analytics_reports", json: [] },
  ]);
  const r = await deliverReports(adminDb(), opts());
  assert.deepEqual(r.sent, []);
  assert.match(r.errors[0], /weekly-2026-10-26: resend 422: bad from/);
  assert.deepEqual(JSON.parse(m.calls.at(-1)!.body!), { emailed_at: null });
});

test("a sent email whose id cannot be saved stays claimed: reported, never sent again", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  use([
    { method: "GET", url: REST + "gtm_analytics_reports", json: [unsentRow()] },
    { method: "PATCH", url: REST + "gtm_analytics_reports", times: 1, json: [{ id: "r1" }] },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em_1" } },
    { method: "PATCH", url: REST + "gtm_analytics_reports", status: 500, json: { message: "db down" } },
  ]);
  const r = await deliverReports(adminDb(), opts());
  assert.deepEqual(r.sent, [{ slug: "weekly-2026-10-26", email_id: "em_1" }]);
  assert.match(r.errors[0], /sent, but the email id was not saved/);
});

test("from Monday noon in Bali, a week with no report gets one alert; the claim row makes it once only", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  const base: Route[] = [
    { method: "GET", url: REST + "gtm_analytics_reports?select=id%2Cslug", json: [] },
    { method: "GET", url: REST + "gtm_analytics_reports?select=id&kind=eq.weekly&period_start=eq.2026-10-26", json: null },
  ];
  const m = use([...base,
    { method: "POST", url: REST + "gtm_sync_state", json: [{ key: "analytics_report.missing.20261026" }] },
    { method: "POST", url: "https://api.resend.com/emails", json: { id: "em_missing" } },
    { method: "PATCH", url: REST + "gtm_sync_state", json: [] },
  ]);
  const r = await deliverReports(adminDb(), opts(new Date("2026-11-02T04:30:00Z")));
  assert.deepEqual(r.missing, { week: "2026-10-26", email_id: "em_missing" });
  const send = m.calls.find((c) => c.url.startsWith("https://api.resend.com"))!;
  assert.match(JSON.parse(send.body!).subject, /No weekly report for Oct 26 to Nov 1/);
  assert.equal(send.headers["idempotency-key"], "analytics-report-missing/2026-10-26");
  const claim = m.calls.find((c) => c.method === "POST" && c.url.includes("gtm_sync_state"))!;
  assert.equal(JSON.parse(claim.body!).key, "analytics_report.missing.20261026");
  assert.match(claim.headers.prefer ?? "", /ignore-duplicates/);
  mock!.restore();

  const m2 = use([...base, { method: "POST", url: REST + "gtm_sync_state", json: [] }]);
  const again = await deliverReports(adminDb(), opts(new Date("2026-11-03T05:40:00Z")));
  assert.equal(again.missing, null, "Tuesday: already alerted, nothing sent");
  assert.equal(m2.calls.filter((c) => c.url.startsWith("https://api.resend.com")).length, 0);
});

test("a failed missing alert deletes its claim so the next hour retries", async () => {
  process.env.GTM_COCKPIT_URL = "https://cockpit.test";
  const m = use([
    { method: "GET", url: REST + "gtm_analytics_reports?select=id%2Cslug", json: [] },
    { method: "GET", url: REST + "gtm_analytics_reports?select=id&kind=eq.weekly", json: null },
    { method: "POST", url: REST + "gtm_sync_state", json: [{ key: "analytics_report.missing.20261026" }] },
    { method: "POST", url: "https://api.resend.com/emails", error: "timeout" },
    { method: "DELETE", url: REST + "gtm_sync_state", json: [] },
  ]);
  const r = await deliverReports(adminDb(), opts(new Date("2026-11-02T04:30:00Z")));
  assert.equal(r.missing, null);
  assert.match(r.errors[0], /missing alert 2026-10-26/);
  assert.match(m.calls.at(-1)!.url, /key=eq\.analytics_report\.missing\.20261026/);
});

test("a null where a block or item belongs is a listed problem, not a crash", () => {
  const d = fixture();
  d.blocks[5].items.push(null);
  d.blocks.push(null);
  const problems = validateReportDoc(d);
  assert.equal(problems.length > 0, true);
  const d2 = fixture(); d2.blocks[0].items[0].value = "";
  assert.match(validateReportDoc(d2).join("\n"), /items\[0\]\.value: must be a non-empty string/);
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
