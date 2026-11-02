// Which channels a piece goes to (John, 2026-11-02): "I want to easily select if one piece goes out to multiple channels
// or just one. The approval comes with the channels I select; several channels share one post text." A channel is on a
// piece when the piece's files are bound to it (gtm_story_asset_channels). Ticking a channel binds the piece's one text
// and its media to it; unticking unbinds it, so nothing can approve, schedule or post the piece there afterwards. The
// files themselves are never deleted: ticking the channel again binds them again.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { nonFinal } from "./stage";
import { pillarAllowed, traitPillarOf } from "./rhythm";

export const PIECE_CHANNELS = ["linkedin", "instagram", "youtube"] as const;
export type PieceChannel = (typeof PIECE_CHANNELS)[number];

export type ChannelAsset = { id: string; kind: string; sha256: string; revision: number; body: string | null; stage: string | null };
export type Binding = { asset_id: string; channel: string; status: string };
export type ChannelRow = { id: string; status: string; channels: string[] | null; pillar: string | null; zernio_post_id: string | null };
export type PieceChannelState = { storyId: string; assets: ChannelAsset[]; bindings: Binding[]; rows: ChannelRow[] };

export async function loadPieceChannels(db: SupabaseClient, storyId: string): Promise<PieceChannelState> {
  const assets = must(await db.from("gtm_story_assets").select("id,kind,sha256,revision,body,stage").eq("story_id", storyId).in("kind", ["copy", "video", "image"]), "piece files") as ChannelAsset[];
  const bindings = assets.length ? must(await db.from("gtm_story_asset_channels").select("asset_id,channel,status").in("asset_id", assets.map((a) => a.id)), "piece channels") as Binding[] : [];
  const rows = must(await db.from("gtm_content_items").select("id,status,channels,pillar,zernio_post_id").eq("story_id", storyId), "piece calendar") as ChannelRow[];
  return { storyId, assets, bindings, rows };
}

/** The platform channels the piece's files are bound to now. */
export function boundChannels(s: PieceChannelState): PieceChannel[] {
  return PIECE_CHANNELS.filter((c) => s.bindings.some((b) => b.channel === c));
}

/** The files a channel posts: the piece's one text and its media, as bound to the channels it already goes to. */
export function filesFor(s: PieceChannelState, channel: string, from: string[]): ChannelAsset[] {
  const bound = (c: string) => new Set(s.bindings.filter((b) => b.channel === c).map((b) => b.asset_id));
  const own = bound(channel);
  if (own.size) return s.assets.filter((a) => own.has(a.id));
  const source = from.map(bound).find((set) => set.size) ?? new Set<string>();
  const copies = s.assets.filter((a) => a.kind === "copy" && source.has(a.id));
  return [...copies.slice(0, 1), ...s.assets.filter((a) => a.kind !== "copy" && source.has(a.id))];
}

export type ChannelPlan = { on: PieceChannel[]; add: PieceChannel[]; off: PieceChannel[]; errors: string[] };

/** What a tick set means for the piece: which channels are added, which removed, and what forbids it. Pure. */
export function planChannels(s: PieceChannelState, wanted: string[]): ChannelPlan {
  const on = PIECE_CHANNELS.filter((c) => wanted.includes(c));
  const bound = boundChannels(s);
  const add = on.filter((c) => !bound.includes(c));
  const off = bound.filter((c) => !on.includes(c));
  const errors: string[] = [];
  if (!on.length) errors.push("Tick at least one channel, or kill the piece.");
  const keep = on.filter((c) => bound.includes(c));
  if (add.length && !keep.length) errors.push("Keep at least one channel the piece is already staged for, so its text and media can be copied to the new one.");
  const pillar = s.rows.find((r) => r.pillar)?.pillar ?? traitPillarOf(s.storyId);
  for (const c of add) {
    const files = filesFor(s, c, keep);
    if (c === "youtube" && !files.some((a) => a.kind === "video")) errors.push("YouTube needs a video, and this piece has none.");
    if (c === "instagram" && !files.some((a) => a.kind === "video" || a.kind === "image")) errors.push("Instagram needs an image or a video, and this piece has none.");
    if (!pillarAllowed(pillar, c)) errors.push(`${c === "instagram" ? "Instagram" : c} never takes ${pillar} pieces (the weekly rhythm).`);
  }
  for (const c of off) {
    if (s.rows.some((r) => (r.channels ?? []).includes(c) && r.status === "published")) errors.push(`It already went out on ${c}; that cannot be taken back here.`);
  }
  const media = s.assets.filter((a) => s.bindings.some((b) => b.asset_id === a.id && on.includes(b.channel as PieceChannel)) || (add.length > 0 && filesFor(s, add[0], keep).includes(a)));
  if (nonFinal(media).length) errors.push("The media is still a rough cut. Approve the edit in its stage; the channels are picked once the final is in.");
  return { on, add, off, errors };
}

/** Binds the files to a new channel, pending John's decision. */
export async function bindChannel(db: SupabaseClient, files: ChannelAsset[], channel: string): Promise<void> {
  if (!files.length) return;
  must(await db.from("gtm_story_asset_channels").upsert(files.map((a) => ({ asset_id: a.id, channel, status: "pending" })), { onConflict: "asset_id,channel", ignoreDuplicates: true }), `bind ${channel}`);
}

/**
 * Unbinds a channel from the piece: its unsent calendar rows (already skipped by dropPieceChannel) are removed and its
 * file bindings deleted. The files stay. A row that went out is never touched (planChannels refuses that channel).
 */
export async function unbindChannel(db: SupabaseClient, s: PieceChannelState, channel: string): Promise<void> {
  const unsent = s.rows.filter((r) => (r.channels ?? []).includes(channel) && r.status !== "published").map((r) => r.id);
  if (unsent.length) must(await db.from("gtm_content_items").delete().in("id", unsent).neq("status", "published").is("zernio_post_id", null), `remove ${channel} rows`);
  const ids = s.bindings.filter((b) => b.channel === channel).map((b) => b.asset_id);
  if (ids.length) must(await db.from("gtm_story_asset_channels").delete().in("asset_id", ids).eq("channel", channel), `unbind ${channel}`);
}
