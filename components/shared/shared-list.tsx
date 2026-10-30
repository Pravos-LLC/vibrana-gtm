import { SharedPieceCard, type DecideAsset } from "@/components/shared/shared-piece";
import type { SharedPiece } from "@/lib/reviewer/shared";

/** The review page's body: the full episode, then its shorts. Shared by /shared (a reviewer, or the owner's preview) and /view (a read-only link). */
export function SharedList({ pieces, decide, preview }: { pieces: SharedPiece[]; decide: DecideAsset; preview: boolean }) {
  const ready = pieces.filter((p) => p.state === "final");
  const waiting = ready.reduce((n, p) => n + p.assets.filter((a) => a.reviewable && a.decision !== "approved").length, 0);
  const episodes = pieces.filter((p) => p.format === "episode");
  const shorts = pieces.filter((p) => p.format === "short");
  const card = (p: SharedPiece) => <SharedPieceCard key={p.storyId} piece={p} decide={decide} preview={preview} />;
  return (
    <>
          <p className="mb-6 text-sm text-ink-2">
            {!pieces.length ? "Nothing is ready for you yet."
              : waiting ? `${episodes.length ? "The full episode" : ""}${episodes.length && shorts.length ? " and " : ""}${shorts.length ? `${shorts.length} ${shorts.length === 1 ? "short" : "shorts"}` : ""}: ${waiting} ${waiting === 1 ? "video is" : "videos are"} waiting for your review. Approve each one as it is, or ask for changes and we will send a new version. Nothing goes out until every video is approved.`
              : ready.length ? "You are up to date. New versions will appear here." : "Nothing is ready for you yet. Finals appear here as they are finished."}
          </p>
          {episodes.length > 0 && (
            <section className="mb-10 space-y-6">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-ink-3">The full episode</h2>
              {episodes.map(card)}
            </section>
          )}
          {shorts.length > 0 && (
            <section className="space-y-5">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-ink-3">The {shorts.length} shorts</h2>
              <p className="text-sm text-ink-2">Exactly as they will be posted.</p>
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{shorts.map(card)}</div>
            </section>
          )}
        </>
  );
}
