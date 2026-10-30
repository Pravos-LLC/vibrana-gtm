// Synthetic browser fixture. Never imported by an application route.
import React from "react";
import { createRoot } from "react-dom/client";
import { WritingDesk, type DeskActions } from "../../components/outreach/writing-desk";
import type { OfferOverride } from "../../lib/outreach/offers";
import type { DeskEdit, DossierRow, QueueItem } from "../../lib/outreach/desk";
import type { DeskPerson } from "../../lib/outreach/desk-store";
import { OUTREACH_ANGLE_KEYS } from "../../lib/outreach/ai-draft-core";

declare global {
  interface Window { deskFixture: { saved: DeskEdit[]; saveDelay: number; savesStarted: number; failSave: boolean; throwSave: boolean; generationDelay: number; failGeneration: boolean; generationsFinished: number; requestedOffer?: OfferOverride } }
}
window.deskFixture = { saved: [], saveDelay: 0, savesStarted: 0, failSave: false, throwSave: false, generationDelay: 0, failGeneration: false, generationsFinished: 0 };
const signature = "Jo Fixture\nFounder, Fixture Co\nfixture.example";
const person = (id: string): DeskPerson => ({
  row: { twenty_person_id: id, track: "client", name: id === "fixture-one" ? "Riley Fixture" : "Devi Fixture", company: "Fixture Co", title: "Founder", score: 88, domain: "fixture.example", built_at: null, skipped_at: null, skip_reason: "", dossier: { prospect: { first_name: "Riley", email: "riley@fixture.example" }, client_check: { ok: true } } } as DossierRow,
  draft: null, versions: [], reference: [],
  start: { from: "blank", to: "riley@fixture.example", subject: "", body: `Hey Riley,\n\n\n\n${signature}`, linkedin_note: "" },
});
const first = person("fixture-one");
const queue = [first, person("fixture-two")].map((p) => ({ ...p.row, state: "to_write", draft_id: null })) as unknown as QueueItem[];
const failure = async () => ({ ok: false as const, error: "Fixture action is unavailable." });
const actions = {
  load: async (id: string) => ({ ok: true, value: person(id) }),
  save: async (_id: string, edit: DeskEdit) => {
    window.deskFixture.savesStarted++;
    await new Promise((resolve) => setTimeout(resolve, window.deskFixture.saveDelay));
    if (window.deskFixture.throwSave) throw new Error("Synthetic network failure");
    if (window.deskFixture.failSave) return { ok: false, error: "Fixture save failed." };
    window.deskFixture.saved.push({ ...edit });
    return { ok: true, value: { id: "fixture-draft", ...edit, track: "client", status: "pending", email_status: "draft", linkedin_status: "pending" } };
  },
  generate: async (_id: string, _track: string, _signal: AbortSignal, override: OfferOverride) => {
    window.deskFixture.requestedOffer = override;
    await new Promise((resolve) => setTimeout(resolve, window.deskFixture.generationDelay));
    window.deskFixture.generationsFinished++;
    if (window.deskFixture.failGeneration) return { ok: false, error: "Fixture generation failed." };
    return { ok: true, value: { selection: { offer_id: override === "auto" ? "ai-readiness" : override, confidence: "medium", reason: "The synthetic dossier describes an organizational adoption need.", uncertainty: "Synthetic example only.", evidence_ids: [] }, evidence: [], angles: OUTREACH_ANGLE_KEYS.map((key, i) => ({ key, label: ["Light touch", "Direct fit", "Useful value"][i], rationale: "Synthetic explanation for this fixture.", role_read: "unclear", role_evidence_ids: [], evidence_ids: [], subject: `fixture subject ${i + 1}`, body: `Hi Riley, This is fixture opening ${i + 1}.\n\nThis paragraph is synthetic test content.\n\nOne fixture question?\n\nP.S. Fixture resource.`, linkedin_note: `Fixture LinkedIn note ${i + 1}.` })) } };
  },
  markSent: failure, undoSent: failure, markInvite: failure, markFollowUp: failure, undoFollowUp: failure, skip: failure, unskip: failure, setTarget: failure,
} as unknown as DeskActions;
const settings = { daily_target: 5, from_address: "jo@fixture.example", profile_imported_at: null, profile: { name: "Jo Fixture", signature } };
createRoot(document.getElementById("root")!).render(<WritingDesk initialQueues={{ client: queue, guest: [] }} initialTrack="client" initialPerson={first} tracks={{ client: settings, guest: settings }} tz="UTC" actions={actions} />);
