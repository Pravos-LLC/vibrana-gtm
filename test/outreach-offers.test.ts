import assert from "node:assert/strict";
import test from "node:test";
import catalog from "../config/outreach-offers.json";
import { activeOffers, isOfferOverride, validateOfferResponse, type OfferChoice } from "../lib/outreach/offers";
import { outreachDraftContext, requestOutreachAngles, OUTREACH_ANGLE_KEYS, schemaForEvidence, draftResponseSchema } from "../lib/outreach/ai-draft-core";
import type { DossierRow } from "../lib/outreach/desk";

const offers = activeOffers(catalog, Date.parse("2026-10-28"));
const ids = new Set(["signal"]);
const response = (id: OfferChoice = "eu-ai-act-readiness", body = "Would our EU AI Act Readiness assessment help clarify your readiness gaps?") => ({
  selection: { offer_id: id, confidence: "high", evidence_ids: ["signal"], reason: "They explicitly asked about their regulatory readiness gaps.", uncertainty: "" },
  angles: OUTREACH_ANGLE_KEYS.map(key => ({ key, offer_id: id, claim_ids: id === "none" ? [] : Object.keys(offers.find(o => o.id === id)!.claims), label: "A relevant question", rationale: "A current signal supports this question.", role_read: "unclear", role_evidence_ids: [], evidence_ids: ["signal"], subject: "Your readiness question", body, linkedin_note: "Would this be helpful?" })),
});

test("catalog rejects stale/invalid registries and excludes inactive or missing entries", () => {
  assert.throws(() => activeOffers({ ...catalog, version: 0 }), /needs review/);
  assert.throws(() => activeOffers({ ...catalog, reviewed_at: "invalid" }), /needs review/);
  assert.throws(() => activeOffers(catalog, Date.parse("2027-05-01")), /needs review/);
  assert.throws(() => activeOffers({ ...catalog, offers: [...catalog.offers, catalog.offers[0]] }), /duplicate/);
  const inactive = { ...catalog, offers: catalog.offers.map(o => ({ ...o, active: false })) };
  assert.equal(activeOffers(inactive).length, 0);
  assert.throws(() => validateOfferResponse(response(), ids, activeOffers(inactive), "auto"), /unsupported offer/);
  assert.throws(() => validateOfferResponse(response(), ids, [], "auto"), /unsupported offer/);
  assert.equal(isOfferOverride("nonsense"), false);
  assert.equal(isOfferOverride("none"), true);
});

test("context retains recommendation identity but canonical offers supersede missing/obsolete profile pitches beyond fifth position", () => {
  const row = { name: "Synthetic Person", dossier: { brief: { asset: { id: "retired-checklist", label: "Old checklist", url: "https://example.test/old" } } } } as DossierRow;
  const profile = { assets: Array.from({ length: 7 }, (_, n) => ({ id: n === 6 ? "eu-ai-act-readiness" : `old-${n}`, name: "Old pitch", pitch: "every employee gets a compliance certificate", fits: ["training"] })) };
  const context = outreachDraftContext(row, profile);
  assert.equal(context.research.asset?.id, "retired-checklist");
  assert.equal(context.research.asset?.url, "https://example.test/old");
  assert.equal(context.sender.assets.length, 3);
  assert.ok(context.sender.assets.find(o => o.id === "eu-ai-act-readiness")?.fits.length);
  assert.doesNotMatch(JSON.stringify(context.sender.assets), /every employee/);
  const schema = schemaForEvidence(context.evidence, OUTREACH_ANGLE_KEYS, context.offers!.catalog);
  assert.ok(schema.required.includes("selection"));
  assert.ok(schema.properties.angles.items.required.includes("offer_id"));
});

test("selection requires known evidence, active identity, meaningful reason and exact manual choice", () => {
  assert.equal(validateOfferResponse(response(), ids, offers, "auto").offer_id, "eu-ai-act-readiness");
  const unsupported = response(); unsupported.selection.evidence_ids = ["invented"];
  assert.throws(() => validateOfferResponse(unsupported, ids, offers, "auto"), /unsupported offer/);
  assert.throws(() => validateOfferResponse(response(), ids, offers, "ai-readiness"), /honor your offer choice/);
  const empty = response(); empty.selection.evidence_ids = [];
  assert.throws(() => validateOfferResponse(empty, ids, offers, "auto"), /no supporting evidence/);
  assert.equal(validateOfferResponse(empty, ids, offers, "eu-ai-act-readiness").offer_id, "eu-ai-act-readiness");
});

