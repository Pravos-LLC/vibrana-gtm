"use client";

import { useState, useTransition } from "react";
import { Brain, Plus, X, XCircle } from "lucide-react";
import { addOutreachLesson, learnOutreachNow, retireOutreachLesson, type DeskResult } from "@/app/outreach/write/actions";
import { Button } from "@/components/ui/button";

function useAction() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const run = (fn: () => Promise<DeskResult<string>>, after?: () => void) => start(async () => {
    const r = await fn();
    setMsg(r.ok ? { text: r.value } : { text: r.error, error: true });
    if (r.ok) after?.();
  });
  const note = msg && <p className={`text-xs ${msg.error ? "text-red-strong" : "text-ink-2"}`} role={msg.error ? "alert" : "status"}>{msg.error && <XCircle className="mr-1 inline size-3.5" aria-hidden />}{msg.text}</p>;
  return { pending, run, note };
}

/** Retire one lesson: the next angles stop using it. */
export function RetireLesson({ id }: { id: string }) {
  const [gone, setGone] = useState(false);
  const { pending, run, note } = useAction();
  if (gone) return <span className="text-xs text-ink-3">Retired</span>;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => retireOutreachLesson(id), () => setGone(true))} aria-label="Retire this lesson"><X aria-hidden />Retire</Button>
      {note}
    </span>
  );
}

/** John's own lesson: kept until he retires it, never changed by a learning run. */
export function AddLesson() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("body");
  const { pending, run, note } = useAction();
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(() => addOutreachLesson(kind, text), () => setText("")); }}>
      <label htmlFor="new-outreach-lesson" className="text-xs font-medium text-ink-2">Teach it something directly</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Where the lesson applies"
          className="h-10 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm text-ink">
          <option value="subject">Subject</option><option value="opening">Opening</option><option value="body">Body</option><option value="ask">The ask</option><option value="linkedin">LinkedIn note</option>
        </select>
        <input id="new-outreach-lesson" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
          placeholder="e.g. Open with the hiring signal, never a compliment"
          className="h-10 min-w-0 flex-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-3 text-sm text-ink" />
        <Button type="submit" className="h-10" disabled={pending || text.trim().length < 3}><Plus aria-hidden />Add</Button>
      </div>
      {note}
    </form>
  );
}

export function LearnNow() {
  const { pending, run, note } = useAction();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(learnOutreachNow)}><Brain aria-hidden />{pending ? "Learning…" : "Learn now"}</Button>
      {note}
    </span>
  );
}
