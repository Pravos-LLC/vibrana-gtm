"use client";

import { useActionState } from "react";
import { addInspirationAction } from "@/app/inspiration/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const select = "h-10 rounded-md border border-input bg-[color:var(--surface-inset)] px-3 text-sm text-ink";

export function AddInspirationForm({ kinds, pillars }: { kinds: readonly string[]; pillars: readonly string[] }) {
  const [state, action, pending] = useActionState(addInspirationAction, null);
  return (
    <form action={action} className="grid gap-2 rounded-lg border border-line bg-[color:var(--surface-frost)] p-4 md:grid-cols-[2fr_1fr_1fr]" aria-label="Add inspiration">
      <Input name="url" type="url" required placeholder="https://… (YouTube, LinkedIn, Substack, any page)" aria-label="URL" />
      <select name="kind" required defaultValue="" className={select} aria-label="Kind">
        <option value="" disabled>Kind</option>
        {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <select name="pillar" defaultValue="" className={select} aria-label="Pillar">
        <option value="">No pillar</option>
        {pillars.map((pillar) => <option key={pillar} value={pillar}>{pillar}</option>)}
      </select>
      <Input name="title" placeholder="Title (fetched if blank)" aria-label="Title" />
      <Input name="tags" placeholder="tags, comma separated" aria-label="Tags" />
      <Input name="why" placeholder="Why we like it" aria-label="Why we like it" />
      <div className="flex items-center gap-3 md:col-span-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Fetching…" : "Add"}</Button>
        {state && <p className={state.ok ? "text-sm text-ink-2" : "text-sm text-red-strong"} role="status">{state.message}</p>}
      </div>
    </form>
  );
}
