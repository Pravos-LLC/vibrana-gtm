import { loadContent } from "../../lib/content-overlay.mjs";
// Red flags (VIB-424): a deterministic read of one post's classified comments. Some pushback is good for
// awareness ("healthy debate"); misreads clustering on one point mean the post is "not landing"; hostile or
// bad-faith volume, a fast pile-on, or dissent from someone in the CRM is "backlash". Thresholds are absolute
// counts from content/guide/redflags.json. The action comes from a fixed set and is only ever a
// recommendation: nothing here hides, deletes or replies.
import type { SupabaseClient } from "@supabase/supabase-js";
const cfgJson = loadContent("guide/redflags.json") as typeof import("../../content/sample/guide/redflags.json");
import { must } from "../db";
import type { CrmMatch, Stance } from "./parse";
import { authorKey } from "./who";

export type RedFlagConfig = typeof cfgJson;
export const REDFLAGS: RedFlagConfig = cfgJson;

export type FlagType = "backlash" | "not_landing" | "healthy_debate";
export type FlagAction = keyof RedFlagConfig["actions"];
export const FLAG_ORDER: FlagType[] = ["backlash", "not_landing", "healthy_debate"];

/** What the computation needs from a comment (the row as stored). */
export type FlagComment = {
  id: string; platform: string; kind: string; is_own: boolean;
  zernio_post_id: string | null; platform_post_id: string | null; comment_url: string | null;
  content_item_id: string | null; post_preview: string | null; permalink: string | null;
  author_id: string | null; author_username: string | null; author_name: string | null;
  author_crm: CrmMatch | null; author_verified: boolean | null; author_followers: number | null;
  stance: Stance | null; objection: string | null; commented_at: string | null; status: string;
};

export type RedFlag = {
  post_key: string; platform: string; title: string; url: string | null; content_item_id: string | null;
  flag: FlagType; reasons: string[];
  counts: Record<Stance, number> & { classified: number; negative: number; unclassified: number };
  who: { authors: number; repeat: number; known: number; icp: number; verified: number; notable: { name: string; tags: string[]; stance: Stance }[] };
  objection: string | null; objections: { text: string; n: number }[];
  action: FlagAction; also: FlagAction[]; comment_ids: string[]; first_at: string | null; last_at: string | null;
};

/** The same post key the engage queue groups threads by. */
export const postKey = (c: Pick<FlagComment, "platform" | "zernio_post_id" | "platform_post_id" | "comment_url">) =>
  `${c.platform}|${c.zernio_post_id ?? c.platform_post_id ?? c.comment_url?.replace(/\?.*$/, "") ?? "?"}`;

const STOP = new Set("the a an of to and or in on for is it that this be are was with as at by not no about from they their them you your i we our".split(" "));
// A crude stem ("replaces", "replacing" -> "replac") so the same point in different words still groups.
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));

/**
 * Groups objections that are about the same point (shared content words), largest group first. Cheap and
 * deterministic: "cost of training ignored" and "ignores the training cost" land together.
 */
export function clusterObjections(list: string[]): { text: string; n: number }[] {
  const groups: { text: string; keys: Set<string>; n: number }[] = [];
  for (const o of list.map((s) => s.trim()).filter(Boolean)) {
    const w = words(o);
    const g = groups.find((x) => [...w].filter((k) => x.keys.has(k)).length >= Math.min(2, Math.max(1, Math.min(w.size, x.keys.size))));
    if (g) { g.n++; for (const k of w) g.keys.add(k); } else groups.push({ text: o, keys: w, n: 1 });
  }
  return groups.sort((a, b) => b.n - a.n).map(({ text, n }) => ({ text, n }));
}

const zero = (): RedFlag["counts"] => ({ supportive: 0, question: 0, constructive_dissent: 0, misread: 0, hostile: 0, troll_or_bad_faith: 0, spam: 0, classified: 0, negative: 0, unclassified: 0 });

/**
 * One post's flag, or null when its comments are ordinary. `priorAuthors` holds the author keys seen on
 * earlier posts (for "repeat commenter"). Precedence: backlash, then not landing, then healthy debate.
 */
