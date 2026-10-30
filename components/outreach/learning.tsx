import type { SupabaseClient } from "@supabase/supabase-js";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { learningScore, similarity, type AngleEdit, type Lesson, type SetScore } from "@/lib/outreach/learn";
import { AddLesson, LearnNow, RetireLesson } from "./learning-controls";

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const day = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
const KIND: Record<string, string> = { subject: "Subject", opening: "Opening", body: "Body", ask: "The ask", linkedin: "LinkedIn", rule_conflict: "Rule" };

/**
 * What the angle generator has learned from John's edits: whether the angles are getting closer to what he sends (per
 * lesson set, with absolute counts), the lessons in use, rules his sends disagree with, and each recent edit with what
 * the learning run observed about it.
 */
export async function OutreachLearning({ db }: { db: SupabaseClient }) {
  const [{ data: lessonRows, error }, scores, { data: editRows }, { data: runs }] = await Promise.all([
    db.from("gtm_outreach_lessons").select("id,kind,lesson,evidence,status,source,created_at").eq("status", "active").order("created_at"),
    learningScore(db).catch(() => [] as SetScore[]),
    db.from("gtm_outreach_angle_edits").select("*").order("created_at", { ascending: false }).limit(12),
    db.from("gtm_outreach_learn_runs").select("started_at,finished_at,stats,errors").order("started_at", { ascending: false }).limit(1),
  ]);
  if (error) return <p className="text-sm text-red-strong" role="alert">Lessons could not load: {error.message}</p>;
  const lessons = (lessonRows ?? []) as Lesson[];
  const edits = (editRows ?? []) as AngleEdit[];
  const conflicts = lessons.filter((l) => l.kind === "rule_conflict");
  const inUse = lessons.filter((l) => l.kind !== "rule_conflict");
  const last = runs?.[0] as { started_at: string; finished_at: string | null; stats: Record<string, number>; errors: { error: string }[] } | undefined;
  const waiting = edits.filter((e) => !e.analyzed_at).length;

  return (
    <div className="space-y-4" data-testid="outreach-learning">
      <p className="text-sm text-ink-2">
        When you mark an email or LinkedIn invite sent from a generated angle, the desk compares what it wrote with what you sent. Your latest
        edits go into every new set of angles as examples right away, and a learning run turns repeated patterns into lessons. Lessons shape
        style only: the fixed rules (no dashes, American spelling, no invented facts) always win, and where your sends disagree with one it is listed for you to decide.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-3">
        <LearnNow />
        <span>Last learning run: {last ? `${day(last.started_at)}${last.finished_at ? `, read ${last.stats.edits ?? 0} edits` : last.errors?.length ? `, failed: ${last.errors[0].error}` : ", did not finish"}` : "never"}{waiting ? ` · ${waiting} waiting` : ""}</span>
      </div>

      <Card glow={false} className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-ink">Are the angles getting closer?</h2>
        {scores.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="outreach-learning-score">
              <thead className="text-ink-3"><tr><th className="py-1 pr-3 font-medium">Angles written with</th><th className="pr-3 font-medium">Emails sent</th><th className="pr-3 font-medium">Sent unchanged</th><th className="font-medium">Generated close to sent</th></tr></thead>
              <tbody className="text-ink-2">
                {scores.map((s) => (
                  <tr key={s.lesson_set ?? "none"} className="border-t border-line">
                    <td className="py-1.5 pr-3">{s.lesson_set ? `Lesson set ${s.lesson_set.slice(0, 6)}, from ${day(s.first)}` : "No lessons yet (baseline)"}</td>
                    <td className="pr-3 tabular-nums">{s.sent}</td>
                    <td className="pr-3 tabular-nums">{s.unedited} ({pct(s.unedited, s.sent)})</td>
                    <td className="tabular-nums">{Math.round(100 * s.similarity)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink-3">&quot;Close to sent&quot;: the share of words you kept from the angle, in order, across subject and body. Read it with the count beside it: a handful of sends is not a trend.</p>
          </div>
        ) : <p className="text-xs text-ink-3">No emails sent from a generated angle yet.</p>}
      </Card>

      {conflicts.length > 0 && (
        <Card glow={false} className="space-y-2 border-amber/40 p-4">
          <h2 className="text-sm font-semibold text-ink">Your sends disagree with a rule</h2>
          <p className="text-xs text-ink-3">The angles follow these rules whatever the lessons say. If your way is right, the rule needs changing; say so and it gets changed.</p>
          <ul className="space-y-2">
            {conflicts.map((l) => <li key={l.id} className="flex items-start justify-between gap-3 text-sm text-ink"><span>{l.lesson} <span className="text-xs text-ink-3">({l.evidence.length} edits)</span></span><RetireLesson id={l.id} /></li>)}
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
                  <Badge variant="default" className="mr-2">{KIND[l.kind] ?? l.kind}</Badge>
                  {l.lesson}
                  <span className="ml-1 text-xs text-ink-3">{l.source === "john" ? "(yours)" : `(from ${l.evidence.length} edits, ${day(l.created_at)})`}</span>
                </span>
                <RetireLesson id={l.id} />
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-ink-3">None yet. A lesson needs the same change in at least two of your edits.</p>}
        <AddLesson />
      </Card>

      <Card glow={false} className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-ink">What you changed</h2>
        {edits.length ? edits.map((e) => (
          <div key={e.id} className="space-y-1 border-t border-line pt-3 text-sm first:border-t-0 first:pt-0">
            <p className="text-xs text-ink-3">{e.channel === "email" ? "Email" : "LinkedIn note"} · {e.angle_key.replace("_", " ")} · {day(e.created_at)} · {Math.round(100 * similarity(Object.values(e.generated).join(" "), Object.values(e.final).join(" ")))}% kept</p>
            {e.analyzed_at
              ? <ul className="list-disc space-y-0.5 pl-5 text-ink-2">{e.observations.map((o) => <li key={o}>{o}</li>)}</ul>
              : <p className="text-xs text-ink-3">Waiting for the learning run.</p>}
            {e.channel === "email" && e.final.subject !== e.generated.subject && <p className="text-xs text-ink-3"><span className="line-through decoration-ink-3/40">{e.generated.subject}</span> → <span className="text-ink-2">{e.final.subject}</span></p>}
          </div>
        )) : <p className="text-xs text-ink-3">Nothing sent from a generated angle yet.</p>}
      </Card>
    </div>
  );
}
