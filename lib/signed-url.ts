/**
 * Supabase signs a private object afresh on every server render (the token carries its own issue time), so a
 * `router.refresh()` hands each player a new URL for the same file. Swapping a <video> src reloads it from zero,
 * which is why a video on /content stopped and reset whenever anything on the page saved.
 *
 * keepSignedUrl keeps the URL a player already has while it still names the same object and has time left on
 * its signature. A different object, a different version, or a signature about to lapse takes the new URL.
 */

/** The object a URL names, without its signature. */
const objectOf = (url: string) => {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
};

/** Epoch seconds at which a Supabase signed URL's token expires, or null when it carries none we can read. */
export function signedUrlExpiry(url: string): number | null {
  try {
    const token = new URL(url).searchParams.get("token");
    const payload = token?.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** Swap a little before the signature lapses, so a paused video is never left holding a dead URL. */
const MARGIN_SECONDS = 10 * 60;

export function keepSignedUrl<T extends string | null | undefined>(kept: T, next: T, nowSeconds: number): T {
  if (!kept || !next || kept === next || objectOf(kept) !== objectOf(next)) return next;
  const exp = signedUrlExpiry(kept);
  if (exp !== null && exp - nowSeconds < MARGIN_SECONDS) return next;
  return kept;
}
