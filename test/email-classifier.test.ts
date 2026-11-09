// The reply classifier (lib/email/classifier.ts): Jev's answer shape, the thresholds, free-then-paid fallback, the outbound
// text boundary (only new text, masked, quoted mail in several languages removed), skips, and the shared deadline. No
// network: the fetcher is a stub. Synthetic text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierEnabled, classifyReply, outboundText, readAnswer, ENDPOINT, MAX_CHARS, RESERVE_MS } from "../lib/email/classifier.ts";
import { newText, replyRule } from "../lib/email/rules.ts";

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
const decided = (r: Awaited<ReturnType<typeof classifyReply>>) => { assert.equal(r.status, "decided"); return (r as { decision: ReturnType<typeof readAnswer> & object }).decision; };

test("off unless EMAIL_CLASSIFIER=jev and a key are both set; off sends nothing", async () => {
  assert.equal(classifierEnabled({}), false);
  assert.equal(classifierEnabled({ EMAIL_CLASSIFIER: "jev" }), false);
  assert.equal(classifierEnabled({ OPENCODE_API_KEY: "k" }), false);
  assert.equal(classifierEnabled(ON), true);
  const s = stub([]);
  assert.deepEqual(await classifyReply("Interested, let's talk.", { env: {}, fetcher: s.fetcher }), { status: "failed", attempts: 0 });
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

test("the free model first; the paid one when the free one fails; neither answering is a failure to retry", async () => {
  const ok = stub([json(answer("interested", 0.95, 0.01))]);
  const a = decided(await classifyReply("Sounds good, can we talk Tuesday?", { env: ON, fetcher: ok.fetcher }));
  assert.equal(a.model, "jev-1.13-free");
  assert.equal(ok.calls[0].url, ENDPOINT);
  assert.equal(ok.calls[0].auth, "Bearer oc_test");
  assert.equal(ok.calls[0].body.model, "jev-1.13-free");
  assert.deepEqual(Object.keys(ok.calls[0].body.questions as object), ["intent", "asked_to_stop"]);

  const fallback = stub([json({ error: "rate limited" }, 429), json(answer("referral", 0.9, 0, "paid"))]);
  const b = decided(await classifyReply("Talk to my colleague instead.", { env: ON, fetcher: fallback.fetcher }));
  assert.deepEqual([b.model, b.intent, b.billing], ["jev-1.13", "referral", "paid"]);
  assert.deepEqual(fallback.calls.map((c) => c.body.model), ["jev-1.13-free", "jev-1.13"]);

  const timeout = stub([new Error("timeout"), json({ unexpected: true })]);
  assert.deepEqual(await classifyReply("Maybe later.", { env: ON, fetcher: timeout.fetcher }), { status: "failed", attempts: 2 });
});

test("only the new text leaves: quoted mail in several languages and Outlook layouts is removed (review of #34, finding 1)", () => {
  const cases: [string, string][] = [
    ["Thanks.\n\n-----Ursprüngliche Nachricht-----\nVon: Sender <s@example.test>\nGesendet: Donnerstag\nAn: R <r@example.test>\nBetreff: Hi\nQUOTED", "Thanks."],
    ["Merci.\n\nLe jeu. 5 nov. 2026 à 10:00, Sender <s@example.test> a écrit :\nQUOTED", "Merci."],
    ["Gracias.\n\nEl jue, 5 nov 2026, Sender escribió:\nQUOTED", "Gracias."],
    ["Am Do., 5. Nov. 2026 um 10:00 Uhr schrieb Sender <s@example.test>:\nQUOTED", ""],
    ["Sure, Tuesday works.\n________________________________\nFrom: Sender <s@example.test>\nSent: Thursday\nQUOTED", "Sure, Tuesday works."],
    ["Sounds good.\n\nFrom: Sender <s@example.test>\nSent: Thursday\nQUOTED", "Sounds good."],
    // Language-independent markers (round 2): Russian Outlook, Japanese Gmail, a bare ruled line, a header in any alphabet.
    ["Спасибо.\n\n-----Исходное сообщение-----\nОт: Sender <s@example.test>\nОтправлено: 5 ноября 2026\nQUOTED", "Спасибо."],
    ["Спасибо.\n\nОт: Sender <s@example.test>\nОтправлено: 5 ноября 2026\nQUOTED", "Спасибо."],
    ["ありがとう。\n\n2026年11月5日(木) 10:00 Sender <s@example.test>:\nQUOTED", "ありがとう。"],
    ["Ok.\n==========\nQUOTED", "Ok."],
  ];
  for (const [input, expected] of cases) {
    const out = outboundText(input);
    if (expected) { assert.ok("text" in out, input); assert.equal((out as { text: string }).text, expected); }
    else assert.deepEqual(out, { skip: "no_text" });
    assert.ok(!JSON.stringify(out).includes("QUOTED"), input);
  }
});

test("addresses and phone numbers are masked; a surviving header line means nothing is sent", () => {
  assert.deepEqual(outboundText("Reach my colleague at jo.doe@example.test or +44 20 7946 0958."), { text: "Reach my colleague at [email] or [phone]." });
  assert.deepEqual(outboundText("Thanks\nOriginal sender: s@example.test"), { text: "Thanks" }, "a header after the reply ends it");
  assert.deepEqual(outboundText("Original sender: s@example.test\nThanks"), { skip: "quoted_header" }, "a header that cannot be cut off: nothing is sent");
  assert.deepEqual(outboundText("Отправитель: s@example.test\nСпасибо"), { skip: "quoted_header" }, "in any alphabet");
  assert.deepEqual(outboundText("> only quoted text"), { skip: "no_text" });
  assert.equal((outboundText("x".repeat(MAX_CHARS + 500)) as { text: string }).text.length, MAX_CHARS);
});

test("a skipped reply makes no request and is terminal (review of #34, finding 2)", async () => {
  const s = stub([]);
  assert.deepEqual(await classifyReply("", { env: ON, fetcher: s.fetcher }), { status: "skipped", reason: "no_text", attempts: 0 });
  assert.deepEqual(await classifyReply("> quoted only", { env: ON, fetcher: s.fetcher }), { status: "skipped", reason: "no_text", attempts: 0 });
  assert.equal(s.calls.length, 0);
});

test("the shared deadline: no request without time left; the fallback never resets the budget (review of #34, finding 3)", async () => {
  let t = 1_000_000;
  const none = stub([]);
  assert.deepEqual(await classifyReply("Maybe later.", { env: ON, fetcher: none.fetcher, deadline: t + RESERVE_MS + 1_000, now: () => t }), { status: "failed", attempts: 0 });
  assert.equal(none.calls.length, 0, "under the minimum per-attempt time: nothing is sent");
  // The free model uses up the time; the paid fallback is not tried.
  const slow = { calls: 0 } as { calls: number };
  const fetcher = (async () => { slow.calls++; t += 30_000; throw new Error("timeout"); }) as unknown as typeof fetch;
  assert.deepEqual(await classifyReply("Maybe later.", { env: ON, fetcher, deadline: t + RESERVE_MS + 25_000, now: () => t }), { status: "failed", attempts: 1 });
  assert.equal(slow.calls, 1);
});

test("the run's cap holds per request: a reply never makes more attempts than the cap has left", async () => {
  const s = stub([json({}, 503), json(answer("neutral", 0.9, 0))]);
  assert.deepEqual(await classifyReply("Maybe later.", { env: ON, fetcher: s.fetcher, maxAttempts: 1 }), { status: "failed", attempts: 1 });
  assert.equal(s.calls.length, 1, "the paid fallback is not tried when only one request is left");
});

test("ordinary lines never hide a local opt-out: the rule reads past them even where the outbound text stops (review of #34, round 3)", () => {
  for (const reply of ["Hello,\nReason: 3 emails this week is too much.\nPlease remove me from your list.", "Hello,\n========\nPlease remove me from your list.", "Hello,\n----- Please remove me -----\nThank you."]) {
    assert.match(newText(reply), /remove me/, reply);
    assert.equal(replyRule(reply, false).opt_out, "uncertain", "held for a person");
    assert.deepEqual(outboundText(reply), { text: "Hello," }, "the model sees less; the local rule still sees the request");
    assert.equal(replyRule(reply, false).opt_out, "uncertain");
  }
});

test("quoted footers still never count as the person's own opt-out, in any language", () => {
  const footers = [
    "Thanks, interested.\n\nOn Thu, Nov 5, 2026, Sender <s@example.test> wrote:\nReply unsubscribe to stop these emails.",
    "Danke.\n\n-----Ursprüngliche Nachricht-----\nVon: Sender <s@example.test>\nReply unsubscribe to stop these emails.",
    "Спасибо.\n\n-----Исходное сообщение-----\nОт: Sender <s@example.test>\nReply unsubscribe to stop these emails.",
    "Sure.\n________________________________\nFrom: Sender <s@example.test>\nReply unsubscribe to stop these emails.",
    "ありがとう。\n\n2026年11月5日(木) 10:00 Sender <s@example.test>:\nReply unsubscribe to stop these emails.",
  ];
  for (const f of footers) assert.equal(replyRule(f, false).opt_out, "none", f);
});
