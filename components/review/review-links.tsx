"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { ShareForReview, type ShareForReviewAction } from "@/components/review/share-for-review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ReviewLinkRow = { id: string; party: string; state: "open" | "claimed" | "expired" | "revoked"; claimedEmail: string | null; expiresAt: string; createdAt: string };
type Revoke = (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;

const TONE = { open: "warning", claimed: "success", expired: "outline", revoked: "outline" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * Third-party review, at the top of /content: one "Share for review" per party (the same modal every piece with a
 * third party has), a preview of what they see, and the links that are out, to revoke.
 */
export function ReviewLinks({ parties, links, share, revoke }: { parties: Array<{ party: string; pieces: string[] }>; links: ReviewLinkRow[]; share: ShareForReviewAction; revoke: Revoke }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const live = links.filter((l) => l.state === "open" || l.state === "claimed");
  const end = (id: string) => {
    setError(null);
    start(async () => {
      const r = await revoke(id);
      if (!r.ok) setError(r.error); else router.refresh();
    });
  };

  return (
    <div className="rounded-lg border border-line px-4 py-3 text-sm">
      {parties.map(({ party, pieces }) => {
        const claimed = live.find((l) => l.party === party && l.state === "claimed");
        return (
          <div key={party} className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-ink">Third-party review: <strong>{party}</strong></span>
            <span className="text-xs text-ink-3">{pieces.length} final{pieces.length === 1 ? "" : "s"} ready{claimed ? ` · has access as ${claimed.claimedEmail ?? "a reviewer"}` : " · no access yet"}</span>
            <span className="ml-auto flex gap-1">
              <ShareForReview party={party} pieces={pieces} share={share} variant="default" />
              <Button size="sm" variant="ghost" asChild><a href={`/shared?party=${encodeURIComponent(party)}`} target="_blank" rel="noreferrer"><Eye /> Preview</a></Button>
            </span>
          </div>
        );
      })}
      {links.length > 0 && (
        <details className="group mt-2">
          <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">Links sent ({live.length} active)</summary>
          <ul className="mt-2 divide-y divide-line">
            {links.slice(0, 12).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <Badge variant={TONE[l.state]} className="py-0">{l.state}</Badge>
                <span className="text-ink">{l.party}</span>
                <span className="text-ink-3">{l.claimedEmail ?? (l.state === "open" ? `unused, open until ${day(l.expiresAt)}` : `made ${day(l.createdAt)}`)}</span>
                {(l.state === "open" || l.state === "claimed") && (
                  <Button size="sm" variant="ghost" className="ml-auto h-7" disabled={busy} onClick={() => end(l.id)}><X /> Revoke</Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-strong">{error}</p>}
    </div>
  );
}
