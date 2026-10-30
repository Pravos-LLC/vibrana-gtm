// Inspiration board on /guide: the curated seeds (content/guide/inspiration.json) merged with the
// references saved in gtm_inspiration (lib/inspiration.ts owns validation and saving).
import type { InspirationSeed, PillarSlug } from "./content";
import type { Inspiration } from "../inspiration";

/** YouTube links get their public thumbnail; everything else shows its title card. */
export function youtubeThumb(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

export type BoardItem = {
  url: string; title: string; kind: InspirationSeed["kind"]; platform: string; pillar: PillarSlug | null; tags: string[]; why_we_like: string;
  featured: boolean; source: "curated" | "added"; media?: string; image_url?: string;
};

/**
 * Curated seeds first (featured on top), then references saved in gtm_inspiration, newest first.
 * A saved row with a seed's URL is the same reference: it keeps the seed's place, media and note.
 * Pass rows whose thumbnail_path is already a URL (sign storage paths first); anything else shows a title card.
 */
export function mergeBoard(seeds: InspirationSeed[], rows: Inspiration[]): BoardItem[] {
  const seedUrls = new Set(seeds.map((s) => s.url));
  const fromSeeds: BoardItem[] = seeds.map((s) => ({ ...s, featured: !!s.featured, source: "curated" as const }));
  const fromRows: BoardItem[] = rows.filter((r) => !seedUrls.has(r.url)).map((r) => ({
    url: r.url, title: r.title || r.url, kind: r.kind, platform: r.platform ?? "", pillar: r.pillar as PillarSlug | null, tags: r.tags, why_we_like: r.why_we_like,
    featured: false, source: "added" as const, image_url: r.thumbnail_path && /^https?:\/\//.test(r.thumbnail_path) ? r.thumbnail_path : undefined,
  }));
  return [...fromSeeds.filter((s) => s.featured), ...fromRows, ...fromSeeds.filter((s) => !s.featured)];
}