test("all angles share selected identity and only that offer's claim IDs", () => {
  const mixed = response(); mixed.angles[1].offer_id = "simulator";
  assert.throws(() => validateOfferResponse(mixed, ids, offers, "auto"), /mixed offers/);
  const wrong = response(); wrong.angles[0].claim_ids = ["organization-profile"];
  assert.throws(() => validateOfferResponse(wrong, ids, offers, "auto"), /unsupported claim/);
  const unknown = response(); unknown.angles[0].claim_ids = ["made-up-claim"];
  assert.throws(() => validateOfferResponse(unknown, ids, offers, "auto"), /unsupported claim/);
});

for (const [id, text] of [
  ["ai-readiness", "Our AI Readiness assessment maps your EU AI Act obligations."],
  ["ai-readiness", "Every employee gets an individual assessment."],
  ["eu-ai-act-readiness", "Our AI Readiness assessment gives you a transformation score."],
  ["eu-ai-act-readiness", "We certify your compliance."],
  ["eu-ai-act-readiness", "Are you ready for the EU AI Act rollout in December?"],
  ["simulator", "Our simulator provides guaranteed savings."],
  ["none", "We have a free readiness assessment if helpful."],
] as const) test(`blocks unsupported offer promise: ${text}`, () => {
  assert.throws(() => validateOfferResponse(response(id, text), ids, offers, "auto"));
});

test("one request returns selection and three short link-free options without a second model call", async () => {
  const row = { name: "Synthetic Person", dossier: { signal: { text: "We need to understand our EU AI Act exposure." } } } as DossierRow;
  let requests = 0;
  const result = await requestOutreachAngles(outreachDraftContext(row, {}, "eu-ai-act-readiness"), "test", { key: "test", fetcher: async (_url, init) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    assert.ok(request.response_format.json_schema.schema.required.includes("draft"));
    const decoded = response(); decoded.angles[0].body += " https://example.test/tool";
    return Response.json({ choices: [{ message: { content: JSON.stringify({ draft: decoded }) } }] });
  } });
  assert.equal(requests, 1);
  assert.equal(result.selection?.offer_id, "eu-ai-act-readiness");
  assert.ok(result.angles.every(a => a.offer_id === result.selection?.offer_id));
  assert.doesNotMatch(result.angles[0].body, /https?:|example.test/);
  assert.ok(result.angles[0].body.split(/\s+/).length < 60);
});

test("valid qualifications and completed-assessment context are not false promises", () => {
  assert.equal(validateOfferResponse(response("ai-readiness", "The AI Readiness assessment is an organizational self-report. It is not a compliance certification or an individual employee assessment."), ids, offers, "auto").offer_id, "ai-readiness");
  assert.equal(validateOfferResponse(response("eu-ai-act-readiness", "Our EU AI Act Readiness assessment may help. It is not legal advice or a certification."), ids, offers, "auto").offer_id, "eu-ai-act-readiness");
  assert.equal(validateOfferResponse(response("none", "Your EU AI Act assessment is already complete. How are you approaching implementation?"), ids, offers, "auto").offer_id, "none");
  assert.throws(() => validateOfferResponse({ selection: response().selection, angles: {} }, ids, offers, "auto"), /three complete options/);
});

test("free executive assessment produces one organizational result; personalized department instruments belong to transformation delivery", () => {
  const general = offers.find(o => o.id === "ai-readiness")!;
  assert.match(general.scope, /CEO, COO/);
  assert.match(Object.values(general.claims).join(" "), /one organizational/);
  assert.match(general.not_to_be_confused_with ?? "", /each person.*department/);
  const cauridor = "Saw Cauridor is hiring a Senior Data Analyst with an AI focus. We built an AI Readiness assessment that gives every person a personalized read across six dimensions, which can be useful when deciding where AI support is needed most.";
  assert.throws(() => validateOfferResponse(response("ai-readiness", cauridor), ids, offers, "auto"), /unsupported outcome/);
  for (const claim of ["a personalized readiness result", "a per-department readiness result", "a department-specific assessment"]) {
    assert.throws(() => validateOfferResponse(response("ai-readiness", `The AI Readiness assessment gives you ${claim}.`), ids, offers, "auto"), /unsupported outcome/);
  }
  assert.equal(validateOfferResponse(response("ai-readiness", "Our free AI Readiness assessment gives your executive team one organizational result."), ids, offers, "auto").offer_id, "ai-readiness");
});

test("explicit limits do not look like positive personalized or certification promises", () => {
  assert.doesNotThrow(() => validateOfferResponse(response("ai-readiness", "The AI Readiness assessment produces one organizational result. It is not a personalized assessment for every person or department."), ids, offers, "auto"));
  assert.doesNotThrow(() => validateOfferResponse(response("eu-ai-act-readiness", "The EU AI Act Readiness assessment maps likely obligations. It does not certify compliance and it isn't legal advice."), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("eu-ai-act-readiness", "The EU AI Act Readiness assessment is not legal advice, but it certifies compliance."), ids, offers, "auto"));
});

