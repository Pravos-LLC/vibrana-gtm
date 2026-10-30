// The daily media audit cron (/api/cron/media-audit): refuses without the secret and does no work.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
const route = await import("../app/api/cron/media-audit/route.ts");
afterEach(() => { delete process.env.CRON_SECRET; });
const req = (auth?: string) => new Request("https://cockpit.test/api/cron/media-audit", { headers: auth === undefined ? {} : { authorization: auth } });

test("media-audit cron: 401 without the right secret, and no request goes out", async () => {
  const m = installFetchMock([]);
  try {
    for (const auth of [undefined, "Bearer undefined", "Bearer "]) assert.equal((await route.GET(req(auth))).status, 401, String(auth));
    process.env.CRON_SECRET = "s3cret-value";
    assert.equal((await route.GET(req("Bearer s3cret-valuf"))).status, 401);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("the cron is scheduled daily in vercel.json", async () => {
  const { readFileSync } = await import("node:fs");
  const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
  assert.ok(crons.some((c) => c.path === "/api/cron/media-audit" && /^\d+ \d+ \* \* \*$/.test(c.schedule)));
});
