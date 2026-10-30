// gtm_comments reads and writes for the engage queue (VIB-423). Server and CLI only (service role).
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { ANSWERED, replyCommentId, type CommentRow, type StoredComment } from "./parse";

export const COMMENT_COLUMNS = "id,kind,source,platform,account_id,zernio_post_id,platform_post_id,content_item_id,external_id,parent_external_id,conversation_id,author_id,author_username,author_name,author_picture,text,post_preview,permalink,comment_url,is_own,commented_at,received_at,status,classification,draft,draft_reason,final_text,edited,reply_external_id,sent_at,note,error,stance,objection,author_crm,author_verified,author_followers,author_headline,author_company,author_website,author_profile_url,author_enriched_at,reclassified_from,lesson_set,linked,attachments";

/** Joins rows to the calendar item they comment on: by Zernio post id, else by the post's permalink. */
async function withContentItems(db: SupabaseClient, rows: CommentRow[]) {
  const zids = [...new Set(rows.map((r) => r.zernio_post_id).filter(Boolean))] as string[];
  const links = [...new Set(rows.filter((r) => !r.zernio_post_id && r.permalink).map((r) => r.permalink!))];
  const byZid = new Map<string, string>();
  const byLink = new Map<string, string>();
  if (zids.length) {
    for (const i of must(await db.from("gtm_content_items").select("id,zernio_post_id").in("zernio_post_id", zids), "content items") as { id: string; zernio_post_id: string }[]) byZid.set(i.zernio_post_id, i.id);
  }
  if (links.length) {
    for (const m of must(await db.from("gtm_post_metrics_latest").select("content_item_id,platform_post_url").in("platform_post_url", links), "post metrics") as { content_item_id: string | null; platform_post_url: string }[]) {
      if (m.content_item_id) byLink.set(m.platform_post_url, m.content_item_id);
    }
  }
  return rows.map((r) => ({ ...r, content_item_id: (r.zernio_post_id && byZid.get(r.zernio_post_id)) || (r.permalink && byLink.get(r.permalink)) || null }));
}

/**
 * Inserts rows that are not stored yet; a row already in the table keeps its status, draft and John's
 * decision (the same comment arrives by webhook, by poll and on every replay). Returns how many were new.
 */
export async function upsertComments(db: SupabaseClient, rows: CommentRow[]): Promise<{ inserted: number; seen: number }> {
  const unique = [...new Map(rows.map((r) => [`${r.platform}|${r.kind}|${r.external_id}`, r])).values()];
  if (!unique.length) return { inserted: 0, seen: 0 };
  const joined = await withContentItems(db, unique);
  let inserted = 0;
  for (let i = 0; i < joined.length; i += 200) {
    const data = must(await db.from("gtm_comments").upsert(joined.slice(i, i + 200), { onConflict: "platform,kind,external_id", ignoreDuplicates: true }).select("id"), "store comments");
    inserted += (data ?? []).length;
  }
  // A DM stored before attachments were kept (or by a path that did not carry them) gets them now. One read finds the
  // few that lack them, so a big poll is not a write per DM.
  const withMedia = joined.filter((r) => r.kind === "dm" && r.attachments?.length);
  for (let i = 0; i < withMedia.length; i += 200) {
    const chunk = withMedia.slice(i, i + 200);
    const bare = must(await db.from("gtm_comments").select("platform,external_id").eq("kind", "dm").is("attachments", null).in("external_id", chunk.map((r) => r.external_id)), "dms without attachments") as { platform: string; external_id: string }[];
    for (const b of bare) {
      const r = chunk.find((c) => c.platform === b.platform && c.external_id === b.external_id);
      if (r) must(await db.from("gtm_comments").update({ attachments: r.attachments }).eq("platform", r.platform).eq("kind", "dm").eq("external_id", r.external_id).is("attachments", null), "store attachments");
    }
  }
  return { inserted, seen: unique.length };
}

/**
 * Rows still waiting for John. `failed` is one: the card stays retryable, and an edited retry carries a
 * new idempotency key, so a failed row John has since answered natively (or whose first send went out
 * despite the error) must leave the queue or a retry would post twice.
 */
const OPEN = ["new", "drafted", "failed"];

/**
 * The insert above never touches a stored row, so what the poll learns later must be applied here, and
 * only to rows still waiting for John: a comment that turns out to be ours becomes is_own (out of the
 * queue and the counts), and one John has since answered on the platform is skipped, so he is never asked
 * to reply twice. Conditional on the open statuses: a decision John already made is left alone.
 */
