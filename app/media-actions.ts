"use server";

// The players' two calls (components/media/watched-media.tsx): a fresh signature for a URL that failed to load (a 429
// from Storage is transient, a signature can lapse), and the report of a file the browser could not decode after its
// retries, which becomes a BLOCK finding in /content and an agent note on the asset (lib/media-audit.ts).
//
// Who may ask: the owner for any stored key (team members see /signals only, no stored media); a third-party reviewer only for the keys their /shared page
// shows (lib/reviewer/shared.ts sharedKeys). Signing uses the service client after that check, because Storage reads are
// owner-only. Nothing the browser sends is trusted: the kind comes from the key, the evidence from the server's own
// probe, and the reporter's text never reaches an agent note.
import { sessionDb } from "@/lib/supabase/server";
import { adminDb } from "@/lib/db";
import { storageKeyOf } from "@/lib/media-url";
import { BUCKET } from "@/lib/review";
import { isImageName } from "@/lib/image-loadable";

type Caller = { all: true } | { all: false; keys: Set<string> };

/** What the signed-in caller may re-sign or report, or null for anyone else. */
async function caller(): Promise<Caller | null> {
  const db = await sessionDb();
  const { data } = await db.auth.getUser();
  const meta = data.user?.app_metadata as { gtm_owner?: boolean; gtm_reviewer?: boolean } | undefined;
  if (!data.user) return null;
  if (meta?.gtm_owner) return { all: true };
  if (!meta?.gtm_reviewer) return null;
  const { data: parties } = await db.rpc("gtm_reviewer_parties");
  const list = (parties as string[] | null) ?? [];
  if (!list.length) return null;
  const { sharedKeys } = await import("@/lib/reviewer/shared");
  return { all: false, keys: await sharedKeys(adminDb(), list) };
}
const allowed = (c: Caller, key: string) => c.all || c.keys.has(key);

/** Fresh signed URLs (six hours) for stored media URLs, keyed by the URL asked about. Not allowed or unknown: left out. */
export async function resignMedia(urls: string[]): Promise<Record<string, string>> {
  const who = await caller();
  if (!who) return {};
  const keys = new Map<string, string>();
  for (const u of urls.slice(0, 20)) { const k = storageKeyOf(u); if (k && allowed(who, k)) keys.set(k, u); }
  if (!keys.size) return {};
  const { signedUrls } = await import("@/lib/sign-urls");
  const { data } = await signedUrls(adminDb(), [...keys.keys()], 60 * 60 * 6, BUCKET);
  const out: Record<string, string> = {};
  for (const d of data) if (d.path && d.signedUrl && keys.has(d.path)) out[keys.get(d.path)!] = d.signedUrl;
  return out;
}

export type PlaybackReport = { src: string; code: number | null; message: string; page: string | null; /** the browser decoded no picture */ decode?: boolean };

/**
 * A player gave up on a file. The server reads it itself and files a BLOCK only on evidence:
 *   - the header probe finds a problem (whatever the browser said), or
 *   - a video loaded but decoded no picture (MEDIA_ERR_DECODE, or no frames): a codec the header check cannot see.
 * A network, expired-link or rate-limit failure on a file whose bytes are fine files nothing; the next view retries.
 */
export async function reportUnplayable(r: PlaybackReport): Promise<{ filed: boolean; reason?: string }> {
  const who = await caller();
  if (!who) return { filed: false, reason: "not signed in" };
  const key = storageKeyOf(r.src);
  if (!key || !allowed(who, key)) return { filed: false, reason: "not a stored file this user can see" };
  const kind = isImageName(key) ? "image" as const : "video" as const;
  const admin = adminDb();
  const { problemKey, noteOnAsset, probeStored, refsForKey } = await import("@/lib/media-audit");
  const { data: existing } = await admin.from("gtm_sync_state").select("key").eq("key", problemKey(key)).maybeSingle();
  if (existing) return { filed: true, reason: "already flagged" };
  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(key, 300);
  if (!signed) return { filed: false, reason: "the file is gone" };
  const head = await fetch(signed.signedUrl, { headers: { range: "bytes=0-0" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  await head.body?.cancel().catch(() => {});
  if (head.status === 429 || head.status >= 500) return { filed: false, reason: `storage busy (${head.status})` };
  let problems: string[] = [];
  try { problems = await probeStored(admin, key, undefined, fetch, signed.signedUrl, kind); } catch (e) { return { filed: false, reason: `the server could not read it: ${e instanceof Error ? e.message : String(e)}` }; }
  const decode = kind === "video" && (r.decode === true || r.code === 3);
  if (!problems.length && !decode) return { filed: false, reason: "the bytes are fine; a network, expired-link or rate-limit failure" };
  if (!problems.length) problems = ["the browser loaded it but decoded no picture, though its header looks valid (a codec or level the player cannot decode)"];
  const { refs, story_id } = await refsForKey(admin, key);
  const value = {
    key, where: "storage" as const, kind, problems, story_id, refs, source: "browser" as const, detected_at: new Date().toISOString(),
    // What the browser said is kept for a person to read; it never goes into an agent note.
    browser: { code: typeof r.code === "number" ? r.code : null, message: String(r.message ?? "").slice(0, 200), page: typeof r.page === "string" ? r.page.slice(0, 200) : null, decode },
  };
  await admin.from("gtm_sync_state").upsert({ key: problemKey(key), value, updated_at: value.detected_at });
  await noteOnAsset(admin, value);
  console.error(`media report BLOCK ${kind} ${key} from ${value.browser.page}: ${problems.join("; ")}`);
  return { filed: true };
}
