import Image from "next/image";
import { cn } from "@/lib/ui/cn";

/** Vibrana V prism mark + wordmark, as in the brand.example.com nav. */
export function VibranaLogo({ size = 32, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <Image src={size > 64 ? "/vibrana-v-prism.png" : "/vibrana-v-prism-96.webp"} alt="Vibrana" width={size} height={size} priority />
      {wordmark && <span className="font-display text-lg font-semibold tracking-[0.05em] text-ink">VIBRANA</span>}
    </span>
  );
}

/** Tiny uppercase label (Prism Eyebrow). */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-pl-xs font-medium uppercase tracking-[0.12em] text-ink-3", className)}>{children}</p>;
}
