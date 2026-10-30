"use client";
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * "Back on per-platform review": shown once after "Leave shared review". The outcome rides in `?released=` across the
 * refresh, then leaves the URL at once, so a reload or a shared link never replays it (review #151 N2).
 */
export function ReleasedNotice({ released }: { released: string }) {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  useEffect(() => {
    if (!params.has("released")) return;
    const next = new URLSearchParams(params.toString());
    next.delete("released");
    router.replace(`${path}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [params, path, router]);
  return (
    <p role="status" className="mb-5 rounded border border-line p-3 text-sm" data-testid="released-notice">
      Back on per-platform review. Text approval {released[0] === "1" ? "kept" : "needs a new decision"}; video approval {released[1] === "1" ? "kept" : "needs a new decision"}.
    </p>
  );
}
