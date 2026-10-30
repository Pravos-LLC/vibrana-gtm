import { LogOut } from "lucide-react";
import { VibranaLogo } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SharedList } from "@/components/shared/shared-list";
import { sessionDb } from "@/lib/supabase/server";
import { adminDb } from "@/lib/db";
import { loadShared, type SharedPiece } from "@/lib/reviewer/shared";
import { decideAsset } from "./actions";

export const dynamic = "force-dynamic";
// An approval schedules after the response (lib/schedule-approved.ts); an episode final streams its multi-GB master
// from storage to Zernio in that run, so the function gets the Pro plan's full duration.
export const maxDuration = 800;

// A third party's whole cockpit: their pieces, nothing else (no sidebar, no links out). The parties come from the
// database (gtm_reviewer_parties: claimed, unrevoked invites); the owner may preview one with ?party=.
export const metadata = { title: "Shared review" };

export default async function SharedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const db = await sessionDb();
  const { data } = await db.auth.getClaims();
  const owner = (data?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  const asked = (await searchParams).party;
  let parties: string[] = [];
  if (owner) {
    parties = typeof asked === "string" && asked.trim() ? [asked.trim()] : [];
  } else {
    const { data: mine } = await db.rpc("gtm_reviewer_parties");
    parties = (mine as string[] | null) ?? [];
  }

  let pieces: SharedPiece[] = [];
  let failed: string | null = null;
  if (parties.length) {
    try { pieces = await loadShared(adminDb(), parties); } catch (e) { failed = e instanceof Error ? e.message : String(e); }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <VibranaLogo size={32} wordmark={false} />
          <div>
            <p className="font-display text-sm font-semibold tracking-[0.05em] text-ink">VIBRANA</p>
            <p className="text-xs text-ink-3">{parties.length ? `Shared for review with ${parties.join(", ")}` : "Shared for review"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {!owner && (
            <form action="/auth/signout" method="post">
              <Button type="submit" size="sm" variant="ghost"><LogOut /> Sign out</Button>
            </form>
          )}
        </div>
      </header>

      {owner && <p className="mb-4 rounded-lg border border-line px-4 py-3 text-sm text-ink-2">Owner preview{parties.length ? `: exactly what ${parties[0]} sees` : ". Add ?party=<who> to see a third party's view"}.</p>}

      {!parties.length && !owner && (
        <Card glow={false} className="p-8 text-center text-ink-2">Nothing is shared with this account. If you expected something here, ask John for a new link.</Card>
      )}
      {failed && <p className="text-sm text-red-strong">Could not load your pieces. Refresh the page in a moment.</p>}
      {parties.length > 0 && !failed && <SharedList pieces={pieces} decide={decideAsset} preview={owner} />}
    </main>
  );
}
