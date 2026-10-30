// Who "we" are on each platform, so our own comments (and Meta's echoes of replies we sent) are never
// queued or counted, even when a payload carries no isOwnAccount flag.
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAccounts } from "../zernio";
import type { OwnContext } from "./parse";
import { sentReplyIds } from "./store";

let cached: { at: number; handles: Map<string, Set<string>> } | null = null;
const TTL_MS = 10 * 60_000;

/** Our handle and display name on each connected platform, lowercased; cached 10 minutes per instance. */
export async function ownHandles(opts: { fresh?: boolean } = {}): Promise<Map<string, Set<string>>> {
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.handles;
  const handles = new Map<string, Set<string>>();
  try {
    for (const a of (await listAccounts()).accounts) {
      const set = handles.get(a.platform) ?? new Set<string>();
      for (const h of [a.username, a.displayName]) if (h) set.add(h.toLowerCase());
      handles.set(a.platform, set);
    }
    cached = { at: Date.now(), handles };
  } catch {
    // Zernio down: keep the last good list; the explicit isOwnAccount flags and sent reply ids still apply.
    return cached?.handles ?? handles;
  }
  return handles;
}

export async function ownContext(db: SupabaseClient | null, opts: { fresh?: boolean } = {}): Promise<OwnContext> {
  return { ownHandles: await ownHandles(opts), sentReplyIds: db ? await sentReplyIds(db) : new Set() };
}

/** Test hook: forget the cached handles. */
export function resetOwnCache() { cached = null; }
