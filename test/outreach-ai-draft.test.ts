import assert from "node:assert/strict";
import test from "node:test";
import { OUTREACH_ANGLE_KEYS, outreachDraftContext, parseAngles, requestOutreachAngles, schemaForEvidence } from "../lib/outreach/ai-draft-core.js";
import type { DossierRow, Profile } from "../lib/outreach/desk.js";

const row = (dossier: Record<string, unknown>) => ({
  twenty_person_id: "p-arjun", track: "client", created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z",
  domain: "fulcrum.example", name: "Arjun Mangla", company: "Fulcrum", title: "Founder", score: null, built_at: null,
  dossier, skipped_at: null, skip_reason: "", skipped_by: null,
}) as DossierRow;

const profile: Profile = { positioning: "AI transformation partner", voice: ["Clear", "Useful"], asks: ["Would a short note be useful?"] };

const prospect = () => row({
  prospect: { first_name: "Arjun", title: "Founder" },
  company: { name: "Fulcrum", description: "Enterprise AI platform", employees: "240", industry: "Brokerage software", ai_native: false },
  person: {
    headline: "Founder at Fulcrum", about: "Building tools for brokerages",
    recent_posts: [1, 2, 3].map((n) => ({ text: `Recent post ${n}`, url: `https://linkedin.example/post/${n}`, date: "2026-10-20" })),
  },
  triggers: [1, 2, 3].map((n) => ({ summary: `Hiring signal ${n}`, subtype: "hiring", source_url: `https://fulcrum.example/jobs/${n}`, event_date: "2026-10-18" })),
  sources: [1, 2, 3, 4, 5].map((n) => ({ title: `Source ${n}`, text: `Evidence ${n}`, url: `https://fulcrum.example/source/${n}`, published: "2026-10-18" })),
  brief: { problem: "Deployment work is scaling", why_now: "The team is hiring" },
});

const angles = (body = "I noticed Fulcrum is expanding deployments, and I have a short field note that may help.") => OUTREACH_ANGLE_KEYS.map((key) => ({
  key, label: "Relevant opening", rationale: "The hiring signal makes deployment a timely topic.",
  role_read: "likely_decision_maker", role_evidence_ids: ["linkedin-post-3"], evidence_ids: ["research-brief", "source-5"],
  subject: "Deployment at Fulcrum", body, linkedin_note: "Saw the deployment role at Fulcrum. Open to connecting?",
}));

test("strict schema requirements and evidence enums match the full bounded dossier", () => {
  const context = outreachDraftContext(prospect(), profile);
  const schema = schemaForEvidence(context.evidence);
  const item = schema.properties.angles.items;
  const propertyNames = Object.keys(item.properties);
  assert.deepEqual(item.required.filter((name) => !propertyNames.includes(name)), []);
  assert.ok(context.evidence.some((entry) => entry.id === "research-brief"));
  assert.ok(context.evidence.some((entry) => entry.id === "linkedin-post-3"));
  assert.ok(context.evidence.length <= 18);
  const contextIds = new Set(context.evidence.map((entry) => entry.id));
  for (const field of ["role_evidence_ids", "evidence_ids"] as const) {
    const enumValues = item.properties[field].items.enum;
    assert.ok(enumValues.every((id) => contextIds.has(id)), `${field} only advertises supplied evidence`);
  }

  const parsed = parseAngles({ angles: angles() }, contextIds);
  assert.equal(parsed[0]!.role_read, "likely_decision_maker");
  assert.deepEqual(parsed[0]!.role_evidence_ids, ["linkedin-post-3"]);
});

test("numeric headcount is preserved as evidence and context", () => {
  const numericRow = row({ company: { name: "Fulcrum", employees: 240 } });
  const context = outreachDraftContext(numericRow, profile);
  assert.equal(context.company.employees, "240");
  assert.match(context.evidence.find((item) => item.id === "company")?.detail ?? "", /Headcount: 240/);
});

test("normalizes dashes and rejects unknown or duplicate keys and false authorship claims", () => {
  const context = outreachDraftContext(prospect(), profile);
  const allowed = new Set(context.evidence.map((entry) => entry.id));
  const normalized = parseAngles({ angles: angles("Fulcrum is hiring for deployments—which may make a field note useful.") }, allowed);
  assert.doesNotMatch(normalized[0]!.body, /[—–]/);

  const overlongAfterDashCleanup = angles().map((angle) => ({ ...angle, linkedin_note: `${"a".repeat(299)}—` }));
  assert.throws(() => parseAngles({ angles: overlongAfterDashCleanup }, allowed), /incomplete option/);

  const duplicate = angles();
  duplicate[1] = { ...duplicate[1]!, key: duplicate[0]!.key };
  assert.throws(() => parseAngles({ angles: duplicate }, allowed), /duplicate or unknown angles/);
  const unknown: unknown[] = angles();
  unknown[0] = { ...unknown[0]!, key: "unrecognized" };
  assert.throws(() => parseAngles({ angles: unknown }, allowed), /duplicate or unknown angles/);

  const missingRoleEvidence = angles().map(({ role_evidence_ids: _roleEvidence, ...angle }) => angle);
  assert.equal(parseAngles({ angles: missingRoleEvidence }, allowed)[0]!.role_read, "unclear");
  assert.throws(() => parseAngles({ angles: angles("No AI was used to write this email. I have a short field note that may help.") }, allowed), /inaccurate authorship claim/);
});

