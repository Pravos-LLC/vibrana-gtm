// Reads what /content would list, with the same rules as the page (lib/content-visibility.ts), for `gtm story hidden`,
// `gtm story withdraw` and checks from a terminal. Service role.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { channelsSentBack, hiddenFromContent, type Hidden, type VisibilityDecision, type VisibilityStage, type VisibilityVersion } from "./content-visibility";
import { finalState } from "./pipeline-state";
import { publishedUrl, withoutAlternatives } from "./newsletter-card";
import { REVIEW_CHANNELS } from "./season";
import { boardStoryIds, onBoard } from "./season-board";
import { isPublishedCard, loadPublishedCards, withoutPublishedDecisions } from "./review-publication";

type Asset = { id: string; story_id: string; kind: string; stage: string | null; revision: number; sha256: string; source: string; body: string | null; metadata: Record<string, unknown> | null };
type Row = { asset_id: string; channel: string; status: string; approved_sha256: string | null };

async function chunked<T>(ids: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...await load(ids.slice(i, i + 150)));
  return out;
}

/**
 * Season pieces /content lists before filters (a piece with at least one platform text), and those hidden from it,
 * with the reason. `storyId` narrows it to one Story.
 */
export type ContentVisibility = {
  /** Season pieces with at least one platform card (what /content listed before these rules). */
  listed: string[]; shown: string[]; hidden: Hidden[];
  /** Platform cards: listed before the rules, shown now, and the cards left out of shown pieces (sent back). */
  cards: { listed: number; shown: number; sentBack: Array<{ storyId: string; channel: string }> };
};

export async function contentVisibility(db: SupabaseClient, storyId?: string): Promise<ContentVisibility> {
  const q = db.from("gtm_stories").select("id,season_id");
  const [{ live, killed }, published] = await Promise.all([boardStoryIds(db), loadPublishedCards(db)]);
  const stories = (must(await (storyId ? q.eq("id", storyId) : q), "stories") as { id: string; season_id: string | null }[]).filter((s) => onBoard(s, live, killed)).map((s) => s.id).sort();
  const cards = { listed: 0, shown: 0, sentBack: [] as Array<{ storyId: string; channel: string }> };
  if (!stories.length) return { listed: [], shown: [], hidden: [], cards };
  const assets = await chunked(stories, async (part) => must(await db.from("gtm_story_assets").select("id,story_id,kind,stage,revision,sha256,source,body,metadata").in("story_id", part), "assets") as Asset[]);
  const ids = assets.map((a) => a.id);
  const rows = ids.length ? await chunked(ids, async (part) => must(await db.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", part), "channels") as Row[]) : [];
  const versions = ids.length ? await chunked(ids, async (part) => must(await db.from("gtm_story_asset_versions").select("asset_id,revision,created_at").in("asset_id", part), "versions") as VisibilityVersion[]) : [];
  const stages = await chunked(stories, async (part) => must(await db.from("gtm_story_stages").select("story_id,stage,status,note,updated_at").in("story_id", part), "stages") as Array<VisibilityStage & { story_id: string }>);
  const decisions = await chunked(stories, async (part) => must(await db.from("gtm_story_stage_decisions").select("story_id,stage,party,decision,decided_at,assets").in("story_id", part), "decisions") as Array<VisibilityDecision & { story_id: string }>);
  const listed: string[] = [];
  const shown: string[] = [];
  const hidden: Hidden[] = [];
  for (const id of stories) {
    const own = assets.filter((a) => a.story_id === id);
    // A published Substack essay has nothing left to decide: its rows and card are out, as on the page.
    const ownRows = withoutAlternatives(own, withoutPublishedDecisions(own, rows.filter((r) => own.some((a) => a.id === r.asset_id)), published));
    // The page lists a piece when one of its platforms, or its newsletter, has a text (a card).
    const roles = REVIEW_CHANNELS.filter((role) => own.some((a) => a.kind === "copy" && !isPublishedCard(published, id, a.id, role) && !(role === "newsletter" && publishedUrl(a)) && ownRows.some((r) => r.asset_id === a.id && r.channel === role)));
    if (!roles.length) continue;
    listed.push(id);
    cards.listed += roles.length;
    const input = {
      storyId: id, finalStaged: finalState(own, ownRows).staged, assets: own, rows: ownRows,
      versions: versions.filter((v) => own.some((a) => a.id === v.asset_id)),
      stages: stages.filter((s) => s.story_id === id), decisions: decisions.filter((d) => d.story_id === id),
    };
    const h = hiddenFromContent(input, roles);
    if (h) { hidden.push(h); continue; }
    shown.push(id);
    const back = channelsSentBack(input);
    for (const role of roles) if (back.has(role)) cards.sentBack.push({ storyId: id, channel: role }); else cards.shown++;
  }
  return { listed, shown, hidden, cards };
}

/**
 * `gtm story withdraw <id> --note`: takes a staged final off /content until a new final is staged (the final's stage row
 * at "working", which the pipeline view never reads: the final's state comes from the platform approvals). It changes
 * no asset, approval, note or schedule.
 */
export async function withdrawFinal(db: SupabaseClient, storyId: string, note: string, opts: { dryRun?: boolean } = {}) {
  const text = note.trim();
  if (!text) throw new Error('withdraw needs --note "why" (for example "new final being rendered from the approved storyboard")');
  if (text.length > 2000) throw new Error("--note is limited to 2000 characters");
  const story = must(await db.from("gtm_stories").select("id").eq("id", storyId).maybeSingle(), "story") as { id: string } | null;
  if (!story) throw new Error(`no Story ${storyId}`);
  const items = must(await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("story_id", storyId), "calendar items") as Array<{ id: string; status: string; zernio_post_id: string | null }>;
  const live = items.filter((i) => i.zernio_post_id || i.status === "scheduled" || i.status === "published");
  if (live.length) throw new Error(`${live.map((i) => `${i.id} (${i.status})`).join(", ")} is already on Zernio; unschedule it first, withdrawing only hides it from /content`);
  if (!opts.dryRun) {
    must(await db.from("gtm_story_stages").upsert({ story_id: storyId, stage: "final", status: "working", note: text, actor: "agent", updated_at: new Date().toISOString() }), "withdraw");
  }
  return { story: storyId, withdrawn: !opts.dryRun, note: text, visibility: await contentVisibility(db, storyId) };
}
