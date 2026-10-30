// The weekly report's input pack (VIB-418): a deterministic JSON picture of the week, built only from the
// database (and Zernio's dashboard when it is reachable). The model reads this and nothing else, and the
// guard (lib/reports/guard.ts) drops any number or id in its answer that is not in here.
//
// Every number the model may cite is also listed in `facts` under a stable key, so a claim can carry its
// evidence as { fact, value } and be checked mechanically. Absolute counts come first; a rate always names
// its denominator, and nothing is summed across platforms.
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHANNELS, PHASE, PILLARS, type LeadingMetric, type PillarSlug } from "../guide/content";
import { must } from "../db";
import { ageDays, engagements, isFinal, isMaturing, median, nativeReach, ownRate, savesAndSends, type PostMetrics } from "../analytics/metrics";
import { addDays } from "../week";
import { checkTags, tagsCurrent } from "../playbook/tag";
import { CTAS, HOOKS, STORYLINES, TAXONOMY, type Awareness } from "../playbook/taxonomy";
import { analyticsDashboard, isSkipped, orSkip } from "../zernio-analytics";
import { localDate, type ReportWeek } from "./week";
import { redFlags, type RedFlag } from "../engage/redflags";

export const TARGETS = {
  /** STRATEGY.md cadence: three pieces a week (Tue, Wed, Thu). */
  pieces_per_week: 3,
  /** channels.json format mix: at least one carousel a week (LinkedIn document, Instagram carousel). */
  carousels_per_week_min: 1,
  /** One soft CTA a week, on the Proof or Build slot. */
  soft_cta_per_week: 1,
};
export const RULES = { final_after_days: 7, cohort_weeks: 8, maturing_hours: { instagram: 48, youtube: 72, other: 24 } };
const CAROUSEL_FORMATS = new Set(["carousel", "document"]);
export const MEASURED_PLATFORMS = ["linkedin", "instagram", "youtube"];

// ---- inputs ------------------------------------------------------------------------------------------------

export type MetricSnap = PostMetrics & {
  zernio_post_id: string; content_item_id: string | null; is_external: boolean;
  platform_post_url: string | null; content_preview: string | null; captured_at: string;
};
export type ItemRow = {
  id: string; date: string; time: string | null; pillar: string; format: string; channels: string[]; status: string; title: string;
  story_id?: string | null; zernio_post_id?: string | null; published_at?: string | null; urls?: Record<string, string> | null;
  cta?: string | null; lens?: string | null; playbook_tags?: unknown;
};
export type FollowerRow = { account_id: string; platform: string; date: string; followers: number | null };
export type SignalRow = { id: string; title: string; status: string; requested_format: string | null; lanes: string[]; score: number; brief: { headline?: string } | null };
export type CommentRow = { platform: string | null; content_item_id: string | null; at: string; kind: string | null };
export type ZernioWeek = { impressions: number; reach: number; views: number; engagement: number; followers_gained: number };
export type PackInputs = {
  metrics: MetricSnap[]; items: ItemRow[]; followers: FollowerRow[]; signals: SignalRow[];
  comments: CommentRow[] | null; manual: { channel: string; metrics: Record<string, unknown> }[] | null;
  baseline: { period_start: string; period_end: string; report: unknown } | null;
  zernio: Record<string, { week: ZernioWeek; prev: ZernioWeek | null }> | null;
  gaps: string[];
  /** Pushback (VIB-424): this week's red flags. Absent when the stance columns do not exist yet. */
  pushback?: PushbackRow[] | null;
};

/** One red-flagged post for the report: what kind of pushback, how much, from whom (counts only), about what. */
export type PushbackRow = Pick<RedFlag, "flag" | "platform" | "title" | "content_item_id" | "objection" | "action"> & {
  negative: number; dissent: number; misreads: number; questions: number; known_people: number; comments: number;
};
export const toPushback = (f: RedFlag): PushbackRow => ({
  flag: f.flag, platform: f.platform, title: f.title, content_item_id: f.content_item_id, objection: f.objection, action: f.action,
  negative: f.counts.negative, dissent: f.counts.constructive_dissent, misreads: f.counts.misread, questions: f.counts.question,
  known_people: f.who.known, comments: f.comment_ids.length,
});

