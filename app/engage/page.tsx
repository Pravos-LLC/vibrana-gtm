import Link from "next/link";
import { Shell } from "@/components/shell";
import { CommentCard, type EngageCard } from "@/components/engage/comment-card";
import { RedFlags } from "@/components/engage/red-flags";
import { EngageLearning } from "@/components/engage/learning";
import { REDFLAGS, redFlags, type RedFlag } from "@/lib/engage/redflags";
import { Card } from "@/components/ui/card";
import { canHide, replyMode } from "@/lib/engage/actions";
import type { StoredComment } from "@/lib/engage/parse";
import { COMMENT_COLUMNS } from "@/lib/engage/store";
import { unresolvedFlags } from "@/lib/engage/resolve";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// "Not spam" redrafts inside the server action (one model call), and "Learn now" runs a learning pass.
export const maxDuration = 90;

// The daily comment-reply queue: drafted each morning at 07:00 Bali, cleared here in a few minutes.
const VIEWS = {
  queue: { label: "To answer", statuses: ["new", "drafted", "failed", "approved"] },
  done: { label: "Sent", statuses: ["sent", "hidden"] },
  skipped: { label: "Skipped", statuses: ["skipped"] },
} as const;
type View = keyof typeof VIEWS;

const ago = (iso: string | null) => {
  if (!iso) return "unknown time";
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

function toCard(c: StoredComment): EngageCard {
  return {
    id: c.id, platform: c.platform, kind: c.kind, author: c.author_name ?? c.author_username ?? "Someone", handle: c.author_username,
    when: ago(c.commented_at ?? c.received_at), text: c.text, isReply: Boolean(c.parent_external_id),
    postPreview: c.post_preview, postUrl: c.permalink ?? c.comment_url, commentUrl: c.comment_url,
    draft: c.draft ?? "", classification: c.classification, reason: c.draft_reason, note: c.note,
    status: c.status, mode: replyMode(c), canHide: canHide(c), error: c.error, finalText: c.final_text, edited: c.edited,
    stance: c.stance ?? null, objection: c.objection ?? null,
    picture: c.author_picture, followers: c.author_followers, headline: c.author_headline ?? null, company: c.author_company ?? null,
    website: c.author_website ?? null, profileUrl: c.author_profile_url ?? (c.platform === "linkedin" && c.author_username ? `https://www.linkedin.com/in/${encodeURIComponent(c.author_username)}/` : null),
    reclassified: c.reclassified_from === "spam", linked: c.linked ?? null, attachments: c.attachments ?? null,
  };
}

/** `platform|post id` (the red-flag post key) to a filter on that post's comments. */
function postFilter(key: string | undefined) {
  const m = key ? /^([a-z]{1,20})\|(.+)$/.exec(key) : null;
  if (!m) return null;
  return { platform: m[1], id: m[2], zernio: /^[0-9a-f]{24}$/.test(m[2]) };
}

export const metadata = { title: "Engage" };

export default async function EngagePage({ searchParams }: { searchParams: Promise<{ view?: string; post?: string }> }) {
  const raw = await searchParams;
  const learning = raw.view === "learning";
  const view: View = raw.view && Object.hasOwn(VIEWS, raw.view) ? (raw.view as View) : "queue";
  const post = postFilter(raw.post);
  const db = await sessionDb();
  // One post's whole thread (from a red flag), whatever each comment's status; else the chosen view.
  let list = db.from("gtm_comments").select(COMMENT_COLUMNS).eq("is_own", false);
  list = post ? list.eq("platform", post.platform).eq(post.zernio ? "zernio_post_id" : "platform_post_id", post.id).eq("kind", "comment") : list.in("status", [...VIEWS[view].statuses]);
  // A failure reading resolutions shows every flag rather than none: an unresolved flag is noise, a hidden pile-on is not.
  const flagsP: Promise<RedFlag[]> = redFlags(db, new Date(Date.now() - REDFLAGS.window_days * 86400_000), new Date(Date.now() + 60_000)).then(async (f) => { try { return await unresolvedFlags(db, f); } catch { return f; } }).catch(() => []);
  const [{ data, error }, { data: runs }, { count }, flags] = await Promise.all([
    list.order(view === "queue" || post ? "commented_at" : "updated_at", { ascending: view === "queue" || Boolean(post), nullsFirst: false }).limit(view === "queue" || post ? 100 : 50),
    db.from("gtm_comment_runs").select("kind,started_at,finished_at,stats,errors").order("started_at", { ascending: false }).limit(10),
    db.from("gtm_comments").select("id", { count: "exact", head: true }).in("status", [...VIEWS.queue.statuses]).eq("is_own", false),
    flagsP,
  ]);
  const rows = (data ?? []) as StoredComment[];
  // Spam and needs-John cards go last in the queue: the quick approvals come first.
  const rank = (c: StoredComment) => (c.classification === "spam" ? 2 : c.classification === "needs_john" ? 1 : 0);
  const cards = (view === "queue" && !post ? [...rows].sort((a, b) => rank(a) - rank(b)) : rows).map(toCard);
  const latest = (kind: string) => (runs ?? []).find((r) => r.kind === kind) as { started_at: string; finished_at: string | null; stats: Record<string, number>; errors: unknown[] } | undefined;
  const chip = (active: boolean) => `rounded-full border px-3 py-1.5 text-sm ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;
  const daily = latest("daily");
  const email = latest("intake_email");

  return (
    <Shell title="Engage" active="/engage" wide>
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm text-ink-2">
          Comments and DMs from other people, with a drafted reply. Approve sends it as you; nothing goes out without a tap.
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3" data-testid="engage-runs">
          <span>Drafts: {daily ? `${ago(daily.started_at)}${daily.finished_at ? "" : " (did not finish)"}, ${daily.stats.drafted ?? 0} drafted${daily.errors.length ? `, ${daily.errors.length} errors` : ""}` : "never run"}</span>
          <span>LinkedIn email: {email ? `${ago(email.started_at)}, ${email.stats.inserted ?? 0} new` : "never run"}</span>
        </div>
        <RedFlags flags={flags} active={raw.post} />
        {post && <p className="text-sm text-ink-2">All comments on one post. <Link href="/engage" className="text-violet-strong hover:underline">Back to the queue</Link></p>}
        <nav className="flex flex-wrap gap-2" aria-label="Views">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <Link key={v} href={v === "queue" ? "/engage" : `/engage?view=${v}`} className={chip(view === v && !post && !learning)} aria-current={view === v && !post && !learning ? "page" : undefined}>
              {VIEWS[v].label}{v === "queue" && count ? ` (${count})` : ""}
            </Link>
          ))}
          <Link href="/engage?view=learning" className={chip(learning)} aria-current={learning ? "page" : undefined}>Learning</Link>
        </nav>
        {learning && <EngageLearning db={db} />}
        {error && !learning && <p className="text-sm text-red-strong" role="alert">The queue could not load: {error.message}</p>}
        <div className={learning ? "hidden" : "space-y-3"} data-testid="engage-cards">
          {cards.map((c) => <CommentCard key={c.id} card={c} />)}
          {!cards.length && !error && (
            <Card glow={false} className="p-8 text-center text-ink-2" data-testid="engage-empty">
              {view === "queue"
                ? <>Nothing to answer. New comments are drafted every morning at 07:00 Bali; <code>gtm engage run</code> drafts now.</>
                : "Nothing here yet."}
            </Card>
          )}
        </div>
      </div>
    </Shell>
  );
}
