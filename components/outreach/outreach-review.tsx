"use client";

// /outreach: one card per prospect, each model-trial variant side by side, the email editable in place. Optimistic like
// /content: a click updates the card at once and the server call follows; a failure puts it back and says why.
// Keyboard: J/K next and previous prospect, A accept, R reject, N note (send back), E edit the email; in a text box,
// Cmd/Ctrl+S saves the edit and Cmd/Ctrl+Enter sends the note or the reason.
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { Check, ExternalLink, RotateCcw, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { noteSent, toast } from "@/components/ui/toaster";
import { cn } from "@/lib/ui/cn";
import { diffWords, hasChanges } from "@/lib/text-diff";
import { actedOn, editOf, editProblems, isEdited, LIMITS, prospectName, sameEdit, STATUS_LABEL, type Draft, type DraftEdit, type DraftVersion, type OutreachStatus } from "@/lib/outreach/model";
import type { OutreachResult } from "@/app/outreach/actions";

export type OutreachActions = {
  save: (id: string, edit: DraftEdit) => Promise<OutreachResult>;
  accept: (id: string, edit: DraftEdit | null) => Promise<OutreachResult>;
  reject: (id: string, reason: string) => Promise<OutreachResult>;
  sendBack: (id: string, note: string, edit: DraftEdit | null) => Promise<OutreachResult>;
  reopen: (id: string) => Promise<OutreachResult>;
};

export type ProspectCardData = { key: string; drafts: Draft[]; history: Record<string, DraftVersion[]> };

const TONE: Record<OutreachStatus, "warning" | "success" | "destructive" | "info"> = { pending: "warning", accepted: "success", rejected: "destructive", regenerate: "info" };
const area = "w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";
const link = "text-violet-strong underline-offset-4 hover:underline";
const rows = (s: string, min: number) => Math.max(min, s.split("\n").length + 1);
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
};
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** The list, with J/K/A/R/N/E. The active prospect has a ring; keys act on its variant that has focus, or its only open one. */
export function OutreachList({ cards, actions }: { cards: ProspectCardData[]; actions: OutreachActions }) {
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const i = Math.min(at, Math.max(0, cards.length - 1));
  useEffect(() => {
    const cardEl = (n: number) => list.current?.querySelectorAll<HTMLElement>("[data-prospect]")[n];
    const panel = () => {
      const card = cardEl(i);
      if (!card) return null;
      const panels = [...card.querySelectorAll<HTMLElement>("[data-variant-panel]")];
      return panels.find((p) => p.contains(document.activeElement)) ?? (panels.filter((p) => p.dataset.open === "true").length === 1 ? panels.find((p) => p.dataset.open === "true") : panels.length === 1 ? panels[0] : null) ?? null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        const n = Math.min(cards.length - 1, Math.max(0, i + (k === "j" ? 1 : -1)));
        setAt(n);
        cardEl(n)?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      const action = { a: "accept", r: "reject", n: "note", e: "edit" }[k];
      if (!action) return;
      const p = panel();
      if (!p) { if (cardEl(i)) toast("Several variants: click into the one you mean first."); return; }
      const target = p.querySelector<HTMLElement>(`[data-action=${action}]:not([disabled])`);
      if (target) { e.preventDefault(); if (target.tagName === "TEXTAREA") target.focus(); else target.click(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div ref={list} className="space-y-6">
      {cards.map((c, n) => <ProspectCard key={c.key} data={c} actions={actions} active={n === i} onFocus={() => setAt(n)} />)}
    </div>
  );
}

function ProspectCard({ data, actions, active, onFocus }: { data: ProspectCardData; actions: OutreachActions; active: boolean; onFocus: () => void }) {
  const [drafts, setDrafts] = useState(data.drafts);
  const first = drafts[0];
  const p = first.prospect;
  const name = prospectName(p) || first.domain;
  const trigger = first.trigger;
  const replace = (next: Draft[]) => setDrafts((cur) => cur.map((d) => next.find((x) => x.id === d.id) ?? d));
  const cols = drafts.length >= 3 ? "xl:grid-cols-3" : drafts.length === 2 ? "xl:grid-cols-2" : "";
  return (
    <Card glow={false} data-prospect={first.domain} data-testid="outreach-card" onFocusCapture={onFocus} onMouseDown={onFocus}
      className={cn("scroll-mt-20 space-y-4 p-5", active && "ring-2 ring-violet/40")}>
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">{name}</h2>
          <span className="text-sm text-ink-2">{[p.title, p.company].filter(Boolean).join(", ")}</span>
          {p.country && <Badge variant="outline">{p.country}</Badge>}
          {p.lane && <Badge variant="outline">{p.lane}</Badge>}
          {p.score != null && <Badge variant="outline" title="Prospect score">Score {p.score}</Badge>}
          <span className="font-mono text-xs text-ink-3">{first.domain}</span>
        </div>
        {(trigger.what || trigger.url) && (
          <p className="text-sm text-ink" data-testid="outreach-trigger">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-3">Trigger </span>
            {trigger.what}
            {trigger.date && <span className="text-ink-3"> · {trigger.date}</span>}
            {safeUrl(trigger.url) && <> · <a href={safeUrl(trigger.url)!} target="_blank" rel="noreferrer" className={link}>source<ExternalLink className="ml-0.5 inline size-3" /></a></>}
          </p>
        )}
      </header>
      <div className={cn("grid gap-4", cols)}>
        {drafts.map((d) => <VariantPanel key={d.id} draft={d} trial={drafts.length > 1} history={data.history[d.id] ?? []} actions={actions} onChange={replace} />)}
      </div>
    </Card>
  );
}

function VariantPanel({ draft, trial, history, actions, onChange }: { draft: Draft; trial: boolean; history: DraftVersion[]; actions: OutreachActions; onChange: (drafts: Draft[]) => void }) {
  const [edit, setEdit] = useState<DraftEdit>(() => editOf(draft));
  const [mode, setMode] = useState<null | "reject" | "note">(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [, start] = useTransition();
  const body = useRef<HTMLTextAreaElement>(null);
  const dirty = !sameEdit(edit, editOf(draft));
  const problems = editProblems(edit);
  const locked = draft.email_status !== "none" || draft.status === "rejected";
  const contacted = actedOn(draft);
  const open = draft.status === "pending" || draft.status === "regenerate";
  const regenNote = [...history].reverse().find((v) => v.reason === "regenerated" && v.note)?.note;

  // Optimistic: show the outcome now, then reconcile with what the server returns (or put it back and say why).
  const act = (optimistic: Partial<Draft>, call: () => Promise<OutreachResult>, after?: () => void) => {
    const before = draft;
    setError(null);
    onChange([{ ...draft, ...optimistic }]);
    start(async () => {
      const r = await call();
      if (!r.ok) { onChange([before]); setError(r.error); return; }
      onChange([r.draft, ...(r.siblings ?? [])]);
      setEdit(editOf(r.draft));
      after?.();
    });
  };
  const save = () => { if (dirty && !problems.length) act(edit, () => actions.save(draft.id, edit)); };
  const accept = () => act({ ...edit, status: "accepted" }, () => actions.accept(draft.id, dirty ? edit : null));
  const reject = () => { const reason = text.trim(); setMode(null); setText(""); act({ status: "rejected", note: reason }, () => actions.reject(draft.id, reason)); };
  const sendBack = () => {
    const note = text.trim();
    if (!note) return;
    setMode(null); setText("");
    act({ ...edit, status: "regenerate", note }, () => actions.sendBack(draft.id, note, dirty ? edit : null), noteSent);
  };
  const reopen = () => act({ status: "pending", note: "" }, () => actions.reopen(draft.id));
  const saveKey = (e: React.KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } };
  const followup = (n: number, field: "subject" | "body", value: string) =>
    setEdit((x) => ({ ...x, followups: x.followups.map((f, i) => (i === n ? { ...f, [field]: value } : f)) }));
  const parts = diff ? diffWords(draft.original_body, edit.body) : [];
  const changed = isEdited({ ...draft, subject: edit.subject, body: edit.body });
  const strategy = ([["Problem", draft.strategy.problem], ["Proof", draft.strategy.proof], ["Why now", draft.strategy.why_now], ["The ask", draft.strategy.door], ["Asset", draft.strategy.asset]] as Array<[string, unknown]>)
    .flatMap(([k, v]) => (typeof v === "string" && v.trim() ? [[k, v] as const] : []));

  return (
    <section data-variant-panel data-open={open} data-variant={draft.variant} data-status={draft.status} data-testid="outreach-variant"
      aria-label={trial ? `Variant ${draft.variant}` : "Draft"} className="min-w-0 space-y-3 rounded-lg border border-line bg-[color:var(--surface-raised)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        {trial && <span className="rounded-md border border-line px-2 py-0.5 font-mono text-xs text-ink-2" title="Model trial variant">{draft.variant}</span>}
        {draft.model && draft.model !== draft.variant && <span className="font-mono text-xs text-ink-3">{draft.model}</span>}
        <Badge variant={TONE[draft.status]} data-testid="outreach-status">{STATUS_LABEL[draft.status]}</Badge>
        {draft.version > 1 && <span className="text-xs text-ink-3">v{draft.version}</span>}
        {draft.linkedin_status !== "none" && <Badge variant="outline">LinkedIn: {draft.linkedin_status}</Badge>}
        {draft.email_status !== "none" && <Badge variant="outline">Email: {draft.email_status}</Badge>}
      </div>
      {draft.status !== "pending" && draft.note && <p className="text-xs text-ink-2">{draft.status === "rejected" ? "Reason" : "Your note"}: <span className="whitespace-pre-wrap">{draft.note}</span></p>}
      {draft.status === "pending" && regenNote && <p className="border-l-2 border-[color:var(--blue)]/50 pl-2.5 text-xs text-ink-2">Rewritten from your note: <span className="whitespace-pre-wrap">{regenNote}</span></p>}

      {draft.findings.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Findings (advisory)">
          {draft.findings.map((f, n) => (
            <li key={n}><Badge variant={f.level === "block" ? "warning" : "outline"} title={f.detail ?? undefined} className="max-w-full whitespace-normal">{f.code || f.level}{f.detail ? `: ${f.detail}` : ""}</Badge></li>
          ))}
        </ul>
      )}

      {strategy.length > 0 && (
        <Details summary="Strategy">
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            {strategy.map(([k, v]) => <Fragment key={k}><dt className="text-ink-3">{k}</dt><dd className="whitespace-pre-wrap text-ink">{v}</dd></Fragment>)}
          </dl>
        </Details>
      )}

      {/* The email, as an email. */}
      <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)]">
        <div className="space-y-1 border-b border-line px-3 py-2 text-sm">
          <div className="flex gap-2"><span className="w-14 shrink-0 text-ink-3">To</span><span className="truncate text-ink">{prospectName(draft.prospect) || draft.domain}{draft.prospect.email ? ` <${draft.prospect.email}>` : ""}</span></div>
          <label className="flex items-center gap-2"><span className="w-14 shrink-0 text-ink-3">Subject</span>
            <input value={edit.subject} disabled={locked} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} onKeyDown={saveKey} aria-label="Subject" maxLength={LIMITS.subject}
              className="min-w-0 flex-1 bg-transparent font-medium text-ink focus-visible:outline-none" />
          </label>
        </div>
        {diff
          ? <div className="whitespace-pre-wrap px-3 py-2.5 text-sm leading-relaxed text-ink" data-testid="outreach-diff">
              {hasChanges(parts) ? parts.map((x, n) => <span key={n} className={cn(x.type === "add" && "bg-[color:var(--emerald)]/20", x.type === "del" && "text-red-strong line-through")}>{x.text}</span>) : edit.body}
            </div>
          : <textarea ref={body} data-action="edit" value={edit.body} disabled={locked} onChange={(e) => setEdit({ ...edit, body: e.target.value })} onKeyDown={saveKey}
              rows={rows(edit.body, 6)} aria-label="Email body" className="block w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink focus-visible:outline-none" />}
      </div>
      {changed && <button type="button" onClick={() => setDiff((x) => !x)} className="text-xs text-ink-3 underline underline-offset-4 hover:text-ink">{diff ? "Back to editing" : "Show changes from the agent's draft"}</button>}

      <label className="block space-y-1">
        <span className="flex justify-between text-xs text-ink-3"><span>LinkedIn note</span><span className={cn("tabular-nums", edit.linkedin_note.length > LIMITS.linkedin_note && "text-red-strong")}>{edit.linkedin_note.length}/{LIMITS.linkedin_note}</span></span>
        <textarea value={edit.linkedin_note} disabled={locked} onChange={(e) => setEdit({ ...edit, linkedin_note: e.target.value })} onKeyDown={saveKey} rows={3} aria-label="LinkedIn note" className={area} />
      </label>

      {edit.followups.length > 0 && (
        <Details summary={`Follow-ups (${edit.followups.length})`}>
          <ol className="space-y-3">
            {edit.followups.map((f, n) => (
              <li key={n} className="space-y-1">
                <p className="text-xs text-ink-3">Day {f.day ?? "?"}{f.topic ? ` · ${f.topic}` : ""}</p>
                <input value={f.subject ?? ""} disabled={locked} onChange={(e) => followup(n, "subject", e.target.value)} onKeyDown={saveKey} aria-label={`Follow-up ${n + 1} subject`} placeholder="Subject (blank: same thread)"
                  className="h-8 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm text-ink" />
                <textarea value={f.body ?? ""} disabled={locked} onChange={(e) => followup(n, "body", e.target.value)} onKeyDown={saveKey} rows={rows(f.body ?? "", 3)} aria-label={`Follow-up ${n + 1} body`} className={area} />
              </li>
            ))}
          </ol>
        </Details>
      )}

      {draft.claims.length > 0 && (
        <Details summary={`Claims and sources (${draft.claims.length})`}>
          <ul className="space-y-2 text-sm">
            {draft.claims.map((c, n) => (
              <li key={n}>
                <p className="text-ink">{c.claim}</p>
                {c.quote && <blockquote className="border-l-2 border-line pl-2 text-xs italic text-ink-2">{c.quote}</blockquote>}
                {safeUrl(c.source_url) ? <a href={safeUrl(c.source_url)!} target="_blank" rel="noreferrer" className={cn("text-xs", link)}>{c.source_url}</a> : <span className="text-xs text-amber-strong">No source link</span>}
              </li>
            ))}
          </ul>
        </Details>
      )}

      {mode && (
        <div className="space-y-2">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={LIMITS.note}
            aria-label={mode === "note" ? "Note to the agent" : "Reason for rejecting (optional)"} placeholder={mode === "note" ? "What should change?" : "Why not (optional)"}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (mode === "note") sendBack(); else reject(); } if (e.key === "Escape") setMode(null); }} className={area} />
          <div className="flex gap-2">
            {mode === "note"
              ? <Button size="sm" onClick={sendBack} disabled={!text.trim()} className="border-transparent bg-amber-strong text-white hover:bg-amber-strong/90"><RotateCcw /> Send back</Button>
              : <Button size="sm" variant="secondary" onClick={reject} className="text-red-strong"><X /> Reject</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setMode(null); setText(""); }}>Cancel</Button>
          </div>
        </div>
      )}

      {!mode && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {draft.status !== "accepted" && draft.status !== "rejected" && (
            <Button size="sm" onClick={accept} disabled={problems.length > 0} data-action="accept" aria-label={trial ? `Accept ${draft.variant}` : "Accept"}><Check /> Accept</Button>
          )}
          {draft.status === "rejected" && !contacted && <Button size="sm" variant="ghost" onClick={accept} disabled={problems.length > 0} data-action="accept" aria-label={trial ? `Accept ${draft.variant}` : "Accept"}><Check /> Accept instead</Button>}
          {!locked && dirty && <Button size="sm" variant="secondary" onClick={save} disabled={problems.length > 0}>Save edit</Button>}
          {!contacted && draft.status !== "rejected" && <Button size="sm" variant="secondary" onClick={() => setMode("note")} data-action="note" className="border-[color:var(--amber)]/40 text-amber-strong">Send back with note</Button>}
          {!contacted && draft.status !== "rejected" && <Button size="sm" variant="ghost" onClick={() => setMode("reject")} data-action="reject" className="text-red-strong hover:text-red-strong"><X /> Reject</Button>}
          {!contacted && !open && <Button size="sm" variant="ghost" onClick={reopen} className="text-ink-3"><Undo2 /> Undo</Button>}
          {dirty && !problems.length && <span className="text-xs text-ink-3">Unsaved edit. Accept saves it.</span>}
          {problems.map((m) => <span key={m} className="basis-full text-xs text-red-strong">{m}</span>)}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-strong">{error}</p>}
    </section>
  );
}

function Details({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-ink-2 marker:text-ink-3">{summary}</summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
