"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

const DetailsContext = createContext<{ open: string | null; toggle: (id: string) => void; host: HTMLDivElement | null } | null>(null);

/** Streamed server slots share one local disclosure state without changing the filter query.
 * Panel portals follow every trigger in the DOM, keeping keyboard order aligned with the layout. */
export function ContentDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <DetailsContext.Provider value={{ open, toggle: (id) => setOpen((current) => current === id ? null : id), host }}>
      <div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3">{children}</div>
        <div ref={setHost} />
      </div>
    </DetailsContext.Provider>
  );
}

export function ContentDetail({ name, label, children }: { name: string; label: ReactNode; children: ReactNode }) {
  const context = useContext(DetailsContext);
  const id = useId();
  // This streamed boundary must hydrate before it can add content to the shared host.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!context) throw new Error("ContentDetail needs ContentDetails");
  const expanded = context.open === name;
  return (
    <>
      <Button id={`${id}-trigger`} size="sm" variant={expanded ? "secondary" : "ghost"}
        className="max-w-full" aria-expanded={expanded} aria-controls={`${id}-panel`}
        onClick={() => context.toggle(name)}>
        {label}<ChevronDown className={expanded ? "rotate-180" : ""} aria-hidden="true" />
      </Button>
      {expanded && mounted && context.host && createPortal(<section id={`${id}-panel`} aria-labelledby={`${id}-trigger`}
        className="mt-3 min-w-0 border-t border-line pt-4">
        {children}
      </section>, context.host)}
    </>
  );
}

/** Pending and failed analysis never masquerade as a successful zero-findings result. */
export function SeasonDetailsStatus({ state }: { state: "loading" | "unavailable" }) {
  const message = state === "loading" ? "Loading season analysis…" : "Could not load the season analysis. Refresh to retry.";
  return (
    <>
      <ContentDetail name="season" label="Season analysis"><p className="text-sm text-ink-2">{message}</p></ContentDetail>
      <ContentDetail name="findings" label={`Findings (${state === "loading" ? "loading…" : "unavailable"})`}>
        <p className="text-sm text-ink-2">{message}</p>
      </ContentDetail>
      <p role={state === "loading" ? "status" : "alert"}
        className={`order-last basis-full text-xs ${state === "loading" ? "text-ink-3" : "text-red-strong"}`}>{message}</p>
    </>
  );
}
