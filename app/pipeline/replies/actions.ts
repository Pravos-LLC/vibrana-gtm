"use server";
// Writes from /pipeline/replies (VIB-496): an owner's label on a reply, approval of a pending Twenty suppression operation,
// and a live test of the reply classifier on text the owner types. Owner only; the service role writes after the check.
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { classifierEnabled, classifyReply } from "@/lib/email/classifier";
import { humanLabelProblems } from "@/lib/email/review";
import { approve } from "@/lib/email/suppression";
import { sessionDb } from "@/lib/supabase/server";

export type Result = { ok: boolean; message: string } | null;

async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}

/** An owner's label on one reply. It supersedes their earlier label (labels are append-only) and outranks rule and model. */
export async function labelReply(_prev: Result, form: FormData): Promise<Result> {
  const who = await owner();
  if (!who) return { ok: false, message: "Not signed in as a cockpit owner." };
  const eventId = Number(form.get("eventId")), intent = String(form.get("intent") ?? ""), optOut = String(form.get("optOut") ?? "");
  const problems = humanLabelProblems(intent, optOut);
  if (!Number.isInteger(eventId) || eventId <= 0) problems.push("Unknown reply.");
  if (problems.length) return { ok: false, message: problems.join(" ") };
  const db = adminDb();
  const { data: ev, error: evErr } = await db.from("gtm_team_mail_events").select("id").eq("id", eventId).eq("kind", "reply").maybeSingle();
  if (evErr || !ev) return { ok: false, message: "That reply is not in the cockpit." };
  const { data: prior } = await db.from("gtm_email_reply_labels").select("person_id").eq("event_id", eventId).is("superseded_at", null).not("person_id", "is", null).limit(1);
  const now = new Date().toISOString();
  const sup = await db.from("gtm_email_reply_labels").update({ superseded_at: now }).eq("event_id", eventId).eq("source", "human").is("superseded_at", null);
  if (sup.error) return { ok: false, message: "The earlier label could not be replaced; try again." };
  const ins = await db.from("gtm_email_reply_labels").insert({ event_id: eventId, person_id: prior?.[0]?.person_id ?? null, source: "human", intent, opt_out: optOut, labeled_by: who, labeled_at: now });
  if (ins.error) return { ok: false, message: ins.error.code === "23505" ? "Someone labeled this reply at the same moment; reload." : "The label could not be saved." };
  revalidatePath("/pipeline/replies");
  return { ok: true, message: optOut === "none" ? "Saved." : "Saved. The hourly sync turns this into a stop-list item for your approval." };
}

/** Approve one pending Twenty suppression operation; the hourly writer applies it and confirms it on read-back. */
export async function approveOperation(_prev: Result, form: FormData): Promise<Result> {
  const who = await owner();
  if (!who) return { ok: false, message: "Not signed in as a cockpit owner." };
  const id = Number(form.get("opId"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: "Unknown operation." };
  const n = await approve(adminDb(), [id], `approved in the cockpit (/pipeline/replies) by ${who} on ${new Date().toISOString().slice(0, 10)}`, new Date()).catch(() => -1);
  if (n < 0) return { ok: false, message: "The approval could not be saved." };
  revalidatePath("/pipeline/replies");
  return n === 1 ? { ok: true, message: "Approved. It is written to Twenty on the next hourly run." } : { ok: false, message: "Nothing to approve: it is not pending, or it is a review (label the reply instead)." };
}

/** Run the reply classifier on text the owner typed. Nothing is stored; the text goes to Jev and back. */
export async function tryClassifier(_prev: Result, form: FormData): Promise<Result> {
  if (!(await owner())) return { ok: false, message: "Not signed in as a cockpit owner." };
  if (!classifierEnabled()) return { ok: false, message: "The classifier is off (EMAIL_CLASSIFIER and OPENCODE_API_KEY)." };
  const text = String(form.get("text") ?? "").slice(0, 4000);
  if (!text.trim()) return { ok: false, message: "Type a reply to test." };
  const r = await classifyReply(text, { deadline: Date.now() + 45_000 });
  if (r.status === "skipped") return { ok: false, message: r.reason === "no_text" ? "Nothing left to send after removing quoted text." : "It looks like a quoted mail header, so nothing was sent." };
  if (r.status === "failed") return { ok: false, message: "Jev did not answer in time; try again." };
  const d = r.decision;
  return { ok: true, message: `${d.intent.replace("_", " ")} (confidence ${Math.round(d.confidence * 100)}%), asked to stop: ${Math.round(d.stop * 100)}%${d.opt_out === "uncertain" ? " → would open a review" : ""}. Model ${d.model}.` };
}
