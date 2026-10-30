import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui/cn";

// shadcn Button from brand.example.com, customised: `default` is the Prism primary CTA
// (violet fill, rainbow edge + glow on hover); `secondary` is the Prism hairline button.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "btn-prism",
        secondary: "border border-[color:var(--border-default)] bg-transparent text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink hover:border-[color:var(--border-strong)]",
        outline: "border border-[color:var(--border-strong)] bg-[color:var(--surface-frost)] text-ink shadow-sm hover:bg-[color:var(--surface-card-hover)]",
        ghost: "text-ink-2 hover:bg-accent hover:text-ink",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-violet-strong underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-5",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
