// Server-side halves of the post model: query-string parsing, captions and thumbnail choice. Kept apart
// from lib/posts.ts because lib/calendar.ts reads files, and client components import lib/posts.ts.
import { parseCopy, STATUSES } from "./calendar";
import { CHANNELS, type Post, type PostFilters } from "./posts";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function parsePostFilters(params: Params): PostFilters {
  const channel = one(params.channel), status = one(params.status), pillar = one(params.pillar);
  return {
    q: one(params.q).trim().slice(0, 100),
    channel: (CHANNELS as readonly string[]).includes(channel) ? channel : "",
    status: (STATUSES as readonly string[]).includes(status) ? status : "",
    pillar: /^[a-z-]{1,30}$/.test(pillar) ? pillar : "",
  };
}

/** The copy the post's channel will actually send: its `--- channel: x ---` section, else the shared text. */
export function captionFor(body: string | null, channel: string | undefined): string {
  if (!body) return "";
  const { base, perChannel } = parseCopy(body);
  return ((channel && perChannel[channel]) || base).trim();
}

type AssetRef = { id: string; kind: string; storage_path: string | null; metadata: unknown };

/**
 * The storage path to show as the post's thumbnail: the first image among its Story assets, else a video's
 * poster frame, else the first image in its media list. Null when the post has nothing to look at.
 */
export function thumbFor(item: { story_assets?: string[] | null; media?: string[] | null; format: string }, assets: Map<string, AssetRef>):
  { path: string | null; kind: Post["mediaKind"] } {
  const own = (item.story_assets ?? []).map((id) => assets.get(id)).filter((a): a is AssetRef => !!a);
  const image = own.find((a) => a.kind === "image" && a.storage_path);
  const video = own.find((a) => a.kind === "video");
  const poster = (video?.metadata as { poster_path?: string } | null)?.poster_path ?? null;
  const media = item.media ?? [];
  const kind: Post["mediaKind"] = video || media.some((m) => /\.(mp4|mov|webm)$/i.test(m)) ? "video"
    : item.format === "document" || media.some((m) => /\.pdf$/i.test(m)) ? "document"
    : image || media.some((m) => /\.(png|jpe?g|webp)$/i.test(m)) ? "image" : null;
  // A video's own poster beats a cover image only when there is no cover: covers are what the platform shows.
  const path = image?.storage_path ?? poster ?? media.find((m) => /\.(png|jpe?g|webp)$/i.test(m)) ?? null;
  return { path, kind };
}

