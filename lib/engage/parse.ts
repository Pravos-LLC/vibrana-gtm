// Turns what Zernio sends (comment.received and message.received webhooks, the daily comment poll) into
// gtm_comments rows. Pure: no network, no database. Our own comments and the echoes of replies we sent
// are kept but marked is_own and skipped, so they never reach the queue and never count as conversation.
import type { ZComment, ZCommentedPost } from "../zernio-inbox";

export type CommentSource = "webhook" | "poll" | "email";
export type CommentKind = "comment" | "dm";
export type CommentStatus = "new" | "drafted" | "approved" | "sent" | "skipped" | "hidden" | "failed";
export type Classification = "reply" | "needs_john" | "spam" | "skip";

/** A row as written to gtm_comments (insert shape). */
export type CommentRow = {
  kind: CommentKind; source: CommentSource; platform: string; account_id: string | null;
  zernio_post_id: string | null; platform_post_id: string | null; external_id: string;
  parent_external_id: string | null; conversation_id: string | null;
  author_id: string | null; author_username: string | null; author_name: string | null; author_picture: string | null;
  text: string; post_preview: string | null; permalink: string | null; comment_url: string | null;
  is_own: boolean; commented_at: string | null; status: CommentStatus; note: string | null;
  /** Only what Zernio already sends with the comment (Instagram's instagramProfile, X's verifiedType). Never scraped. */
  author_followers: number | null; author_verified: boolean | null;
  /** DMs only: what came with the message besides text. Null when there was nothing (or for a comment). */
  attachments?: Attachment[] | null;
};

/**
 * One DM attachment, in message order. No URL is kept: Instagram and Facebook sign media links and expire them,
 * so the cockpit asks Zernio for a live one each time (app/api/engage/attachment). `index` is its position.
 */
export type Attachment = { type: string; original_type: string | null; mime: string | null; name: string | null; message_id: string };

export const STANCES = ["supportive", "question", "constructive_dissent", "misread", "hostile", "troll_or_bad_faith", "spam"] as const;
export type Stance = (typeof STANCES)[number];
export type CrmMatch = "none" | "contact" | "icp";

/** A gtm_comments row as read back. */
export type StoredComment = CommentRow & {
  id: string; content_item_id: string | null; received_at: string; classification: Classification | null;
  draft: string | null; draft_reason: string | null; final_text: string | null; edited: boolean;
  reply_external_id: string | null; sent_at: string | null; error: string | null;
  stance?: Stance | null; objection?: string | null; author_crm?: CrmMatch | null;
  author_headline?: string | null; author_company?: string | null; author_website?: string | null; author_profile_url?: string | null;
  author_enriched_at?: string | null; reclassified_from?: Classification | null; lesson_set?: string | null;
  /** What the comment linked to, summarized by the drafting run (lib/engage/links.ts). */
  linked?: { url: string; title: string | null; summary: string }[] | null;
};

