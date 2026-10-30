"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Columns2, MapPin } from "lucide-react";
import { clock, type WhatChanged } from "@/lib/what-changed";
import type { DiffPart } from "@/lib/text-diff";
import { SignedVideo } from "@/components/media/signed-video";

/**
 * Everything the agent wrote about a part (its changelog, its replies to resolved notes, jump points, a compare with an
 * earlier version), folded into one closed, quiet disclosure under the decision. John decides from the media itself
 * (John, 2026-10-13: "agent noise is not what humans need to make decisions"); the data stays in the database.
 */
export function History({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-4 text-xs text-ink-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 hover:text-ink-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3 -rotate-90 transition-transform group-open:rotate-0" /> History
      </summary>
      <div className="mt-2 space-y-3">{children}</div>
    </details>
  );
}

/**
 * Inside History when there is a newer version than the one John decided on: what the agent says changed, the notes
 * it answered, what is provably unchanged (same input hashes), and jump points that seek the video.
 */
export function WhatChangedPanel({ info, onSeek }: { info: WhatChanged; onSeek?: (t: number) => void }) {
  if (!info.since && !info.points.length) return null;
  return (
    <div className="text-xs text-ink-3" role="region" aria-label="What changed">
      {info.since && (
        <>
          <p className="font-medium text-ink-2">New since {info.since.label} ({info.since.why})</p>
          {info.summary.length > 0 && (
            <ul className="mt-1.5 space-y-1 text-ink-2">
              {info.summary.map((s) => <li key={s.label}><span className="text-ink-3">{s.label}:</span> {s.text}</li>)}
            </ul>
          )}
          {info.addressed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {info.addressed.map((n, i) => (
                <li key={i} className="text-ink-2">
                  <span className="text-ink-3">Your note:</span> {n.body}
                  {n.resolution && <span className="block">Agent: {n.resolution}</span>}
                </li>
              ))}
            </ul>
          )}
          {info.unchanged.length > 0 && (
            <p className="mt-2 inline-flex items-start gap-1">
              <Check className="mt-0.5 size-3 shrink-0" aria-hidden />
              Unchanged since {info.since.why}: {info.unchanged.join(", ")}. Only look at what was added.
            </p>
          )}
        </>
      )}
      {info.points.length > 0 && (
        <div className={info.since ? "mt-2" : ""}>
          <p className="mb-1 text-ink-3">Jump to</p>
          <span className="flex flex-wrap gap-1">
            {info.points.map((p) => (
              <button key={`${p.t}-${p.label}`} type="button" onClick={() => onSeek?.(p.t)} aria-label={`Jump to ${clock(p.t)}: ${p.label}`}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-[color:var(--surface-inset)] px-2 py-0.5 text-[11px] text-ink-2 hover:border-violet hover:text-ink">
                <MapPin className="size-3" aria-hidden />{clock(p.t)} {p.label}
              </button>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Word-level changes in a caption since the version John last decided on. */
export function TextDiff({ parts, since }: { parts: DiffPart[]; since: string }) {
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer text-ink-2">What changed since {since}</summary>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink" aria-label={`Changes since ${since}`}>
        {parts.map((p, i) => p.type === "same" ? <span key={i}>{p.text}</span>
          : p.type === "add" ? <ins key={i} className="bg-[color:var(--emerald)]/20 no-underline">{p.text}</ins>
          : <del key={i} className="bg-destructive/10 text-red-strong">{p.text}</del>)}
      </p>
    </details>
  );
}

/** Two versions side by side on one playhead: play, pause and seek on either moves both. */
export function VersionCompare({ before, after, width, ratio }: { before: { src: string; label: string }; after: { src: string; label: string }; width: number; ratio: number }) {
  const a = useRef<HTMLVideoElement>(null), b = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const pair = [a.current, b.current];
    if (!pair[0] || !pair[1]) return;
    let syncing = false;
    const follow = (from: HTMLVideoElement, to: HTMLVideoElement) => () => {
      if (syncing) return;
      syncing = true;
      if (Math.abs(to.currentTime - from.currentTime) > 0.15) to.currentTime = from.currentTime;
      if (from.paused !== to.paused) void (from.paused ? to.pause() : to.play().catch(() => undefined));
      syncing = false;
    };
    const offs: Array<() => void> = [];
    for (const [from, to] of [[pair[0], pair[1]], [pair[1], pair[0]]] as const) {
      const f = follow(from, to);
      for (const ev of ["play", "pause", "seeked"]) { from.addEventListener(ev, f); offs.push(() => from.removeEventListener(ev, f)); }
    }
    return () => offs.forEach((off) => off());
  }, []);
  const box = { width: width / 2 - 4, aspectRatio: String(ratio) } as const;
  return (
    <div className="flex gap-2" role="group" aria-label={`Compare ${before.label} with ${after.label}`}>
      {[{ v: before, r: a }, { v: after, r: b }].map(({ v, r }) => (
        <figure key={v.label} className="min-w-0">
          <SignedVideo ref={r} src={v.src} controls playsInline muted={v === before} preload="metadata" style={box} className="block rounded-lg bg-black object-contain" />
          <figcaption className="mt-1 text-center text-[11px] text-ink-3">{v.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The compare toggle: shown when an earlier decided version can be played next to the latest. */
export function useCompare() {
  const [on, setOn] = useState(false);
  const toggle = (label: string) => (
    <button type="button" onClick={() => setOn((x) => !x)} aria-pressed={on}
      className="inline-flex items-center gap-1 text-xs text-ink-3 underline underline-offset-4 hover:text-ink">
      <Columns2 className="size-3" aria-hidden /> {on ? "Back to the latest" : `Compare with ${label}`}
    </button>
  );
  return { on, toggle };
}
