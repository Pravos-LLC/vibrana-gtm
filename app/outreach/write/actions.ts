"use server";
import { isOfferOverride, type OfferOverride } from "@/lib/outreach/offers";

import { after } from "next/server";
import { adminDb } from "@/lib/db";
import { isTrack, senderProfile, type DeskEdit, type DossierRow, type Track } from "@/lib/outreach/desk";
import {
  deskPerson, deskSettings, markDeskFollowUpSent, markDeskLinkedinSent, markDeskSent, saveDesk, setDailyTarget, skipPerson, unmarkDeskFollowUpSent, unmarkDeskSent, unskipPerson,
  type DeskPerson,
} from "@/lib/outreach/desk-store";
import type { Draft } from "@/lib/outreach/model";
import { angleModel, generateOutreachAngles, type OutreachAngles } from "@/lib/outreach/ai-draft";
import { addLesson, learnFromEdits, outreachGuidance, recordAngleEdit, recordAngleRun, removeAngleEdit, retireLesson, type Channel, type LessonKind } from "@/lib/outreach/learn";
import { sessionDb } from "@/lib/supabase/server";

export type DeskResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Owner only: the gtm_owner claim is checked here, then the write uses the service client (the browser role cannot write gtm_* tables). */
type Viewer = { email?: string; app_metadata?: { gtm_owner?: boolean } };
async function owner(): Promise<{ actor: string; claims: Viewer } | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as Viewer | undefined;
  return claims?.app_metadata?.gtm_owner === true ? { actor: claims.email ?? "owner", claims } : null;
}

