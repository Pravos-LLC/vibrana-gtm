// The Signal Desk pipeline against Supabase: collect sightings, then classify (Clef), embed, cluster
// into stories and score. Each run writes a gtm_signal_runs row with absolute counts per source.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { clef, embed, type AiRunner } from "./cloudflare";
import type { SignalItem, SignalsConfig } from "./config";
import { assignClusters, clefQuestions, clefState, interpret, laneTaste, scoreStory, type ClusterStory, type ItemRow, type SameStoryJudge } from "./rank";

const SAME_STORY = "Do Item A and Item B report the same specific event, release, decision or announcement (not merely the same topic)?";
const prob = (a: { type: string; noul?: number } | undefined) => (a?.type === "noul" ? a.noul ?? 0 : 0);

export type Job = { name: string; run: () => Promise<SignalItem[]> };
export type RunKind = "collect" | "collect_x" | "digest";
export type CollectResult = { run_id: string; fetched: Record<string, number>; unique: number; inserted: number; errors: { source: string; error: string }[] };

async function startRun(db: SupabaseClient, kind: RunKind) {
  return must(await db.from("gtm_signal_runs").insert({ kind }).select("id").single(), "start run") as { id: string };
}

export async function finishRun(db: SupabaseClient, id: string, stats: Record<string, unknown>, errors: unknown[]) {
  must(await db.from("gtm_signal_runs").update({ finished_at: new Date().toISOString(), stats, errors }).eq("id", id), "finish run");
}

/**
 * Feeds hand back their whole archive; only recent sightings are news. Items without a date are kept.
 * GitHub repos are already limited to recently created ones by the search itself.
 */
export function isFresh(item: SignalItem, maxAgeHours: number, now = new Date()): boolean {
  if (item.source_kind === "github" || !item.published_at) return true;
  const t = new Date(item.published_at).getTime();
  return !Number.isFinite(t) || now.getTime() - t <= maxAgeHours * 3600_000;
}

