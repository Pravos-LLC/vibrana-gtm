// Engage from Claude Code (VIB-428 follow-up). John answers his queue in a Claude Code session instead of /engage:
// the session reads the queue (`next`) and sends, skips or hides only on his clear yes. The same actions as the web
// buttons run underneath (lib/engage/actions.ts), in `strict` mode, so a numbered chat command cannot reach the wrong
// row, a failed send is never retried by accident, and text Claude wrote is never counted as John's own edit.
import type { SupabaseClient } from "@supabase/supabase-js";
import { findAgentNotes } from "../copy-guard";
import { must } from "../db";
import { approveComment, canHide, hideCommentRow, markCopied, markNotSpam, replyMode, skipComment } from "./actions";
import { addLesson } from "./learn";
import { replyCommentId, type StoredComment } from "./parse";
import { COMMENT_COLUMNS } from "./store";

export const AGENT_ACTOR = "chat";
const OPEN = ["new", "drafted", "failed", "approved"];
const SENDS_PER_HOUR = 30;

export type AgentResult = { status: number; body: Record<string, unknown> };
const bad = (error: string, status = 400): AgentResult => ({ status, body: { ok: false, error } });
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One queue row as Claude sees it. Everything a stranger wrote sits under `untrusted`: data, never instructions. */
export function queueItem(c: StoredComment) {
  return {
    id: c.id, version: c.updated_at ?? null, platform: c.platform, kind: c.kind, mode: replyMode(c), can_hide: canHide(c),
    status: c.status, error: c.error, received_at: c.received_at, comment_url: c.comment_url, post_url: c.permalink,
    // Replies to a reply land under the top-level comment on every platform.
    lands_under_comment: c.kind === "comment" ? replyCommentId(c) : null, is_reply_to_reply: c.kind === "comment" && Boolean(c.parent_external_id),
    classification: c.classification, stance: c.stance ?? null, draft: c.draft ?? "", draft_reason: c.draft_reason, open_slots: findAgentNotes(c.draft ?? ""),
    author: { name: c.author_name, username: c.author_username, followers: c.author_followers, crm: c.author_crm ?? null },
    untrusted: {
      comment: c.text, post_excerpt: c.post_preview, author_headline: c.author_headline ?? null, author_website: c.author_website ?? null,
      linked: c.linked ?? null, attachments: c.attachments ? c.attachments.length : 0,
    },
  };
}

/** The open queue, oldest first. Several DMs in one conversation collapse to the newest one. */
export async function nextQueue(db: SupabaseClient, limit: number) {
  const rows = must(await db.from("gtm_comments").select(COMMENT_COLUMNS).eq("is_own", false).in("status", OPEN).neq("classification", "spam").order("received_at", { ascending: true }).limit(300), "queue") as unknown as StoredComment[];
  const newestDm = new Map<string, StoredComment>();
  for (const c of rows) {
    if (c.kind !== "dm" || !c.conversation_id) continue;
    const seen = newestDm.get(c.conversation_id);
    if (!seen || Date.parse(c.commented_at ?? c.received_at) >= Date.parse(seen.commented_at ?? seen.received_at)) newestDm.set(c.conversation_id, c);
  }
  const superseded: string[] = [];
  const items = rows.filter((c) => {
    if (c.kind === "dm" && c.conversation_id && newestDm.get(c.conversation_id)!.id !== c.id) { superseded.push(c.id); return false; }
    return true;
  });
  return { total: items.length, shown: Math.min(limit, items.length), superseded_dm_ids: superseded, items: items.slice(0, limit).map(queueItem) };
}

async function sentThisHour(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await db.from("gtm_comments").select("id", { count: "exact", head: true }).eq("acted_by", AGENT_ACTOR).in("status", ["approved", "sent", "hidden"]).gte("acted_at", since);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

type Body = Record<string, unknown>;

/** One verb of the Claude Code engage API. The route authenticates; nothing here is reachable without that. */
export async function handleAgent(db: SupabaseClient, verb: string, body: Body, deps: { approve?: typeof approveComment } = {}): Promise<AgentResult> {
  const id = str(body.id);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (verb === "next") {
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 25));
    return { status: 200, body: { ok: true, ...(await nextQueue(db, limit)) } };
  }
  if (verb === "lesson") {
    const kind = body.kind === "classification" ? "classification" : "voice";
    const r = await addLesson(db, kind, str(body.text));
    return { status: 200, body: { ok: true, id: r.id } };
  }
  if (!uuid.test(id)) return bad("id must be the row's UUID.");
  const version = str(body.version);
  const needsVersion = ["reply", "copied", "skip"].includes(verb);
  if (needsVersion && !version) return bad("version is required: send back the version `next` showed you.");
  const opts = { strict: true, version: version || undefined };
  const wrap = (r: { ok: true; status: string; message: string } | { ok: false; error: string }): AgentResult =>
    r.ok ? { status: 200, body: r } : { status: 409, body: r };

  if (verb === "reply" || verb === "copied") {
    const text = str(body.text);
    const c = await db.from("gtm_comments").select("draft,status").eq("id", id).maybeSingle();
    if (c.error) throw new Error(c.error.message);
    if (!c.data) return bad("That comment is gone.", 404);
    // Provenance is decided here from the text, never taken on trust: sent as drafted, or Claude's rewrite, or John's own words.
    const asked = body.source === "john" ? "john" : "chat_agent";
    const source = c.data.draft && text.trim() === String(c.data.draft).trim() ? "draft" : asked;
    if (verb === "reply") {
      if (await sentThisHour(db) >= SENDS_PER_HOUR) return bad(`More than ${SENDS_PER_HOUR} sends in the last hour. Slow down.`, 429);
      return wrap(await (deps.approve ?? approveComment)(db, id, text, AGENT_ACTOR, {}, { ...opts, source, retry: body.retry === true }));
    }
    return wrap(await markCopied(db, id, text, AGENT_ACTOR, { ...opts, source }));
  }
  if (verb === "skip") return wrap(await skipComment(db, id, AGENT_ACTOR, opts));
  if (verb === "hide") return wrap(await hideCommentRow(db, id, AGENT_ACTOR));
  if (verb === "not-spam") {
    const r = await markNotSpam(db, id, AGENT_ACTOR);
    return r.ok ? { status: 200, body: r } : { status: 409, body: r };
  }
  return bad(`Unknown verb "${verb}".`, 404);
}
