/** Synthetic-only provider evaluation. No CRM access or writes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { outreachDraftContext, requestOutreachAngles } from "../lib/outreach/ai-draft-core";
import { CLIENT_SYSTEM } from "../lib/outreach/client-system";
import type { DossierRow } from "../lib/outreach/desk";

const cases = [
  { id: "explicit-regulatory", signal: "We need to understand which EU AI Act obligations apply to our AI systems and where our readiness gaps are.", expected: ["eu-ai-act-readiness"] },
  { id: "organization-adoption", signal: "Our teams struggle with AI adoption. We need to understand organizational capability gaps across leadership, data, technology and culture.", expected: ["ai-readiness"] },
  { id: "eu-finance-economics", signal: "As CFO of an EU company, I need a business case estimating AI operating cost and freed team capacity. We are evaluating economics, not compliance.", expected: ["simulator"] },
  { id: "generic-governance", signal: "We are thinking about general AI governance and organizational capability. We have not identified a regulatory question.", expected: ["ai-readiness", "none"] },
  { id: "staff-training", signal: "Our executive team needs one general view of organizational readiness and adoption barriers before scoping company-wide training.", expected: ["ai-readiness"] },
  { id: "individual-department-assessments", signal: "We specifically need each employee to fill out a personalized AI Readiness assessment tailored to their department, not a general executive assessment.", expected: ["none"] },
  { id: "act-literacy", signal: "We need to understand our EU AI Act readiness gaps, including how its AI literacy requirements apply to staff training.", expected: ["eu-ai-act-readiness"] },
  { id: "already-assessed", signal: "Our lawyers have completed our EU AI Act exposure assessment and mapped all obligations. Now we need implementation, not another assessment.", expected: ["none"] },
  { id: "weak-obsolete-recommendation", signal: "We are based in Europe and have an open product role. No current AI initiative is known.", expected: ["none"], obsolete: true },
  { id: "conflicting-recommendation", signal: "We have already settled regulatory questions. The immediate need is estimating AI operating costs and team capacity for a business case.", expected: ["simulator"], obsolete: true },
];
const replayPath = process.argv.find(arg => arg.startsWith("--replay="))?.slice(9);
const replay = replayPath ? new Map(fs.readFileSync(replayPath, "utf8").trim().split("\n").map(line => { const entry = JSON.parse(line); return [entry.id, entry]; })) : null;
const provenance = { code_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), prompt_sha256: createHash("sha256").update(CLIENT_SYSTEM).digest("hex") };
let failures = 0;
const only = process.argv.find(arg => arg.startsWith("--cases="))?.slice(8).split(",");
for (const scenario of cases.filter(scenario => !only || only.includes(scenario.id))) {
  const start = performance.now();
  let raw = "";
  try {
    const row = { name: "Riley Synthetic", title: "Operations leader", company: "Example Organization", dossier: { company: { name: "Example Organization", employees: "240", industry: "Software", ai_native: false }, signal: { text: scenario.signal, date: "2026-10-30", type: "synthetic-current-need" }, ...(scenario.obsolete ? { brief: { asset: { id: "retired-checklist", label: "AI compliance checklist" } } } : {}) } } as DossierRow;
    const result = await requestOutreachAngles(outreachDraftContext(row, { signature: "Sample Author" }), CLIENT_SYSTEM, { ...(replay ? { key: "offline-replay" } : {}), fetcher: async (url, init) => { if (replay) {
      const prior = replay.get(scenario.id);
      if (!prior) throw new Error("No captured response for this scenario; live provider was not called.");
      raw = prior.raw || JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selection: prior.selection, angles: prior.angles }) } }] });
      return new Response(raw, { status: prior.error?.includes("402") ? 402 : 200, headers: { "content-type": "application/json" } });
    }
    const response = await fetch(url, init); raw = await response.clone().text(); return response; } });
    assert.ok(scenario.expected.includes(result.selection!.offer_id), `expected ${scenario.expected}, received ${result.selection!.offer_id}`);
    assert.ok(result.selection!.reason.length > 10);
    assert.ok(result.selection!.offer_id === "none" || result.selection!.evidence_ids.includes("signal"));
    assert.ok(result.angles.every(a => !/https?:\/\/|www\./i.test(a.body + a.linkedin_note)));
    assert.ok(result.angles[0].body.split(/\s+/).length <= 80, "light-touch message stays short including signature");
    console.log(JSON.stringify({ ...provenance, id: scenario.id, pass: true, mode: replay ? "offline-replay" : "live", elapsed_ms: Math.round(performance.now() - start), ...result }));
  } catch (error) { failures++; console.log(JSON.stringify({ ...provenance, id: scenario.id, pass: false, mode: replay ? "offline-replay" : "live", elapsed_ms: Math.round(performance.now() - start), error: error instanceof Error ? error.message : String(error), raw })); if (error instanceof Error && /no available credit|HTTP 402/.test(error.message)) break; }
}
process.exitCode = failures ? 1 : 0;