type Profile = { followerCount?: number | null; isVerified?: boolean | null } | undefined;
const followers = (p: Profile) => (typeof p?.followerCount === "number" && p.followerCount >= 0 ? Math.round(p.followerCount) : null);
const verified = (p: Profile) => (typeof p?.isVerified === "boolean" ? p.isVerified : null);

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const url = (v: unknown): string | null => { const s = str(v); return s && /^https?:\/\//.test(s) ? s : null; };
const clip = (s: string | null, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ZERNIO_ID = /^[0-9a-f]{24}$/;

export type OwnContext = {
  /** Platform comment ids of replies we sent (Meta re-delivers them as new comments). */
  sentReplyIds?: Set<string>;
  /** Our own handles per platform, lowercased (e.g. instagram: "sample_author"). */
  ownHandles?: Map<string, Set<string>>;
};

/** True for a comment by the connected account itself, or the echo of a reply we sent. */
export function isOwnComment(c: { platform: string; external_id: string; author_username: string | null; author_name?: string | null }, explicit: boolean | undefined, ctx: OwnContext = {}): boolean {
  if (explicit === true) return true;
  if (ctx.sentReplyIds?.has(c.external_id)) return true;
  const handles = ctx.ownHandles?.get(c.platform);
  const who = [c.author_username, c.author_name].filter(Boolean).map((s) => s!.toLowerCase().replace(/^@/, ""));
  return Boolean(handles && who.some((w) => handles.has(w)));
}

/** The note on a comment our account already answered on the platform (the repair update keys on it). */
export const ANSWERED = "already answered on the platform";

/** Only emoji, punctuation or whitespace: nothing to answer in words (it stays visible under Skipped). */
export function isEmojiOnly(text: string): boolean {
  return text.trim().length > 0 && !/[\p{L}\p{N}]/u.test(text);
}

/** The status a freshly ingested row starts in, with the reason when it is skipped outright. */
function initialStatus(text: string, own: boolean): { status: CommentStatus; note: string | null } {
  if (own) return { status: "skipped", note: "our own comment or reply" };
  if (!text.trim()) return { status: "skipped", note: "no text" };
  if (isEmojiOnly(text)) return { status: "skipped", note: "emoji only" };
  return { status: "new", note: null };
}

type WebhookComment = {
  event?: string;
  comment?: {
    id?: string; postId?: string | null; platformPostId?: string; platform?: string; text?: string; createdAt?: string;
    isReply?: boolean; parentCommentId?: string | null;
    author?: { id?: string; username?: string; name?: string; picture?: string | null; isOwnAccount?: boolean; instagramProfile?: Profile };
  };
  post?: { id?: string | null; platformPostId?: string; content?: string | null; permalink?: string | null };
  account?: { id?: string; accountId?: string; platform?: string; username?: string };
};

/** comment.received → a row, or null when the payload is not a usable comment. */
export function parseCommentEvent(payload: unknown, ctx: OwnContext = {}): CommentRow | null {
  const p = (payload ?? {}) as WebhookComment;
  const c = p.comment;
  const external = str(c?.id);
  const platform = str(c?.platform) ?? str(p.account?.platform);
  if (!c || !external || !platform) return null;
  const text = typeof c.text === "string" ? c.text : "";
  const zernioPost = str(c.postId) ?? str(p.post?.id);
  const base = {
    platform: platform.toLowerCase(), external_id: external,
    author_username: str(c.author?.username), author_name: str(c.author?.name),
  };
  // Our own account's handle is in the payload: a comment by it is ours even when isOwnAccount is absent.
  const handles = new Map(ctx.ownHandles ?? []);
  const own = str(p.account?.username);
  if (own) handles.set(base.platform, new Set([...(handles.get(base.platform) ?? []), own.toLowerCase()]));
  const isOwn = isOwnComment(base, c.author?.isOwnAccount, { ...ctx, ownHandles: handles });
  return {
    kind: "comment", source: "webhook", ...base,
    account_id: str(p.account?.accountId) ?? str(p.account?.id),
    zernio_post_id: zernioPost && ZERNIO_ID.test(zernioPost) ? zernioPost : null,
    platform_post_id: str(c.platformPostId) ?? str(p.post?.platformPostId),
    parent_external_id: c.isReply ? str(c.parentCommentId) : null,
    conversation_id: null,
    author_id: str(c.author?.id), author_picture: url(c.author?.picture),
    text, post_preview: clip(str(p.post?.content), 2000), permalink: url(p.post?.permalink), comment_url: null,
    is_own: isOwn, commented_at: str(c.createdAt), ...initialStatus(text, isOwn),
    author_followers: followers(c.author?.instagramProfile), author_verified: verified(c.author?.instagramProfile),
  };
}

const ATTACHMENT_TYPES = new Set(["image", "video", "audio", "file", "sticker", "share", "template", "unsupported_type"]);
const MAX_ATTACHMENTS = 10;

/** The attachments of a message.received payload, trimmed to what the card needs (see Attachment). */
export function parseAttachments(list: unknown, messageId: string | null): Attachment[] | null {
  if (!Array.isArray(list) || !messageId) return null;
  const out = list.slice(0, MAX_ATTACHMENTS).map((raw): Attachment => {
    const a = (raw ?? {}) as { type?: unknown; originalType?: unknown; mimeType?: unknown; filename?: unknown };
    const type = typeof a.type === "string" && ATTACHMENT_TYPES.has(a.type) ? a.type : "file";
    return { type, original_type: str(a.originalType)?.slice(0, 40) ?? null, mime: str(a.mimeType)?.slice(0, 100) ?? null, name: str(a.filename)?.slice(0, 200) ?? null, message_id: messageId };
  });
  return out.length ? out : null;
}

type WebhookMessage = {
  message?: {
    id?: string; conversationId?: string; platform?: string; platformMessageId?: string; direction?: string; text?: string | null;
    attachments?: unknown[]; sentAt?: string;
    sender?: { id?: string; name?: string; username?: string; picture?: string; instagramProfile?: Profile };
  };
  conversation?: { id?: string };
  account?: { id?: string; accountId?: string; platform?: string; username?: string };
};

/** message.received → a DM row (incoming only), or null. */
export function parseMessageEvent(payload: unknown): CommentRow | null {
  const p = (payload ?? {}) as WebhookMessage;
  const m = p.message;
  const external = str(m?.id) ?? str(m?.platformMessageId);
  const conversation = str(m?.conversationId) ?? str(p.conversation?.id);
  const platform = str(m?.platform) ?? str(p.account?.platform);
  if (!m || !external || !conversation || !platform) return null;
  const own = m.direction === "outgoing";
  const text = typeof m.text === "string" ? m.text : m.attachments?.length ? "(attachment)" : "";
  return {
    kind: "dm", source: "webhook", platform: platform.toLowerCase(),
    account_id: str(p.account?.accountId) ?? str(p.account?.id),
    zernio_post_id: null, platform_post_id: null, external_id: external, parent_external_id: null, conversation_id: conversation,
    author_id: str(m.sender?.id), author_username: str(m.sender?.username), author_name: str(m.sender?.name), author_picture: url(m.sender?.picture),
    text, post_preview: null, permalink: null, comment_url: null,
    is_own: own, commented_at: str(m.sentAt), ...initialStatus(text === "(attachment)" ? "x" : text, own),
    author_followers: followers(m.sender?.instagramProfile), author_verified: verified(m.sender?.instagramProfile),
    // Zernio's attachment endpoint is addressed by the platform's message id, which the webhook carries.
    attachments: parseAttachments(m.attachments, str(m.platformMessageId) ?? external),
  };
}

/** Routes a stored Zernio webhook event to the right parser. */
export function parseZernioEvent(event: string, payload: unknown, ctx: OwnContext = {}): CommentRow | null {
  if (event === "comment.received") return parseCommentEvent(payload, ctx);
  if (event === "message.received") return parseMessageEvent(payload);
  return null;
}

/**
 * One polled post's comments, flattened (replies keep their parent). A top-level comment that our own
 * account already answered on the platform starts as skipped, so John is not asked to reply twice.
 */
export function parsePolledComments(post: ZCommentedPost, comments: ZComment[], ctx: OwnContext = {}, postText?: string | null): CommentRow[] {
  const rows: CommentRow[] = [];
  const handles = new Map(ctx.ownHandles ?? []);
  if (post.accountUsername) handles.set(post.platform, new Set([...(handles.get(post.platform) ?? []), post.accountUsername.toLowerCase()]));
  const own = { ...ctx, ownHandles: handles };
  const visit = (c: ZComment, parent: string | null) => {
    if (!c.id) return;
    const base = { platform: post.platform.toLowerCase(), external_id: c.id, author_username: str(c.from?.username), author_name: str(c.from?.name) };
    const isOwn = isOwnComment(base, c.from?.isOwner, own);
    const text = c.message ?? "";
    const start = initialStatus(text, isOwn);
    const answered = !isOwn && !parent && (c.replies ?? []).some((r) => isOwnComment({ platform: base.platform, external_id: r.id, author_username: str(r.from?.username), author_name: str(r.from?.name) }, r.from?.isOwner, own));
    rows.push({
      kind: "comment", source: "poll", ...base, account_id: post.accountId,
      zernio_post_id: ZERNIO_ID.test(post.id) ? post.id : null, platform_post_id: ZERNIO_ID.test(post.id) ? null : post.id,
      parent_external_id: parent ?? str(c.parentId), conversation_id: null,
      author_id: str(c.from?.id), author_picture: url(c.from?.picture),
      text, post_preview: clip(str(postText) ?? str(post.content), 2000), permalink: url(post.permalink), comment_url: url(c.url),
      is_own: isOwn, commented_at: str(c.createdTime),
      ...(answered && start.status === "new" ? { status: "skipped" as const, note: ANSWERED } : start),
      author_followers: null,
      author_verified: c.from?.verifiedType ? c.from.verifiedType !== "none" : null,
    });
    for (const r of c.replies ?? []) visit(r, c.id);
  };
  for (const c of comments) visit(c, null);
  return rows;
}

/** Where a reply goes: Zernio post id when known, else the platform's. */
export function replyTarget(row: Pick<CommentRow, "zernio_post_id" | "platform_post_id">): string | null {
  return row.zernio_post_id ?? row.platform_post_id;
}

/**
 * The comment to reply under. Instagram and YouTube only thread one level deep, so a reply to a reply
 * goes under its top-level parent.
 */
export function replyCommentId(row: Pick<CommentRow, "external_id" | "parent_external_id">): string {
  return row.parent_external_id ?? row.external_id;
}
