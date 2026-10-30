// Server side of the LinkedIn email intake: validates what the gog job posted and stores it as
// gtm_comments rows (source "email"). A comment Zernio already delivered for the same post is not
// stored twice: the comment URN matches, or the same text from the same person is already there.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { emailExternalId, type LinkedInEmailComment } from "./linkedin-email";
import type { CommentRow } from "./parse";
import { upsertComments } from "./store";

const s = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const link = (v: unknown) => { const u = s(v, 2000); return u && /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(u) ? u : null; };
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Validates the posted body. Throws a TypeError (a 400) on a malformed payload. */
export function emailRows(body: unknown): CommentRow[] {
  const list = (body as { comments?: unknown })?.comments;
  if (!Array.isArray(list)) throw new TypeError("expected { comments: [...] }");
  if (list.length > 200) throw new TypeError("at most 200 comments per request");
  return list.map((raw, i): CommentRow => {
    const c = raw as Partial<LinkedInEmailComment>;
    const gmail = s(c.gmail_id, 200);
    const author = s(c.author_name, 200);
    if (!gmail || !author) throw new TypeError(`comment ${i}: gmail_id and author_name are required`);
    const text = s(c.text, 10000);
    const urn = s(c.comment_urn, 500);
    const at = s(c.received_at, 40);
    return {
      kind: "comment", source: "email", platform: "linkedin", account_id: null, zernio_post_id: null,
      platform_post_id: s(c.activity_urn, 200), external_id: emailExternalId({ comment_urn: urn, gmail_id: gmail }),
      parent_external_id: null, conversation_id: null, author_id: null, author_username: null, author_name: author, author_picture: null,
      text: text ?? "", post_preview: null, permalink: link(c.post_url), comment_url: link(c.comment_url),
      is_own: false, commented_at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null,
      // Without the text there is nothing to draft from: John opens the comment and replies by hand.
      status: text ? "new" : "drafted", note: text ? null : "the email did not include the comment text: open it",
      author_followers: null, author_verified: null,
    };
  });
}

export async function intakeEmailComments(db: SupabaseClient, body: unknown) {
  const rows = emailRows(body);
  const run = (await db.from("gtm_comment_runs").insert({ kind: "intake_email" }).select("id").single()).data;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const existing = must(await db.from("gtm_comments").select("author_name,text,platform_post_id").eq("platform", "linkedin").gte("received_at", since).limit(2000), "existing linkedin") as { author_name: string | null; text: string; platform_post_id: string | null }[];
  // Same person and same text is the same comment unless both sides name a post and the posts differ
  // (the same short comment on two different posts is two comments).
  const same = (e: (typeof existing)[number], r: CommentRow) => norm(e.author_name ?? "") === norm(r.author_name ?? "") && norm(e.text) === norm(r.text)
    && (!e.platform_post_id || !r.platform_post_id || e.platform_post_id === r.platform_post_id);
  const fresh = rows.filter((r) => !r.text || !existing.some((e) => same(e, r)));
  const { inserted } = await upsertComments(db, fresh);
  const stats = { received: rows.length, inserted, duplicates: rows.length - inserted };
  if (run) await db.from("gtm_comment_runs").update({ finished_at: new Date().toISOString(), stats }).eq("id", run.id);
  return stats;
}
