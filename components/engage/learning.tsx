import type { SupabaseClient } from "@supabase/supabase-js";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { learningScore, similarity, type Lesson, type SetScore } from "@/lib/engage/learn";
import { AddLesson, LearnNow, RetireLesson } from "./learning-controls";

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const day = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));

type Pair = { id: string; platform: string; author_name: string | null; text: string; draft: string; final_text: string; sent_at: string; edited: boolean; lesson_set: string | null };

/**
 * What the drafting agent has learned from John (VIB-428): whether drafts are getting closer to what he
 * sends (per lesson set, with absolute counts), the lessons in use, rules his own replies disagree with,
 * and the latest draft-versus-sent pairs.
 */
export async function EngageLearning({ db }: { db: SupabaseClient }) {
  const [{ data: lessonRows, error }, scores, { data: pairRows }, { data: runs }] = await Promise.all([
    db.from("gtm_engage_lessons").select("id,kind,lesson,evidence,status,source,created_at").eq("status", "active").order("created_at"),
    learningScore(db).catch(() => [] as SetScore[]),
    db.from("gtm_comments").select("id,platform,author_name,text,draft,final_text,sent_at,edited,lesson_set").eq("status", "sent").eq("is_own", false)
      .not("draft", "is", null).not("final_text", "is", null).order("sent_at", { ascending: false }).limit(12),
    db.from("gtm_comment_runs").select("started_at,finished_at,stats,errors").eq("kind", "learn").order("started_at", { ascending: false }).limit(1),
  ]);
  if (error) return <p className="text-sm text-red-strong" role="alert">Lessons could not load: {error.message}</p>;
  const lessons = (lessonRows ?? []) as Lesson[];
  const pairs = (pairRows ?? []) as Pair[];
  const conflicts = lessons.filter((l) => l.kind === "rule_conflict");
  const inUse = lessons.filter((l) => l.kind !== "rule_conflict");
  const last = runs?.[0] as { started_at: string; finished_at: string | null; stats: Record<string, number>; errors: { error: string }[] } | undefined;

  return (
    <div className="space-y-4" data-testid="engage-learning">
      <p className="text-sm text-ink-2">
        Every reply you send, rewrite, skip or relabel teaches the drafts. Your latest sends go into every draft as examples right away;
        a learning run turns the patterns into lessons each morning before drafting. Nothing here changes a fixed rule: where your
        replies disagree with one, it is listed for you to decide.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-3">
        <LearnNow />
        <span>Last learning run: {last ? `${day(last.started_at)}${last.finished_at ? `, read ${last.stats.signals ?? 0} decisions` : last.errors?.length ? `, failed: ${last.errors[0].error}` : ", did not finish"}` : "never"}</span>
      </div>

      <Card glow={false} className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-ink">Are the drafts getting closer?</h2>
        {scores.some((s) => s.sent) ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="engage-learning-score">
              <thead className="text-ink-3"><tr><th className="py-1 pr-3 font-medium">Drafts written with</th><th className="pr-3 font-medium">Sent</th><th className="pr-3 font-medium">Sent as drafted</th><th className="pr-3 font-medium">Draft close to sent</th><th className="pr-3 font-medium">Skipped</th><th className="font-medium">Relabeled</th></tr></thead>
              <tbody className="text-ink-2">
                {scores.map((s) => (
                  <tr key={s.lesson_set ?? "none"} className="border-t border-line">
                    <td className="py-1.5 pr-3">{s.lesson_set ? `Lesson set ${s.lesson_set.slice(0, 6)}, from ${day(s.first)}` : "No lessons yet (baseline)"}</td>
                    <td className="pr-3 tabular-nums">{s.sent}</td>
                    <td className="pr-3 tabular-nums">{s.unedited} ({pct(s.unedited, s.sent)})</td>
                    <td className="pr-3 tabular-nums">{s.sent ? `${Math.round(100 * s.similarity)}%` : "-"}</td>
                    <td className="pr-3 tabular-nums">{s.skipped}</td>
                    <td className="tabular-nums">{s.corrected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink-3">"Close to sent": the share of words your reply kept from the draft, in order. Read it with the count beside it: a handful of sends is not a trend.</p>
          </div>
        ) : <p className="text-xs text-ink-3">No sent drafts yet in the last 90 days.</p>}
      </Card>

      {conflicts.length > 0 && (
        <Card glow={false} className="space-y-2 border-amber/40 p-4">
          <h2 className="text-sm font-semibold text-ink">Your replies disagree with a rule</h2>
          <p className="text-xs text-ink-3">The drafts follow these rules whatever the lessons say. If your way is the right one, the rule needs changing; say so and it gets changed.</p>
          <ul className="space-y-2">
            {conflicts.map((l) => <li key={l.id} className="flex items-start justify-between gap-3 text-sm text-ink"><span>{l.lesson} <span className="text-xs text-ink-3">({l.evidence.length} replies)</span></span><RetireLesson id={l.id} /></li>)}
          </ul>
        </Card>
      )}

      <Card glow={false} className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-ink">Lessons in use ({inUse.length})</h2>
        {inUse.length ? (
          <ul className="space-y-2">
            {inUse.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 text-sm text-ink">
                <span>
                  <Badge variant={l.kind === "voice" ? "default" : "info"} className="mr-2">{l.kind === "voice" ? "Voice" : "Labels"}</Badge>
                  {l.lesson}
                  <span className="ml-1 text-xs text-ink-3">{l.source === "john" ? "(yours)" : `(from ${l.evidence.length} ${l.evidence.length === 1 ? "decision" : "decisions"}, ${day(l.created_at)})`}</span>
                </span>
                <RetireLesson id={l.id} />
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-ink-3">None yet. The first learning run writes them from your sends so far.</p>}
        <AddLesson />
      </Card>

      <Card glow={false} className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-ink">Draft and what you sent</h2>
        {pairs.length ? pairs.map((p) => (
          <div key={p.id} className="space-y-1 border-t border-line pt-3 text-sm first:border-t-0 first:pt-0">
            <p className="text-xs text-ink-3">{p.author_name ?? "Someone"} on {p.platform}, {day(p.sent_at)} · {p.edited ? `${Math.round(100 * similarity(p.draft, p.final_text))}% kept` : "sent as drafted"}</p>
            <p className="line-clamp-2 text-xs text-ink-2">“{p.text}”</p>
            {p.edited && <p className="text-ink-3 line-through decoration-ink-3/40">{p.draft}</p>}
            <p className="text-ink">{p.final_text}</p>
          </div>
        )) : <p className="text-xs text-ink-3">Nothing sent from a draft yet.</p>}
      </Card>
    </div>
  );
}
