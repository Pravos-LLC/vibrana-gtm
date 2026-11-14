import { useId } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/ui/cn";

/**
 * A small "i" that shows an explanation on hover, keyboard focus or tap. CSS only, so it works in server components.
 * Keep the visible text short and put definitions, caveats and coverage detail here. The parent that may overlap its
 * neighbors needs `relative hover:z-20 focus-within:z-20`: cards blur their backdrop, which traps z-index inside each card.
 * The tip spans that parent (its nearest positioned ancestor) instead of starting at the "i", so a tile in the last
 * column never pushes it off screen, at any width or with the sidebar open.
 */
export function InfoTip({ children, label = "What this means", className }: {
  children: React.ReactNode; label?: string; className?: string;
}) {
  const id = useId();
  return (
    <span className={cn("group/tip static inline-flex align-middle", className)}>
      <button type="button" aria-label={label} aria-describedby={id}
        className="inline-flex rounded-full text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-strong)]">
        <Info aria-hidden className="size-3.5" />
      </button>
      <span role="tooltip" id={id}
        className={cn("pointer-events-none absolute inset-x-2 top-11 z-30 hidden rounded-lg border border-line bg-surface-raised p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-2 shadow-lg",
          // display:none at rest, not visibility: a hidden box that still takes layout space widens the page on a phone.
          "group-hover/tip:block group-focus-within/tip:block")}>
        {children}
      </span>
    </span>
  );
}