export async function repairFromPoll(db: SupabaseClient, rows: CommentRow[]): Promise<{ own: number; answered: number }> {
  const out = { own: 0, answered: 0 };
  const groups = new Map<string, { platform: string; kind: string; own: string[]; answered: string[] }>();
  for (const r of rows) {
    const g = groups.get(`${r.platform}|${r.kind}`) ?? { platform: r.platform, kind: r.kind, own: [], answered: [] };
    if (r.is_own) g.own.push(r.external_id);
    else if (r.status === "skipped" && r.note === ANSWERED) g.answered.push(r.external_id);
    groups.set(`${r.platform}|${r.kind}`, g);
  }
  const now = () => new Date().toISOString();
  for (const g of groups.values()) {
    for (let i = 0; i < g.own.length; i += 200) {
      const ids = g.own.slice(i, i + 200);
      // is_own is a fact about the author whatever the status; the status only moves while still open.
      must(await db.from("gtm_comments").update({ is_own: true, updated_at: now() }).eq("platform", g.platform).eq("kind", g.kind).in("external_id", ids).eq("is_own", false).not("status", "in", `(${OPEN.join(",")})`), "mark own");
      out.own += (must(await db.from("gtm_comments").update({ is_own: true, status: "skipped", note: "our own comment or reply", updated_at: now() })
        .eq("platform", g.platform).eq("kind", g.kind).in("external_id", ids).in("status", OPEN).select("id"), "skip own") ?? []).length;
    }
    for (let i = 0; i < g.answered.length; i += 200) {
      out.answered += (must(await db.from("gtm_comments").update({ status: "skipped", note: ANSWERED, updated_at: now() })
        .eq("platform", g.platform).eq("kind", g.kind).in("external_id", g.answered.slice(i, i + 200)).in("status", OPEN).select("id"), "skip answered") ?? []).length;
    }
  }
  return out;
}

/**
 * True when `row` is the echo of the reply we are sending or just sent: Meta can echo it back as a new
 * comment before reply_external_id is written. Text alone is not enough (a stranger's "Agreed." under
 * another thread would vanish from the queue), so the echo must also be a reply under the same comment
 * our reply went to, and must not be by the person we answered (when both author ids are known).
 */
export async function isOurRecentReply(db: SupabaseClient, row: Pick<CommentRow, "platform" | "text" | "parent_external_id" | "author_id">): Promise<boolean> {
  const text = row.text.trim();
  if (!text || !row.parent_external_id) return false;
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const rows = must(await db.from("gtm_comments").select("external_id,parent_external_id,author_id").eq("platform", row.platform).in("status", ["approved", "sent"])
    .eq("final_text", text).gte("updated_at", since).limit(50), "recent replies") as Pick<CommentRow, "external_id" | "parent_external_id" | "author_id">[];
  return rows.some((r) => replyCommentId(r) === row.parent_external_id && !(r.author_id && row.author_id && r.author_id === row.author_id));
}

/** Platform ids of replies we sent: Meta re-delivers each one as a new comment, which must be skipped. */
export async function sentReplyIds(db: SupabaseClient): Promise<Set<string>> {
  const rows = must(await db.from("gtm_comments").select("reply_external_id").not("reply_external_id", "is", null).gte("sent_at", new Date(Date.now() - 60 * 86400_000).toISOString()), "sent replies") as { reply_external_id: string }[];
  return new Set(rows.map((r) => r.reply_external_id));
}

export async function getComment(db: SupabaseClient, id: string): Promise<StoredComment | null> {
  const { data, error } = await db.from("gtm_comments").select(COMMENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`comment: ${error.message}`);
  return data as StoredComment | null;
}

export type ConversationCounts = Record<string, { comments: number; dms: number; total: number }>;

/**
 * Conversations by platform in [weekStart, weekEnd): comments and replies by other people (any source,
 * LinkedIn email intake included) plus incoming DMs. Our own comments and reply echoes never count.
 * Feeds the dashboard's Conversations tile and the weekly report (VIB-417).
 */
export async function conversationCounts(db: SupabaseClient, weekStart: string | Date, weekEnd: string | Date): Promise<ConversationCounts> {
  const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : d);
  const out: ConversationCounts = {};
  for (let from = 0; ; from += 1000) {
    const rows = must(await db.from("gtm_comments").select("platform,kind").eq("is_own", false)
      .gte("commented_at", iso(weekStart)).lt("commented_at", iso(weekEnd)).order("id").range(from, from + 999), "conversation counts") as { platform: string; kind: "comment" | "dm" }[];
    for (const r of rows) {
      const c = (out[r.platform] ??= { comments: 0, dms: 0, total: 0 });
      if (r.kind === "dm") c.dms++; else c.comments++;
      c.total++;
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** The newest incoming message time in a DM conversation (never earlier than `own`), for Meta's reply window. */
export async function latestInboundAt(db: SupabaseClient, c: { conversation_id: string | null; account_id: string | null; platform: string }, own: string | null): Promise<string | null> {
  if (!c.conversation_id) return own;
  let q = db.from("gtm_comments").select("commented_at").eq("conversation_id", c.conversation_id).eq("platform", c.platform).eq("kind", "dm").eq("is_own", false);
  if (c.account_id) q = q.eq("account_id", c.account_id);
  const rows = must(await q
    .not("commented_at", "is", null).order("commented_at", { ascending: false }).limit(1), "latest inbound") as { commented_at: string }[];
  const t = rows[0]?.commented_at;
  return t && (!own || new Date(t) > new Date(own)) ? t : own;
}
