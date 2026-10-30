import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight, CircleCheck, CircleDashed, Clock3 } from "lucide-react";
import { Shell } from "@/components/shell";
import { Eyebrow } from "@/components/brand";
import { SocialMark } from "@/components/guide/social-mark";
import { ChangeDecision } from "@/components/reports/change-decision";
import { Card } from "@/components/ui/card";
import { currentSeason } from "@/lib/seasons";
import { sessionDb } from "@/lib/supabase/server";
import type { Evidence, Report, Verdict } from "@/lib/reports/guard";
import type { Pack, PackPost } from "@/lib/reports/pack";
import type { ActionRow } from "@/lib/reports/actions";
import { PlaybookChips } from "@/components/reports/playbook-chips";

export const dynamic = "force-dynamic";

type ReportRow = {
  id: string; season_id: string | null; week: number; period_start: string; period_end: string; status: string;
  headline: string | null; model: string | null; input: Pack; report: Report | null;
  guard: { dropped?: { section: string; reason: string }[]; cleaned?: unknown[] }; finished_at: string | null; errors: { error: string }[];
};
type Slot = { id: string; title: string; date: string; time: string | null; format: string; status: string; pillar: string; channels: string[] };

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const UNIT: Record<string, string> = { impressions: "impressions", reach: "accounts reached", views: "views" };
const n = (x: number) => x.toLocaleString("en-US");

/** A post's headline numbers in its own platform's units: never added across platforms. */
function PostNumbers({ p }: { p: PackPost }) {
  return (
    <span className="text-ink-2">
      <span className="tabular-nums text-ink">{n(p.native_reach.value)}</span> {UNIT[p.native_reach.unit] ?? p.native_reach.unit}
      {" · "}<span className="tabular-nums text-ink">{n(p.metrics.comments)}</span> comments
      {" · "}<span className="tabular-nums text-ink">{n(p.saves_sends)}</span> saves and sends
      {p.rate && <>{" · "}<span className="tabular-nums text-ink">{p.rate.value}%</span> per {p.rate.per}</>}
      {p.stage !== "final" && <span className="ml-1 italic text-ink-3">({p.stage === "maturing" ? "◔ maturing" : "still settling"})</span>}
    </span>
  );
}

function PostLine({ p }: { p: PackPost | undefined }) {
  if (!p) return null;
  const label = p.title ?? (p.preview || "untitled");
  return (
    <span className="flex items-baseline gap-2">
      <SocialMark channel={p.platform} className="size-3.5 shrink-0 translate-y-0.5" />
      <span>
        {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-ink underline-offset-4 hover:underline">{label}</a> : <span className="font-medium text-ink">{label}</span>}
        <span className="text-ink-3"> · {day(p.published_on)}</span>
      </span>
    </span>
  );
}

function EvidenceList({ ev }: { ev: Evidence[] }) {
  if (!ev.length) return null;
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.7rem] text-ink-3" aria-label="Evidence from the cockpit's data">
      {ev.map((e) => <span key={e.fact}>{e.fact} = {e.value}</span>)}
    </p>
  );
}