// ---- the pack ----------------------------------------------------------------------------------------------

export type PostStage = "maturing" | "settling" | "final";
/** A post's playbook tags as the report sees them: live taxonomy ids only, with the CTA's awareness flag. */
export type PackTags = { hook: string; storyline: string; cta: string; cta_awareness: Awareness; confidence: string };
export type PackPost = {
  ref: string; zernio_post_id: string; platform: string; item_id: string | null; title: string | null;
  pillar: string | null; format: string | null; lens?: string | null; playbook_tags?: PackTags;
  published_on: string; age_days: number | null; stage: PostStage; window: "this_week" | "previous_week" | "earlier";
  url: string | null; preview: string;
  metrics: { impressions: number; reach: number; views: number; likes: number; comments: number; shares: number; saves: number; clicks: number };
  extras: Record<string, number>;
  engagements: number; saves_sends: number; native_reach: { value: number; unit: string }; rate: { value: number; per: string } | null;
  conversations?: number;
};
type Totals = { posts: number; engagements: number; comments: number; saves_sends: number; native_reach: number };
export type ChannelWeek = {
  platform: string; reach_unit: string; this_week: Totals; previous_week: Totals;
  followers: { start: number | null; end: number | null; net: number | null; previous_net: number | null };
  zernio?: { week: ZernioWeek; prev: ZernioWeek | null };
};
export type MedianCell = { platform: string; key: string; n: number; thin: boolean; rate: number | null; engagements: number | null; leading: number | null };
export type SlotItem = Pick<ItemRow, "id" | "date" | "time" | "pillar" | "format" | "channels" | "status" | "title"> & { lens?: string | null };

export type Pack = {
  version: 1;
  week: { season_id: string; number: number; from: string; to: string; today: string; previous: { number: number; from: string; to: string } };
  phase: { label: string; success: string[]; tracked_not_judged: string[] };
  rules: typeof RULES; targets: typeof TARGETS;
  pillars: { slug: PillarSlug; name: string; share: number; funnel_role: string; awareness_job: string; leading_metric: LeadingMetric }[];
  posts: PackPost[];
  unmeasured: { item_id: string; title: string; channels: string[]; format: string; pillar: string; published_on: string | null }[];
  channels: ChannelWeek[];
  medians: { by_pillar: MedianCell[]; by_format: MedianCell[]; by_lens: MedianCell[] };
  /**
   * The playbook read (VIB-421), null until posts carry tags. `standard` defines the ids in use (with the
   * benchmark creators who use them) and every CTA with its awareness flag; `week` counts this week's posts
   * by CTA flag; `medians` are the settled cohort's medians per hook, storyline and CTA.
   */
  playbook: {
    taxonomy_version: number;
    standard: {
      hooks: { id: string; name: string; definition: string; example_creators: string[] }[];
      storylines: { id: string; name: string; definition: string; example_creators: string[] }[];
      ctas: { id: string; name: string; awareness: Awareness; note: string }[];
    };
    week: { posts: number; tagged: number; untagged: number; cta: Record<Awareness, number>; avoid_refs: string[]; limit_refs: string[] };
    cohort: { tagged: number; cta: Record<Awareness, number> };
    medians: { by_hook: MedianCell[]; by_storyline: MedianCell[]; by_cta: MedianCell[] };
  } | null;
  mix: { pieces: number; items: number; carousels: number; by_pillar: Record<string, number>; with_cta: number };
  upcoming: SlotItem[]; reserve: SlotItem[];
  signals: { id: string; title: string; status: string; requested_format: string | null; lanes: string[]; score: number }[];
  conversations: { this_week: number; by_platform: Record<string, number> } | null;
  manual: { channel: string; metrics: Record<string, unknown> }[] | null;
  baseline: { period_start: string; period_end: string; report: unknown } | null;
  facts: Record<string, number>;
  gaps: string[];
  pushback?: PushbackRow[];
};

const pieceOf = (i: ItemRow) => i.story_id || i.id.replace(/-(linkedin|instagram|youtube|newsletter|substack)$/, "");
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (now: number, before: number) => (before ? round1(((now - before) / before) * 100) : null);

