"use server";

import { adminDb } from "@/lib/db";
import type { Draft, DraftEdit } from "@/lib/outreach/model";
import { acceptDraft, rejectDraft, reopenDraft, saveEdit, sendBack } from "@/lib/outreach/store";
import { sessionDb } from "@/lib/supabase/server";

export type OutreachResult = { ok: true; draft: Draft; siblings?: Draft[] } | { ok: false; error: string };

/** Owner only: the gtm_owner claim is checked here, then the write uses the service client (the browser role cannot write gtm_* tables). */
async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}

async function run(fn: (actor: string) => Promise<OutreachResult>): Promise<OutreachResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    return await fn(actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

// No revalidatePath: /outreach is optimistic and keeps its own state, like /content, so a click never re-renders the page.
export async function saveOutreachEdit(id: string, edit: DraftEdit): Promise<OutreachResult> {
  return run(async (actor) => ({ ok: true, draft: await saveEdit(adminDb(), id, edit, actor) }));
}

/** Accept saves any pending edit in the same call. An accept means John saw it: there is no second confirmation. */
export async function acceptOutreach(id: string, edit: DraftEdit | null): Promise<OutreachResult> {
  return run(async (actor) => ({ ok: true, ...(await acceptDraft(adminDb(), id, edit, actor)) }));
}

export async function rejectOutreach(id: string, reason: string): Promise<OutreachResult> {
  return run(async (actor) => ({ ok: true, draft: await rejectDraft(adminDb(), id, reason, actor) }));
}

export async function sendBackOutreach(id: string, note: string, edit: DraftEdit | null): Promise<OutreachResult> {
  return run(async (actor) => ({ ok: true, draft: await sendBack(adminDb(), id, note, edit, actor) }));
}

export async function reopenOutreach(id: string): Promise<OutreachResult> {
  return run(async () => ({ ok: true, draft: await reopenDraft(adminDb(), id) }));
}
