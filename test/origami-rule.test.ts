// Rule origami-reply-v1 (VIB-521) and the shared reply rule's bare "no". Synthetic replies only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply, exactPhrase, unsubscribedStatus, RULE_VERSION } from "../lib/origami/rule.ts";
import { replyCore, replyRule } from "../lib/email/rules.ts";

const c = (body: string, first: boolean | null = true) => classifyReply(body, first).classification;

test("a first reply that is exactly a confirmed phrase is confirmed, whatever its case, punctuation, spacing or sign-off", () => {
  for (const body of ["no", "No", "NO.", " no \n", "No thanks!", "No, thank you.", "no thank you", "Not relevant.", "Unsubscribe", "remove me", "STOP",
    "No thanks,\nThanks,\nAna", "No\n\nSent from my iPhone", "no\n-- \nAna Example\nHead of Ops", "No thanks, cheers", "No\nBest regards", "“No.”"]) {
    assert.deepEqual(classifyReply(body, true), { classification: "confirmed", reason: "exact_phrase" }, JSON.stringify(body));
  }
  assert.equal(RULE_VERSION, "origami-reply-v1");
});

test("the same phrase later in a conversation, or when first-ness is unknown, is only possible", () => {
  assert.deepEqual(classifyReply("no", false), { classification: "possible", reason: "exact_phrase_later" });
  assert.deepEqual(classifyReply("No thanks!", null), { classification: "possible", reason: "exact_phrase_later" });
});

test("a 'no' only in quoted text is not an opt-out; our own footer quoted back is not one either", () => {
  const quoted = "Sounds good, Tuesday works.\n\nOn Mon, Nov 9, 2026 at 10:00 AM John <john@vibrana.test> wrote:\n> Not relevant? Reply \"no\" and I won't contact you again.\n> no";
  assert.equal(c(quoted), "none");
  assert.equal(c("Happy to talk.\n> no"), "none");
  assert.equal(exactPhrase(quoted), false);
  assert.equal(replyCore(quoted), "sounds good tuesday works");
});

test("refusals and opt-out wording are possible; a 'no' that opens a reply is possible; 'No problem' is not", () => {
  assert.deepEqual(classifyReply("Not interested, thanks.", true), { classification: "possible", reason: "refusal_phrase" });
  assert.deepEqual(classifyReply("We're not interested at this time.", true), { classification: "possible", reason: "refusal_phrase" });
  assert.deepEqual(classifyReply("This is not a fit for us.", true), { classification: "possible", reason: "refusal_phrase" });
  assert.deepEqual(classifyReply("Please unsubscribe me from this list", true), { classification: "possible", reason: "opt_out_phrase" });
  assert.deepEqual(classifyReply("Don't contact me again", true), { classification: "possible", reason: "opt_out_phrase" });
  assert.deepEqual(classifyReply("No, we're all set for now.", true), { classification: "possible", reason: "leading_no" });
  assert.deepEqual(classifyReply("Nope", true), { classification: "possible", reason: "leading_no" });
  assert.equal(c("No problem, Tuesday at 10 works."), "none");
  assert.equal(c("No worries! Send me the deck."), "none");
  assert.equal(c("Don't unsubscribe me, I like these"), "none");
});

test("a greeting before the answer, or a name after it, does not hide a confirmed phrase (review B1)", () => {
  for (const body of ["Hi John,\n\nNo.\n\nBest,\nAna", "Hi John,\n\nNo\n\nAna", "Hello,\nno", "Dear John, no.", "John - no.", "Hi, no", "Hi John,\n\nStop.",
    "Hey John!\n\nNo thanks.\n\nCheers,\nAna", "Good morning,\n\nNot relevant.\n\nKind regards,\nAna Example", "Hallo John,\n\nNo.\n\nViele Grüße\nAna"]) {
    assert.deepEqual(classifyReply(body, true), { classification: "confirmed", reason: "exact_phrase" }, JSON.stringify(body));
  }
});

