"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { IDEA_LENSES, IDEA_STATUSES, type IdeaLens, type IdeaStatus, type NewIdea } from "@/lib/ideas/model";
import { addIdea, promoteIdea, updateIdea } from "@/lib/ideas/store";
import { sessionDb } from "@/lib/supabase/server";

export type IdeaResult = { ok: true; status: string; week_start?: string; warnings?: string[] } | { ok: false; error: string };

/** Owner only: the gtm_owner claim is checked here, then the write uses the service client (the browser role cannot write gtm_* tables). */
async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The add form: a title is enough; everything else is optional. */
export async function addIdeaAction(_prev: { ok: boolean; message: string } | null, form: FormData): Promise<{ ok: boolean; message: string }> {
  const actor = await owner();
  if (!actor) return { ok: false, message: "Not signed in as the cockpit owner." };
  const impact = text(form, "impact");
  try {
    const idea = await addIdea(adminDb(), {
      title: text(form, "title"), summary: text(form, "summary"), kind: (text(form, "kind") || "content") as NewIdea["kind"],
      pillar: (text(form, "pillar") || null) as NewIdea["pillar"], format: (text(form, "format") || null) as NewIdea["format"],
      effort: (text(form, "effort") || null) as NewIdea["effort"], impact: impact ? Number(impact) : null,
      source_url: text(form, "source_url") || null, owner: text(form, "owner") || null, tags: text(form, "tags").split(","), created_by: actor,
    });
    revalidatePath("/ideas");
    return { ok: true, message: `Added "${idea.title}".` };
  } catch (e) {
    return { ok: false, message: message(e, "Could not add the idea.") };
  }
}

/** Move an idea between idea, shortlisted, in production, shipped and parked. */
export async function setIdeaStatus(id: string, status: IdeaStatus): Promise<IdeaResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Only the cockpit owner changes ideas." };
  if (!(IDEA_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Pick a status." };
  try {
    const idea = await updateIdea(adminDb(), id, { status });
    revalidatePath("/ideas");
    return { ok: true, status: idea.status };
  } catch (e) {
    return { ok: false, error: message(e, "Could not change the status.") };
  }
}

/** Promote a content idea into the Sunday candidates for a week, as a text brief John writes up or rejects there. */
export async function promoteIdeaAction(id: string, week: string, lens: IdeaLens): Promise<IdeaResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Only the cockpit owner promotes ideas." };
  if (!(IDEA_LENSES as readonly string[]).includes(lens)) return { ok: false, error: "Pick a lens." };
  try {
    const r = await promoteIdea(adminDb(), id, { week_start: week, lens });
    revalidatePath("/ideas");
    revalidatePath("/signals");
    revalidatePath("/");
    return { ok: true, status: r.idea.status, week_start: r.candidate.week_start, warnings: r.warnings };
  } catch (e) {
    return { ok: false, error: message(e, "Could not promote it.") };
  }
}
