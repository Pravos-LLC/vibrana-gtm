// Pure ranking logic for the Signal Desk: Clef questions and their interpretation, clustering by
// embedding similarity, and story scores. No I/O here, so every rule is unit-tested.
import type { ClefAnswer, ClefQuestion } from "./cloudflare";
import type { SignalsConfig, SourceKind } from "./config";

export type ItemRow = {
  id: string; url: string; source: string; source_kind: SourceKind; author: string | null; title: string; body: string;
  published_at: string | null; fetched_at: string; metrics: Record<string, number>;
  lanes: Record<string, number> | null; flags: Record<string, number> | null; relevant: boolean | null;
  classified_at: string | null; embedding: number[] | null; story_id: string | null;
};

/** Clef question ids may hold letters, digits, '_', '.', '-'. Lanes and flags get distinct prefixes. */
export function clefQuestions(cfg: SignalsConfig): Record<string, ClefQuestion> {
  const out: Record<string, ClefQuestion> = {};
  for (const lane of cfg.lanes) out[`lane.${lane.slug}`] = { type: "noul", instructions: lane.question };
  for (const [name, question] of Object.entries(cfg.flags)) out[`flag.${name}`] = { type: "noul", instructions: question };
  return out;
}

export function clefState(item: Pick<ItemRow, "title" | "body" | "source" | "author">): string {
  const head = [item.title, [item.source, item.author].filter(Boolean).join(" · ")].join("\n");
  return `${head}\n\n${item.body ?? ""}`.trim().slice(0, 6000);
}

const prob = (a: ClefAnswer | undefined) => (a && a.type === "noul" ? a.noul : 0);

/**
 * Lane and flag probabilities from one Clef response. An item is relevant when any lane clears its
 * threshold and it is not plainly hype or an ad (substance under 0.25 is dropped).
 */
export function interpret(cfg: SignalsConfig, answers: Record<string, ClefAnswer>) {
  const lanes: Record<string, number> = {};
  for (const lane of cfg.lanes) lanes[lane.slug] = round(prob(answers[`lane.${lane.slug}`]));
  const flags: Record<string, number> = {};
  for (const name of Object.keys(cfg.flags)) flags[name] = round(prob(answers[`flag.${name}`]));
  const hit = cfg.lanes.some((lane) => lanes[lane.slug] >= lane.threshold);
  return { lanes, flags, relevant: hit && (flags.substance ?? 1) >= 0.25 };
}

