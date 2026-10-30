"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, CircleAlert, X } from "lucide-react";
import { editCandidateField, rejectCandidateAction, sendCandidateToReview } from "@/app/signals/candidate-actions";
import { PLATFORM } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { REJECT_REASONS, type RejectReason } from "@/lib/candidates/reasons";

export type CandidateView = {
  id: string; status: "candidate" | "accepted" | "rejected"; format: "text" | "carousel" | "video";
  lens: string; pillar: string; channels: string[]; title: string; body: string; instagram: string | null;
  slides: { template?: string; slides: Record<string, unknown>[] } | null;
  video: { hook: string; beats: string[]; lines?: string } | null;
  sources: { title?: string; url: string; source?: string }[];
  score: number | null; rubric: { overall?: string; rounds?: number; fails?: string[]; persona_review?: string };
  reject_reason: string | null; reject_note: string | null; gtm_story_id: string | null;
  decided_by: string | null; decided_at: string | null; updated_at: string; edits: number;
};

const FORMAT_LABEL = { text: "Text post", carousel: "Carousel", video: "Video script" } as const;
const LENS_LABEL: Record<string, string> = { transformation: "Transformation", thought_leadership: "Thought leadership", regenerative: "Regenerative" };
const PILLAR_LABEL: Record<string, string> = { proof: "Proof", perspective: "Perspective", build: "The Build", lists: "Lists" };
const SLOT = /(\[JOHN:[^\]]*\])/g;
const IS_SLOT = /^\[JOHN:[^\]]*\]$/;
const prose = (text: string) => text.replace(/^\uFEFF?---\n[\s\S]*?\n---\n?/, "").trim();
const who = (by: string | null) => (by ? by.split("@")[0].replace(/^./, (c) => c.toUpperCase()) : "");
const when = (at: string | null) => (at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** Text with every [JOHN: ...] slot marked, so the places that need John's own take stand out. */
function WithSlots({ text }: { text: string }) {
  return <>{text.split(SLOT).map((part, i) => (IS_SLOT.test(part) ? <mark key={i} className="rounded bg-[color:var(--amber)]/20 px-0.5 text-amber-strong">{part}</mark> : <span key={i}>{part}</span>))}</>;
}

/** The slides as a strip of 4:5 tiles: what each slide says, in order, before anything is rendered. */
function SlideStrip({ slides }: { slides: Record<string, unknown>[] }) {
  return (
    <ol className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label={`${slides.length} slides`}>
      {slides.map((s, i) => {
        const head = [s.n != null ? `${s.n}.` : "", typeof s.title === "string" ? s.title : typeof s.name === "string" ? s.name : ""].join(" ").trim();
        const sub = [s.subtitle, s.body, s.quote, s.value, s.label, s.cta].find((x) => typeof x === "string") as string | undefined;
        return (
          <li key={i} className="flex aspect-[4/5] w-32 shrink-0 flex-col gap-1 overflow-hidden rounded-lg border border-line bg-surface-raised p-2.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-3">{i + 1} · {String(s.type)}</span>
            {head && <span className="line-clamp-4 font-display text-xs font-semibold leading-snug text-ink"><WithSlots text={head} /></span>}
            {sub && <span className="line-clamp-5 text-[11px] leading-snug text-ink-2"><WithSlots text={sub} /></span>}
          </li>
        );
      })}
    </ol>
  );
}

export function CandidateCard({ c: initial }: { c: CandidateView }) {
  const [c, setC] = useState(initial);
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draft, setDraft] = useState({ title: c.title, body: c.body, instagram: c.instagram ?? "", slides: JSON.stringify(c.slides, null, 2), video: JSON.stringify(c.video, null, 2) });
  const [reason, setReason] = useState<RejectReason | "">("");
  const [note, setNote] = useState("");
  const slots = [c.title, c.body, c.instagram ?? "", JSON.stringify(c.slides ?? ""), JSON.stringify(c.video ?? "")].join("\n").match(SLOT)?.length ?? 0;
  const decided = c.status !== "candidate";

  const send = () => start(async () => {
    setError("");
    const r = await sendCandidateToReview(c.id);
    if (r.ok) setC({ ...c, status: "accepted", gtm_story_id: r.gtm_story_id ?? null, decided_at: new Date().toISOString(), decided_by: "you" });
    else setError(r.error);
  });
  const reject = () => start(async () => {
    setError("");
    if (!reason) return setError("Pick a reason.");
    const r = await rejectCandidateAction(c.id, reason, note);
    if (r.ok) { setC({ ...c, status: "rejected", reject_reason: reason, reject_note: note || null, decided_at: new Date().toISOString(), decided_by: "you" }); setMode("view"); }
    else setError(r.error);
  });
  const save = () => start(async () => {
    setError("");
    const fields: { field: "title" | "body" | "instagram" | "slides" | "video"; value: string; current: string }[] = [
      { field: "title", value: draft.title, current: c.title },
      { field: "body", value: draft.body, current: c.body },
      { field: "instagram", value: draft.instagram, current: c.instagram ?? "" },
      ...(c.format === "carousel" ? [{ field: "slides" as const, value: draft.slides, current: JSON.stringify(c.slides, null, 2) }] : []),
      ...(c.format === "video" ? [{ field: "video" as const, value: draft.video, current: JSON.stringify(c.video, null, 2) }] : []),
    ];
    let next = { ...c };
    const notes: string[] = [];
    for (const f of fields.filter((x) => x.value !== x.current)) {
      const r = await editCandidateField(c.id, f.field, f.value, next.updated_at);
      if (!r.ok) { setC(next); return setError(r.error); }
      next = { ...next, [f.field]: r.value, updated_at: r.updated_at ?? next.updated_at, edits: next.edits + 1 } as CandidateView;
      notes.push(...(r.warnings ?? []));
    }
    setC(next);
    setWarnings(notes);
    setMode("view");
  });

  return (
    <Card glow={false} className="space-y-3 p-5" data-testid="candidate-card" data-id={c.id} data-status={c.status}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <Badge variant={c.format === "carousel" ? "info" : c.format === "video" ? "warning" : "outline"}>{FORMAT_LABEL[c.format]}</Badge>
        <span className="font-medium text-ink-2">{PILLAR_LABEL[c.pillar] ?? c.pillar}</span>
        <span>{LENS_LABEL[c.lens] ?? c.lens}</span>
        <span className="flex items-center gap-1" aria-label={`Channels: ${c.channels.join(", ")}`}>
          {c.channels.map((ch) => { const P = PLATFORM[ch as keyof typeof PLATFORM]; return P ? <P.Icon key={ch} className="size-4" title={P.label} /> : <span key={ch}>{ch}</span>; })}
        </span>
        {c.score != null && <span className="font-mono text-ink-2" title={`Rubric judge${c.rubric.rounds ? `, ${c.rubric.rounds} rounds` : ""}${c.rubric.fails?.length ? `; failing ${c.rubric.fails.join(", ")}` : ""}`}>rubric {Math.round(c.score)}</span>}
        {c.rubric.overall === "fail" && <span className="flex items-center gap-1 text-amber-strong"><CircleAlert className="size-3.5" aria-hidden />rubric fail {c.rubric.fails?.join(", ")}</span>}
        {c.pillar === "proof" && <span className="flex items-center gap-1">{c.rubric.persona_review ? <>persona-review: {c.rubric.persona_review}</> : <span className="flex items-center gap-1 text-amber-strong"><CircleAlert className="size-3.5" aria-hidden />persona-review not run</span>}</span>}
        {slots > 0 && <span className="flex items-center gap-1 text-amber-strong"><CircleAlert className="size-3.5" aria-hidden />{slots} {slots === 1 ? "place needs" : "places need"} your take</span>}
        {c.edits > 0 && <span>{c.edits} {c.edits === 1 ? "edit" : "edits"} by you</span>}
      </div>

      {mode === "edit" ? (
        <div className="space-y-3">
          <label className="block space-y-1 text-xs text-ink-3">Title
            <input className="w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="block space-y-1 text-xs text-ink-3">{c.format === "text" ? "Post text (LinkedIn)" : "Caption (LinkedIn)"}
            <textarea className="min-h-48 w-full rounded-md border border-line bg-surface-raised px-3 py-2 font-sans text-sm text-ink" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          {c.channels.includes("instagram") && (
            <label className="block space-y-1 text-xs text-ink-3">Instagram caption (empty: the LinkedIn text)
              <textarea className="min-h-24 w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" value={draft.instagram} onChange={(e) => setDraft({ ...draft, instagram: e.target.value })} />
            </label>
          )}
          {c.format === "carousel" && (
            <label className="block space-y-1 text-xs text-ink-3">slides.json
              <textarea className="min-h-64 w-full rounded-md border border-line bg-surface-raised px-3 py-2 font-mono text-xs text-ink" value={draft.slides} onChange={(e) => setDraft({ ...draft, slides: e.target.value })} />
            </label>
          )}
          {c.format === "video" && (
            <label className="block space-y-1 text-xs text-ink-3">Script (hook and beats)
              <textarea className="min-h-48 w-full rounded-md border border-line bg-surface-raised px-3 py-2 font-mono text-xs text-ink" value={draft.video} onChange={(e) => setDraft({ ...draft, video: e.target.value })} />
            </label>
          )}
        </div>
      ) : (
        <>
          <h2 className="font-display text-pl-lg font-semibold leading-snug tracking-tight text-ink"><WithSlots text={c.title} /></h2>
          {c.format === "carousel" && c.slides && <SlideStrip slides={c.slides.slides} />}
          {c.format === "video" && c.video && (
            <div className="space-y-2 text-sm">
              <p className="font-display text-base font-semibold text-ink"><span className="mr-1 font-mono text-xs font-normal uppercase text-ink-3">Hook</span><WithSlots text={c.video.hook} /></p>
              <ol className="list-decimal space-y-1 pl-5 text-ink-2">
                {c.video.beats.slice(0, open ? undefined : 3).map((b, i) => <li key={i}><WithSlots text={b} /></li>)}
              </ol>
            </div>
          )}
          <p className={`whitespace-pre-line text-sm text-ink-2 ${open ? "" : c.format === "text" ? "line-clamp-6" : "line-clamp-3"}`} data-testid="candidate-body"><WithSlots text={prose(c.body)} /></p>
          <button type="button" className="text-xs text-violet-strong underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>
        </>
      )}

      {c.sources.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Sources">
          {c.sources.slice(0, 4).map((s) => (
            <li key={s.url} className="truncate">
              <a href={s.url} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">{s.title || s.url}</a>
              {s.source && <span className="text-ink-3"> · {s.source}</span>}
            </li>
          ))}
          {c.sources.length > 4 && <li className="text-xs text-ink-3">and {c.sources.length - 4} more</li>}
        </ul>
      )}

      {decided ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-2" role="status">
          {c.status === "accepted" ? <Check className="size-3.5 text-emerald-strong" aria-hidden /> : <X className="size-3.5 text-ink-3" aria-hidden />}
          {c.status === "accepted" ? "Sent to review" : `Rejected: ${REJECT_REASONS.find((r) => r.slug === c.reject_reason)?.label ?? c.reject_reason}${c.reject_note ? `, "${c.reject_note}"` : ""}`}
          {c.decided_by && c.decided_by !== "you" ? ` by ${who(c.decided_by)}` : ""}{c.decided_at ? `, ${when(c.decided_at)}` : ""}
          {c.status === "accepted" && <Link href="/content" className="ml-1 text-violet-strong underline-offset-2 hover:underline">Open Content review</Link>}
        </p>
      ) : mode === "edit" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={save}>Save edits</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setMode("view"); setDraft({ title: c.title, body: c.body, instagram: c.instagram ?? "", slides: JSON.stringify(c.slides, null, 2), video: JSON.stringify(c.video, null, 2) }); }}>Cancel</Button>
        </div>
      ) : mode === "reject" ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`reason-${c.id}`}>Reason</label>
          <select id={`reason-${c.id}`} className="h-8 rounded-md border border-line bg-surface-raised px-2 text-xs text-ink" value={reason} onChange={(e) => setReason(e.target.value as RejectReason)}>
            <option value="">Why not?</option>
            {REJECT_REASONS.map((r) => <option key={r.slug} value={r.slug}>{r.label}</option>)}
          </select>
          <input className="h-8 min-w-48 flex-1 rounded-md border border-line bg-surface-raised px-2 text-xs text-ink" placeholder="A note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <Button size="sm" variant="secondary" disabled={pending || !reason} onClick={reject}>Reject</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode("view")}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={send} title="Stage it as a Story with drafted posts in Content review. Nothing is approved or scheduled.">Send to Review</Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setMode("edit")}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode("reject")}>Reject</Button>
        </div>
      )}
      {warnings.length > 0 && <ul className="space-y-0.5 text-xs text-amber-strong" role="status">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {error && <p className="text-xs text-red-strong" role="alert">{error}</p>}
    </Card>
  );
}
