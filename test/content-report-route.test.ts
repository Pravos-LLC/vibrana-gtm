// The Sunday report cron route: auth gate, and a dry pass through the run with every service mocked.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test", OPENROUTER_API_KEY: "or_test" });
const route = await import("../app/api/cron/content-report/route.ts");

const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; delete process.env.CRON_SECRET; });
const req = (auth?: string) => new Request("https://cockpit.test/api/cron/content-report", { headers: auth === undefined ? {} : { authorization: auth } });

test("content-report cron: 401 without the right secret, and no work is done", async () => {
  const m = use([]);
  for (const auth of [undefined, "Bearer undefined", "Bearer "]) assert.equal((await route.GET(req(auth))).status, 401, String(auth));
  process.env.CRON_SECRET = "s3cret-value";
  for (const auth of ["Bearer s3cret-valuf", "s3cret-value", "bearer s3cret-value"]) assert.equal((await route.GET(req(auth))).status, 401, auth);
  assert.equal(m.calls.length, 0);
});

test("content-report cron: with the secret it runs the week's report; an already-written week is a 200 skip", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  use([
    { method: "GET", url: REST + "gtm_seasons", json: [{ id: "season-1", title: "S1", description: "", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: [] }] },
    { method: "GET", url: REST + "gtm_content_reports", json: { id: "rep-1", status: "done" } },
  ]);
  const res = await route.GET(req("Bearer s3cret-value"));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.id, "rep-1");
  assert.match(out.skipped, /already has a report/);
});

test("content-report cron: a failure is a 500 with the reason", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  use([{ method: "GET", url: REST + "gtm_seasons", status: 500, json: { message: "db down" } }]);
  const res = await route.GET(req("Bearer s3cret-value"));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /db down/);
});