export function topLanes(cfg: SignalsConfig, lanes: Record<string, number>): string[] {
  return cfg.lanes.filter((l) => (lanes[l.slug] ?? 0) >= l.threshold).sort((a, b) => lanes[b.slug] - lanes[a.slug]).map((l) => l.slug);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type ClusterStory = { id: string; centroid: number[]; item_count: number; title: string; isNew?: boolean };
export type ClusterItem = { id: string; embedding: number[]; title: string };
/** Decides whether an item reports the same specific event as a story (Clef in production). */
export type SameStoryJudge = (item: ClusterItem, story: ClusterStory) => Promise<boolean>;

/**
 * Online clustering. An item joins the most similar story at or above `cutoff`. Embeddings alone cannot
 * tell a tweet and a headline about the same news from two stories on the same topic (measured: same
 * event 0.55-0.88, unrelated top 0.1% at 0.77), so for stories between `floor` and `cutoff` the judge
 * decides, best candidate first, up to `maxJudged`. Otherwise the item starts a new story. Centroids
 * are running means, so a story drifts with its coverage.
 */
export async function assignClusters(
  items: ClusterItem[], stories: ClusterStory[], opts: { cutoff: number; floor: number; maxJudged?: number; judge?: SameStoryJudge; newId: () => string; stop?: () => boolean },
) {
  const pool = stories.map((s) => ({ ...s, centroid: [...s.centroid] }));
  const assignment = new Map<string, string>();
  let judged = 0;
  for (const item of items) {
    // Out of time: leave the rest unassigned for the next run rather than clustering them blind.
    if (opts.stop?.()) break;
    const ranked = pool.map((story) => ({ story, sim: cosine(item.embedding, story.centroid) })).sort((a, b) => b.sim - a.sim);
    let target = ranked[0] && ranked[0].sim >= opts.cutoff ? ranked[0].story : null;
    if (!target && opts.judge) {
      for (const { story, sim } of ranked.slice(0, opts.maxJudged ?? 3)) {
        if (sim < opts.floor) break;
        judged++;
        if (await opts.judge(item, story)) { target = story; break; }
      }
    }
    if (target) {
      const n = target.item_count;
      target.centroid = target.centroid.map((v, i) => (v * n + item.embedding[i]) / (n + 1));
      target.item_count = n + 1;
      assignment.set(item.id, target.id);
    } else {
      const story = { id: opts.newId(), centroid: [...item.embedding], item_count: 1, title: item.title, isNew: true };
      pool.push(story);
      assignment.set(item.id, story.id);
    }
  }
  return { assignment, stories: pool, judged };
}

const SOURCE_PRIOR: Partial<Record<SourceKind, number>> = { arxiv: 0.75, hf: 0.85 };

const X_KINDS = new Set<SourceKind>(["x_bookmark", "x_like", "x_list", "x_search", "x_news", "x_user"]);
const NEWS_KINDS = new Set<SourceKind>(["rss", "gdelt", "hn", "github", "arxiv", "hf", "x_news"]);

/** The headline a story shows: a reported title beats a post, and a longer one beats a fragment. */
export function storyTitle(items: Pick<ItemRow, "title" | "source_kind">[]): string {
  const ranked = [...items].sort((a, b) => Number(NEWS_KINDS.has(b.source_kind)) - Number(NEWS_KINDS.has(a.source_kind)) || b.title.length - a.title.length);
  return (ranked[0]?.title ?? "Untitled").replace(/\s+/g, " ").trim().slice(0, 300);
}

export type LaneTaste = Record<string, number>;

/** Reject reasons that say "not this subject" (a lane judgment); the others (voice, facts, timing...) are about the draft. */
const TOPIC_REJECTS = new Set(["topic", "angle"]);

/** What one feedback label does to its story's lanes: +1, 0 or -1. */
export function tasteDelta(f: { action: string; reason?: string | null }): number {
  if (f.action === "dismiss") return -1;
  if (f.action === "restore") return 0;
  // A rejected Sunday candidate (VIB-420): a topic or angle reject is negative taste; a reject about the draft is neutral.
  if (f.action === "reject") return TOPIC_REJECTS.has(String(f.reason ?? "").split(":")[0].trim()) ? -1 : 0;
  return 1; // save, queue, drafted
}

/** Per-lane taste multipliers from feedback: save/queue/draft +1, dismiss and topic rejects -1; clamped 0.6..1.5. */
export function laneTaste(feedback: { action: string; lanes: string[]; reason?: string | null }[]): LaneTaste {
  const net: Record<string, number> = {};
  for (const f of feedback) {
    const delta = tasteDelta(f);
    for (const lane of f.lanes) net[lane] = (net[lane] ?? 0) + delta;
  }
  return Object.fromEntries(Object.entries(net).map(([lane, n]) => [lane, Math.min(1.5, Math.max(0.6, 1 + 0.08 * n))]));
}

export type StoryScore = { score: number; velocity: number; source_count: number; lanes: string[]; first_seen: string; last_seen: string; title: string };

/**
 * A story's rank. Lane fit and substance carry most weight; independent sources and velocity show it
 * is spreading; John's own bookmarks or likes on X count as strong taste; older stories decay
 * (half-life about a day). Scaled to 0..100.
 */
export function scoreStory(cfg: SignalsConfig, items: ItemRow[], taste: LaneTaste, now = new Date()): StoryScore {
  const t = now.getTime();
  const seen = items.map((i) => new Date(i.published_at ?? i.fetched_at).getTime()).filter(Number.isFinite);
  const firstSeen = Math.min(...seen, t);
  const lastSeen = Math.max(...items.map((i) => new Date(i.fetched_at).getTime()));
  const laneTotals: Record<string, number> = {};
  for (const item of items) for (const [lane, p] of Object.entries(item.lanes ?? {})) laneTotals[lane] = Math.max(laneTotals[lane] ?? 0, p);
  const lanes = topLanes(cfg, laneTotals);
  const laneFit = Math.max(0, ...lanes.map((l) => laneTotals[l] * (taste[l] ?? 1)));
  const mean = (key: string) => items.reduce((s, i) => s + (i.flags?.[key] ?? 0.5), 0) / Math.max(1, items.length);
  const sources = new Set(items.map((i) => i.source.replace(/^Bluesky.*/, "Bluesky"))).size;
  const recent = items.filter((i) => t - new Date(i.fetched_at).getTime() <= 12 * 3600_000).length;
  const velocity = recent / Math.max(1, items.length - recent + 1);
  const engagement = items.reduce((s, i) => s + (i.metrics.points ?? 0) + (i.metrics.likes ?? 0) / 10 + (i.metrics.stars_per_day ?? 0) * 5 + (i.metrics.upvotes ?? 0) * 3, 0);
  const johns = items.some((i) => i.source_kind === "x_bookmark" || i.source_kind === "x_like") ? 1 : 0;
  // Papers are plentiful and rarely the story on their own; reported news and John's own saves are not.
  const prior = Math.max(...items.map((i) => SOURCE_PRIOR[i.source_kind] ?? 1));
  const base = 0.35 * laneFit + 0.15 * mean("substance") + 0.1 * mean("novel")
    + 0.15 * Math.min(1, Math.log2(1 + sources) / 3) + 0.05 * Math.min(1, velocity)
    + 0.1 * Math.min(1, Math.log10(1 + engagement) / 3) + 0.1 * johns;
  const ageHours = (t - lastSeen) / 3600_000;
  const decay = Math.pow(0.5, Math.max(0, ageHours) / 24) * prior;
  return {
    score: Math.round(base * decay * 1000) / 10, velocity: Math.round(velocity * 100) / 100, source_count: sources, lanes,
    first_seen: new Date(firstSeen).toISOString(), last_seen: new Date(lastSeen).toISOString(), title: storyTitle(items),
  };
}

export const isX = (kind: SourceKind) => X_KINDS.has(kind);