test("OpenRouter request path handles valid content and provider errors", async () => {
  const makeResponse = (content: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as Response;
  const validContent = JSON.stringify({ selection: { offer_id: "none", confidence: "low", evidence_ids: [], reason: "Evidence does not establish an immediate buyer need.", uncertainty: "Need is unclear." }, angles: angles().map(a => ({ ...a, offer_id: "none", claim_ids: [] })) });
  const context = outreachDraftContext(prospect(), profile);
  const valid = await requestOutreachAngles(context, "test system", { key: "test-key", model: "deepseek/deepseek-v4.1-flash", fetcher: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.reasoning, { effort: "none" }, "reasoning must not consume the bounded draft output budget");
    assert.equal(request.max_tokens, 4500);
    return makeResponse(validContent);
  } });
  assert.equal(valid.angles.length, 3);

  await requestOutreachAngles(context, "test system", { key: "test-key", model: "example/non-reasoning-model", fetcher: async (_url, init) => {
    assert.equal(Object.hasOwn(JSON.parse(String(init?.body)), "reasoning"), false, "model overrides retain their existing provider parameter contract");
    return makeResponse(validContent);
  } });

  await assert.rejects(() => requestOutreachAngles(context, "test system", { key: "test-key", fetcher: async () => makeResponse("no", 503) }), /HTTP 503/);
  await assert.rejects(() => requestOutreachAngles(context, "test system", { key: "test-key", fetcher: async () => makeResponse({ text: "not a string" }) }), /no content/);
  await assert.rejects(() => requestOutreachAngles(context, "test system", { key: "test-key", fetcher: async () => makeResponse("not json") }), /invalid JSON/);
  await assert.rejects(() => requestOutreachAngles(context, "test system", { key: "", fetcher: async () => makeResponse(validContent) }), /OPENROUTER_API_KEY/);
});

test("live provider returns three complete outreach options with reasoning disabled", { skip: process.env.OUTREACH_PROVIDER_SMOKE !== "1" }, async () => {
  const result = await requestOutreachAngles(outreachDraftContext(prospect(), profile),
    "Generate exactly three concise outreach angles from the supplied evidence, one for each schema key. Each needs a subject, email body and LinkedIn note. Use only supplied evidence IDs and no claims about authorship.",
    { model: "deepseek/deepseek-v4.1-flash" });
  assert.equal(result.angles.length, 3);
  assert.ok(result.angles.every((angle) => angle.subject && angle.body && angle.linkedin_note));
});

test("OpenRouter aborts are reported as a drafting timeout", async () => {
  await assert.rejects(() => requestOutreachAngles(outreachDraftContext(prospect(), profile), "test system", {
    key: "test-key",
    timeoutMs: 1,
    fetcher: async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })),
  }), /drafting request timed out/);
});

// ---- podcast guests: the same machinery with its own angles, evidence and route ---------------------------------------------

const guestRow = (over: Record<string, unknown> = {}) => row({
  track: "guest", route: "intermediary", twenty_person_id: "guest-md:riley-fixture", domain: "fixture.example",
  prospect: { first_name: "Riley", last_name: "Fixture", title: "Director", company: "Fixture Lab" },
  signal: { text: "Showed a film at the Fixture Gallery", url: "https://fixture.example/news/1", date: "2026-04-24", type: "guest_trigger" },
  guest: {
    template: "04", season: "ai-transition", wisdom_angle: "Fixture wisdom angle", central_question: "What changes when design starts from place?",
    prompts: ["First fixture prompt?", "Second fixture prompt?"], warm_path: "none known", approach_note: "Write to the office first.",
    protocol_note: "Consult the council before naming the nation.", contact_line: "Office contact form", website: "fixture.example",
  },
  client_check: { ok: true }, ...over,
});
const guestProfile: Profile = {
  signature: "John", positioning: "Host of a show", facts: [{ id: "f", text: "Launched a Example campaign title 16 podcast in 2021." }],
  podcast_history: { summary: "Hosted a Example campaign title 16 show.", shows: [{ name: "Fixture Show", language: "English", host: "John" }], notable_guests: [{ name: "Casey Guest", role: "Founder" }] },
  templates: { "04": "Subject: {{their work}} and a conversation\n\nHey {{first_name}},\n\nBody." },
};

