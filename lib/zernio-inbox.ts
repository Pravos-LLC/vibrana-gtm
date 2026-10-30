// Zernio inbox: comments on John's posts and DMs, for the engage queue (VIB-423).
// Docs: https://docs.zernio.com/comments/* and /messages/*. Reads are cached by Zernio for up to 10
// minutes; new comments arrive in real time through the comment.received webhook, and the daily poll
// here catches anything the webhook missed (and the platforms Zernio itself polls).
import { createHash } from "node:crypto";
import { zernio } from "./zernio";

/** Interactive sends fail fast (the card shows why) instead of hanging until the function limit. */
const SEND_TIMEOUT_MS = 30_000;

export type ZCommentedPost = {
  id: string; platform: string; accountId: string; accountUsername?: string; content?: string;
  permalink?: string | null; createdTime?: string; commentCount: number; isAd?: boolean;
};

export type ZComment = {
  id: string; message: string; createdTime?: string; platform?: string; url?: string | null;
  from?: { id?: string; name?: string; username?: string; picture?: string | null; isOwner?: boolean; verifiedType?: string | null };
  replies?: ZComment[]; parentId?: string | null; canReply?: boolean; canHide?: boolean; isHidden?: boolean;
};

/** Posts with comments across every connected account, newest first (cursor-paginated, deduped by id). */
export async function listCommentedPosts(opts: { since?: string; maxPages?: number; limit?: number } = {}) {
  const out = new Map<string, ZCommentedPost>();
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 5); page++) {
    const r = await zernio<{ data?: ZCommentedPost[]; pagination?: { hasMore?: boolean; nextCursor?: string | null }; meta?: { failedAccounts?: { platform: string; error: string }[] } }>(
      "/inbox/comments", { query: { since: opts.since, limit: opts.limit ?? 50, minComments: 1, cursor } });
    for (const p of r.data ?? []) if (!p.isAd) out.set(`${p.accountId}:${p.id}`, p);
    if (!r.pagination?.hasMore || !r.pagination.nextCursor) break;
    cursor = r.pagination.nextCursor;
  }
  return [...out.values()];
}

/** One post's comments (top level, each with its nested replies). `postId`: Zernio or platform id. */
export async function postComments(postId: string, accountId: string, opts: { limit?: number } = {}) {
  const r = await zernio<{ comments?: ZComment[]; post?: { text?: string; permalink?: string } }>(
    `/inbox/comments/${encodeURIComponent(postId)}`, { query: { accountId, limit: opts.limit ?? 100 } });
  return { comments: r.comments ?? [], post: r.post ?? null };
}

/**
 * Stable per queued comment AND per text. Zernio keeps a key 24 h: the same key with the same body replays
 * (so a retried Approve never posts twice), the same key with a different body is a 422. Hashing the text
 * in means an edited retry after a failure is a new request rather than a day-long 422.
 */
export const replyIdempotencyKey = (commentRowId: string, text: string) =>
  `gtm-reply-${commentRowId}-${createHash("sha256").update(text.trim()).digest("hex").slice(0, 12)}`;

/** Replies to a comment (or, without commentId, to the post). Returns the new comment's platform id. */
export async function replyToComment(postId: string, body: { accountId: string; message: string; commentId?: string }, idempotencyKey: string) {
  const r = await zernio<{ success?: boolean; data?: { commentId?: string } }>(`/inbox/comments/${encodeURIComponent(postId)}`, {
    method: "POST", body, headers: { "Idempotency-Key": idempotencyKey }, timeoutMs: SEND_TIMEOUT_MS,
  });
  return { commentId: r.data?.commentId ?? null };
}

/** Platforms where Zernio can hide a comment (POST .../hide). Elsewhere a spam comment is only skipped. */
export const HIDE_PLATFORMS = new Set(["facebook", "instagram", "threads", "twitter", "x", "tiktok"]);

export async function hideComment(postId: string, commentId: string, accountId: string) {
  return zernio<{ hidden?: boolean }>(`/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/hide`, {
    method: "POST", body: { accountId }, timeoutMs: SEND_TIMEOUT_MS,
  });
}

/**
 * Sends a DM in a conversation. Instagram and Facebook only allow a reply inside 24 hours of the
 * person's last message, unless the message is tagged HUMAN_AGENT (a person answering by hand, which
 * this is: John approves every send).
 */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 3600_000;

/** True when an Instagram or Facebook DM is past Meta's 7-day HUMAN_AGENT window, so only the app can answer it. */
export function dmWindowClosed(platform: string, lastInboundAt: string | null | undefined, now = Date.now()) {
  if (platform !== "instagram" && platform !== "facebook") return false;
  const t = lastInboundAt ? new Date(lastInboundAt).getTime() : NaN;
  return Number.isFinite(t) && now - t > HUMAN_AGENT_WINDOW_MS;
}

export async function sendDirectMessage(conversationId: string, body: { accountId: string; message: string; platform: string; lastInboundAt?: string | null }, idempotencyKey: string, now = Date.now()) {
  const late = !body.lastInboundAt || now - new Date(body.lastInboundAt).getTime() > 24 * 3600_000;
  const meta = body.platform === "instagram" || body.platform === "facebook";
  const payload: Record<string, unknown> = { accountId: body.accountId, message: body.message };
  if (meta && late) Object.assign(payload, { messagingType: "MESSAGE_TAG", messageTag: "HUMAN_AGENT" });
  const r = await zernio<{ success?: boolean; data?: { messageId?: string; id?: string } }>(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST", body: payload, headers: { "Idempotency-Key": idempotencyKey }, timeoutMs: SEND_TIMEOUT_MS,
  });
  return { messageId: r.data?.messageId ?? r.data?.id ?? null, payload };
}

/**
 * A DM attachment's media link that works right now. Instagram and Facebook sign these and expire them; Zernio
 * re-mints a stale one. `position` is the attachment's zero-based place in the message.
 */
export async function resolveAttachmentUrl(conversationId: string, messageId: string, position: number, accountId: string) {
  const r = await zernio<{ url?: string; data?: { url?: string } }>(
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${position}`,
    { query: { accountId, format: "json" }, timeoutMs: 15_000 });
  const url = r.url ?? r.data?.url;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

export type ZAccountHealth = {
  accountId: string; platform: string; username?: string; status?: string;
  tokenStatus?: { valid?: boolean; expiresIn?: string; needsRefresh?: boolean };
  permissions?: { canPost?: boolean; optional?: { scope: string; granted: boolean }[] };
  issues?: unknown[];
};

export async function accountHealth(accountId: string) {
  return zernio<ZAccountHealth>(`/accounts/${encodeURIComponent(accountId)}/health`);
}

export type ZWebhook = { _id: string; name?: string; url: string; events: string[]; isActive: boolean };

export async function listWebhooks() {
  return (await zernio<{ webhooks?: ZWebhook[] }>("/webhooks/settings")).webhooks ?? [];
}

export const ENGAGE_EVENTS = ["comment.received", "message.received"] as const;

/** Adds the engage events to an existing subscription (keeps every event it already has). */
export async function subscribeEngageEvents(hook: ZWebhook) {
  const events = [...new Set([...hook.events, ...ENGAGE_EVENTS])];
  return zernio(`/webhooks/settings`, { method: "PUT", body: { webhookId: hook._id, events } });
}
