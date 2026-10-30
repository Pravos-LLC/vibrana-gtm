"use client";

import { useActionState } from "react";
import { addIdeaAction } from "@/app/ideas/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EFFORT_LABEL, IDEA_EFFORTS, IDEA_FORMATS, IDEA_KINDS, IDEA_PILLARS, KIND_LABEL } from "@/lib/ideas/model";

const select = "h-10 rounded-md border border-input bg-[color:var(--surface-inset)] px-3 text-sm text-ink";

export function AddIdeaForm() {
  const [state, action, pending] = useActionState(addIdeaAction, null);
  return (
    <form action={action} className="grid gap-2 rounded-lg border border-line bg-[color:var(--surface-frost)] p-4 md:grid-cols-6" aria-label="Add an idea">
      <Input name="title" required maxLength={300} placeholder="The idea, in a line" aria-label="Title" className="md:col-span-4" />
      <select name="kind" defaultValue="content" className={select} aria-label="Kind">
        {IDEA_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      <select name="pillar" defaultValue="" className={select} aria-label="Pillar">
        <option value="">No pillar</option>
        {IDEA_PILLARS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <textarea name="summary" rows={2} maxLength={5000} placeholder="What it is and the bet it makes: if we ship this, what happens, and why" aria-label="Summary"
        className="min-h-10 rounded-md border border-input bg-[color:var(--surface-inset)] px-3 py-2 text-sm text-ink md:col-span-6" />
      <select name="format" defaultValue="" className={select} aria-label="Format">
        <option value="">Any format</option>
        {IDEA_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <select name="effort" defaultValue="" className={select} aria-label="Effort">
        <option value="">Effort</option>
        {IDEA_EFFORTS.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e]}</option>)}
      </select>
      <select name="impact" defaultValue="" className={select} aria-label="Impact">
        <option value="">Impact</option>
        {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>Impact {n}</option>)}
      </select>
      <Input name="source_url" type="url" placeholder="Source link (optional)" aria-label="Source link" />
      <Input name="owner" placeholder="Owner" aria-label="Owner" />
      <Input name="tags" placeholder="tags, comma separated" aria-label="Tags" />
      <div className="flex items-center gap-3 md:col-span-6">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Adding…" : "Add idea"}</Button>
        {state && <p className={state.ok ? "text-sm text-ink-2" : "text-sm text-red-strong"} role="status">{state.message}</p>}
      </div>
    </form>
  );
}