/** One labeled section: a 10rem label rail, then the reading. */
function Rail({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="grid gap-3 border-t border-line py-8 md:grid-cols-[10rem_1fr] md:gap-8">
      <div>
        <h2 className="text-pl-xs font-medium uppercase tracking-[0.12em] text-ink-3">{label}</h2>
        {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
      </div>
      <div className="max-w-[62ch] space-y-5 text-pl-base leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

const VERDICT: Record<Verdict, { word: string; icon: typeof CircleCheck; tone: string }> = {
  on_track: { word: "On track", icon: CircleCheck, tone: "text-emerald-strong" },
  behind: { word: "Behind", icon: AlertTriangle, tone: "text-amber-strong" },
  too_early: { word: "Too early", icon: CircleDashed, tone: "text-ink-3" },
};

const TYPE: Record<string, string> = { move: "Move", swap: "Swap", replace: "Swap in from the reserve", new_story: "New idea slot", change_format: "Change format" };

/** The slot diff a change makes: before on the left, after on the right. */
function SlotDiff({ a, items }: { a: ActionRow; items: Map<string, Slot> }) {
  const s = a.item_id ? items.get(a.item_id) : undefined;
  const o = a.other_item_id ? items.get(a.other_item_id) : undefined;
  const row = (label: string, before: string, after: string) => (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-3 py-1">
      <span className="text-ink-3 line-through decoration-ink-3/40">{before}</span>
      <ArrowRight className="size-3.5 text-ink-3" aria-label={`${label} changes to`} />
      <span className="text-ink">{after}</span>
    </div>
  );
  const when = (x: Slot) => `${day(x.date)}${x.time ? ` ${x.time}` : ""}`;
  if (a.type === "move" && s && a.change.date) return <>{row("date", `${s.title}, ${when(s)}`, `${s.title}, ${day(a.change.date)}${s.time ? ` ${s.time}` : ""}`)}</>;
  if ((a.type === "swap" || a.type === "replace") && s && o) return <>{row("slot", `${s.title}, ${when(s)}`, `${s.title}, ${when(o)}`)}{row("slot", `${o.title}, ${when(o)}`, `${o.title}, ${when(s)}`)}</>;
  if (a.type === "change_format" && s) return <>{row("format", `${s.title} as ${s.format}`, `${s.title} as ${a.change.format}`)}</>;
  if (a.type === "new_story") return <>{row("slot", "Empty", `${a.change.title}, ${a.change.date ? day(a.change.date) : ""} · ${a.change.pillar} · ${a.change.format} · ${(a.change.channels ?? []).join(", ")} · idea`)}</>;
  return <p className="text-xs text-ink-3">The calendar item this change names no longer exists.</p>;
}

/** Titles of approved items a date change would move. Allowed (approval covers the content, not the date), but said out loud. */
function approvedMoves(a: ActionRow, items: Map<string, Slot>): string[] {
  if (!["move", "swap", "replace"].includes(a.type)) return [];
  return [a.item_id, a.other_item_id].map((id) => (id ? items.get(id) : undefined)).filter((x): x is Slot => x?.status === "approved").map((x) => x.title);
}

export const metadata = { title: "Weekly report" };

export default async function WeeklyReportPage({ params }: { params: Promise<{ week: string }> }) {
  const { week: raw } = await params;
  const week = Number(raw);
  if (!Number.isInteger(week) || week < 1) notFound();
  const db = await sessionDb();
  const { data: seasons } = await db.from("gtm_seasons").select("id,starts_on,ends_on").order("starts_on");
  const today = new Date().toISOString().slice(0, 10);
  const season = currentSeason((seasons ?? []) as { id: string; starts_on: string; ends_on: string }[], today);

  let q = db.from("gtm_content_reports").select("id,season_id,week,period_start,period_end,status,headline,model,input,report,guard,finished_at,errors").eq("kind", "weekly").eq("week", week);
  if (season) q = q.eq("season_id", season.id);
  const [{ data: rows }, { data: history }] = await Promise.all([
    q.order("period_start", { ascending: false }).limit(1),
    db.from("gtm_content_reports").select("id,week,period_start,headline,status").eq("kind", "weekly").order("period_start", { ascending: false }).limit(20),
  ]);
  const rep = (rows ?? [])[0] as ReportRow | undefined;

  const aside = (
    <aside className="space-y-8 xl:sticky xl:top-24 xl:self-start">
      <div>
        <Eyebrow>Reports</Eyebrow>
        <ol className="mt-3 space-y-2 text-sm">
          {(history ?? []).map((h: { id: string; week: number; period_start: string; headline: string | null; status: string }) => (
            <li key={h.id}>
              <Link href={`/performance/report/${h.week}`} className={h.week === week ? "font-medium text-ink" : "text-ink-2 hover:text-ink"}>
                <span className="tabular-nums">Week {h.week}</span> <span className="text-ink-3">· {day(h.period_start)}</span>
              </Link>
              {h.headline && <p className="line-clamp-2 text-xs text-ink-3">{h.headline}</p>}
            </li>
          ))}
          {!history?.length && <li className="text-ink-3">None yet.</li>}
        </ol>
      </div>
      {rep?.input?.gaps?.length ? (
        <div>
          <Eyebrow>What this report can't see yet</Eyebrow>
          <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-3">{rep.input.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </div>
      ) : null}
    </aside>
  );

  if (!rep || !rep.report?.headline || !rep.input?.posts) {
    return (
      <Shell title="Weekly report" active="/performance">
        <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_14rem]">
          <div>
            <Eyebrow>Week {week}</Eyebrow>
            <h1 className="mt-3 font-display text-pl-3xl font-semibold tracking-tight text-ink">{rep?.status === "running" ? "This report is being written." : rep?.status === "failed" ? "This report failed." : "No report for this week yet."}</h1>
            <p className="mt-4 max-w-[62ch] text-pl-base leading-relaxed text-ink-2">
              {rep?.status === "failed" ? rep.errors?.[0]?.error : "The report runs on Sunday at 08:00 Bali time. To write it now: gtm report weekly --week " + week + "."}
            </p>
          </div>
          {aside}
        </div>
      </Shell>
    );
  }

  const r = rep.report;
  const pack = rep.input;
  const refs = new Map(pack.posts.map((p) => [p.ref, p]));
  const thisWeek = pack.posts.filter((p) => p.window === "this_week");
  const notes = new Map(r.went_out.map((e) => [e.ref, e.note]));
  const { data: actionData } = await db.from("gtm_report_actions").select("*").eq("report_id", rep.id).order("position");
  const actions = (actionData ?? []) as ActionRow[];
  const ids = [...new Set(actions.flatMap((a) => [a.item_id, a.other_item_id]).filter(Boolean))] as string[];
  const { data: slotData } = ids.length ? await db.from("gtm_content_items").select("id,title,date,time,format,status,pillar,channels").in("id", ids) : { data: [] };
  const items = new Map(((slotData ?? []) as Slot[]).map((s) => [s.id, s]));
  const open = actions.filter((a) => a.status === "proposed").length;
  const dropped = rep.guard?.dropped?.length ?? 0;

  return (
    <Shell title="Weekly report" active="/performance" updated={rep.finished_at}>
      <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <article>
          <Eyebrow>Week {rep.week} · {day(rep.period_start)} to {day(rep.period_end)} · {pack.phase.label}</Eyebrow>
          <h1 className="mt-3 max-w-[32ch] font-display text-pl-3xl font-semibold leading-tight tracking-tight text-ink">{r.headline}</h1>
          {r.lede && <p className="mt-4 max-w-[62ch] text-pl-lg leading-relaxed text-ink-2">{r.lede}</p>}
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
            <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" aria-hidden />Written {rep.finished_at ? new Date(rep.finished_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : ""} by {rep.model}</span>
            <span>Every number checked against the cockpit's data{dropped ? `; ${dropped} unsupported ${dropped === 1 ? "claim" : "claims"} removed` : ""}.</span>
            {open > 0 && <a href="#changes" className="font-medium text-blue-strong">{open} {open === 1 ? "change" : "changes"} to decide</a>}
          </p>

          <div className="mt-10">
            <Rail label="Went out" note="Each platform in its own units">
              {thisWeek.length === 0 && pack.unmeasured.length === 0 && <p>Nothing was published this week.</p>}
              {thisWeek.map((p) => (
                <div key={p.ref}>
                  <PostLine p={p} />
                  <p className="mt-1 text-sm"><PostNumbers p={p} /></p>
                  <PlaybookChips p={p} />
                  {notes.get(p.ref) && <p className="mt-1 text-sm">{notes.get(p.ref)}</p>}
                </div>
              ))}
              {pack.unmeasured.map((u) => (
                <div key={u.item_id}>
                  <span className="font-medium text-ink">{u.title}</span> <span className="text-ink-3">· {u.channels.join(", ")}</span>
                  <p className="mt-1 text-sm text-ink-3">No metrics recorded for it, so its numbers are unknown, not zero.</p>
                </div>
              ))}
            </Rail>

            <Rail label="Did well" note="Settled posts only">
              {r.did_well.length ? r.did_well.map((e, i) => (
                <div key={i}><PostLine p={refs.get(e.ref)} /><p className="mt-1">{e.why}</p><EvidenceList ev={e.evidence} /></div>
              )) : <p className="text-ink-3">Nothing stands out yet.</p>}
            </Rail>

            <Rail label="Didn't">
              {r.underperformed.length ? r.underperformed.map((e, i) => (
                <div key={i}><PostLine p={refs.get(e.ref)} /><p className="mt-1">{e.why}</p><EvidenceList ev={e.evidence} /></div>
              )) : <p className="text-ink-3">Nothing fell short on the evidence so far.</p>}
            </Rail>

            {r.patterns.length > 0 && (
              <Rail label="Patterns">
                {r.patterns.map((e, i) => <div key={i}><p>{e.observation}</p><EvidenceList ev={e.evidence} /></div>)}
              </Rail>
            )}

            <Rail label="Against the playbook">
              {r.against_playbook.length ? r.against_playbook.map((e, i) => <div key={i}><p>{e.observation}</p><EvidenceList ev={e.evidence} /></div>)
                : <p className="text-ink-3">Posts are not tagged against the channel playbook yet (hook, storyline, CTA), so there is nothing to grade.</p>}
            </Rail>

            <Rail label="Pillars" note="Each judged on its own job">
              {r.pillars.map((e) => {
                const pillar = pack.pillars.find((p) => p.slug === e.pillar);
                const v = VERDICT[e.verdict];
                return (
                  <div key={e.pillar}>
                    <p className="flex flex-wrap items-baseline gap-x-3">
                      <span className="font-medium text-ink">{pillar?.name ?? e.pillar}</span>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${v.tone}`}><v.icon className="size-3.5" aria-hidden />{v.word}</span>
                    </p>
                    {pillar && <p className="text-xs text-ink-3">{pillar.awareness_job} Judged on: {pillar.leading_metric.label.toLowerCase()}.</p>}
                    <p className="mt-1">{e.note}</p>
                    <EvidenceList ev={e.evidence} />
                  </div>
                );
              })}
            </Rail>

            <section id="changes" className="grid scroll-mt-24 gap-3 border-t border-line py-8 md:grid-cols-[10rem_1fr] md:gap-8">
              <div>
                <h2 className="text-pl-xs font-medium uppercase tracking-[0.12em] text-ink-3">Changes</h2>
                <p className="mt-1 text-xs text-ink-3">Accepting edits the calendar only. Nothing is approved or scheduled.</p>
              </div>
              <div className="max-w-[62ch] space-y-4">
                {actions.length === 0 && <p className="text-pl-base text-ink-3">No calendar changes proposed this week.</p>}
                {actions.map((a) => (
                  <Card key={a.id} glow={false} className="p-5">
                    <Eyebrow>{TYPE[a.type] ?? a.type}</Eyebrow>
                    <p className="mt-2 font-medium leading-snug text-ink">{a.proposal}</p>
                    <div className="mt-3 rounded-lg border border-line bg-[color:var(--surface-card-hover)] px-3 py-2 text-sm">
                      <SlotDiff a={a} items={items} />
                    </div>
                    {a.status === "proposed" && approvedMoves(a, items).map((t) => (
                      <p key={t} className="mt-2 flex items-start gap-1.5 text-xs text-amber-strong" role="note">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>&ldquo;{t}&rdquo; is approved; moving it keeps the approval, so it would go out on the new date without another look.</span>
                      </p>
                    ))}
                    {a.rationale && <p className="mt-3 text-sm leading-relaxed text-ink-2">{a.rationale}</p>}
                    <EvidenceList ev={a.evidence} />
                    <div className="mt-4"><ChangeDecision id={a.id} status={a.status} decidedBy={a.decided_by} decidedAt={a.decided_at} /></div>
                  </Card>
                ))}
              </div>
            </section>
          </div>
        </article>
        {aside}
      </div>
    </Shell>
  );
}
