import { loadRuntimeConfig } from "../runtime-config.mjs";
// The daily engage run (Vercel cron 23:00 UTC, 07:00 in Bali): catch every comment and DM the webhook
// missed, draft replies for the new ones, and email John "N replies to approve". Also `gtm engage run`.
import { unresolvedFlags } from "./resolve";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { listCommentedPosts, postComments } from "../zernio-inbox";
import { checkDraft, draftModel, openRouterReplyWriter, stripDashes, type DraftInput, type DraftReply, type ReplyWriter } from "./draft";
import { sendEngageEmail, type DigestItem } from "./digest";
import { parsePolledComments, parseZernioEvent, type CommentRow, type OwnContext, type StoredComment } from "./parse";
import { ownContext } from "./own";
import { crmMatcher } from "./who";
import { draftGuidance, learnFromDecisions, type LessonWriter } from "./learn";
import { enrichAuthors, type ProfileReader } from "./profile";
import { firecrawlReader, linkedFor, readLinks, type Linked, type LinkedPage, type PageReader } from "./links";
import { claimAlert } from "./alerts";
import { REDFLAGS, computeFlags, redFlags, type FlagComment, type RedFlag } from "./redflags";
import { COMMENT_COLUMNS, repairFromPoll, upsertComments } from "./store";

export { ownContext };

/** Comments older than this when first drafted are skipped, not answered weeks late (first run, outages). */
export const DRAFT_MAX_AGE_DAYS = 7;

type RunError = { source: string; error: string };

/** Re-reads stored comment/message webhook events (the webhook stores every event before parsing it). */
export async function replayEvents(db: SupabaseClient, ctx: OwnContext, sinceHours = 72) {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const events = must(await db.from("gtm_zernio_events").select("event,payload").in("event", ["comment.received", "message.received"]).gte("received_at", since).limit(2000), "zernio events") as { event: string; payload: unknown }[];
  const rows = events.map((e) => parseZernioEvent(e.event, e.payload, ctx)).filter((r): r is CommentRow => r !== null);
  return { events: events.length, ...(await upsertComments(db, rows)) };
}

/** Polls Zernio's comment inbox for posts of the last `days` days and flattens every thread. */
export async function pollComments(ctx: OwnContext, opts: { days?: number; deadline?: number; maxPosts?: number } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 14) * 86400_000).toISOString();
  const errors: RunError[] = [];
  const rows: CommentRow[] = [];
  const posts = (await listCommentedPosts({ since })).slice(0, opts.maxPosts ?? 60);
  for (const p of posts) {
    if (Date.now() > (opts.deadline ?? Infinity)) { errors.push({ source: "poll", error: "time budget used up before every post was read" }); break; }
    try {
      const r = await postComments(p.id, p.accountId);
      rows.push(...parsePolledComments(p, r.comments, ctx, r.post?.text ?? null));
    } catch (e) {
      errors.push({ source: `poll ${p.platform}`, error: (e as Error).message.slice(0, 200) });
    }
  }
  return { posts: posts.length, rows, errors };
}

const threadKey = (c: Pick<StoredComment, "kind" | "platform" | "conversation_id" | "zernio_post_id" | "platform_post_id" | "comment_url">) =>
  c.kind === "dm" ? `dm|${c.conversation_id}` : `${c.platform}|${c.zernio_post_id ?? c.platform_post_id ?? c.comment_url?.replace(/\?.*$/, "")}`;

