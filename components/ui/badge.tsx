import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui/cn";

// Prism status chips: accent at 10% tint with the WCAG-deepened accent as text.
const badgeVariants = cva("inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "border-transparent bg-violet/10 text-violet-strong",
      success: "border-transparent bg-[color:var(--emerald)]/15 text-emerald-strong",
      warning: "border-transparent bg-[color:var(--amber)]/15 text-amber-strong",
      destructive: "border-transparent bg-destructive/10 text-red-strong",
      info: "border-transparent bg-[color:var(--blue)]/10 text-blue-strong",
      outline: "border-[color:var(--border-default)] text-ink-2",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
