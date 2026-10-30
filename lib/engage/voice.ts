// Re-measures how John actually replies (VIB-428), so the drafting rules in content/engage/reply-voice.json
// follow his real replies instead of an agent's guess. `gtm engage voice` reads every reply he wrote on his
// own posts through Zernio and prints the same numbers the file records. Nothing is stored.
import { listCommentedPosts, postComments, type ZComment } from "../zernio-inbox";
import { REPLY_VOICE } from "./draft";
import { ownHandles } from "./own";

export type OwnReply = { platform: string; at: string | null; text: string; to: string };

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const sentences = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).filter((s) => /\p{L}/u.test(s)).length;
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
const EMOJI = /\p{Extended_Pictographic}/u;

/** The numbers reply-voice.json records, for any set of John's replies. A bare link (a "link in comments") is not a reply. */
export function measureVoice(all: OwnReply[]) {
  const replies = all.filter((r) => r.text.trim() && !/^https?:\/\/\S+$/.test(r.text.trim()));
  const ws = replies.map((r) => words(r.text)).sort((a, b) => a - b);
  const count = (f: (r: OwnReply) => boolean) => replies.filter(f).length;
  const li = replies.filter((r) => r.platform === "linkedin");
  const never = REPLY_VOICE.never_used.map((p) => ({ phrase: p, uses: count((r) => r.text.toLowerCase().replace(/’/g, "'").includes(p)) })).filter((x) => x.uses);
  return {
    replies: replies.length,
    words_median: pct(ws, 0.5), words_p80: pct(ws, 0.8), words_p95: pct(ws, 0.95),
    sentences_median: pct(replies.map((r) => sentences(r.text)).sort((a, b) => a - b), 0.5),
    over_3_sentences: count((r) => sentences(r.text) > 3), over_50_words: count((r) => words(r.text) > 50),
    with_exclamation: count((r) => r.text.includes("!")), with_exclamation_when_commenter_had_none: count((r) => r.text.includes("!") && !r.to.includes("!")),
    with_emoji: count((r) => EMOJI.test(r.text)), with_emoji_on_linkedin: `${li.filter((r) => EMOJI.test(r.text)).length} of ${li.length}`,
    with_question: count((r) => r.text.includes("?")), with_dash: count((r) => /[—–]/.test(r.text)),
    with_hashtag: count((r) => /(^|\s)#[\p{L}\p{N}_]+/u.test(r.text)), with_link: count((r) => /https?:\/\/|\b[\w-]+\.(com|xyz|ai|io|network)\b/i.test(r.text)),
    /** Phrases the guard deletes as "never used" that John has now used: the guard list needs updating. */
    never_used_now_used: never,
  };
}

/** Every reply John wrote on his own posts that Zernio can still read. */
export async function ownReplies(opts: { maxPages?: number } = {}): Promise<OwnReply[]> {
  const handles = await ownHandles({ fresh: true });
  const posts = await listCommentedPosts({ maxPages: opts.maxPages ?? 40, since: "2020-01-01" });
  const out: OwnReply[] = [];
  for (const p of posts) {
    const mine = handles.get(p.platform) ?? new Set<string>();
    const isMe = (c: ZComment) => !!c.from?.isOwner || [c.from?.username, c.from?.name].some((h) => !!h && mine.has(h.toLowerCase()));
    let comments: ZComment[];
    try { ({ comments } = await postComments(p.id, p.accountId, { limit: 100 })); } catch { continue; }
    const walk = (list: ZComment[], parent: ZComment | null) => {
      for (const c of list) {
        if (isMe(c) && c.message) out.push({ platform: p.platform, at: c.createdTime ?? null, text: c.message, to: parent?.message ?? "" });
        walk(c.replies ?? [], c);
      }
    };
    walk(comments, null);
  }
  return out;
}
