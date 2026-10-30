"use client";

import { authorName } from "@/lib/reviewer/access";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { UI_LABEL, labelForRevision, type FeedbackItem, type PartUi, type PartVersion } from "@/lib/season-review";
import { noteText } from "@/lib/approve-note";

const TONE = { approved: "success", fixing: "warning", pending: "warning", changes: "destructive", new: "info" } as const;

/** "Text: Approved v1.2". Sits in the platform card header so the state is the first thing read. */
export function StatusChip({ part, ui, version }: { part: "Text" | "Asset"; ui: PartUi; version?: string }) {
  if (ui === "none") return null;
  return (
    <Badge variant={TONE[ui]} className="gap-1.5 py-1">
      <span className="font-semibold">{part}:</span> {UI_LABEL[ui]}
      {version && <span className="opacity-70">{version}</span>}
    </Badge>
  );
}

/**
 * Version dropdown for one section. Latest is selected by default and is the only one that can be approved.
 * With one version it is a plain label, because there is nothing to switch.
 */
export function VersionSwitcher({ label, versions, viewing, onView, isNew }: {
  label: string; versions: PartVersion[]; viewing: number; onView: (revision: number) => void; isNew: boolean;
}) {
  const latest = versions[versions.length - 1];
  if (!latest) return null;
  return (
    <span className="inline-flex items-center gap-2">
      {versions.length === 1
        ? <span className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-ink-2">{latest.label}</span>
        : (
          <span className="relative inline-flex">
            <select aria-label={`${label} version`} value={viewing} onChange={(e) => onView(Number(e.target.value))}
              className="h-7 appearance-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] pl-2 pr-6 text-xs font-medium text-ink focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20">
              {[...versions].reverse().map((v) => <option key={v.revision} value={v.revision}>{v.label}{v.revision === latest.revision ? " (latest)" : ""}</option>)}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
          </span>
        )}
      {isNew && <Badge variant="default" className="py-0">New</Badge>}
    </span>
  );
}

/** One of John's open notes, short: what he asked for and the version he asked it on. Never the agent's reply. */
export function NoteItem({ note, versions }: { note: FeedbackItem; versions: PartVersion[] }) {
  const on = labelForRevision(versions, note.revision);
  const { text, approvedWithNote } = noteText(note.body);
  return (
    <li className="border-l-2 border-[color:var(--amber)]/60 pl-2.5 text-sm text-ink">
      {approvedWithNote && <span className="mr-1.5 rounded bg-emerald-strong/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-strong">Approved with note</span>}
      {authorName(note.author) && <span className="text-xs font-medium text-ink-2">{authorName(note.author)}: </span>}
      <span className="whitespace-pre-wrap">{text}</span>
      {on && <span className="ml-1.5 text-xs text-ink-3">{on}</span>}
    </li>
  );
}

/** Resolved notes, each with the agent's reply. Shown only inside the closed History disclosure. */
export function ResolvedNotes({ notes, versions }: { notes: FeedbackItem[]; versions: PartVersion[] }) {
  if (!notes.length) return null;
  return (
    <div>
      <p className="mb-1 font-medium text-ink-2">Resolved notes</p>
      <ul className="space-y-2">
        {notes.map((n) => {
          const on = labelForRevision(versions, n.revision);
          return (
            <li key={n.id} className="text-ink-3">
              {authorName(n.author) && <span className="font-medium">{authorName(n.author)}: </span>}
              <span className="whitespace-pre-wrap">{noteText(n.body).text}</span>{on && <span> ({on})</span>}
              <span className="block">Agent: {n.resolution || "Resolved."}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