/** The pillar's leading metric for one post (the number a pillar is judged on in this phase). */
export function leadingValue(key: LeadingMetric["key"], p: Pick<PackPost, "metrics" | "native_reach" | "saves_sends" | "conversations">): number {
  if (key === "reach") return p.native_reach.value;
  if (key === "saves_sends") return p.saves_sends;
  // The queue's rows for a post and the platform's comment count describe the same comments: take the larger, never the sum.
  if (key === "conversations") return Math.max(p.metrics.comments, p.conversations ?? 0);
  return p.metrics.comments;
}

export function buildPack(inp: PackInputs, wk: ReportWeek, now: Date): Pack {
  const gaps = [...inp.gaps];
  const items = new Map(inp.items.map((i) => [i.id, i]));
  // Snapshots written before the join fix carry no content_item_id; the post URL on the calendar row still links them.
  const byUrl = new Map<string, string>();
  for (const i of inp.items) for (const url of Object.values(i.urls ?? {})) if (typeof url === "string" && url) byUrl.set(url, i.id);
  const itemIdOf = (m: MetricSnap) => m.content_item_id ?? (m.platform_post_url ? byUrl.get(m.platform_post_url) ?? null : null);
  const cohortFrom = addDays(wk.from, -7 * RULES.cohort_weeks);
  const conversationsByItem = new Map<string, number>();
  for (const c of inp.comments ?? []) if (c.content_item_id) conversationsByItem.set(c.content_item_id, (conversationsByItem.get(c.content_item_id) ?? 0) + 1);

  // Posts: this week, last week, and the settled cohort before them.
  const posts: PackPost[] = inp.metrics
    .filter((m) => m.published_at && MEASURED_PLATFORMS.includes(m.platform))
    .map((m) => ({ m, on: localDate(m.published_at!) }))
    .filter(({ on }) => on >= cohortFrom && on <= wk.to)
    .sort((a, b) => a.on.localeCompare(b.on) || a.m.platform.localeCompare(b.m.platform))
    .map(({ m, on }, n) => {
      const id = itemIdOf(m);
      const item = id ? items.get(id) : undefined;
      const stage: PostStage = isFinal(m.published_at, now) ? "final" : isMaturing(m.platform, m.published_at, now) ? "maturing" : "settling";
      const post: PackPost = {
        ref: `P${n + 1}`, zernio_post_id: m.zernio_post_id, platform: m.platform, item_id: item?.id ?? null, title: item?.title ?? null,
        pillar: item?.pillar ?? null, format: item?.format ?? null,
        ...(item && "lens" in item ? { lens: item.lens ?? null } : {}),
        ...(item && packTags(item.playbook_tags) ? { playbook_tags: packTags(item.playbook_tags)! } : {}),
        published_on: on, age_days: ageDays(m.published_at, now), stage,
        window: on >= wk.from ? "this_week" : on >= wk.prev.from ? "previous_week" : "earlier",
        url: m.platform_post_url, preview: (m.content_preview ?? "").replace(/\s+/g, " ").slice(0, 160),
        metrics: { impressions: m.impressions, reach: m.reach, views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, clicks: m.clicks },
        extras: m.extras ?? {},
        engagements: engagements(m), saves_sends: savesAndSends(m), native_reach: nativeReach(m), rate: ownRate(m),
        ...(inp.comments && item ? { conversations: conversationsByItem.get(item.id) ?? 0 } : {}),
      };
      return post;
    });

  const published = inp.items.filter((i) => i.status === "published" && i.published_at);
  const inWeek = (i: ItemRow) => { const d = localDate(i.published_at!); return d >= wk.from && d <= wk.to; };
  const weekItems = published.filter(inWeek);
  const measuredIds = new Set(posts.map((p) => p.item_id).filter(Boolean));
  const unmeasured = weekItems.filter((i) => !measuredIds.has(i.id)).map((i) => ({ item_id: i.id, title: i.title, channels: i.channels, format: i.format, pillar: i.pillar, published_on: i.published_at ? localDate(i.published_at) : null }));

  // Per platform, in its own units.
  const totals = (list: PackPost[]): Totals => ({
    posts: list.length, engagements: list.reduce((s, p) => s + p.engagements, 0), comments: list.reduce((s, p) => s + p.metrics.comments, 0),
    saves_sends: list.reduce((s, p) => s + p.saves_sends, 0), native_reach: list.reduce((s, p) => s + p.native_reach.value, 0),
  });
  const followerWindow = (platform: string, from: string, to: string) => {
    const rows = inp.followers.filter((f) => f.platform === platform && f.followers != null).sort((a, b) => a.date.localeCompare(b.date));
    const start = rows.filter((r) => r.date < from).at(-1) ?? rows.find((r) => r.date >= from && r.date <= to);
    const end = rows.filter((r) => r.date <= to).at(-1);
    // One observation is not a change: with a single snapshot the net is unknown, not zero.
    if (!start || !end || end.date < from || start === end) return { start: start?.followers ?? null, end: end && end.date >= from ? end.followers : null, single: true };
    return { start: start.followers, end: end.followers, single: false };
  };
  const channels: ChannelWeek[] = MEASURED_PLATFORMS.map((platform) => {
    const own = posts.filter((p) => p.platform === platform);
    const f = followerWindow(platform, wk.from, wk.to);
    const fp = followerWindow(platform, wk.prev.from, wk.prev.to);
    const z = inp.zernio?.[platform];
    return {
      platform, reach_unit: nativeReach({ platform } as PostMetrics & { platform: string }).unit,
      this_week: totals(own.filter((p) => p.window === "this_week")), previous_week: totals(own.filter((p) => p.window === "previous_week")),
      followers: { start: f.start, end: f.end, net: !f.single && f.start != null && f.end != null ? f.end - f.start : null, previous_net: !fp.single && fp.start != null && fp.end != null ? fp.end - fp.start : null },
      ...(z ? { zernio: z } : {}),
    };
  });

  // Medians over the settled cohort only (at least 7 days old), per platform.
  const finals = posts.filter((p) => p.stage === "final");
  // `lead`: the cell's leading number. Pillars use their own leading metric; playbook cells use conversations,
  // the awareness phase's first success measure.
  const cells = (keyOf: (p: PackPost) => string | null | undefined, lead?: (p: PackPost) => number): MedianCell[] => {
    const groups = new Map<string, PackPost[]>();
    for (const p of finals) { const k = keyOf(p); if (!k) continue; const g = `${p.platform}|${k}`; groups.set(g, [...(groups.get(g) ?? []), p]); }
    return [...groups].map(([g, list]) => {
      const [platform, key] = g.split("|");
      const pillar = PILLARS.find((x) => x.slug === key);
      return {
        platform, key, n: list.length, thin: list.length < 3,
        rate: median(list.map((p) => p.rate?.value ?? NaN)), engagements: median(list.map((p) => p.engagements)),
        leading: lead ? median(list.map(lead)) : pillar ? median(list.map((p) => leadingValue(pillar.leading_metric.key, p))) : null,
      };
    }).sort((a, b) => a.platform.localeCompare(b.platform) || a.key.localeCompare(b.key));
  };
  const hasLens = inp.items.some((i) => "lens" in i);
  if (!hasLens) gaps.push("No lens field on calendar items yet, so there are no lens medians (Transformation, Thought leadership, Regenerative).");
  const tagged = posts.filter((p) => p.playbook_tags);
  if (!tagged.length) gaps.push("No playbook tags yet (hook, storyline, CTA), so the report cannot grade posts against the channel playbook.");
  else {
    const untaggedNow = posts.filter((p) => p.window === "this_week" && !p.playbook_tags).length;
    if (untaggedNow) gaps.push(`${untaggedNow} of this week's posts have no playbook tags yet (gtm playbook tag), so the playbook read leaves them out.`);
  }
  if (!inp.comments) gaps.push("No comment queue yet, so conversations are counted from post comments only (no replies or DMs).");
  if (finals.length < 3) gaps.push(`Only ${finals.length} posts are at least 7 days old, so medians are thin.`);

  const mix = {
    pieces: new Set(weekItems.map(pieceOf)).size, items: weekItems.length,
    carousels: new Set(weekItems.filter((i) => CAROUSEL_FORMATS.has(i.format)).map(pieceOf)).size,
    by_pillar: Object.fromEntries(PILLARS.map((p) => [p.slug, new Set(weekItems.filter((i) => i.pillar === p.slug).map(pieceOf)).size])),
    with_cta: new Set(weekItems.filter((i) => i.cta).map(pieceOf)).size,
  };
  const slot = (i: ItemRow): SlotItem => ({ id: i.id, date: i.date, time: i.time, pillar: i.pillar, format: i.format, channels: i.channels, status: i.status, title: i.title, ...("lens" in i ? { lens: i.lens ?? null } : {}) });
  const upcoming = inp.items.filter((i) => i.date >= wk.next.from && i.date <= wk.next.to && !["published", "skipped"].includes(i.status)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map(slot);
  const reserve = inp.items.filter((i) => i.date > wk.season.ends_on && ["idea", "drafted", "approved"].includes(i.status)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, 20).map(slot);

  let conversations: Pack["conversations"] = null;
  if (inp.comments) {
    const week = inp.comments.filter((c) => { const d = localDate(c.at); return d >= wk.from && d <= wk.to; });
    const by: Record<string, number> = {};
    for (const c of week) by[c.platform ?? "unknown"] = (by[c.platform ?? "unknown"] ?? 0) + 1;
    conversations = { this_week: week.length, by_platform: by };
  }

  const pack: Pack = {
    version: 1,
    week: { season_id: wk.season.id, number: wk.week, from: wk.from, to: wk.to, today: wk.today, previous: { number: wk.prev.week, from: wk.prev.from, to: wk.prev.to } },
    phase: { label: PHASE.label, success: PHASE.success.map((s) => s.label), tracked_not_judged: PHASE.tracked_not_judged },
    rules: RULES, targets: TARGETS,
    pillars: PILLARS.map((p) => ({ slug: p.slug, name: p.name, share: p.share, funnel_role: p.funnel_role, awareness_job: p.awareness_job, leading_metric: p.leading_metric })),
    posts, unmeasured, channels,
    medians: { by_pillar: cells((p) => p.pillar), by_format: cells((p) => p.format), by_lens: hasLens ? cells((p) => p.lens) : [] },
    playbook: tagged.length ? playbookRead(posts, cells) : null,
    mix, upcoming, reserve,
    signals: inp.signals.map((s) => ({ id: s.id, title: s.brief?.headline ?? s.title, status: s.status, requested_format: s.requested_format, lanes: s.lanes, score: round1(s.score) })),
    conversations, manual: inp.manual, baseline: inp.baseline,
    facts: {}, gaps,
    ...(inp.pushback ? { pushback: inp.pushback } : {}),
  };
  pack.facts = packFacts(pack);
  return pack;
}

/** Every citable number, under a stable key. The guard checks evidence and inline numbers against these. */
export function packFacts(p: Pack): Record<string, number> {
  const f: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => { if (typeof v === "number" && Number.isFinite(v)) f[k] = v; };
  put("week.number", p.week.number); put("week.previous", p.week.previous.number);
  put("rule.final_after_days", p.rules.final_after_days);
  for (const [k, v] of Object.entries(p.rules.maturing_hours)) put(`rule.maturing_hours.${k}`, v);
  for (const [k, v] of Object.entries(p.targets)) put(`target.${k}`, v);
  for (const pl of p.pillars) put(`target.share.${pl.slug}`, pl.share);
  for (const post of p.posts) {
    for (const [k, v] of Object.entries(post.metrics)) put(`${post.ref}.${k}`, v);
    for (const [k, v] of Object.entries(post.extras)) put(`${post.ref}.${k}`, v);
    put(`${post.ref}.engagements`, post.engagements); put(`${post.ref}.saves_sends`, post.saves_sends);
    put(`${post.ref}.native_reach`, post.native_reach.value); put(`${post.ref}.rate`, post.rate?.value);
    put(`${post.ref}.age_days`, post.age_days); put(`${post.ref}.conversations`, post.conversations);
  }
  for (const c of p.channels) {
    for (const [w, t] of [["week", c.this_week], ["prev", c.previous_week]] as const) for (const [k, v] of Object.entries(t)) put(`${w}.${c.platform}.${k}`, v);
    for (const k of ["engagements", "comments", "saves_sends", "native_reach", "posts"] as const) {
      put(`change.${c.platform}.${k}`, c.this_week[k] - c.previous_week[k]);
      put(`change_pct.${c.platform}.${k}`, pct(c.this_week[k], c.previous_week[k]));
    }
    put(`followers.${c.platform}.start`, c.followers.start); put(`followers.${c.platform}.end`, c.followers.end);
    put(`followers.${c.platform}.net`, c.followers.net); put(`followers.${c.platform}.previous_net`, c.followers.previous_net);
    if (c.zernio) {
      for (const [k, v] of Object.entries(c.zernio.week)) put(`zernio.${c.platform}.${k}`, v);
      for (const [k, v] of Object.entries(c.zernio.prev ?? {})) put(`zernio_prev.${c.platform}.${k}`, v as number);
    }
  }
  const pb = p.playbook;
  if (pb) {
    put("playbook.week.posts", pb.week.posts); put("playbook.week.tagged", pb.week.tagged); put("playbook.week.untagged", pb.week.untagged);
    put("playbook.cohort.tagged", pb.cohort.tagged);
    for (const [k, v] of Object.entries(pb.week.cta)) put(`playbook.week.cta.${k}`, v);
    for (const [k, v] of Object.entries(pb.cohort.cta)) put(`playbook.cohort.cta.${k}`, v);
  }
  for (const [kind, list] of [["pillar", p.medians.by_pillar], ["format", p.medians.by_format], ["lens", p.medians.by_lens], ["hook", pb?.medians.by_hook ?? []], ["storyline", pb?.medians.by_storyline ?? []], ["cta", pb?.medians.by_cta ?? []]] as const) {
    for (const m of list) {
      put(`median.${kind}.${m.platform}.${m.key}.n`, m.n); put(`median.${kind}.${m.platform}.${m.key}.rate`, m.rate);
      put(`median.${kind}.${m.platform}.${m.key}.engagements`, m.engagements); put(`median.${kind}.${m.platform}.${m.key}.leading`, m.leading);
    }
  }
  put("mix.pieces", p.mix.pieces); put("mix.items", p.mix.items); put("mix.carousels", p.mix.carousels); put("mix.with_cta", p.mix.with_cta);
  for (const [k, v] of Object.entries(p.mix.by_pillar)) put(`mix.pillar.${k}`, v);
  put("count.unmeasured", p.unmeasured.length); put("count.upcoming", p.upcoming.length);
  for (const s of p.signals) put(`signal.${s.id}.score`, s.score);
  (p.pushback ?? []).forEach((r, i) => { put(`pushback.${i}.negative`, r.negative); put(`pushback.${i}.dissent`, r.dissent); put(`pushback.${i}.misreads`, r.misreads); put(`pushback.${i}.questions`, r.questions); put(`pushback.${i}.known_people`, r.known_people); put(`pushback.${i}.comments`, r.comments); });
  if (p.conversations) { put("conversations.week", p.conversations.this_week); for (const [k, v] of Object.entries(p.conversations.by_platform)) put(`conversations.week.${k}`, v); }
  return f;
}

/** Validated tags: every id live in the taxonomy, or nothing (an unresolvable tag is never graded). */
export function packTags(raw: unknown): PackTags | null {
  const c = checkTags(raw as never);
  return c.ok ? { hook: c.tags.hook, storyline: c.tags.storyline, cta: c.tags.cta, cta_awareness: c.tags.cta_awareness, confidence: c.tags.confidence } : null;
}

function playbookRead(posts: PackPost[], cells: (keyOf: (p: PackPost) => string | null | undefined, lead?: (p: PackPost) => number) => MedianCell[]): NonNullable<Pack["playbook"]> {
  const conv = (p: PackPost) => leadingValue("conversations", p);
  const flags = (list: PackPost[]) => {
    const c: Record<Awareness, number> = { use: 0, limit: 0, avoid: 0 };
    for (const p of list) if (p.playbook_tags) c[p.playbook_tags.cta_awareness]++;
    return c;
  };
  const week = posts.filter((p) => p.window === "this_week");
  const used = (k: "hook" | "storyline") => new Set(posts.map((p) => p.playbook_tags?.[k]).filter(Boolean) as string[]);
  const hooks = used("hook"), stories = used("storyline");
  return {
    taxonomy_version: TAXONOMY.version,
    standard: {
      hooks: [...hooks].sort().map((id) => { const h = HOOKS.get(id)!; return { id, name: h.name, definition: h.definition, example_creators: h.example_creators ?? [] }; }),
      storylines: [...stories].sort().map((id) => { const s = STORYLINES.get(id)!; return { id, name: s.name, definition: s.definition, example_creators: s.example_creators ?? [] }; }),
      ctas: TAXONOMY.ctas.filter((c) => !c.retired).map((c) => ({ id: c.id, name: c.name, awareness: c.awareness, note: c.note ?? "" })),
    },
    week: {
      posts: week.length, tagged: week.filter((p) => p.playbook_tags).length, untagged: week.filter((p) => !p.playbook_tags).length, cta: flags(week),
      avoid_refs: week.filter((p) => p.playbook_tags?.cta_awareness === "avoid").map((p) => p.ref),
      limit_refs: week.filter((p) => p.playbook_tags?.cta_awareness === "limit").map((p) => p.ref),
    },
    cohort: { tagged: posts.filter((p) => p.playbook_tags).length, cta: flags(posts) },
    medians: { by_hook: cells((p) => p.playbook_tags?.hook, conv), by_storyline: cells((p) => p.playbook_tags?.storyline, conv), by_cta: cells((p) => p.playbook_tags?.cta, conv) },
  };
}

// ---- loading -----------------------------------------------------------------------------------------------

/** True when a PostgREST error means "this table does not exist (yet)": read optional tables defensively. */
const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? ""));

