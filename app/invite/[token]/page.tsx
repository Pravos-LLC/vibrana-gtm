import { VibranaLogo } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card } from "@/components/ui/card";
import { SharedList } from "@/components/shared/shared-list";
import { adminDb } from "@/lib/db";
import { sessionDb } from "@/lib/supabase/server";
import { validToken } from "@/lib/reviewer/access";
import { findInvite } from "@/lib/reviewer/invites";
import { loadShared, type SharedPiece } from "@/lib/reviewer/shared";
import { decideAssetByLink } from "../../shared/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review", robots: { index: false, follow: false } };
// An approval schedules after the response (lib/schedule-approved.ts); an episode final streams its master to Zernio in that run.
export const maxDuration = 800;

// A private review link (/invite/<token>) IS the review page: no account, no login, the approve buttons right there
// (John, 2026-10-15). The 256-bit token is the credential: only its hash is stored, it names one party, a revoked or
// expired link shows nothing, and the database checks it again on every decision. The owner opening it sees the page
// without buttons, so John's visit never approves anything.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = validToken(token) ? await findInvite(adminDb(), token).catch(() => null) : null;
  const live = !!invite && !invite.revoked_at && new Date(invite.expires_at) > new Date();

  const { data } = await (await sessionDb()).auth.getClaims();
  const owner = (data?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;

  let pieces: SharedPiece[] = [];
  let failed = false;
  if (live) { try { pieces = await loadShared(adminDb(), [invite!.party]); } catch { failed = true; } }

  // Bound here so the browser only ever holds the link it already has.
  async function decide(input: { assetId: string; decision: "approved" | "changes" | "note"; note: string; sha256: string; revision: number }) {
    "use server";
    return decideAssetByLink(token, input);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <VibranaLogo size={32} wordmark={false} />
          <div>
            <p className="font-display text-sm font-semibold tracking-[0.05em] text-ink">VIBRANA</p>
            <p className="text-xs text-ink-3">{live ? `Shared for review with ${invite!.party}` : "Shared for review"}</p>
          </div>
        </div>
        <ThemeToggle />
      </header>
      {owner && live && <p className="mb-4 rounded-lg border border-line px-4 py-3 text-sm text-ink-2">Owner preview: exactly what {invite!.party} sees, without the buttons, so opening it never approves anything.</p>}
      {!live && <Card glow={false} className="p-8 text-center text-ink-2">This link is no longer valid. Ask John for a new one.</Card>}
      {live && failed && <p className="text-sm text-red-strong">Could not load the page. Refresh in a moment.</p>}
      {live && !failed && <SharedList pieces={pieces} decide={decide} preview={owner} />}
    </main>
  );
}
