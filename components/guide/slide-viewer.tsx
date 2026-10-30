"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GuideImage } from "@/components/guide/media";
import type { SignedMedia } from "@/lib/guide/media";

/** One carousel at a time: a picker of covers, then the chosen carousel's slides with prev and next. */
export function SlideViewer({ carousels }: { carousels: { slug: string; title: string; slides: SignedMedia[] }[] }) {
  const [c, setC] = useState(0);
  const [s, setS] = useState(0);
  const deck = carousels[c];
  if (!deck) return null;
  const go = (d: number) => setS((x) => (x + d + deck.slides.length) % deck.slides.length);
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,26rem)_1fr]">
      <div>
        <div className="relative overflow-hidden rounded-2xl border border-line">
          <GuideImage key={deck.slides[s].key} media={deck.slides[s]} alt={`${deck.title}, slide ${s + 1} of ${deck.slides.length}`} className="aspect-[4/5]" />
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-3">
            <button type="button" onClick={() => go(-1)} aria-label="Previous slide" className="grid size-9 place-items-center rounded-full bg-[color:var(--surface-inset)] text-ink shadow-sm active:scale-95"><ChevronLeft className="size-4" /></button>
            <span className="rounded-full bg-[color:var(--surface-inset)] px-2.5 py-1 text-xs tabular-nums text-ink-2">{s + 1} / {deck.slides.length}</span>
            <button type="button" onClick={() => go(1)} aria-label="Next slide" className="grid size-9 place-items-center rounded-full bg-[color:var(--surface-inset)] text-ink shadow-sm active:scale-95"><ChevronRight className="size-4" /></button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 content-start gap-3 sm:grid-cols-3">
        {carousels.map((x, i) => (
          <button key={x.slug} type="button" onClick={() => { setC(i); setS(0); }} aria-pressed={i === c}
            className="group overflow-hidden rounded-xl border border-line text-left transition-[border-color,transform] duration-200 active:scale-[0.98] aria-pressed:border-[color:var(--border-strong)]">
            <GuideImage media={x.slides[0]} alt="" className="aspect-[4/5] transition-opacity group-aria-pressed:opacity-100 opacity-80" />
            <span className="block truncate px-2.5 py-2 text-xs text-ink-2">{x.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
