// Settings John edits on screen (phase 4 of the content-system redesign). First: the weekly rhythm, which used to be
// private guide JSON shipped through a release. A save applies at once; every version is kept below.
import { Shell } from "@/components/shell";
import { RhythmForm } from "@/components/settings/rhythm-form";
import { sessionDb } from "@/lib/supabase/server";
import { RHYTHM } from "@/lib/rhythm";
import { loadRhythm, RHYTHM_KEY, type RhythmSetting } from "@/lib/rhythm-settings";
import { resetRhythm, saveRhythm } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function Settings() {
  const db = await sessionDb();
  const { source, problems } = await loadRhythm(db, { fresh: true });
  const initial: RhythmSetting = JSON.parse(JSON.stringify({ days: RHYTHM.days, blocked: RHYTHM.blocked ?? [], rules: RHYTHM.rules, summary: RHYTHM.summary }));
  const { data: history } = await db.from("gtm_settings_history").select("id,changed_at,changed_by").eq("key", RHYTHM_KEY).order("changed_at", { ascending: false }).limit(10);
  return (
    <Shell title="Settings" active="/settings">
      <h1 className="mb-2 font-display text-pl-2xl font-semibold text-ink">Weekly rhythm</h1>
      <p className="mb-6 max-w-[62ch] text-sm text-ink-2">Which days post, what each day carries, which channels it goes to, and what a channel never takes. The calendar, the lint and the scheduler read this.</p>
      {problems.length > 0 && <p className="mb-4 text-sm text-red-strong">The saved rhythm could not be used ({problems.join(" ")}); the guide's is in place.</p>}
      <RhythmForm initial={initial} source={source} save={saveRhythm} reset={resetRhythm} />
      {(history ?? []).length > 0 && (
        <div className="mt-10">
          <h2 className="mb-2 text-sm font-medium text-ink">Saved versions</h2>
          <ul className="space-y-1 text-xs text-ink-3">
            {(history as Array<{ id: number; changed_at: string; changed_by: string | null }>).map((h) => (
              <li key={h.id}>{new Date(h.changed_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}{h.changed_by ? ` · ${h.changed_by}` : ""}</li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  );
}