/** Drafts replies for every `new` comment, one model call per post or conversation, inside the deadline. */
export async function draftNew(db: SupabaseClient, opts: {
  write?: ReplyWriter; deadline?: number; limit?: number; dryRun?: boolean;
  /** Only this post's new comments (the webhook path classifies a fast-moving thread right away). */
  only?: { platform: string; zernio_post_id?: string | null; platform_post_id?: string | null };
  /** CRM lookup per author (lib/engage/who.ts); defaults to Twenty when TWENTY_API_KEY is set. */
  crm?: ReturnType<typeof crmMatcher>;
  /** Classify these rows instead of the queue's new ones (with dryRun: `gtm engage classify`, read-only). */
  rows?: StoredComment[];
  /** John's word on a row, by id ("not spam"): passed to the model, and it overrides a spam or skip label. */
  johnSays?: Record<string, string>;
  /** Lessons and examples from John's decisions (lib/engage/learn.ts); tests pass a fixed one. */
  guidance?: (platform: string) => Promise<Awaited<ReturnType<typeof draftGuidance>>>;
  /** Reads the pages comments link to (Firecrawl when FIRECRAWL_API_KEY is set); null turns it off. */
  read?: PageReader | null;
} = {}) {
  const cutoff = new Date(Date.now() - DRAFT_MAX_AGE_DAYS * 86400_000).toISOString();
  // The global "skip old" sweep belongs to the daily run, not to a per-post or explicit-rows call.
  if (!opts.dryRun && !opts.rows && !opts.only) {
    must(await db.from("gtm_comments").update({ status: "skipped", note: `older than ${DRAFT_MAX_AGE_DAYS} days when first seen`, updated_at: new Date().toISOString() })
      // A comment John pulled back out of spam is his explicit call: never swept as "old".
      .eq("status", "new").lt("commented_at", cutoff).is("reclassified_from", null), "skip old");
  }
  let fq = db.from("gtm_comments").select(COMMENT_COLUMNS).eq("status", "new").eq("is_own", false)
    .or(`commented_at.is.null,commented_at.gte.${cutoff}`);
  if (opts.only) {
    fq = fq.eq("platform", opts.only.platform);
    fq = opts.only.zernio_post_id ? fq.eq("zernio_post_id", opts.only.zernio_post_id) : fq.eq("platform_post_id", opts.only.platform_post_id ?? "");
  }
  const fresh = opts.rows ?? must(await fq.order("commented_at", { ascending: true }).limit(opts.limit ?? 80), "new comments") as StoredComment[];
  const crm = opts.crm ?? crmMatcher();
  const out = { drafted: 0, needs_john: 0, spam: 0, skipped: 0, errors: [] as RunError[], drafts: [] as { id: string; classification: string; reply: string; reason: string; stance?: string; objection?: string; author_crm?: string | null; linked?: Linked[] | null }[] };
  if (!fresh.length) return out;
  const write = opts.write ?? openRouterReplyWriter();
  const groups = new Map<string, StoredComment[]>();
  for (const c of fresh) groups.set(threadKey(c), [...(groups.get(threadKey(c)) ?? []), c]);
  const itemIds = [...new Set(fresh.map((c) => c.content_item_id).filter(Boolean))] as string[];
  // John's word on a row: passed in, or recorded on the row itself, so the webhook and the daily run honor a
  // "not spam" that a redraft in flight has not saved yet.
  const johnSays = (t: StoredComment) => opts.johnSays?.[t.id] ?? (t.reclassified_from === "spam" ? "this is not spam" : null);
  const guidanceCache = new Map<string, ReturnType<typeof draftGuidance>>();
  const guide = (platform: string) => {
    if (!guidanceCache.has(platform)) guidanceCache.set(platform, (opts.guidance ?? ((p: string) => draftGuidance(db, p)))(platform).catch(() => ({ lessons: [], examples: [], lesson_set: null })));
    return guidanceCache.get(platform)!;
  };
  // A dry run (`gtm engage classify`, `--dry-run`) never spends Firecrawl credits unless a reader is passed in.
  const read = opts.read === undefined ? (opts.dryRun ? null : firecrawlReader()) : opts.read;
  const readErrors = new Set<string>();
  const pageCache = new Map<string, Promise<LinkedPage | null>>();
  const bodies = new Map<string, string>();
  if (itemIds.length) for (const i of must(await db.from("gtm_content_items").select("id,body").in("id", itemIds), "post copy") as { id: string; body: string | null }[]) if (i.body) bodies.set(i.id, i.body);

  for (const [key, targets] of groups) {
    const left = (opts.deadline ?? Infinity) - Date.now();
    if (left < 8000) { out.errors.push({ source: "draft", error: `time budget used up, ${targets.length} left for the next run` }); continue; }
    const first = targets[0];
    // Context: the rest of the thread we hold, oldest first (other people's comments and John's replies).
    let q = db.from("gtm_comments").select("author_name,author_username,text,is_own,final_text,status,external_id,commented_at").eq("platform", first.platform).order("commented_at", { ascending: true }).limit(40);
    q = first.kind === "dm" ? q.eq("conversation_id", first.conversation_id!) : first.zernio_post_id ? q.eq("zernio_post_id", first.zernio_post_id) : first.platform_post_id ? q.eq("platform_post_id", first.platform_post_id) : q.eq("external_id", first.external_id);
    const thread = (must(await q, "thread") as { author_name: string | null; author_username: string | null; text: string; is_own: boolean; final_text: string | null; status: string; external_id: string }[])
      .filter((t) => !targets.some((x) => x.external_id === t.external_id))
      .flatMap((t) => [{ author: t.author_name ?? t.author_username ?? "someone", text: t.text, own: t.is_own }, ...(t.status === "sent" && t.final_text ? [{ author: loadRuntimeConfig().brand.authorLabel, text: t.final_text, own: true }] : [])]);
    const byExt = new Map(fresh.map((c) => [c.external_id, c.text]));
    const guidance = await guide(first.platform);
    // Their links, read before drafting so the reply can answer what they shared. Never at the cost of the draft.
    const pages = left > 40_000 ? await readLinks(targets, read, { cache: pageCache, timeoutMs: Math.min(25_000, left - 35_000), errors: readErrors }) : new Map<string, LinkedPage[]>();
    // Reading took time: the model call gets what is actually left now.
    const leftNow = (opts.deadline ?? Infinity) - Date.now();
    if (leftNow < 8000) { out.errors.push({ source: "draft", error: `time budget used up, ${targets.length} left for the next run` }); continue; }
    const input: DraftInput = {
      lessons: guidance.lessons, examples: guidance.examples,
      platform: first.platform,
      post: first.kind === "dm" ? "" : (first.content_item_id && bodies.get(first.content_item_id)) || first.post_preview || "",
      thread,
      targets: targets.map((t) => ({
        id: t.id, author: t.author_name ?? t.author_username ?? "someone", text: t.text, kind: t.kind,
        in_reply_to: t.parent_external_id ? byExt.get(t.parent_external_id) ?? null : null,
        about: aboutAuthor(t), john_says: johnSays(t), pages: pages.get(t.id),
      })),
    };
    try {
      // The guard runs here too, not only inside the writer: the send gate no longer checks for dashes (John may
      // type one himself), so no writer, present or future, can put an unguarded draft in front of him.
      const ids = new Set(targets.map((t) => t.id));
      const drafts = (await write(input, { timeoutMs: Math.min(90_000, leftNow - 5000) })).map((d) => checkDraft(d, ids)).filter((d): d is DraftReply => d !== null).map((d) => { const t = targets.find((x) => x.id === d.comment_id); return overruled(d, t ? johnSays(t) ?? undefined : opts.johnSays?.[d.comment_id]); });
      for (const d of drafts) {
        const target = targets.find((t) => t.id === d.comment_id);
        // Who: a yes/no from the CRM, only for people pushing back (no lookup for every "nice post").
        const pushback = d.stance && !["supportive", "question", "spam"].includes(d.stance);
        // Skipped when the budget is short (the webhook path has 120 s for a model call, Twenty and an email).
        const crmTime = (opts.deadline ?? Infinity) - Date.now() > 30_000;
        const author_crm = pushback && target && crmTime ? await crm({ name: target.author_name, username: target.author_username, platform: target.platform }) : null;
        const linked = linkedFor(pages.get(d.comment_id), d.links, stripDashes);
        out.drafts.push({ id: d.comment_id, classification: d.classification, reply: d.reply, reason: d.reason, stance: d.stance, objection: d.objection, author_crm, linked });
        if (d.classification === "needs_john") out.needs_john++;
        if (d.classification === "spam") out.spam++;
        if (d.classification === "skip") out.skipped++; else out.drafted++;
        if (opts.dryRun) continue;
        // One row that will not save (a constraint, a race) costs that row only, not the rest of the post.
        try {
          must(await db.from("gtm_comments").update({
            status: d.classification === "skip" ? "skipped" : "drafted", classification: d.classification,
            draft: d.reply || null, draft_reason: d.reason || null, draft_model: draftModel(), drafted_at: new Date().toISOString(),
            note: d.classification === "skip" ? "nothing to answer in words" : null, updated_at: new Date().toISOString(), lesson_set: guidance.lesson_set,
            ...(d.stance ? { stance: d.stance, objection: d.objection || null, stance_at: new Date().toISOString() } : {}),
            ...(author_crm ? { author_crm } : {}),
            ...(linked ? { linked } : {}),
          }).eq("id", d.comment_id).eq("status", "new"), "save draft");
        } catch (e) {
          out.errors.push({ source: `save ${d.comment_id}`, error: (e as Error).message.slice(0, 200) });
        }
      }
    } catch (e) {
      out.errors.push({ source: `draft ${key.split("|")[0]}`, error: (e as Error).message.slice(0, 200) });
    }
  }
  for (const e of readErrors) out.errors.push({ source: "links", error: `${e}: comments were drafted without their linked pages` });
  return out;
}