async function run<T>(fn: (actor: string, claims: Viewer) => Promise<T>): Promise<DeskResult<T>> {
  const who = await owner();
  if (!who) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    return { ok: true, value: await fn(who.actor, who.claims) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/** Every action names the stream John is in: a person of the other stream is refused, never written. */
const stream = (t: Track): Track => { if (!isTrack(t)) throw new Error("Unknown stream."); return t; };
/** The stream's profile as the signed-in person writes with it (their own signature on the client stream). */
const profile = async (track: Track, claims: Viewer) => senderProfile(track, (await deskSettings(adminDb(), track)).profile, claims);

// No revalidatePath: the desk keeps its own state, so an autosave never re-renders the page under John's cursor.
export async function loadDeskPerson(personId: string, track: Track): Promise<DeskResult<DeskPerson>> {
  return run(async (_actor, claims) => deskPerson(adminDb(), personId, await profile(stream(track), claims), track));
}

/** Generate copy for a client prospect or a podcast guest, only after the owner check and the dossier's client exclusion check pass. */
export async function generateDeskAngles(personId: string, track: Track = "client", offerOverride: OfferOverride = "auto"): Promise<DeskResult<OutreachAngles>> {
  return run(async (actor, claims) => {
    if (!isOfferOverride(offerOverride)) throw new Error("Choose a valid offer before drafting.");
    const stream_ = stream(track);
    const currentProfile = await profile(stream_, claims);
    const person = await deskPerson(adminDb(), personId, currentProfile, stream_);
    if (person.row.dossier.client_check?.ok !== true) {
      throw new Error("The dossier's client check has not passed. Resolve that check before drafting outreach.");
    }
    // Guest invitations have their own angle keys and are not learned from yet.
    if (stream_ === "guest") return generateOutreachAngles(person.row, currentProfile, {}, stream_);
    // What the generator has learned from John's earlier edits. A learning failure never stops a generation.
    const guidance = await outreachGuidance(adminDb()).catch(() => null);
    const result = await generateOutreachAngles(person.row, currentProfile, { guidance, offerOverride }, stream_);
    // The angles as generated are the baseline a later edit is diffed against. If storing fails the angles are still returned, just not learned from.
    const run_id = await recordAngleRun(adminDb(), { person: personId, model: angleModel(), lesson_set: guidance?.lesson_set ?? null, angles: result.angles, actor }).catch(() => undefined);
    return { ...result, run_id };
  });
}

/** The angle John sent from: the stored run and which of its three angles was in the editor. */
export type SentAngle = { run_id: string; key: string };

/**
 * Right after a send: keep the generated text next to what John sent (cheap, awaited), then let the learning run read it
 * after the response (observations on the diff, updated lessons). Nothing here can fail or delay the send.
 */
async function learnFromSend(personId: string, draft: Draft, channel: Channel, edit: DeskEdit, angle: SentAngle | undefined, actor: string) {
  if (!angle) return;
  try {
    const row = await recordAngleEdit(adminDb(), { run_id: angle.run_id, angle_key: angle.key, draft_id: draft.id, person: personId, channel, final: edit });
    if (row) after(() => learnFromEdits(adminDb(), { actor, deadline: Date.now() + 80_000 }).then(() => undefined, () => undefined));
  } catch { /* the message is sent; learning is best effort */ }
}

export async function saveDeskDraft(personId: string, edit: DeskEdit, track: Track): Promise<DeskResult<Draft>> {
  return run(async (actor, claims) => saveDesk(adminDb(), personId, edit, actor, await profile(stream(track), claims), track));
}

/** A client: the email. A guest: by the route on their dossier (email, LinkedIn note, or via an intermediary). */
export async function markSent(personId: string, edit: DeskEdit, track: Track, angle?: SentAngle): Promise<DeskResult<Draft>> {
  return run(async (actor, claims) => {
    const draft = await markDeskSent(adminDb(), personId, edit, actor, await profile(stream(track), claims), track);
    if (track === "client") await learnFromSend(personId, draft, "email", edit, angle, actor);
    return draft;
  });
}

export async function undoSent(personId: string, track: Track): Promise<DeskResult<Draft>> {
  return run(async () => {
    const draft = await unmarkDeskSent(adminDb(), personId, stream(track));
    // It never went out, so it teaches nothing.
    await removeAngleEdit(adminDb(), draft.id, "email").catch(() => undefined);
    return draft;
  });
}

export async function markInviteSent(personId: string, edit: DeskEdit, track: Track, angle?: SentAngle): Promise<DeskResult<Draft>> {
  return run(async (actor, claims) => {
    const draft = await markDeskLinkedinSent(adminDb(), personId, edit, actor, await profile(stream(track), claims), track);
    await learnFromSend(personId, draft, "linkedin", edit, angle, actor);
    return draft;
  });
}

// ---- the learning view: lessons and the learning run ------------------------------------------------------------------

export async function learnOutreachNow(): Promise<DeskResult<string>> {
  return run(async (actor) => {
    const r = await learnFromEdits(adminDb(), { actor, force: false, deadline: Date.now() + 80_000 });
    return r.skipped ? "Nothing new to learn from since the last run." : `Read ${r.edits} ${r.edits === 1 ? "edit" : "edits"}: ${r.added.length} new lessons, ${r.kept} kept, ${r.retired.length} retired${r.held.length ? `, ${r.held.length} kept anyway (a run retires at most half)` : ""}.`;
  });
}
export async function addOutreachLesson(kind: string, text: string): Promise<DeskResult<string>> {
  return run(async () => { await addLesson(adminDb(), kind as Exclude<LessonKind, "rule_conflict">, text); return "Added. The next angles use it."; });
}
export async function retireOutreachLesson(id: string): Promise<DeskResult<string>> {
  return run(async (actor) => ((await retireLesson(adminDb(), id, actor)) ? "Retired." : "Already retired."));
}

export async function markFollowUp(personId: string, track: Track): Promise<DeskResult<Draft>> {
  return run(async () => markDeskFollowUpSent(adminDb(), personId, stream(track)));
}

export async function undoFollowUp(personId: string, track: Track): Promise<DeskResult<Draft>> {
  return run(async () => unmarkDeskFollowUpSent(adminDb(), personId, stream(track)));
}

export async function skipDeskPerson(personId: string, reason: string, track: Track): Promise<DeskResult<DossierRow>> {
  return run(async (actor) => skipPerson(adminDb(), personId, reason, actor, stream(track)));
}

export async function unskipDeskPerson(personId: string, track: Track): Promise<DeskResult<DossierRow>> {
  return run(async () => unskipPerson(adminDb(), personId, stream(track)));
}

export async function setDeskTarget(target: number, track: Track): Promise<DeskResult<number>> {
  return run(async (actor) => setDailyTarget(adminDb(), target, actor, stream(track)));
}