/** Runs every job side by side; a failing source is recorded, never fatal. New, fresh URLs only are inserted. */
export async function collect(db: SupabaseClient, jobs: Job[], kind: RunKind, maxAgeHours = Infinity, now = new Date(), opts: { finish?: boolean } = {}): Promise<CollectResult> {
  const run = await startRun(db, kind);
  const fetched: Record<string, number> = {};
  const errors: { source: string; error: string }[] = [];
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const byUrl = new Map<string, SignalItem>();
  settled.forEach((result, i) => {
    const name = jobs[i].name;
    if (result.status === "rejected") {
      fetched[name] = 0;
      // undici's "fetch failed" hides the real reason (ECONNRESET, ENOTFOUND, a TLS error) in `cause`.
      const err = result.reason as Error & { cause?: { code?: string; message?: string } };
      const cause = err?.cause ? ` (${err.cause.code ?? err.cause.message ?? "cause unknown"})` : "";
      errors.push({ source: name, error: `${String(err?.message ?? result.reason)}${cause}`.slice(0, 300) });
      return;
    }
    fetched[name] = result.value.length;
    for (const item of result.value) if (!byUrl.has(item.url) && isFresh(item, maxAgeHours, now)) byUrl.set(item.url, item);
  });
  let inserted = 0;
  const rows = [...byUrl.values()].map((i) => ({
    url: i.url, source: i.source.slice(0, 200), source_kind: i.source_kind, author: i.author ?? null,
    title: (i.title || i.url).slice(0, 1000), body: (i.body ?? "").slice(0, 20000), published_at: i.published_at ?? null, metrics: i.metrics ?? {},
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const data = must(await db.from("gtm_signal_items").upsert(rows.slice(i, i + 200), { onConflict: "url", ignoreDuplicates: true }).select("id"), "save items") as { id: string }[];
    inserted += data.length;
  }
  // Callers that process afterwards finish the run themselves, so a run killed mid-processing shows as unfinished.
  if (opts.finish !== false) await finishRun(db, run.id, { fetched, unique: byUrl.size, inserted }, errors);
  return { run_id: run.id, fetched, unique: byUrl.size, inserted, errors };
}

/** Runs `fn` over `items` with at most `limit` in flight. Once `stop()` is true no new item starts; skipped items stay undefined. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, stop: () => boolean = () => false): Promise<(PromiseSettledResult<R> | undefined)[]> {
  const out: (PromiseSettledResult<R> | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i]) }; } catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  }));
  return out;
}

const ITEM_COLUMNS = "id,url,source,source_kind,author,title,body,published_at,fetched_at,metrics,lanes,flags,relevant,classified_at,embedding,story_id";
const ITEM_COLUMNS_NO_EMBEDDING = "id,url,source,source_kind,author,title,body,published_at,fetched_at,metrics,lanes,flags,relevant,classified_at,story_id";

export type ProcessResult = {
  classified: number; classify_errors: number; relevant: number; embedded: number; new_stories: number; joined: number;
  judged: number; scored: number; deferred_classify: number; deferred_cluster: number;
};

const vec = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);

/**
 * Three resumable stages, each saved as soon as it finishes, sharing one time budget (`deadline`, epoch
 * ms; Vercel kills a function at 300 s):
 *   1. classify unclassified items in the window with Clef, saved immediately;
 *   2. embed relevant items that have no story yet, saved immediately;
 *   3. cluster them (Clef judges the grey zone) and rescore the window.
 * Work not reached before the deadline stays selectable (unclassified, or relevant with no story) and
 * is picked up by the next run, so a slow run never loses what it finished. A failed Clef call leaves
 * its item unclassified for the next run.
 */
export async function processSignals(db: SupabaseClient, ai: AiRunner, cfg: SignalsConfig, opts: { now?: Date; limit?: number; deadline?: number } = {}): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Infinity;
  const late = () => Date.now() > deadline;
  const since = new Date(now.getTime() - cfg.ranking.window_hours * 3600_000).toISOString();

  // 1. Classify.
  const pending = must(await db.from("gtm_signal_items").select(ITEM_COLUMNS).is("classified_at", null).gte("fetched_at", since).order("fetched_at", { ascending: false }).limit(opts.limit ?? 500), "pending items") as ItemRow[];
  const questions = clefQuestions(cfg);
  const results = await pool(pending, 8, (item) => clef(ai, clefState(item), questions), late);
  let errors = 0;
  let deferredClassify = 0;
  const classified: ItemRow[] = [];
  results.forEach((r, i) => {
    if (!r) { deferredClassify++; return; }
    if (r.status === "rejected") { errors++; return; }
    const { lanes, flags, relevant } = interpret(cfg, r.value.answers);
    // John's own bookmarks are explicit taste: they stay in the feed when Clef finds them substantive.
    const keep = relevant || (pending[i].source_kind === "x_bookmark" && (flags.substance ?? 0) >= 0.25);
    classified.push({ ...pending[i], lanes, flags, relevant: keep, classified_at: now.toISOString() });
  });
  if (errors && !classified.length) throw new Error(`clef failed for all ${errors} items: ${String((results.find((r) => r?.status === "rejected") as PromiseRejectedResult).reason?.message ?? "").slice(0, 200)}`);
  for (let i = 0; i < classified.length; i += 100) {
    const rows = classified.slice(i, i + 100).map((r) => ({ id: r.id, url: r.url, source: r.source, source_kind: r.source_kind, title: r.title, lanes: r.lanes, flags: r.flags, relevant: r.relevant, classified_at: r.classified_at }));
    must(await db.from("gtm_signal_items").upsert(rows, { onConflict: "id" }), "save classifications");
  }

  // 2. Embed relevant items that are not in a story yet (this run's and any a previous run left behind).
  const unclustered = must(await db.from("gtm_signal_items").select(ITEM_COLUMNS).eq("relevant", true).is("story_id", null).gte("fetched_at", since).order("fetched_at", { ascending: false }).limit(300), "unclustered items") as ItemRow[];
  const toEmbed = late() ? [] : unclustered.filter((i) => !i.embedding?.length);
  const vectors = toEmbed.length ? await embed(ai, toEmbed.map((i) => clefState(i).slice(0, 2000))) : [];
  for (const [n, item] of toEmbed.entries()) {
    item.embedding = vec(vectors[n]);
    must(await db.from("gtm_signal_items").update({ embedding: item.embedding }).eq("id", item.id), "save embedding");
  }

  // 3. Cluster until the deadline; anything not reached keeps story_id null for the next run.
  const ready = unclustered.filter((i) => i.embedding?.length);
  const existing = must(await db.from("gtm_signal_stories").select("id,title,centroid,item_count").gte("last_seen", since).not("centroid", "is", null), "window stories") as ClusterStory[];
  const judge: SameStoryJudge = async (item, story) => {
    try {
      const r = await clef(ai, `Item A: ${item.title.slice(0, 600)}\n\nItem B: ${story.title.slice(0, 600)}`, { same: { type: "noul", instructions: SAME_STORY } });
      return prob(r.answers.same) >= 0.6;
    } catch { return false; }
  };
  const { assignment, stories, judged } = await assignClusters(
    ready.map((i) => ({ id: i.id, embedding: i.embedding!, title: i.title })), existing,
    { cutoff: cfg.ranking.cluster_similarity, floor: 0.6, judge, newId: () => randomUUID(), stop: late },
  );
  const assigned = ready.filter((i) => assignment.has(i.id));
  const created = stories.filter((s) => s.isNew);
  if (created.length) {
    must(await db.from("gtm_signal_stories").insert(created.map((s) => ({ id: s.id, title: s.title.slice(0, 500) || "Untitled", centroid: vec(s.centroid), item_count: s.item_count }))), "new stories");
  }
  const touched = new Set(assigned.map((i) => assignment.get(i.id)));
  for (const s of stories.filter((s) => !s.isNew && touched.has(s.id))) {
    must(await db.from("gtm_signal_stories").update({ centroid: vec(s.centroid), item_count: s.item_count }).eq("id", s.id), "update centroid");
  }
  for (const item of assigned) {
    must(await db.from("gtm_signal_items").update({ story_id: assignment.get(item.id) }).eq("id", item.id), "assign story");
  }

  const scored = await rescore(db, cfg, now);
  return {
    classified: classified.length, classify_errors: errors, relevant: classified.filter((i) => i.relevant).length, embedded: vectors.length,
    new_stories: created.length, joined: assigned.length - created.length, judged, scored,
    deferred_classify: deferredClassify, deferred_cluster: unclustered.length - assigned.length,
  };
}

/** Recomputes score, lanes, title and counts for every story seen in the window. */
export async function rescore(db: SupabaseClient, cfg: SignalsConfig, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - cfg.ranking.window_hours * 3600_000).toISOString();
  const stories = must(await db.from("gtm_signal_stories").select("id").gte("last_seen", since), "window stories") as { id: string }[];
  if (!stories.length) return 0;
  const ids = stories.map((s) => s.id);
  const items: ItemRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    items.push(...must(await db.from("gtm_signal_items").select(ITEM_COLUMNS_NO_EMBEDDING).in("story_id", ids.slice(i, i + 200)), "story items") as unknown as ItemRow[]);
  }
  const taste = laneTaste(await feedbackLanes(db, now));
  const byStory = new Map<string, ItemRow[]>();
  for (const item of items) if (item.story_id) byStory.set(item.story_id, [...(byStory.get(item.story_id) ?? []), item]);
  let n = 0;
  for (const [id, group] of byStory) {
    const s = scoreStory(cfg, group, taste, now);
    must(await db.from("gtm_signal_stories").update({
      title: s.title, lanes: s.lanes, score: s.score, velocity: s.velocity, source_count: s.source_count, item_count: group.length,
      first_seen: s.first_seen, last_seen: s.last_seen, updated_at: now.toISOString(),
    }).eq("id", id), "rescore");
    n++;
  }
  return n;
}

