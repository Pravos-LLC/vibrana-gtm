// The reply classifier (lib/email/classifier.ts): Jev's answer shape, the thresholds, free-then-paid fallback, and that only
// the reply's new text is sent. No network: the fetcher is a stub. Synthetic text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierEnabled, classifyReply, readAnswer, ENDPOINT, MAX_CHARS } from "../lib/email/classifier.ts";

const ON = { EMAIL_CLASSIFIER: "jev", OPENCODE_API_KEY: "oc_test" };
const answer = (choice: string, confidence: number, stop: number, billing = "free") =>
  ({ model: "x", answers: { intent: { type: "choice", choice, confidence }, asked_to_stop: { type: "noul", noul: stop } }, usage: { opencode: { billing_source: billing } } });
const stub = (responses: (Response | Error)[]) => {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const r = responses.shift();
    if (!r || r instanceof Error) throw r ?? new Error("no response");
    return r;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("off unless EMAIL_CLASSIFIER=jev and a key are both set; off sends nothing", async () => {
  assert.equal(classifierEnabled({}), false);
  assert.equal(classifierEnabled({ EMAIL_CLASSIFIER: "jev" }), false);
  assert.equal(classifierEnabled({ OPENCODE_API_KEY: "k" }), false);
  assert.equal(classifierEnabled(ON), true);
  const s = stub([]);
  assert.equal(await classifyReply("Interested, let's talk.", { env: {}, fetcher: s.fetcher }), null);
  assert.equal(s.calls.length, 0);
});

test("thresholds: an intent below 0.8 is uncertain; asked-to-stop at 0.5 or more is a possible opt-out, never more", () => {
  assert.deepEqual(readAnswer(answer("not_now", 1, 0.02), "jev-1.13-free"), { intent: "not_now", opt_out: "none", model: "jev-1.13-free", confidence: 1, stop: 0.02, billing: "free" });
  assert.equal(readAnswer(answer("interested", 0.79, 0), "m")!.intent, "uncertain");
  assert.equal(readAnswer(answer("interested", 0.8, 0), "m")!.intent, "interested");
  assert.equal(readAnswer(answer("not_interested", 0.9, 0.5), "m")!.opt_out, "uncertain");
  assert.equal(readAnswer(answer("not_interested", 0.9, 0.49), "m")!.opt_out, "none");
});

test("an answer outside the expected shape is no answer, never a guess", () => {
  assert.equal(readAnswer(null, "m"), null);
  assert.equal(readAnswer({ answers: {} }, "m"), null);
  assert.equal(readAnswer(answer("buy_now", 1, 0), "m"), null, "a label we never asked for");
  assert.equal(readAnswer(answer("interested", 1.2, 0), "m"), null);
  assert.equal(readAnswer({ answers: { intent: { choice: "interested", confidence: 1 } } }, "m"), null, "the opt-out question is required");
});

test("the free model first; the paid one when the free one fails; neither answering is null", async () => {
  const ok = stub([json(answer("interested", 0.95, 0.01))]);
  const a = await classifyReply("Sounds good, can we talk Tuesday?", { env: ON, fetcher: ok.fetcher });
  assert.equal(a!.model, "jev-1.13-free");
  assert.equal(ok.calls[0].url, ENDPOINT);
  assert.equal(ok.calls[0].auth, "Bearer oc_test");
  assert.equal(ok.calls[0].body.model, "jev-1.13-free");
  assert.deepEqual(Object.keys(ok.calls[0].body.questions as object), ["intent", "asked_to_stop"]);

  const fallback = stub([json({ error: "rate limited" }, 429), json(answer("referral", 0.9, 0, "paid"))]);
  const b = await classifyReply("Talk to my colleague instead.", { env: ON, fetcher: fallback.fetcher });
  assert.deepEqual([b!.model, b!.intent, b!.billing], ["jev-1.13", "referral", "paid"]);
  assert.deepEqual(fallback.calls.map((c) => c.body.model), ["jev-1.13-free", "jev-1.13"]);

  const timeout = stub([new Error("timeout"), json({ unexpected: true })]);
  assert.equal(await classifyReply("Maybe later.", { env: ON, fetcher: timeout.fetcher }), null);
});

test("only the new text is sent, capped in length; a reply with no new text is not sent at all", async () => {
  const s = stub([json(answer("neutral", 0.9, 0))]);
  const quoted = "What does it cost?\n\nOn Thu, Nov 5, 2026, Sender <s@hq.test> wrote:\n> Reply unsubscribe to stop these emails.";
  await classifyReply(quoted, { env: ON, fetcher: s.fetcher });
  assert.equal(s.calls[0].body.state, "What does it cost?");
  const long = stub([json(answer("neutral", 0.9, 0))]);
  await classifyReply("x".repeat(MAX_CHARS + 500), { env: ON, fetcher: long.fetcher });
  assert.equal(String(long.calls[0].body.state).length, MAX_CHARS);
  const empty = stub([]);
  assert.equal(await classifyReply("> only quoted text", { env: ON, fetcher: empty.fetcher }), null);
  assert.equal(empty.calls.length, 0);
});