for (const text of [
  "Our free AI Readiness assessment gives each person their own readiness result.",
  "Our AI Readiness assessment gives every member of your team a tailored readiness result.",
  "Our AI Readiness assessment gives each employee a result.",
  "Our AI Readiness assessment is not legal advice, but gives each person a tailored result.",
  "Our AI Readiness assessment is not legal advice and gives every team member their own result.",
]) test(`free executive assessment cannot inherit personalized delivery: ${text}`, () => {
  assert.throws(() => validateOfferResponse(response("ai-readiness", text), ids, offers, "auto"), /unsupported outcome/);
});

test("clause-scoped negation passes truthful boundaries and rejects affirmative promises after contrast", () => {
  assert.doesNotThrow(() => validateOfferResponse(response("ai-readiness", "The AI Readiness assessment is not personalized for each employee; it produces one organizational result."), ids, offers, "auto"));
  assert.doesNotThrow(() => validateOfferResponse(response("simulator", "The AI Transformation Simulator cannot guarantee savings."), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("simulator", "The AI Transformation Simulator is not legal advice, but guarantees savings."), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("eu-ai-act-readiness", "Are you ready for the EU AI Act rollout in May? Our EU AI Act Readiness assessment may help."), ids, offers, "auto"));
  assert.doesNotThrow(() => validateOfferResponse(response("eu-ai-act-readiness", "Our EU AI Act Readiness assessment may help map likely obligations."), ids, offers, "auto"));
});

for (const body of [
  "Try our free AI Readiness assessment.",
  "Would our AI Transformation Simulator help with your business case?",
  "Our EU AI Act Readiness assessment maps your likely obligations.",
]) test(`no-offer override rejects resource invitations: ${body}`, () => {
  assert.throws(() => validateOfferResponse(response("none", body), ids, offers, "none"), /no-offer/);
});

test("affirmative not-only constructions and separate fields cannot mask promises", () => {
  assert.throws(() => validateOfferResponse(response("ai-readiness", "Our AI Readiness assessment is not only organizational: each person gets their own result."), ids, offers, "auto"), /unsupported outcome/);
  assert.throws(() => validateOfferResponse(response("ai-readiness", "Our AI Readiness assessment is not just organizational because each person gets their own result."), ids, offers, "auto"), /unsupported outcome/);
  const payload = response("simulator", "Our AI Transformation Simulator guarantees savings.");
  payload.angles.forEach(a => { a.subject = "No surprises"; });
  assert.throws(() => validateOfferResponse(payload, ids, offers, "auto"), /offer boundary/);
});

test("strict response branches bind each angle to its one decision, with no claims or low-confidence offers in automatic mode", () => {
  const row = { name: "Synthetic", dossier: {} } as DossierRow;
  const schema = draftResponseSchema(outreachDraftContext(row, {}));
  assert.ok("draft" in schema.properties);
  if (!("draft" in schema.properties)) return;
  const branches = schema.properties.draft.anyOf;
  assert.equal(branches.length, 4);
  for (const branch of branches) {
    const id = branch.properties.selection.properties.offer_id.enum[0];
    assert.deepEqual(branch.properties.angles.items.properties.offer_id.enum, [id]);
    if (id === "none") assert.equal(branch.properties.angles.items.properties.claim_ids.maxItems, 0);
    else assert.ok(!branch.properties.selection.properties.confidence.enum.includes("low"));
  }
  assert.doesNotThrow(() => validateOfferResponse(response("none", "Your EU AI Act Readiness assessment is complete. How are you approaching implementation?"), ids, offers, "auto"));
  assert.doesNotThrow(() => validateOfferResponse(response("none", "You mentioned needing each employee to complete a personalized AI Readiness assessment tailored to their department."), ids, offers, "auto"));
  const weak = response("ai-readiness", "The AI Readiness assessment gives one organizational result.");
  weak.selection.confidence = "low";
  assert.throws(() => validateOfferResponse(weak, ids, offers, "auto"), /too uncertain/);
  assert.doesNotThrow(() => validateOfferResponse(weak, ids, offers, "ai-readiness"));
});

test("automatic relevance filter cannot reframe individual assessment demands as the executive tool", () => {
  const row = (text: string) => ({ name: "Synthetic", dossier: { signal: { text } } } as DossierRow);
  const individual = outreachDraftContext(row("We specifically need each employee to fill out a personalized AI Readiness assessment tailored to their department, not a general executive assessment."), {});
  assert.ok(!individual.offers!.catalog.some(offer => offer.id === "ai-readiness"));
  assert.match(individual.offers!.exclusions![0].reason, /individual/);
  const organizational = outreachDraftContext(row("We need a general organizational readiness assessment, not a personalized result for each employee."), {});
  assert.ok(organizational.offers!.catalog.some(offer => offer.id === "ai-readiness"));
  const manual = outreachDraftContext(row("We need each employee to complete a personalized assessment."), {}, "ai-readiness");
  assert.ok(manual.offers!.catalog.some(offer => offer.id === "ai-readiness"));
  assert.deepEqual(manual.offers!.exclusions, []);
});

