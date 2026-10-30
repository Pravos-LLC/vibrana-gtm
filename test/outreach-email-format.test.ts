import assert from "node:assert/strict";
import test from "node:test";
import { formatOutreachEmail, outreachSignature, stripLinks } from "../lib/outreach/email-format.js";
import { outreachDraftContext, requestOutreachAngles, OUTREACH_ANGLE_KEYS } from "../lib/outreach/ai-draft-core.js";
import type { DossierRow } from "../lib/outreach/desk.js";

const signature = "Jo Fixture\nFounder, Fixture Co";

test("formatting separates the greeting, short paragraphs, exact signature and P.S. without losing text", () => {
  const sentence = "This fixture sentence gives enough words to exercise the paragraph layout without any actual claims about a company.";
  const raw = `Hi Riley, ${sentence} ${sentence} ${sentence}\n\nP.S. The supplied resource is a plain note.`;
  const formatted = formatOutreachEmail(raw, signature);
  assert.ok(formatted.startsWith("Hi Riley,\n\n"));
  assert.equal(formatted.split(sentence).length - 1, 3);
  assert.ok(formatted.includes(`\n\n${signature}\n\nP.S. The supplied resource`));
  assert.ok(formatted.endsWith("a plain note."));
  assert.ok(formatted.split("\n\n").length >= 5);
  assert.equal(formatOutreachEmail(formatted, signature), formatted);
});

test("existing paragraph breaks and signature line breaks are preserved", () => {
  const raw = `Hey Riley,\n\nFirst short paragraph.\n\nOne question?\n\n${signature}`;
  assert.equal(formatOutreachEmail(raw, signature), raw);
  assert.equal(formatOutreachEmail("A short note without a greeting."), "A short note without a greeting.");
});

test("the actual request path appends the profile signature after validating the model output", async () => {
  const context = outreachDraftContext({ name: "Riley Fixture", title: "Founder", company: "Fixture", dossier: {} } as DossierRow, { signature });
  const angles = OUTREACH_ANGLE_KEYS.map((key) => ({ key, offer_id: "none", claim_ids: [], label: "Fixture angle", rationale: "A synthetic rationale for this test.", role_read: "unclear", role_evidence_ids: [], evidence_ids: [], subject: "fixture subject", body: "Hi Riley, This is a synthetic email used only for the request test.\n\nOne question?\n\nP.S. Fixture resource: https://fixture.io/x", linkedin_note: "A synthetic connection note." }));
  const result = await requestOutreachAngles(context, "synthetic test", { key: "test", fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selection: { offer_id: "none", confidence: "low", evidence_ids: [], reason: "No evidenced buyer need is supplied.", uncertainty: "No dossier evidence." }, angles }) } }] })) });
  for (const angle of result.angles) assert.ok(angle.body.includes(outreachSignature(signature)) && !/fixture\.io/.test(angle.body));
});

test("a first email carries no link: the signature drops its domain line and generated copy loses every link", () => {
  assert.equal(outreachSignature("Jo Fixture\nFounder, Fixture Co\nfixture.io"), "Jo Fixture\nFounder, Fixture Co");
  assert.equal(outreachSignature("Jo Fixture\nhttps://fixture.example/jo"), "Jo Fixture");
  assert.equal(outreachSignature("Jo Fixture\nFounder, Fixture.io Labs"), "Jo Fixture\nFounder, Fixture.io Labs");
  assert.equal(stripLinks("Hi Riley,\n\nSee https://fixture.example/notes for more.\n\nP.S. Fixture notes: https://fixture.example/notes"), "Hi Riley,\n\nSee for more.");
  assert.equal(stripLinks("Hi Riley,\n\nWe wrote it up at fixture.io/notes.\n\nOne question?"), "Hi Riley,\n\nWe wrote it up at.\n\nOne question?");
});

test("PS inside a sentence or an earlier paragraph is never moved after the signature", () => {
  const body = "Hi Riley,\n\nI will send the PS deck tomorrow.\n\nOne question?";
  assert.equal(formatOutreachEmail(body, signature), `${body}\n\n${signature}`);
  const earlier = "Hi Riley,\n\nPS is the deck name.\n\nI will send it tomorrow.";
  assert.equal(formatOutreachEmail(earlier, signature), `${earlier}\n\n${signature}`);
});


test("server and client formatting stay idempotent with CRLF and long configured signatures", () => {
  for (const sign of [signature.replace(/\n/g, "\r\n"), `Jo Fixture\n${"Fixture role ".repeat(100)}\nfixture.example`]) {
    const context = outreachDraftContext({ name: "Riley Fixture", dossier: {} } as DossierRow, { signature: sign });
    const server = formatOutreachEmail("Hi Riley, A synthetic note.\n\nP.S. Fixture resource.", context.sender.signature);
    assert.equal(formatOutreachEmail(server, sign), server);
    assert.equal(server.split("Jo Fixture").length - 1, 1);
  }
});
