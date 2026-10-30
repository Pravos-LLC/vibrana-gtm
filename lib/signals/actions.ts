// What a person (or the writers-room agent) does with a story. Every action is also a taste label.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { FORMATS, type StoryFormat, type StoryStatus } from "./config";

export const ACTIONS = ["save", "queue", "dismiss", "restore", "drafted"] as const;
export type SignalAction = (typeof ACTIONS)[number];

export function nextState(action: SignalAction, format?: StoryFormat | null): { status: StoryStatus; requested_format?: StoryFormat | null } {
  switch (action) {
    case "save": return { status: "saved" };
    case "queue":
      if (!format || !(FORMATS as readonly string[]).includes(format)) throw new Error(`queue needs a format: ${FORMATS.join(", ")}`);
      return { status: "queued", requested_format: format };
    case "dismiss": return { status: "dismissed" };
    case "restore": return { status: "new", requested_format: null };
    case "drafted": return { status: "drafted" };
  }
}

/** Applies an action with the service client. Callers check who is allowed before calling. */
export async function actOnStory(db: SupabaseClient, input: { id: string; action: SignalAction; actor: string; format?: StoryFormat | null; gtmStoryId?: string | null }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) throw new Error("unknown story");
  if (!(ACTIONS as readonly string[]).includes(input.action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
  const state = nextState(input.action, input.format);
  const patch: Record<string, unknown> = { ...state, acted_by: input.actor, acted_at: new Date().toISOString() };
  if (input.action === "drafted" && input.gtmStoryId) patch.gtm_story_id = input.gtmStoryId;
  const updated = must(await db.from("gtm_signal_stories").update(patch).eq("id", input.id).select("id,title,status,requested_format").maybeSingle(), "update story");
  if (!updated) throw new Error("unknown story");
  must(await db.from("gtm_signal_feedback").insert({ story_id: input.id, actor: input.actor, action: input.action, format: state.requested_format ?? null }), "record feedback");
  return updated as { id: string; title: string; status: StoryStatus; requested_format: StoryFormat | null };
}