export function flagPost(comments: FlagComment[], opts: { cfg?: RedFlagConfig; priorAuthors?: Set<string>; title?: string | null } = {}): RedFlag | null {
  const cfg = opts.cfg ?? REDFLAGS;
  const mine = comments.filter((c) => !c.is_own && c.kind === "comment");
  if (!mine.length) return null;
  const counts = zero();
  for (const c of mine) {
    if (!c.stance) { counts.unclassified++; continue; }
    counts[c.stance]++; counts.classified++;
  }
  const negativeStances = new Set<string>(cfg.backlash.negative_stances);
  const dissentStances = new Set<string>(cfg.backlash.dissent_stances);
  const knownLevels = new Set<string>(cfg.backlash.known_levels);
  const negative = mine.filter((c) => c.stance && negativeStances.has(c.stance));
  counts.negative = negative.length;
  const knownDissent = mine.filter((c) => c.stance && dissentStances.has(c.stance) && c.author_crm && knownLevels.has(c.author_crm));

  // Velocity: the most negative comments inside any window of `within_hours`.
  const times = negative.map((c) => Date.parse(c.commented_at ?? "")).filter(Number.isFinite).sort((a, b) => a - b);
  const span = cfg.backlash.velocity.within_hours * 3600_000;
  let burst = 0;
  for (let i = 0, j = 0; j < times.length; j++) { while (times[j] - times[i] > span) i++; burst = Math.max(burst, j - i + 1); }

  const reasons: string[] = [];
  let flag: FlagType | null = null;
  if (negative.length >= cfg.backlash.min_negative) reasons.push(`${negative.length} hostile or bad-faith comments`);
  if (burst >= cfg.backlash.velocity.min_negative && negative.length < cfg.backlash.min_negative) reasons.push(`${burst} hostile or bad-faith comments within ${cfg.backlash.velocity.within_hours} h`);
  if (knownDissent.length >= cfg.backlash.min_known_dissent) reasons.push(`pushback from ${knownDissent.length} ${knownDissent.length === 1 ? "person" : "people"} in the CRM`);
  if (reasons.length) flag = "backlash";
  else if (counts.misread >= cfg.not_landing.min_misreads) { flag = "not_landing"; reasons.push(`${counts.misread} people read it as something it does not say`); }
  else if (counts.constructive_dissent >= cfg.healthy_debate.min_dissent && counts.constructive_dissent + counts.question >= cfg.healthy_debate.min_dissent_and_questions) {
    flag = "healthy_debate"; reasons.push(`${counts.constructive_dissent} reasoned disagreements and ${counts.question} questions`);
  }
  if (!flag) return null;

  // Who: distinct authors, repeat commenters (seen on an earlier post), CRM and verified.
  const byAuthor = new Map<string, FlagComment[]>();
  for (const c of mine) byAuthor.set(authorKey(c), [...(byAuthor.get(authorKey(c)) ?? []), c]);
  const authors = [...byAuthor.entries()];
  const one = (list: FlagComment[], f: (c: FlagComment) => boolean) => list.some(f);
  const pushers = mine.filter((c) => c.stance && dissentStances.has(c.stance));
  const notable = [...new Map(pushers.map((c) => [authorKey(c), c])).values()].map((c) => ({
    name: c.author_name ?? c.author_username ?? "someone", stance: c.stance!,
    tags: [c.author_crm === "icp" ? "ICP" : c.author_crm === "contact" ? "in CRM" : null, c.author_verified ? "verified" : null,
      opts.priorAuthors?.has(authorKey(c)) || (byAuthor.get(authorKey(c))?.length ?? 0) > 1 ? "repeat" : null,
      c.author_followers != null && c.author_followers >= 10_000 ? `${Math.round(c.author_followers / 1000)}k followers` : null].filter(Boolean) as string[],
  })).sort((a, b) => b.tags.length - a.tags.length).slice(0, 5);

  const focus = flag === "not_landing" ? mine.filter((c) => c.stance === "misread") : pushers;
  const objections = clusterObjections(focus.map((c) => c.objection ?? "").filter(Boolean));

  // The recommended action, from the fixed set.
  let action: FlagAction;
  const also: FlagAction[] = [];
  if (flag === "backlash") {
    if (knownDissent.length) action = "reply_to_critic";
    else if (counts.troll_or_bad_faith + counts.spam > counts.hostile) action = "hide_and_report";
    else action = "john_decides";
    also.push("adjust_future_content");
  } else if (flag === "not_landing") {
    action = counts.misread >= 3 ? "follow_up" : "clarify";
    also.push("adjust_future_content");
  } else {
    action = mine.some((c) => c.stance === "constructive_dissent" && ["new", "drafted", "failed"].includes(c.status)) ? "reply_to_critic" : "leave_it";
    if (action !== "leave_it") also.push("leave_it");
  }

  const ats = mine.map((c) => c.commented_at).filter(Boolean).sort() as string[];
  const first = mine[0];
  return {
    post_key: postKey(first), platform: first.platform,
    title: (opts.title ?? (first.post_preview ? first.post_preview.split(/\r?\n/)[0] : "(post)")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "(post)",
    url: first.permalink ?? first.comment_url?.replace(/\?.*$/, "") ?? null, content_item_id: first.content_item_id,
    flag, reasons, counts,
    who: {
      authors: authors.length,
      repeat: authors.filter(([k, list]) => opts.priorAuthors?.has(k) || list.length > 1).length,
      known: authors.filter(([, l]) => one(l, (c) => c.author_crm === "contact" || c.author_crm === "icp")).length,
      icp: authors.filter(([, l]) => one(l, (c) => c.author_crm === "icp")).length,
      verified: authors.filter(([, l]) => one(l, (c) => c.author_verified === true)).length,
      notable,
    },
    objection: objections[0]?.text ?? null, objections: objections.slice(0, 3),
    action, also, comment_ids: mine.map((c) => c.id), first_at: ats[0] ?? null, last_at: ats.at(-1) ?? null,
  };
}

/** Flags for every post from a set of comment rows, most severe first. */
export function computeFlags(rows: FlagComment[], opts: { cfg?: RedFlagConfig; priorAuthors?: Map<string, Set<string>>; titles?: Map<string, string> } = {}): RedFlag[] {
  const posts = new Map<string, FlagComment[]>();
  for (const r of rows) if (r.kind === "comment" && !r.is_own) posts.set(postKey(r), [...(posts.get(postKey(r)) ?? []), r]);
  const out: RedFlag[] = [];
  for (const [key, list] of posts) {
    const f = flagPost(list, { cfg: opts.cfg, priorAuthors: opts.priorAuthors?.get(key), title: list[0].content_item_id ? opts.titles?.get(list[0].content_item_id) : null });
    if (f) out.push(f);
  }
  return out.sort((a, b) => FLAG_ORDER.indexOf(a.flag) - FLAG_ORDER.indexOf(b.flag) || b.counts.negative - a.counts.negative || (b.last_at ?? "").localeCompare(a.last_at ?? ""));
}

export const FLAG_COLUMNS = "id,platform,kind,is_own,zernio_post_id,platform_post_id,comment_url,content_item_id,post_preview,permalink,author_id,author_username,author_name,author_crm,author_verified,author_followers,stance,objection,commented_at,status";

/**
 * Red flags for posts that drew a comment in [from, to). A post is judged on its whole thread, the same
 * scope as the webhook check (lib/engage/alerts.ts), so the email, /engage and the out-of-cycle alert always
 * agree. An author who commented on another post before `from` is a repeat commenter. For the dashboard,
 * the 07:00 email, the weekly report's Pushback input and /engage.
 */
export async function redFlags(db: SupabaseClient, from: string | Date, to: string | Date, opts: { cfg?: RedFlagConfig } = {}): Promise<RedFlag[]> {
  const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : d);
  const recent = must(await db.from("gtm_comments").select(FLAG_COLUMNS).eq("is_own", false).eq("kind", "comment")
    .gte("commented_at", iso(from)).lt("commented_at", iso(to)).order("commented_at").limit(5000), "red flag comments") as FlagComment[];
  if (!recent.length) return [];
  // The rest of each thread: earlier comments on the same posts.
  const keys = new Set(recent.map(postKey));
  const zids = [...new Set(recent.map((r) => r.zernio_post_id).filter(Boolean))] as string[];
  const pids = [...new Set(recent.filter((r) => !r.zernio_post_id).map((r) => r.platform_post_id).filter(Boolean))] as string[];
  const older: FlagComment[] = [];
  for (const [col, ids] of [["zernio_post_id", zids], ["platform_post_id", pids]] as const) {
    for (let i = 0; i < ids.length; i += 100) {
      older.push(...must(await db.from("gtm_comments").select(FLAG_COLUMNS).eq("is_own", false).eq("kind", "comment")
        .in(col, ids.slice(i, i + 100)).lt("commented_at", iso(from)).limit(5000), "earlier thread") as FlagComment[]);
    }
  }
  const rows = [...new Map([...older, ...recent].filter((r) => keys.has(postKey(r))).map((r) => [r.id, r])).values()];
  // Earlier comments by the same people (any post), for "repeat commenter".
  const earlier = must(await db.from("gtm_comments").select("platform,zernio_post_id,platform_post_id,comment_url,author_id,author_username,author_name")
    .eq("is_own", false).eq("kind", "comment").lt("commented_at", iso(from)).order("commented_at", { ascending: false }).limit(5000), "earlier commenters") as FlagComment[];
  const seen = new Set(earlier.map(authorKey));
  const prior = new Map<string, Set<string>>();
  for (const r of rows) prior.set(postKey(r), seen);
  const itemIds = [...new Set(rows.map((r) => r.content_item_id).filter(Boolean))] as string[];
  const titles = new Map<string, string>();
  if (itemIds.length) for (const i of must(await db.from("gtm_content_items").select("id,title").in("id", itemIds), "titles") as { id: string; title: string | null }[]) if (i.title) titles.set(i.id, i.title);
  return computeFlags(rows, { cfg: opts.cfg, priorAuthors: prior, titles });
}

export const FLAG_LABEL: Record<FlagType, string> = { backlash: "Backlash", not_landing: "Not landing", healthy_debate: "Healthy debate" };
export const actionLabel = (a: FlagAction, cfg: RedFlagConfig = REDFLAGS) => cfg.actions[a];
