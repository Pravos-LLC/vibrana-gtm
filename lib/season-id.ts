// Season Story ids, alone so client components can test an id without pulling in yaml.
// Season N's pieces are `s<N>-...` (Season 1: `s1-01-example-record-1`, Sunday candidates `s1-c261012-...`).
/** Any season's piece: `s<N>-...`. Matching every season means bumping the season never hides live work. */
export const isSeasonStory = (id: string) => /^s\d+-/.test(id);
/**
 * Whether a Story belongs on the season board (/content, the review numbers, `gtm story hidden`): a `s<N>-` piece, or any
 * Story a season row claims through `season_id`. The id pattern alone left a Story like `example-reference-38` invisible, so its
 * copy waited for approval where John could never see it.
 */
export const onSeasonBoard = (story: { id: string; season_id?: string | null }) => isSeasonStory(story.id) || !!story.season_id;
/** The Story id prefix for a season row: `season-2` gives `s2-`; any other id gives `<id>-`. */
export const seasonStoryPrefix = (seasonId: string) => {
  const n = seasonId.match(/^season-(\d+)$/)?.[1];
  return n ? `s${n}-` : `${seasonId}-`;
};
