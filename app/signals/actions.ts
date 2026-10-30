"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { actOnStory, ACTIONS, type SignalAction } from "@/lib/signals/actions";
import { signalsViewer } from "@/lib/signals/access";
import { FORMATS, type StoryFormat } from "@/lib/signals/config";
import { sessionDb } from "@/lib/supabase/server";

type Result = { ok: true; status: string } | { ok: false; error: string };

/**
 * Save, queue (as a story, repost or video), dismiss or restore a Signal Desk story. The owner or a
 * gtm_team member may act; the claim is checked here and the write uses the service client (the
 * browser role cannot write gtm_* tables). Queuing never drafts or posts anything: the writers-room
 * agent picks queued stories up with `gtm signals list --status queued`.
 */
export async function actOnSignal(id: string, action: SignalAction, format?: StoryFormat): Promise<Result> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const viewer = signalsViewer(data?.claims as Record<string, unknown> | undefined);
  if (!viewer) return { ok: false, error: "Not signed in to the cockpit." };
  if (!(ACTIONS as readonly string[]).includes(action) || action === "drafted") return { ok: false, error: "Unknown action." };
  if (format && !(FORMATS as readonly string[]).includes(format)) return { ok: false, error: "Unknown format." };
  try {
    const story = await actOnStory(adminDb(), { id, action, format: format ?? null, actor: viewer.actor });
    revalidatePath("/signals");
    return { ok: true, status: story.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not update the story." };
  }
}
