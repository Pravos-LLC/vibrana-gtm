"use client";

import { pieceView, seriesOptions, type Filters, type PieceData } from "@/lib/season-review";
export { seriesOptions };
import { SeriesReview } from "./series-review";
import { seriesLabel } from "@/lib/series";

/** A filtered series gets its strip; the unfiltered season shows one folded row per series. */
export function SeriesSection({ all, filters, path }: { all: PieceData[]; filters: Filters; path: string }) {
  const { series } = seriesOptions(all);
  const unfiltered = !filters.q && !filters.platform && !filters.status && !filters.pillar && !filters.piece && !filters.stage && !filters.series;
  if (filters.series && !filters.focus) return <SeriesReview series={filters.series} pieces={all.filter((p) => p.pipeline?.series === filters.series)} path={path} />;
  if (!unfiltered) return null;
  return (
    <>
      {series.map((s) => {
        const pieces = all.filter((p) => p.pipeline?.series === s);
        const view = pieces[0] ? pieceView(pieces[0]) : null;
        return (
          <details key={s} className="group rounded-xl border border-line">
            <summary className="cursor-pointer px-4 py-2.5 text-sm text-ink-2 hover:text-ink">
              <span className="font-medium text-ink">{seriesLabel(s)}</span> · {pieces.length} pieces{view ? ` · ${view.pipeline.label} pipeline` : ""}
            </summary>
            <div className="p-2"><SeriesReview series={s} pieces={pieces} path={path} /></div>
          </details>
        );
      })}
    </>
  );
}
