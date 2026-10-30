"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/ui/cn";

export type Chapter = { id: string; title: string };

function useActive(chapters: Chapter[]) {
  const [active, setActive] = useState(chapters[0]?.id);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    chapters.forEach((c) => { const el = document.getElementById(c.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [chapters]);
  return active;
}

/** Sticky chapter list beside the article on desktop. Tracks the chapter in view. */
export function ChapterRail({ chapters }: { chapters: Chapter[] }) {
  const active = useActive(chapters);
  return (
      <nav aria-label="Chapters" className="hidden lg:block">
        <ol className="sticky top-24 space-y-1 text-sm">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <a href={`#${c.id}`} aria-current={active === c.id ? "true" : undefined}
                className={cn("flex items-baseline gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-200", active === c.id ? "bg-[color:var(--surface-card-hover)] text-ink" : "text-ink-3 hover:text-ink-2")}>
                <span className="font-mono text-[0.7rem] tabular-nums">{String(i + 1).padStart(2, "0")}</span>{c.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
  );
}

/** The same chapters as a scrollable chip row pinned under the header on phones and tablets. */
export function ChapterChips({ chapters }: { chapters: Chapter[] }) {
  const active = useActive(chapters);
  return (
      <nav aria-label="Chapters" className="sticky top-16 z-10 -mx-4 overflow-x-auto border-b border-line bg-[color:var(--surface-nav)] px-4 py-2 backdrop-blur-md lg:hidden">
        <ol className="flex gap-1.5 text-xs">
          {chapters.map((c) => (
            <li key={c.id}>
              <a href={`#${c.id}`} className={cn("block whitespace-nowrap rounded-full border px-3 py-1.5", active === c.id ? "border-[color:var(--border-strong)] text-ink" : "border-line text-ink-3")}>{c.title}</a>
            </li>
          ))}
        </ol>
      </nav>
  );
}
