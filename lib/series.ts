// Series names for people. A series key is a slug on the Story (`gtm_stories.series`,);
// the cockpit shows the label. A series without an entry here reads as its title-cased key, so a new series never
// shows a raw slug; add an entry when title case gets the name wrong.
export const SERIES_LABELS: Record<string, string> = {
  "example-shorts": "Example Series Shorts",
  "meridian-case-study": "Meridian Case Study",
};

/** "meridian-case-study" -> "Meridian Case Study". */
export function seriesLabel(key: string): string {
  return SERIES_LABELS[key] ?? key.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
