"use client";

import { useState, type ComponentProps } from "react";
import { keepSignedUrl } from "@/lib/signed-url";
import { WatchedVideo } from "@/components/media/watched-media";

/**
 * The URL to play: the one this player already has while a refresh only re-signed the same object (see
 * lib/signed-url.ts). Without it, any save on the page reloads every video mid-playback.
 */
export function useStableSignedUrl<T extends string | null | undefined>(src: T): T {
  const [kept, setKept] = useState(src);
  const stable = keepSignedUrl(kept, src, Date.now() / 1000);
  if (stable !== kept) setKept(stable);
  return stable;
}

/**
 * A <video> whose private, signed src survives a router.refresh() without restarting, and which retries a failed load
 * and reports a file the browser cannot play (WatchedVideo).
 */
export function SignedVideo({ src, ...props }: ComponentProps<typeof WatchedVideo>) {
  const stable = useStableSignedUrl(typeof src === "string" ? src : undefined);
  return <WatchedVideo {...props} src={stable} />;
}
