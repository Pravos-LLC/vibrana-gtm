"use client";

// Every stored video and image the cockpit shows goes through these two elements (test/media-elements.test.ts fails on a
// raw <video>, or a raw <img> in the review, studio and shared screens). They do two things a bare element does not:
//
// 1. Ride out a transient failure. Supabase Storage answers a burst of requests with HTTP 429 (a JSON body, not media),
//    which a bare <img> shows as a blank slide forever (carousel s1-29, 2026-10-13). On an error the element retries up to
//    three times with backoff, each time with a freshly signed URL for the same object.
// 2. Tell someone when it really will not play. After the retries, or at once when the browser decodes no picture from a
//    video that did load, it shows a small red "Won't play, fixing" ("Won't load, fixing") badge and files a BLOCK note
//    on the asset (app/media-actions.ts), so the next agent sweep fixes it without John having to write "it won't play".
import { useCallback, useEffect, useRef, useState, type ComponentProps, type Ref, type RefCallback, type SyntheticEvent } from "react";
import { reportUnplayable, resignMedia } from "@/app/media-actions";

export const RETRY_DELAYS_MS = [600, 1800, 4500];

type Failure = { code: number | null; message: string; /** loaded, but no picture decoded */ decode?: boolean };

/** The badge shown once a file is reported. `overlay` sits on top of a positioned box; otherwise it follows the element. */
export function FixingBadge({ kind, overlay }: { kind: "video" | "image"; overlay: boolean }) {
  return (
    <span role="status" data-testid="media-fixing"
      className={`${overlay ? "absolute left-2 top-2 z-10" : "mt-1 inline-flex"} rounded-full bg-red-strong px-2 py-0.5 text-[11px] font-medium text-white shadow`}>
      {kind === "video" ? "Won't play, fixing" : "Won't load, fixing"}
    </span>
  );
}

/** Retry and report state for one element. `src` is the signed URL the page rendered. */
function useWatchedSrc(src: string | undefined, kind: "video" | "image") {
  const [current, setCurrent] = useState(src);
  const [failed, setFailed] = useState(false);
  const tries = useRef(0);
  const reported = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A new object (a new version, a refresh) starts over; a re-signed URL for the same object is kept by the caller.
  const [seen, setSeen] = useState(src);
  if (src !== seen) {
    setSeen(src); setCurrent(src); setFailed(false); tries.current = 0; reported.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const report = useCallback((f: Failure) => {
    setFailed(true);
    if (reported.current || !src) return;
    reported.current = true;
    const page = typeof window !== "undefined" ? window.location.pathname : null;
    void reportUnplayable({ src, code: f.code, message: f.message.slice(0, 200), page, decode: f.decode }).catch(() => {});
  }, [src]);

  /** An error event: retry with a fresh URL while tries remain, then report. */
  const onFailure = useCallback((f: Failure) => {
    if (!src) return;
    if (tries.current >= RETRY_DELAYS_MS.length) { report(f); return; }
    const delay = RETRY_DELAYS_MS[tries.current++];
    timer.current = setTimeout(async () => {
      let next: string | null = null;
      try { next = (await resignMedia([src]))[src] ?? null; } catch { next = null; }
      // Without a fresh signature the same URL is asked again (a cache-busting parameter makes it a new request).
      const base = next ?? src;
      setCurrent(`${base}${base.includes("?") ? "&" : "?"}retry=${tries.current}`);
    }, delay);
  }, [src, report]);

  return { current, failed, onFailure, report };
}

/** One ref for the caller and one for us. */
function useMergedRef<T>(outer: Ref<T> | undefined, inner: { current: T | null }): RefCallback<T> {
  return useCallback((el: T | null) => {
    inner.current = el;
    if (typeof outer === "function") outer(el);
    else if (outer) (outer as { current: T | null }).current = el;
  }, [outer, inner]);
}

type VideoProps = Omit<ComponentProps<"video">, "ref"> & { ref?: Ref<HTMLVideoElement>; badge?: "overlay" | "below" };

/** A <video> that retries a failed load and reports a file the browser cannot play. */
export function WatchedVideo({ src, ref, badge, onError, onLoadedMetadata, onTimeUpdate, preload, ...props }: VideoProps) {
  const { current, failed, onFailure, report } = useWatchedSrc(typeof src === "string" ? src : undefined, "video");
  const overlay = badge ? badge === "overlay" : /\babsolute\b/.test(String(props.className ?? ""));
  const checked = useRef(false);
  const el = useRef<HTMLVideoElement | null>(null);
  const setRef = useMergedRef(ref, el);
  // A server-rendered <video> can fail before React hydrates and attaches onError: catch that on mount.
  useEffect(() => {
    const v = el.current;
    if (v?.error) onFailure({ code: v.error.code, message: v.error.message || "the video failed to load before the page was ready" });
  }, [onFailure]);
  return (
    <>
      <video {...props} ref={setRef} src={current} preload={preload ?? "metadata"}
        data-media-state={failed ? "failed" : undefined}
        onError={(e: SyntheticEvent<HTMLVideoElement>) => {
          const err = e.currentTarget.error;
          onFailure({ code: err?.code ?? null, message: err?.message || "the video failed to load" });
          onError?.(e);
        }}
        onLoadedMetadata={(e) => {
          // Loaded, but no picture: a codec the browser cannot decode (H.264 4:4:4 plays sound over black, or nothing).
          const v = e.currentTarget;
          if (v.videoWidth === 0 && v.videoHeight === 0) report({ code: 3, message: "metadata loaded but the browser decodes no video picture", decode: true });
          onLoadedMetadata?.(e);
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (!checked.current && v.currentTime > 1.5 && typeof v.getVideoPlaybackQuality === "function") {
            checked.current = true;
            if (v.getVideoPlaybackQuality().totalVideoFrames === 0) report({ code: 3, message: "playing, but no video frame was decoded", decode: true });
          }
          onTimeUpdate?.(e);
        }} />
      {failed && <FixingBadge kind="video" overlay={overlay} />}
    </>
  );
}

type ImageProps = Omit<ComponentProps<"img">, "ref"> & { ref?: Ref<HTMLImageElement>; badge?: "overlay" | "below" };

/** An <img> that loads lazily, retries a failed load with a fresh URL and reports an image that will not load. */
export function WatchedImage({ src, ref, badge, onError, loading, decoding, alt, ...props }: ImageProps) {
  const { current, failed, onFailure } = useWatchedSrc(typeof src === "string" ? src : undefined, "image");
  const overlay = badge ? badge === "overlay" : /\babsolute\b/.test(String(props.className ?? ""));
  const el = useRef<HTMLImageElement | null>(null);
  const setRef = useMergedRef(ref, el);
  // A server-rendered <img> can fail before React hydrates and attaches onError (a burst of 429s does exactly that):
  // a finished image with no pixels is a failed load.
  useEffect(() => {
    const img = el.current;
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src")) onFailure({ code: null, message: "the image failed to load before the page was ready" });
  }, [onFailure]);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...props} ref={setRef} alt={alt ?? ""} src={current} loading={loading ?? "lazy"} decoding={decoding ?? "async"}
        data-media-state={failed ? "failed" : undefined}
        onError={(e) => { onFailure({ code: null, message: "the image failed to load" }); onError?.(e); }} />
      {failed && <FixingBadge kind="image" overlay={overlay} />}
    </>
  );
}