test("explicitly unknown AI initiative gives no automatic offer unless another concrete tool job is evidenced", () => {
  const row = (text: string) => ({ name: "Synthetic", dossier: { signal: { text } } } as DossierRow);
  const weak = outreachDraftContext(row("We are based in Europe and hiring a product role. No current AI initiative is known."), {});
  assert.equal(weak.offers!.catalog.length, 0);
  const economics = outreachDraftContext(row("No current AI initiative is known. We need a business case estimating AI operating costs."), {});
  assert.ok(economics.offers!.catalog.some(offer => offer.id === "simulator"));
  assert.equal(outreachDraftContext(row("We need an AI business case."), {}, "none").offers!.catalog.length, 0);
});

test("a selected offer can anchor a question-only opening without forcing a product sentence", () => {
  const payload = response("eu-ai-act-readiness", "How are you approaching AI literacy training for your team?");
  payload.angles.forEach(angle => { angle.claim_ids = []; });
  assert.doesNotThrow(() => validateOfferResponse(payload, ids, offers, "auto"));
  payload.selection.uncertainty = "Uncertain ownership. ".repeat(30);
  assert.ok(validateOfferResponse(payload, ids, offers, "auto").uncertainty.length <= 300);
  payload.angles[0].body = "I have a free readiness assessment if helpful.";
  assert.throws(() => validateOfferResponse(payload, ids, offers, "auto"), /clearly name/);
});

test("no-offer opener can refer to the department-specific assessment the recipient described", () => {
  assert.doesNotThrow(() => validateOfferResponse(response("none", "The personalized, department-specific AI Readiness assessment you described is a specific measurement job. How are you planning it?"), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("none", "Our AI Readiness assessment fits the need you described."), ids, offers, "auto"), /no-offer/);
});

test("no-offer opener can acknowledge an assessment the recipient's lawyers have finished", () => {
  assert.doesNotThrow(() => validateOfferResponse(response("none", "You mentioned the lawyers have finished the EU AI Act exposure assessment and mapped the obligations. How are you sequencing implementation?"), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("none", "We have a readiness assessment if helpful."), ids, offers, "auto"), /no-offer/);
});

test("asking about a prospect's department needs is different from promising tailored assessment results", () => {
  assert.doesNotThrow(() => validateOfferResponse(response("ai-readiness", "Is that primarily an organizational picture you need, or something more tailored per team? If useful, I can send the AI Readiness assessment, which gives one organizational result."), ids, offers, "auto"));
  assert.throws(() => validateOfferResponse(response("ai-readiness", "Would our AI Readiness assessment give every person a tailored result?"), ids, offers, "auto"), /unsupported outcome/);
  assert.throws(() => validateOfferResponse(response("ai-readiness", "The AI Readiness assessment gives one view. Could it provide every person a tailored result for your team?"), ids, offers, "auto"), /unsupported outcome/);
});

test("no-offer notes can acknowledge the recipient's assessment work using natural phrasing", () => {
  const payload = response("none", "How are you planning to tailor the questions across departments?");
  payload.angles.forEach(angle => { angle.linkedin_note = "Saw you're thinking through personalized AI readiness assessments per department. How will you tailor the questions?"; });
  assert.doesNotThrow(() => validateOfferResponse(payload, ids, offers, "auto"));
  payload.angles[0].linkedin_note = "Would you like our AI Readiness assessment?";
  assert.throws(() => validateOfferResponse(payload, ids, offers, "auto"), /no-offer/);
});

test("a no-offer note can ask about departmental assessment outcomes without a resource invitation", () => {
  const payload = response("none", "What would a useful result look like for each department?");
  payload.angles.forEach(angle => { angle.linkedin_note = "Curious what a useful outcome looks like for each department's AI readiness assessment, and who acts on the results once they're in."; });
  assert.doesNotThrow(() => validateOfferResponse(payload, ids, offers, "auto"));
  payload.angles[0].linkedin_note = "Curious whether our AI Readiness assessment would help?";
  assert.throws(() => validateOfferResponse(payload, ids, offers, "auto"), /no-offer/);
});

test("a no-offer subject can name the recipient's assessment topic without advertising ours", () => {
  const payload = response("none", "How are you tailoring questions across departments?");
  payload.angles.forEach(angle => { angle.subject = "Department AI readiness assessments"; });
  assert.doesNotThrow(() => validateOfferResponse(payload, ids, offers, "auto"));
  payload.angles[0].subject = "Our AI Readiness assessment";
  assert.throws(() => validateOfferResponse(payload, ids, offers, "auto"), /no-offer/);
});
