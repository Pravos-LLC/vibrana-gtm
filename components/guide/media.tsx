"use client";
import { useEffect, useRef, useState } from "react";
import type { SignedMedia } from "@/lib/guide/media";
import { cn } from "@/lib/ui/cn";
import { WatchedImage, WatchedVideo } from "@/components/media/watched-media";

/**
 * A video that loads nothing but its poster until it nears the viewport. `ambient` plays it muted
 * and looped while visible (never under prefers-reduced-motion); otherwise it shows native controls.
 */
export function GuideVideo({ media, ambient = false, className, label }: { media: SignedMedia; ambient?: boolean; className?: string; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setNear(true);
      if (!ambient || reduce) return;
      if (e.isIntersecting) el.play().catch(() => {});
      else el.pause();
    }, { rootMargin: "200px 0px", threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [ambient]);
  return (
    <WatchedVideo
      ref={ref}
      src={near ? media.src : undefined}
      poster={media.posterSrc ?? undefined}
      muted={ambient}
      loop={ambient}
      playsInline
      controls={!ambient}
      preload="none"
      aria-label={label}
      width={media.w}
      height={media.h}
      className={cn("h-auto w-full bg-black object-cover", className)}
    />
  );
}

export function GuideImage({ media, alt, className, eager }: { media: SignedMedia; alt: string; className?: string; eager?: boolean }) {
  // Signed URLs expire, so next/image's optimizer cache can't key on them; the source is already WebP at <=1600px.
    return <WatchedImage src={media.src} alt={alt} width={media.w} height={media.h} loading={eager ? "eager" : "lazy"} decoding="async" className={cn("h-auto w-full object-cover", className)} />;
}
