"use client";

// Under the text in /content: every @mention, and per platform whether it will tag (lib/mentions.ts). Someone not on file
// can be added right here with a LinkedIn link or an Instagram handle (John, 2026-10-16: "How do I know when mentioning
// someone it will actually work?"). The team (auto_tag) tags on LinkedIn by plain name too, so their names show here
// without an "@"; the add form can mark someone that way.
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PLATFORM } from "@/components/brand-icons";
import { mentionReport, type MentionChannel, type Person } from "@/lib/mentions";
import type { NewPerson } from "@/lib/people";

type AddPerson = (input: NewPerson) => Promise<{ ok: true; person: Person; linkedinError?: string } | { ok: false; error: string }>;
const PeopleCtx = createContext<{ people: Person[]; add: AddPerson | null; added: (p: Person) => void }>({ people: [], add: null, added: () => {} });

export function PeopleProvider({ people: initial, add, children }: { people: Person[]; add: AddPerson | null; children: ReactNode }) {
  const [people, setPeople] = useState(initial);
  const added = (p: Person) => setPeople((all) => [...all.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), p]);
  return <PeopleCtx.Provider value={{ people, add, added }}>{children}</PeopleCtx.Provider>;
}

/** `comment`: the texts are a first comment (LinkedIn does not tag there). */
export function MentionCheck({ texts, channels, comment = false }: { texts: string[]; channels: MentionChannel[]; comment?: boolean }) {
  const { people } = useContext(PeopleCtx);
  const report = mentionReport(texts.join("\n"), channels, people, { comment });
  if (!report.length) return null;
  return (
    <div className="rounded-md border border-line p-3 text-xs" role="group" aria-label="Mentions">
      <p className="mb-2 font-medium text-ink-2">{comment ? "Mentions in the first comment" : "Mentions"}</p>
      <ul className="grid gap-2">
        {report.map((m) => (
          <li key={m.typed} className="grid gap-1">
            <span className="font-medium text-ink">{m.person ? m.person.name : m.typed}{m.auto && <span className="font-normal text-ink-3"> (named without @)</span>}</span>
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {m.results.map((r) => {
                const { Icon, label } = PLATFORM[r.channel];
                return (
                  <span key={r.channel} className={r.tags ? "inline-flex items-center gap-1 text-[color:var(--emerald)]" : "inline-flex items-center gap-1 text-ink-3"}>
                    <Icon className="size-3.5" aria-hidden />
                    {r.tags ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
                    {r.tags ? `${label}: will tag` : `${label}: plain text, ${r.why}`}
                  </span>
                );
              })}
            </span>
            {m.results.some((r) => r.fixable) && <AddPersonForm typed={m.typed.replace(/^@/, "")} known={m.person} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddPersonForm({ typed, known }: { typed: string; known: Person | null }) {
  const { add, added } = useContext(PeopleCtx);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(known?.name ?? typed);
  const [linkedin, setLinkedin] = useState("");
  const [instagram, setInstagram] = useState("");
  const [autoTag, setAutoTag] = useState(!!known?.auto_tag);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  if (!add) return null;
  if (!open) return (
    <>
      <button type="button" className="justify-self-start text-violet underline-offset-2 hover:underline" onClick={() => setOpen(true)}>{known ? "Add their profile" : "Add this person"}</button>
      {msg && <p role="alert" className="text-red-strong">{msg}</p>}
    </>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
      <label className="flex items-center gap-2 text-ink-2 sm:col-span-4">
        <input type="checkbox" checked={autoTag} onChange={(e) => setAutoTag(e.target.checked)} />
        Tag them on LinkedIn whenever I write their name, no @ needed (for the team)
      </label>
      <Input aria-label="Name you type after @" placeholder="Name you type after @" value={name} readOnly={!!known} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="LinkedIn profile link" placeholder="linkedin.com/in/..." value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
      <Input aria-label="Instagram handle" placeholder="Instagram handle" value={instagram} onChange={(e) => setInstagram(e.target.value)} />
      <Button size="sm" disabled={busy || !name.trim() || (!linkedin.trim() && !instagram.trim())} onClick={() => start(async () => {
        setMsg(null);
        const r = await add({ name: known?.name ?? name, linkedin: linkedin || undefined, instagram: instagram || undefined, autoTag });
        if (!r.ok) { setMsg(r.error); return; }
        added(r.person);
        setOpen(false);
        if (r.linkedinError) setMsg(`Saved, but LinkedIn could not resolve the profile: ${r.linkedinError}`);
      })}>Save</Button>
      {msg && <p role="alert" className="text-red-strong sm:col-span-4">{msg}</p>}
    </div>
  );
}
