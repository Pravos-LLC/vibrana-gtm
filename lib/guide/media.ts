import { loadContent } from "../../lib/content-overlay.mjs";
// Content Guide media: content/guide/media.json maps a key to a private content-review path
// (written by scripts/guide-media.mjs). Pages sign the paths they render with the owner's session.
const manifest = loadContent("guide/media.json") as typeof import("../../content/sample/guide/media.json");
import { sessionDb } from "@/lib/supabase/server";
import { BUCKET } from "@/lib/review";
import { signedUrls } from "@/lib/sign-urls";

export type MediaEntry = { kind: "video" | "image"; path: string; poster?: string | null; w: number; h: number; duration?: number };
export type SignedMedia = MediaEntry & { key: string; src: string; posterSrc: string | null };

export const MEDIA = manifest as Record<string, MediaEntry>;

export const mediaKeys = (prefix: string) => Object.keys(MEDIA).filter((k) => k.startsWith(prefix)).sort();

/** Signs every requested key in one call. Unknown keys and failed signatures are dropped, never thrown. */
export async function signMedia(keys: string[], ttl = 60 * 60 * 6): Promise<Record<string, SignedMedia>> {
  const known = [...new Set(keys)].filter((k) => MEDIA[k]);
  const paths = known.flatMap((k) => [MEDIA[k].path, MEDIA[k].poster].filter((p): p is string => !!p));
  if (!paths.length) return {};
  const db = await sessionDb();
  const { data: identity, error: identityError } = await db.auth.getClaims();
  if (identityError || (identity?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) return {};
  const { data } = await signedUrls(db, paths, ttl, BUCKET);
  const url = new Map((data ?? []).filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));
  const out: Record<string, SignedMedia> = {};
  for (const key of known) {
    const m = MEDIA[key];
    const src = url.get(m.path);
    if (src) out[key] = { ...m, key, src, posterSrc: m.poster ? url.get(m.poster) ?? null : null };
  }
  return out;
}
