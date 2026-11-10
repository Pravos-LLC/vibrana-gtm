// The Origami v3 client (VIB-521): pacing, 429/Retry-After, paging, the stop call, and what a "settled" sequence is.
// Every request goes to a mock; synthetic ids only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";
import { DeadlineError, isDeadline, linkedinSlug, OrigamiClient, OrigamiError, retryAfterMs, settled, settledRow } from "../lib/origami/client.ts";

const B = "https://origami.chat/api/v3";
const C = "00000000-0000-4000-8000-00000000c001", S = "00000000-0000-4000-8000-00000000a001";
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; delete process.env.DEMO_MODE; });
const client = (o: ConstructorParameters<typeof OrigamiClient>[0] = {}) => {
  const waits: number[] = [];
  let t = 0;
  return { waits, c: new OrigamiClient({ key: "og_test", pauseMs: 0, sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t, ...o }) };
};

test("a 429 waits for Retry-After, then the request succeeds", async () => {
  mock = installFetchMock([
    { url: `${B}/send/campaigns`, status: 429, json: { error: "slow down", code: "RATE_LIMITED" }, headers: { "retry-after": "3" }, times: 1 },
    { url: `${B}/send/campaigns`, json: { object: "list", items: [{ id: C, status: "active" }], next_cursor: null } },
  ]);
  const { c, waits } = client();
  assert.deepEqual(await c.campaigns(), [{ id: C, status: "active" }]);
  assert.deepEqual(waits, [3000]);
  assert.equal(mock.calls[0].headers.authorization, "Bearer og_test");
});

test("Retry-After as seconds or an HTTP date", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("soon"), null);
});

test("lists follow next_cursor; a person search never appears in an error", async () => {
  mock = installFetchMock([
    { url: `${B}/send/campaigns/${C}/people?search=ana%40prospect.test&limit=100`, json: { items: [{ sequence_id: S, status: "ongoing", stop_reason: null }], next_cursor: "p2" }, times: 1 },
    { url: `${B}/send/campaigns/${C}/people?search=ana%40prospect.test&limit=100&cursor=p2`, json: { items: [{ sequence_id: S.replace("a001", "a002"), status: "stopped", stop_reason: "manual" }], next_cursor: null }, times: 1 },
    { url: `${B}/send/campaigns/${C}/people`, status: 400, json: { error: "bad", code: "VALIDATION_ERROR" } },
  ]);
  const { c } = client();
  assert.equal((await c.people(C, { search: "ana@prospect.test" })).length, 2);
  await assert.rejects(c.people(C, { search: "ana@prospect.test" }), (e: Error) => e instanceof OrigamiError && e.status === 400 && e.code === "VALIDATION_ERROR" && !/ana|prospect/.test(e.message));
});

test("stop POSTs an empty body to .../people/{sequence_id}/stop with an idempotency key, and counts the write", async () => {
  mock = installFetchMock([{ method: "POST", url: `${B}/send/campaigns/${C}/people/${S}/stop`, json: { object: "sequence", status: "stopped" } }]);
  const { c } = client();
  await c.stop(C, S, "vib521-stop-7");
  assert.equal(mock.calls[0].body, "{}");
  assert.equal(mock.calls[0].headers["idempotency-key"], "vib521-stop-7");
  assert.equal(c.requests.writes, 1);
  assert.throws(() => c.stop("not-a-uuid", S, "k"), /not a UUID/);
});

test("a 429 whose Retry-After would pass the deadline stops as a deadline, not as a failure", async () => {
  mock = installFetchMock([{ url: `${B}/send/campaigns`, status: 429, json: { code: "RATE_LIMITED" }, headers: { "retry-after": "50" } }]);
  const { c } = client({ deadline: 10_000 });
  await assert.rejects(c.campaigns(), (e: Error) => isDeadline(e));
  assert.equal(isDeadline(new Error("Twenty read stopped at the run deadline")), true, "the Twenty reader's deadline counts too");
  assert.equal(isDeadline(new Error("Origami GET /x: 500")), false);
});

test("a 5xx backs off and gives up after the retries; nothing runs past the deadline; demo mode sends nothing", async () => {
  mock = installFetchMock([{ url: `${B}/send/campaigns`, status: 503, json: {} }]);
  const { c, waits } = client({ retries: 2 });
  await assert.rejects(c.campaigns(), /503/);
  assert.deepEqual(waits, [2000, 4000]);
  const late = client({ deadline: -1 });
  await assert.rejects(late.c.campaigns(), (e: Error) => e instanceof DeadlineError && isDeadline(e), "the deadline is its own error, so callers defer instead of counting a failure");
  process.env.DEMO_MODE = "1";
  await assert.rejects(client().c.campaigns(), /Demo mode/);
  assert.equal(mock.calls.length, 3);
});

test("settled: a terminal status, any stop reason, or a non-empty step list all done; waiting or missing steps keep it live", () => {
  assert.equal(settled({ status: "stopped", stop_reason: "manual" }), true);
  assert.equal(settled({ status: "replied", stop_reason: "unsubscribed", steps: [{ status: "not_connected" }] }), true);
  assert.equal(settled({ status: "no_messaging", stop_reason: null, steps: [] }), false, "an empty step list is not finished: it is stopped");
  assert.equal(settled({ status: "draft", stop_reason: null, steps: [] }), false, "a draft whose copy is not rendered yet sends once launched");
  assert.equal(settled({ status: "no_messaging", stop_reason: "linkedin_prior_contact", steps: [] }), true);
  assert.equal(settled({ status: "replied", stop_reason: null, steps: [{ status: "sent" }, { status: "stopped" }] }), true);
  assert.equal(settled({ status: "ongoing", stop_reason: null, steps: [{ status: "sent" }, { status: "scheduled" }] }), false);
  assert.equal(settled({ status: "draft", stop_reason: null, steps: [{ status: "draft" }] }), false);
  assert.equal(settled({ status: "scheduled", stop_reason: null }), false, "unknown steps are live");
  assert.equal(settledRow({ status: "ongoing", stop_reason: null }), false);
  assert.equal(settledRow({ status: "bounced", stop_reason: null }), true);
});

test("LinkedIn slugs from URLs or bare slugs, lowercase; an address is not a slug", () => {
  assert.equal(linkedinSlug("https://www.linkedin.com/in/Ana-Example-12ab/"), "ana-example-12ab");
  assert.equal(linkedinSlug("linkedin.com/in/ana%C3%A9x?trk=1"), "anaéx");
  assert.equal(linkedinSlug("ana-example-12ab"), "ana-example-12ab");
  assert.equal(linkedinSlug("ana@prospect.test"), null);
  assert.equal(linkedinSlug(null), null);
});