/** Rejects when `deadline` (epoch ms) passes first, so a slow or rate-limited read cannot eat the cron's budget. */
export function beforeDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  const left = deadline - Date.now();
  if (!Number.isFinite(left)) return p;
  if (left <= 0) return Promise.reject(new Error(`${what}: skipped, time budget used up`));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer before the time budget ran out`)), left); })]).finally(() => clearTimeout(timer));
}

export async function loadPackInputs(db: SupabaseClient, wk: ReportWeek, opts: { live?: boolean; deadline?: number } = {}): Promise<PackInputs> {
  const deadline = opts.deadline ?? Infinity;
  const gaps: string[] = [];
  const cohortFrom = addDays(wk.from, -7 * RULES.cohort_weeks - 1);
  const [metrics, items, followers, signals] = await Promise.all([
    // `*`, not a column list: extras arrives with the 20261011 migration, and the pack must build before it too.
    db.from("gtm_post_metrics_latest").select("*").gte("published_at", `${cohortFrom}T00:00:00Z`),
    db.from("gtm_content_items").select("*").order("date"),
    db.from("gtm_channel_daily").select("account_id,platform,date,followers").gte("date", addDays(wk.prev.from, -7)).lte("date", wk.to).order("date"),
    db.from("gtm_signal_stories").select("id,title,status,requested_format,lanes,score,brief").or(`status.eq.queued,and(status.in.(new,saved),last_seen.gte.${addDays(wk.to, -7)}T00:00:00Z)`).order("score", { ascending: false }).limit(12),
  ]);
  // body, media and approval hashes never go to the model; only what the report reasons about.
  // Tags that describe an older body are dropped here, while the body is still at hand: they describe copy that never went out.
  const itemRows = (must(items, "content items") as (ItemRow & Record<string, unknown>)[]).map(({ body: _b, media: _m, approved_hash: _h, copy_path: _c, ...rest }) => {
    const row = rest as ItemRow;
    if (row.playbook_tags != null && !tagsCurrent(row.playbook_tags, (_b as string | null) ?? null)) row.playbook_tags = null;
    return row;
  });

  let comments: CommentRow[] | null = null;
  // The engage queue (VIB-423). Own comments and our reply echoes never count; DMs count for the platform, not a post.
  const c = await db.from("gtm_comments").select("platform,content_item_id,kind,is_own,commented_at,received_at").eq("is_own", false).gte("received_at", `${addDays(wk.from, -14)}T00:00:00Z`).limit(5000);
  if (c.error) { if (!missingTable(c.error)) gaps.push(`Could not read gtm_comments: ${c.error.message}`); }
  else {
    // Read defensively: the comment queue (VIB-424) owns this table's shape. Own comments and our replies never count.
    comments = (c.data as Record<string, unknown>[]).filter((r) => r.is_own !== true && r.kind !== "own_reply").map((r) => ({
      platform: (r.platform as string) ?? null, content_item_id: r.kind === "dm" ? null : (r.content_item_id as string) ?? null, kind: (r.kind as string) ?? null,
      at: String(r.commented_at ?? r.received_at ?? r.created_at ?? ""),
    })).filter((r) => r.at);
  }
  let manual: PackInputs["manual"] = null;
  const mm = await db.from("gtm_manual_metrics").select("channel,metrics").eq("week_start", wk.from);
  if (!mm.error) manual = (mm.data ?? []) as PackInputs["manual"];
  else if (!missingTable(mm.error)) gaps.push(`Could not read manual metrics: ${mm.error.message}`);
  let baseline: PackInputs["baseline"] = null;
  const bl = await db.from("gtm_content_reports").select("period_start,period_end,report").eq("kind", "baseline").eq("status", "done").order("period_start", { ascending: false }).limit(1).maybeSingle();
  if (!bl.error) baseline = bl.data as PackInputs["baseline"];
  else if (!missingTable(bl.error)) gaps.push(`Could not read the baseline: ${bl.error.message}`);
  if (!baseline) gaps.push("No baseline recorded yet (gtm report baseline).");
  if (!manual?.length) gaps.push("No manual numbers for this week (Substack subscribers and opens, YouTube impressions and click-through rate).");

  let zernio: PackInputs["zernio"] = null;
  if (opts.live !== false && (process.env.ZERNIO_API_KEY || process.env.LATE_API_KEY)) {
    zernio = {};
    for (const platform of MEASURED_PLATFORMS) {
      try {
        const d = await beforeDeadline(orSkip(() => analyticsDashboard({ platform, fromDate: wk.from, toDate: wk.to, compare: "previous_period" })), deadline, `Zernio dashboard for ${platform}`);
        if (isSkipped(d)) { gaps.push(`Zernio dashboard for ${platform}: ${d.skipped}`); continue; }
        // Zernio's own window totals (its definition of the window), with the same-length window before it.
        const pick = (t: NonNullable<typeof d.previousTotals>, gained: number | undefined): ZernioWeek => ({
          impressions: t.impressions, reach: t.reach, views: t.views, engagement: t.likes + t.comments + t.shares + t.saves, followers_gained: gained ?? 0,
        });
        const week = pick(d.totals, d.followers?.gained);
        const prev = d.previousTotals ? pick(d.previousTotals, d.previousFollowers?.gained) : null;
        zernio[platform] = { week, prev };
      } catch (e) {
        gaps.push(`Zernio dashboard for ${platform} failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  // Pushback (VIB-424): red flags on posts commented on this week.
  let pushback: PushbackRow[] | null = null;
  try { pushback = (await redFlags(db, `${wk.from}T00:00:00Z`, `${addDays(wk.to, 1)}T00:00:00Z`)).map(toPushback); }
  catch (e) { if (!/stance|does not exist/i.test((e as Error).message)) gaps.push(`Could not compute pushback: ${(e as Error).message.slice(0, 120)}`); }
  return {
    pushback,
    metrics: must(metrics, "post metrics") as MetricSnap[], items: itemRows,
    followers: must(followers, "followers") as FollowerRow[], signals: must(signals, "signals") as SignalRow[],
    comments, manual, baseline, zernio, gaps,
  };
}

/** Channel formats the calendar accepts, for change_format and new_story proposals. */
export const SLOT_FORMATS = ["text", "image", "carousel", "document", "video"] as const;
export const SLOT_CHANNELS = CHANNELS.channels.map((c) => c.slug).filter((s) => MEASURED_PLATFORMS.includes(s));
