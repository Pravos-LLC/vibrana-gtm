import { useId } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/ui/cn";

/**
 * A small "i" that shows an explanation on hover, keyboard focus or tap. CSS only, so it works in server components.
 * Keep the visible text short and put definitions, caveats and coverage detail here. The parent that may overlap its
 * neighbors needs `relative hover:z-20 focus-within:z-20`: cards blur their backdrop, which traps z-index inside each card.
 */
export function InfoTip({ children, label = "What this means", align = "start", className }: {
  children: React.ReactNode; label?: string; align?: "start" | "end"; className?: string;
}) {
  const id = useId();
  return (
    <span className={cn("group/tip relative inline-flex align-middle", className)}>
      <button type="button" aria-label={label} aria-describedby={id}
        className="inline-flex rounded-full text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-strong)]">
        <Info aria-hidden className="size-3.5" />
      </button>
      <span role="tooltip" id={id}
        className={cn("pointer-events-none invisible absolute top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface-raised p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-2 opacity-0 shadow-lg transition-opacity",
          "group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100",
          align === "end" ? "right-0" : "left-0")}>
        {children}
      </span>
    </span>
  );
}