/** One line about who wrote a comment, from their public profile, for the drafting call. */
export function aboutAuthor(c: Pick<StoredComment, "author_headline" | "author_company" | "author_followers">): string | null {
  const parts = [c.author_headline, c.author_company && !c.author_headline?.includes(c.author_company) ? c.author_company : null,
    c.author_followers != null ? `${c.author_followers.toLocaleString("en-US")} followers` : null].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/**
 * John overruled the label ("not spam"): the model's spam or skip label cannot stand, and a spam stance goes
 * with it. With no usable reply the card gets a [JOHN: ...] slot rather than an empty box.
 */
export function overruled(d: DraftReply, johnSays: string | undefined): DraftReply {
  if (!johnSays || (d.classification !== "spam" && d.classification !== "skip")) return d;
  const { stance, objection, ...rest } = d;
  return {
    ...rest, ...(stance && stance !== "spam" ? { stance, objection } : {}),
    classification: "needs_john", reply: d.reply || "[JOHN: write the reply]",
    reason: [`John: ${johnSays}`, d.reason ? `the model still read it as ${d.classification}: ${d.reason}` : ""].filter(Boolean).join(" · ").slice(0, 1000),
  };
}

async function finishRun(db: SupabaseClient, id: string, stats: Record<string, unknown>, errors: RunError[]) {
  await db.from("gtm_comment_runs").update({ finished_at: new Date().toISOString(), stats, errors }).eq("id", id);
}

/** Everything awaiting John, for the email. */
async function awaiting(db: SupabaseClient): Promise<DigestItem[]> {
  const rows = must(await db.from("gtm_comments").select("platform,author_name,author_username,text,classification").eq("status", "drafted").order("commented_at", { ascending: false }).limit(200), "awaiting") as { platform: string; author_name: string | null; author_username: string | null; text: string; classification: string | null }[];
  return rows.map((r) => ({ platform: r.platform, author: r.author_name ?? r.author_username ?? "someone", text: r.text, classification: r.classification }));
}

export async function runEngage(db: SupabaseClient, opts: { dryRun?: boolean; to?: string; deadline?: number; write?: ReplyWriter; learn?: LessonWriter | null; profiles?: ProfileReader | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Infinity;
  const run = opts.dryRun ? null : (await db.from("gtm_comment_runs").insert({ kind: "daily" }).select("id").single()).data;
  const errors: RunError[] = [];
  const ctx = await ownContext(db);
  const stats: Record<string, unknown> = {};

  try {
    if (!opts.dryRun) {
      const replay = await replayEvents(db, ctx);
      Object.assign(stats, { events_replayed: replay.events, from_events: replay.inserted });
    }
    // Polling stops starting new posts at 40% of the budget so drafting keeps most of it.
    const pollDeadline = Number.isFinite(deadline) ? now.getTime() + (deadline - now.getTime()) * 0.4 : Infinity;
    const poll = await pollComments(ctx, { deadline: pollDeadline }).catch((e) => ({ posts: 0, rows: [] as CommentRow[], errors: [{ source: "poll", error: (e as Error).message.slice(0, 200) }] }));
    errors.push(...poll.errors);
    stats.posts_polled = poll.posts;
    stats.comments_seen = poll.rows.length;
    if (opts.dryRun) {
      const ext = poll.rows.map((r) => r.external_id);
      const known = new Set(ext.length ? (must(await db.from("gtm_comments").select("external_id").in("external_id", ext.slice(0, 500)), "known") as { external_id: string }[]).map((r) => r.external_id) : []);
      const fresh = poll.rows.filter((r) => !known.has(r.external_id));
      Object.assign(stats, { would_insert: fresh.length, would_queue: fresh.filter((r) => r.status === "new").length });
      return { stats, errors, drafts: [], sent: null };
    }
    stats.from_poll = (await upsertComments(db, poll.rows)).inserted;
    const repaired = await repairFromPoll(db, poll.rows);
    Object.assign(stats, { repaired_own: repaired.own, repaired_answered: repaired.answered });

    // Who they are (photo, followers, headline, website), before drafting so the draft can use it. Capped at
    // 25% of the budget, in small batches; what is left is read on the next run.
    const enrichDeadline = Number.isFinite(deadline) ? Date.now() + (deadline - Date.now()) * 0.25 : Infinity;
    try {
      const e = await enrichAuthors(db, { read: opts.profiles, deadline: enrichDeadline });
      errors.push(...e.errors);
      Object.assign(stats, { profiles_read: e.read, profiles_reused: e.reused, profiles_missing: e.missing });
    } catch (e) {
      errors.push({ source: "profiles", error: (e as Error).message.slice(0, 200) });
    }
    // Learn from what John sent, edited, skipped and corrected since the last run, so today's drafts use it.
    if (opts.learn !== null) {
      try {
        const l = await learnFromDecisions(db, { write: opts.learn, deadline: Number.isFinite(deadline) ? Date.now() + (deadline - Date.now()) * 0.4 : undefined });
        Object.assign(stats, { learn_signals: l.signals, lessons_added: l.added.length, lessons_retired: l.retired.length });
      } catch (e) {
        errors.push({ source: "learn", error: (e as Error).message.slice(0, 200) });
      }
    }
    const d = await draftNew(db, { write: opts.write, deadline });
    errors.push(...d.errors);
    Object.assign(stats, { drafted: d.drafted, needs_john: d.needs_john, spam: d.spam, auto_skipped: d.skipped });

    const items = await awaiting(db);
    stats.awaiting = items.length;
    // Red flags over the last window (VIB-424).
    let flags: RedFlag[] = [];
    try {
      const all = await redFlags(db, new Date(now.getTime() - REDFLAGS.window_days * 86400_000), new Date(now.getTime() + 60_000));
      // Same as /engage: if the resolutions read fails, show every flag rather than none.
      flags = await unresolvedFlags(db, all).catch(() => all);
    } catch (e) {
      errors.push({ source: "red flags", error: (e as Error).message.slice(0, 200) });
    }
    stats.red_flags = flags.length;
    let sent: { id: string | null } | null = null;
    if (items.length || flags.length) {
      const date = new Intl.DateTimeFormat("en-US", { timeZone: process.env.SIGNALS_DIGEST_TZ ?? "Asia/Makassar", weekday: "short", month: "short", day: "numeric" }).format(now);
      try {
        sent = await sendEngageEmail(items, { to: opts.to ?? process.env.ENGAGE_DIGEST_TO ?? process.env.SIGNALS_DIGEST_TO ?? loadRuntimeConfig().mail.notify, cockpitUrl: process.env.GTM_COCKPIT_URL ?? "http://localhost:3000", date, flags });
        stats.email_id = sent.id;
      } catch (e) {
        errors.push({ source: "email", error: (e as Error).message.slice(0, 200) });
      }
    }
    // Only once John has the email do its backlash flags count as alerted (so the next webhook does not send
    // a second email about the same post). A failed send claims nothing: the webhook alert stays live.
    if (sent) {
      for (const f of flags) if ((REDFLAGS.alert.flags as string[]).includes(f.flag)) {
        await claimAlert(db, f, { via: "daily", email_id: sent.id ?? "sent" }).catch((e) => errors.push({ source: "red flag claim", error: (e as Error).message.slice(0, 200) }));
      }
    }
    return { stats, errors, drafts: d.drafts, sent };
  } finally {
    if (run) await finishRun(db, run.id, stats, errors);
  }
}

/** The columns that exist before the VIB-424 migration, so a read-only dry run works against production first. */
const BASE_COLUMNS = "id,kind,source,platform,account_id,zernio_post_id,platform_post_id,content_item_id,external_id,parent_external_id,conversation_id,author_id,author_username,author_name,author_picture,text,post_preview,permalink,comment_url,is_own,commented_at,received_at,status,classification,draft,draft_reason,final_text,edited,reply_external_id,sent_at,note,error";

/**
 * Read-only: classifies the stance of every comment by other people in the last `days` days with the same
 * model call drafting uses, then computes the red flags from the result. Writes nothing and sends nothing.
 */
export async function classifyDryRun(db: SupabaseClient, opts: { days?: number; write?: ReplyWriter; crm?: ReturnType<typeof crmMatcher> } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 14) * 86400_000).toISOString();
  const rows = must(await db.from("gtm_comments").select(BASE_COLUMNS).eq("is_own", false).eq("kind", "comment").gte("commented_at", since).order("commented_at").limit(300), "comments") as StoredComment[];
  const d = await draftNew(db, { rows, dryRun: true, write: opts.write, crm: opts.crm });
  const byId = new Map(d.drafts.map((x) => [x.id, x]));
  const classified: FlagComment[] = rows.map((r) => ({
    ...r, author_followers: null, author_verified: null,
    stance: (byId.get(r.id)?.stance ?? null) as FlagComment["stance"], objection: byId.get(r.id)?.objection || null,
    author_crm: (byId.get(r.id)?.author_crm ?? null) as FlagComment["author_crm"],
  }));
  return { comments: rows.length, drafts: d.drafts, errors: d.errors, flags: computeFlags(classified) };
}