test("guest angles have their own keys, and the schema and parser enforce them", async () => {
  const { GUEST_ANGLE_KEYS, angleKeysFor, guestDraftContext } = await import("../lib/outreach/ai-draft-core.js");
  assert.deepEqual(angleKeysFor("guest"), GUEST_ANGLE_KEYS);
  assert.deepEqual(angleKeysFor("client"), OUTREACH_ANGLE_KEYS);
  const context = guestDraftContext(guestRow(), guestProfile);
  const schema = schemaForEvidence(context.evidence, GUEST_ANGLE_KEYS);
  assert.deepEqual(schema.properties.angles.items.properties.key.enum, [...GUEST_ANGLE_KEYS]);
  const ids = new Set(context.evidence.map((e) => e.id));
  const make = (keys: readonly string[]) => keys.map((key) => ({ key, label: "Opening", rationale: "Grounded in their own work.", role_read: "unclear", role_evidence_ids: [], evidence_ids: ["signal"], subject: "a conversation", body: "Hello,\n\nI host a show and would love to talk with Riley.", linkedin_note: "Hello, would Riley be open to a conversation?" }));
  assert.equal(parseAngles({ angles: make(GUEST_ANGLE_KEYS) }, ids, GUEST_ANGLE_KEYS).length, 3);
  assert.throws(() => parseAngles({ angles: make(OUTREACH_ANGLE_KEYS) }, ids, GUEST_ANGLE_KEYS), /duplicate or unknown angles/);
});

test("the guest context carries the route, the protocol notes, the host history and the guest evidence", async () => {
  const { guestDraftContext } = await import("../lib/outreach/ai-draft-core.js");
  const context = guestDraftContext(guestRow(), guestProfile);
  assert.equal(context.guest?.route, "intermediary");
  assert.deepEqual(context.guest?.how_to_approach, ["Write to the office first.", "Consult the council before naming the nation."]);
  assert.equal(context.guest?.reach.contact_line, "Office contact form");
  assert.ok(context.guest?.host_history.some((f) => /Example campaign title 16 podcast in 2021/.test(f)));
  assert.ok(context.guest?.host_history.some((f) => /Casey Guest/.test(f)));
  assert.match(context.guest?.scaffold ?? "", /Body\./);
  for (const id of ["signal", "guest-wisdom", "guest-question", "guest-prompts"]) assert.ok(context.evidence.some((e) => e.id === id), id);
  assert.equal(context.evidence.find((e) => e.id === "guest-question")?.detail, "What changes when design starts from place?");
});

test("a guest request asks for the guest schema and keeps the guest keys", async () => {
  const { GUEST_ANGLE_KEYS, guestDraftContext } = await import("../lib/outreach/ai-draft-core.js");
  const context = guestDraftContext(guestRow(), guestProfile);
  let seen: { response_format?: { json_schema?: { schema?: { properties?: { angles?: { items?: { properties?: { key?: { enum?: string[] } } } } } } } } } = {};
  const content = JSON.stringify({ angles: GUEST_ANGLE_KEYS.map((key) => ({ key, label: "Opening", rationale: "Grounded in their own work.", role_read: "unclear", role_evidence_ids: [], evidence_ids: [], subject: "a conversation", body: "Hello,\n\nWould Riley be open to a conversation on the show?", linkedin_note: "Hello." })) });
  const result = await requestOutreachAngles(context, "guest system", { key: "k", keys: GUEST_ANGLE_KEYS, fetcher: async (_u, init) => { seen = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content } }] })); } });
  assert.deepEqual(seen.response_format?.json_schema?.schema?.properties?.angles?.items?.properties?.key?.enum, [...GUEST_ANGLE_KEYS]);
  assert.deepEqual(result.angles.map((a) => a.key), [...GUEST_ANGLE_KEYS]);
  assert.match(result.angles[0]!.body, /\nJohn$/, "the sender signature is appended");
});


test("a simple question and optional resource offer are accepted without length padding", async () => {
  const context = outreachDraftContext(prospect(), profile);
  const body = "Hey Riley,\n\nAre your teams ready for the new workflow?\n\nWe have a free AI Readiness assessment if it would help.";
  const result = await requestOutreachAngles(context, "test system", { key: "test-key", fetcher: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ selection: { offer_id: "ai-readiness", confidence: "medium", evidence_ids: ["research-brief"], reason: "The team is expanding its organizational AI adoption.", uncertainty: "" }, angles: angles(body).map(a => ({ ...a, offer_id: "ai-readiness", claim_ids: ["organization-profile"] })) }) } }] }) });
  assert.match(result.angles[0].body, /Are your teams ready/);
  assert.ok(result.angles[0].body.split(/\s+/).length < 40);
});
