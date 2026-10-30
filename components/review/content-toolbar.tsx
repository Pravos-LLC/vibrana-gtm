"use client";

import { contentQuery } from "@/lib/content-filters";
import { PLATFORM } from "@/components/brand-icons";
import { FilterToolbar, type FilterSelect } from "@/components/ui/filter-toolbar";
import { REVIEW_CHANNELS } from "@/lib/season";
import { CONTENT_REMEMBERED } from "@/lib/filter-memory";
import { seriesLabel } from "@/lib/series";
import { STATUS_FILTERS, STATUS_FILTER_LABEL, activeFilterCount, hasFilters, type Filters } from "@/lib/season-review";

/** /content's search and filters: the shared FilterToolbar with the season's facets. */
export function ContentToolbar({ path, filters, pieces, pillars, shown, total, series = [], stages = [] }: {
  path: string; filters: Filters; pieces: { id: string; label: string }[]; pillars: string[]; shown: number; total: number;
  /** Series and stages present in the season, for the two selects (empty: the select is not shown). */
  series?: string[]; stages?: { key: string; label: string }[];
}) {
  const platformLabel = (p: string) => (p === "newsletter" ? "Substack" : PLATFORM[p as keyof typeof PLATFORM]?.label ?? p);
  const chips = [
    ...(filters.platform ? [{ key: "platform" as const, label: `Platform: ${platformLabel(filters.platform)}` }] : []),
    ...(filters.status ? [{ key: "status" as const, label: `Status: ${STATUS_FILTER_LABEL[filters.status]}` }] : []),
    ...(filters.pillar ? [{ key: "pillar" as const, label: `Pillar: ${filters.pillar}` }] : []),
    ...(filters.piece ? [{ key: "piece" as const, label: `Piece: ${pieces.find((p) => p.id === filters.piece)?.label ?? filters.piece}` }] : []),
    ...(filters.series ? [{ key: "series" as const, label: `Series: ${seriesLabel(filters.series)}` }] : []),
    ...(filters.stage ? [{ key: "stage" as const, label: `Stage: ${stages.find((s) => s.key === filters.stage)?.label ?? filters.stage}` }] : []),
    ...(filters.q ? [{ key: "q" as const, label: `Search: ${filters.q}` }] : []),
  ].map((c) => ({ ...c, href: `${path}${contentQuery({ ...filters, [c.key]: "" })}` }));
  const selects: FilterSelect[] = [
    { name: "platform", label: "Platform", value: filters.platform, options: [{ value: "", label: "Any platform" }, ...REVIEW_CHANNELS.map((r) => ({ value: r, label: platformLabel(r) }))] },
    { name: "status", label: "Status", value: filters.status || "all", options: [{ value: "all", label: "Any status" }, ...STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_FILTER_LABEL[s] }))] },
    ...(pillars.length ? [{ name: "pillar", label: "Pillar", value: filters.pillar, options: [{ value: "", label: "Any pillar" }, ...pillars.map((p) => ({ value: p, label: p }))] }] : []),
    { name: "piece", label: "Piece", value: filters.piece, options: [{ value: "", label: "Any piece" }, ...pieces.map((p) => ({ value: p.id, label: p.label }))] },
    ...(series.length ? [{ name: "series", label: "Series", value: filters.series, options: [{ value: "", label: "Any series" }, ...series.map((s) => ({ value: s, label: seriesLabel(s) }))] }] : []),
    ...(stages.length ? [{ name: "stage", label: "Stage", value: filters.stage, options: [{ value: "", label: "Any stage" }, ...stages.map((s) => ({ value: s.key, label: s.label }))] }] : []),
  ];
  return (
    <FilterToolbar path={path} query={contentQuery(filters)} id="content" label="Search and filter the season" q={filters.q}
      searchLabel="Search the season" placeholder="Search pieces, copy and notes" selects={selects} chips={chips}
      count={activeFilterCount(filters)} summary={shown === total ? `${total} platform cards` : `Showing ${shown} of ${total} platform cards`}
      clear={hasFilters(filters) ? `${path}?status=all` : null} remember={CONTENT_REMEMBERED} hidden={filters.focus ? { focus: "1" } : {}} />
  );
}
