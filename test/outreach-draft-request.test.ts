import assert from "node:assert/strict";
import test from "node:test";
import { requestDeskAngles } from "../lib/outreach/draft-request.js";

test("drafting uses a cancellable POST outside the Server Action queue", async (t) => {
  const controller = new AbortController();
  const value = { angles: [{}, {}, {}], evidence: [] };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/outreach/write/angles");
    assert.equal(init.method, "POST");
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(String(init.body)), { personId: "synthetic-person", track: "client", offerOverride: "auto" });
    return Response.json({ ok: true, value });
  });
  assert.deepEqual(await requestDeskAngles("synthetic-person", "client", controller.signal), { ok: true, value });
});

test("drafting explains HTTP failures and login HTML instead of hanging", async (t) => {
  for (const [status, expected] of [[403, /Sign in again/], [504, /timed out/], [502, /HTTP 502/]] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("platform error", { status }));
    const result = await requestDeskAngles("synthetic-person", "client");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, expected);
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Sign in</html>"));
  const result = await requestDeskAngles("synthetic-person", "client");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unreadable response/);
});