/** Feedback from the last 60 days with the lanes of the story it was given on. */
async function feedbackLanes(db: SupabaseClient, now: Date) {
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const rows = must(await db.from("gtm_signal_feedback").select("action, reason, gtm_signal_stories(lanes)").gte("created_at", since), "feedback") as unknown as { action: string; reason: string | null; gtm_signal_stories: { lanes: string[] } | null }[];
  return rows.map((r) => ({ action: r.action, reason: r.reason, lanes: r.gtm_signal_stories?.lanes ?? [] }));
}

export async function listStories(db: SupabaseClient, filter: { status?: string; lane?: string; limit?: number; since?: string } = {}) {
  let q = db.from("gtm_signal_stories").select("id,title,lanes,score,velocity,source_count,item_count,first_seen,last_seen,brief,briefed_at,status,requested_format,gtm_story_id,acted_by,acted_at").order("score", { ascending: false }).limit(filter.limit ?? 30);
  if (filter.status) q = q.eq("status", filter.status);
  else q = q.neq("status", "dismissed");
  if (filter.lane) q = q.contains("lanes", [filter.lane]);
  if (filter.since) q = q.gte("last_seen", filter.since);
  return must(await q, "stories");
}

export async function storyItems(db: SupabaseClient, storyIds: string[]) {
  if (!storyIds.length) return [];
  return must(await db.from("gtm_signal_items").select("story_id,url,source,source_kind,author,title,body,published_at,metrics").in("story_id", storyIds).order("published_at", { ascending: false }), "story items") as Pick<ItemRow, "story_id" | "url" | "source" | "source_kind" | "author" | "title" | "body" | "published_at" | "metrics">[];
}
