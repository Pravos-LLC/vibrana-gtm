"use client";

import { ContentToolbar } from "@/components/review/content-toolbar";
import { SeriesSection } from "@/components/review/series-section";
import { seriesOptions } from "@/lib/season-review";
import { OverviewStrip } from "@/components/review/overview-strip";
import { PieceList } from "@/components/review/season-piece";
import { ReviewProvider, type ReviewActions } from "@/components/review/review-store";
import { buildGroups, dateRange, filterPieces, parseFilters, pieceParts } from "@/lib/season-review";
import type { Fixture } from "./fixture-data";
import { REVIEW_CHANNELS, type ReviewChannel } from "@/lib/season";
import { SeasonPanel } from "@/components/review/season-panel";
import type { SeasonAnalysis, SeasonRecord } from "@/lib/season-analysis";

type FixtureSeason = { record: SeasonRecord; analysis: SeasonAnalysis; pillarOptions: { slug: string; name: string }[] };

/** The same composition as app/content/page.tsx, with fake server calls that wait `latency` ms. */
export function FixtureBoard({ fixture, season, params, latency }: { fixture: Fixture; season: FixtureSeason; params: Record<string, string | string[] | undefined>; latency: number }) {
  const filters = parseFilters(params);
  const wait = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), latency));
  const actions: ReviewActions = {
    setPartApproval: () => wait({ ok: true as const }),
    setTextApprovalAll: () => wait({ ok: true as const }),
    setMediaApproval: () => wait({ ok: true as const }),
    approveTextWithNote: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    requestTextChangesAll: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    approveTextWithNoteAll: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    approveMediaWithNote: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    requestMediaChanges: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    decideStage: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    reopenStage: () => wait({ ok: true as const }),
    addSeriesNote: () => wait({ ok: true as const, failed: [] }),
    requestChanges: ({ note }) => (note.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    saveSeasonCopy: ({ prose, expectedRevision, overwrite }) => (prose.includes("CONFLICT") && !overwrite
      ? wait({ ok: false as const, error: `An agent updated this text while you were editing (now v${expectedRevision + 1}). Your edit is still here.`, conflict: { revision: expectedRevision + 1 } })
      : wait({ ok: true as const, sha256: "x", revision: expectedRevision + (overwrite ? 2 : 1) })),
    shareForReview: ({ party, fresh }) => wait({ ok: true as const, share: fresh || !party.includes("example_approver")
      ? { kind: "invite" as const, party, url: "https://cockpit.example/invite/fixture-token-0000000000000000000000000", email: null }
      : { kind: "access" as const, party, url: "https://cockpit.example/shared", email: "partner@example.com" } }),
    killPiece: () => wait({ ok: true as const }),
    markPublished: ({ url }) => (url.includes("FAIL") ? wait({ ok: false as const, error: "The database said no." }) : wait({ ok: true as const })),
    setStoryHold: ({ held, who, note }) => wait({ ok: true as const, hold: held ? { who: who ?? "", note: note ?? "", heldAt: new Date().toISOString(), kind: "hold" as const, finalStaged: true } : null }),
  };
  // Grouped before filtering, as app/content/page.tsx does: a status filter must not regroup a shared file under a key with no state.
  const pieces = fixture.pieces.map((p) => ({ ...p, groups: p.groups ?? buildGroups(p.cards) }));
  const { initial, summary, stages } = pieceParts(pieces);
  const visible = filterPieces(pieces, filters);
  const shown = visible.reduce((n, p) => n + p.cards.length, 0);
  return (
    <ReviewProvider key={JSON.stringify(filters)} initial={initial} summary={summary} stages={stages} actions={actions}>
      <div className="space-y-5">
        <OverviewStrip range={dateRange(pieces.map((p) => p.date))} analysis={
          <SeasonPanel season={season.record} analysis={season.analysis} pillarOptions={season.pillarOptions} path="/dev-fixtures/content"
            save={(input) => wait(input.title.includes("FAIL") ? { ok: false as const, error: "The database said no." } : { ok: true as const })} />
        } />
        <ContentToolbar path="/dev-fixtures/content" filters={filters} pieces={pieces.map((p) => ({ id: p.storyId, label: p.name }))} pillars={["build", "perspective"]} shown={shown} total={summary.length} {...seriesOptions(pieces)} />
        <SeriesSection all={pieces} filters={filters} path="/dev-fixtures/content" />
        <PieceList pieces={visible} focus={filters.focus} open={filters.piece && typeof params.channel === "string" && (REVIEW_CHANNELS as string[]).includes(params.channel) ? { storyId: filters.piece, channel: params.channel as ReviewChannel } : null} />
      </div>
    </ReviewProvider>
  );
}