test("everyday refusals in English are possible opt-outs (review B1)", () => {
  for (const body of ["Thanks, but no", "Thanks but no thanks", "Nah", "Pass", "We'll pass on this", "Opt me out", "please remove", "Take me off your list", "I am not the right person",
    "Not the right contact, sorry", "This is not for us.", "Unfortunately, no.", "Hi John, unfortunately no. Ana", "No longer interested.", "Not at this time.", "Nope"]) {
    assert.equal(classifyReply(body, true).classification, "possible", JSON.stringify(body));
  }
  assert.equal(classifyReply("Hi John,\n\nwe already have a vendor for this, so no.\n\nAna", true).classification, "possible", "a short reply with a standalone no");
  assert.equal(classifyReply("Please stop.", true).classification, "possible");
});

test("refusals and unsubscribes in European languages are possible opt-outs (review B1)", () => {
  for (const body of ["Nein danke", "Nein, danke!", "Kein Interesse.", "Bitte entfernen Sie mich", "Abmelden", "Nee, dank je", "Nee bedankt", "Geen interesse", "Uitschrijven",
    "Non, merci", "Non merci.", "Pas intéressé", "Ça ne m'intéresse pas", "Désinscrire", "Merci de me désinscrire", "No gracias", "No me interesa", "Darse de baja", "Por favor, dar de baja",
    "No grazie", "Non mi interessa", "Cancellami", "Não, obrigado", "Não tenho interesse", "Nej tack", "Inte intresserad", "Nej tak", "Ikke interesseret", "Nei takk", "Ikke interessert",
    "Hola Juan,\n\nNo gracias.\n\nSaludos,\nJuan", "Bonjour,\n\nnon\n\nCordialement"]) {
    assert.equal(classifyReply(body, true).classification, "possible", JSON.stringify(body));
  }
});

test("normal replies stay out of CONFIRMED; the common ones record nothing", () => {
  for (const body of ["No problem, let's talk Tuesday", "No worries! Send me the deck.", "Hi John, no rush, Thursday works.", "Feel free to stop by our office next week",
    "Thanks, can you send more details?", "Sounds good, see you then.", "Hi John,\n\nYes, let's do it.\n\nBest,\nAna"]) {
    assert.equal(classifyReply(body, true).classification, "none", JSON.stringify(body));
  }
  for (const body of ["Is there no way to get a demo next week?", "No, Tuesday is better", "We had no budget last year but might now"]) {
    assert.notEqual(classifyReply(body, true).classification, "confirmed", JSON.stringify(body));
  }
});

test("an unrelated reply records nothing", () => {
  for (const body of ["Thanks, can you send more details?", "Interesting. What does pricing look like?", "Let's talk next week.", "", "Thanks"]) assert.equal(c(body), "none", body);
});

test("Origami's own unsubscribe, as a status or a stop reason, is confirmed evidence", () => {
  assert.equal(unsubscribedStatus({ status: "replied", stop_reason: "unsubscribed" }), true);
  assert.equal(unsubscribedStatus({ status: "unsubscribed", stop_reason: null }), true);
  assert.equal(unsubscribedStatus({ status: "replied", stop_reason: "replied" }), false);
  assert.equal(unsubscribedStatus({ status: "stopped", stop_reason: "manual" }), false);
});

test("the shared reply rule now holds a bare 'no' as a possible opt-out, and nothing that merely starts with no", () => {
  assert.deepEqual(replyRule("no", false), { intent: "uncertain", opt_out: "uncertain" });
  assert.deepEqual(replyRule("No thanks!\n\nOn Mon, Nov 9, 2026 Sender <s@x.test> wrote:\n> hello", false), { intent: "uncertain", opt_out: "uncertain" });
  assert.deepEqual(replyRule("No problem, see you then", false), { intent: "uncertain", opt_out: "none" });
  assert.deepEqual(replyRule("Sure.\n> no", false), { intent: "uncertain", opt_out: "none" });
  assert.deepEqual(replyRule("Out of office until Monday", true), { intent: "auto_reply", opt_out: "none" });
});
