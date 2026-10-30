// Which stored object a URL in the page names. Client-safe (no node imports): the players report and re-sign by URL.

/** The content-review key of a Supabase signed (or public/authenticated) Storage URL, or null for any other URL. */
export function storageKeyOf(url: string, bucket = "content-review"): string | null {
  try {
    const u = new URL(url, "https://cockpit.invalid");
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/(.+)$/);
    if (!m || m[1] !== bucket) return null;
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}
