import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The Prism type scale (text-pl-xs .. text-pl-3xl, app/globals.css) is a font size. Without telling
// tailwind-merge, it reads `text-pl-2xl` as a text color and drops it whenever a color like `text-ink`
// follows, so the element silently fell back to the body size. Keep this list in step with the
// --pl-text-* scale in app/globals.css.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["pl-xs", "pl-sm", "pl-base", "pl-lg", "pl-xl", "pl-2xl", "pl-3xl"] }] } },
});

/** Merge class names with Tailwind-aware conflict resolution (same as brand.example.com's Prism cn). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
