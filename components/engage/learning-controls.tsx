"use client";

import { useState, useTransition } from "react";
import { Brain, Plus, X, XCircle } from "lucide-react";
import { addEngageLesson, learnNow, retireEngageLesson } from "@/app/engage/actions";
import { Button } from "@/components/ui/button";

type Result = { ok: true; message: string } | { ok: false; error: string };

function useAction() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const run = (fn: () => Promise<Result>, after?: () => void) => start(async () => {
    const r = await fn();
    setMsg(r.ok ? { text: r.message } : { text: r.error, error: true });
    if (r.ok) after?.();
  });
  const note = msg && <p className={`text-xs ${msg.error ? "text-red-strong" : "text-ink-2"}`} role={msg.error ? "alert" : "status"}>{msg.error && <XCircle className="mr-1 inline size-3.5" aria-hidden />}{msg.text}</p>;
  return { pending, run, note };
}

/** Retire one lesson: the next drafts stop using it. */
export function RetireLesson({ id }: { id: string }) {
  const [gone, setGone] = useState(false);
  const { pending, run, note } = useAction();
  if (gone) return <span className="text-xs text-ink-3">Retired</span>;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => retireEngageLesson(id), () => setGone(true))} aria-label="Retire this lesson"><X aria-hidden />Retire</Button>
      {note}
    </span>
  );
}

/** John's own lesson: kept until he retires it, never changed by a learning run. */
export function AddLesson() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("voice");
  const { pending, run, note } = useAction();
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(() => addEngageLesson(kind, text), () => setText("")); }}>
      <label htmlFor="new-lesson" className="text-xs font-medium text-ink-2">Teach it something directly</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of lesson"
          className="h-10 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm text-ink">
          <option value="voice">How replies sound</option>
          <option value="classification">What counts as spam or worth a reply</option>
        </select>
        <input id="new-lesson" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
          placeholder="e.g. Partnership offers from people in regenerative work are not spam"
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
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(learnNow)}><Brain aria-hidden />{pending ? "Learning…" : "Learn now"}</Button>
      {note}
    </span>
  );
}
