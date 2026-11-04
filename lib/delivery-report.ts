// Read-only reconciliation. A calendar label is never presented as provider verification.
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "./db-read";
import { getPost, type ZPost } from "./zernio";
export type DeliveryItem = { id: string; story_id: string | null; title: string; channels: string[]; status: string; date: string; zernio_post_id: string | null; urls: Record<string, string> | null };
export type Delivery = { itemId: string; storyId: string | null; title: string; channel: string; state: "published" | "scheduled" | "failed" | "blocked" | "unverified"; verified: boolean; url: string | null; reason: string };
export function deliveryState(item: DeliveryItem, channel: string, post?: ZPost | null): Delivery {
  const entry = post?.platforms.find((p) => p.platform === channel);
  const base = { itemId: item.id, storyId: item.story_id, title: item.title, channel, url: entry?.platformPostUrl ?? item.urls?.[channel] ?? null };
  if (entry?.status === "published") return { ...base, state: "published", verified: true, reason: "Published, confirmed by the publishing service" };
  if (entry?.status === "failed" || entry?.errorMessage) return { ...base, state: "failed", verified: true, reason: entry.errorMessage || "Publishing failed on this channel" };
  if (post?.status === "scheduled" && entry && !["failed", "published"].includes(entry.status ?? "")) return { ...base, state: "scheduled", verified: true, reason: "Scheduled, confirmed by the publishing service" };
  if (post) return { ...base, state: "unverified", verified: false, reason: entry ? `Publishing service reports ${entry.status ?? post.status}` : "The publishing service has no delivery for this channel" };
  if (item.zernio_post_id === "pending") return { ...base, state: "unverified", verified: false, reason: "A publishing attempt needs reconciliation; retrying could duplicate it" };
  if (item.zernio_post_id || ["published", "scheduled"].includes(item.status)) return { ...base, state: "unverified", verified: false, reason: `Recorded as ${item.status}; not confirmed with the publishing service` };
  return { ...base, state: item.status === "failed" ? "failed" : "blocked", verified: false, reason: item.status === "failed" ? "Recorded failure; inspect the delivery before retrying" : `Not scheduled (${item.status})` };
}
export async function loadDeliveryReport(db: SupabaseClient, verify = false, lookup: (id: string) => Promise<ZPost> = (id) => getPost(id, { timeoutMs: 5_000, retry429: false })): Promise<Delivery[]> {
  const items = await readPages<DeliveryItem>((from, to) => db.from("gtm_content_items").select("id,story_id,title,channels,status,date,zernio_post_id,urls", { count: "exact" }).order("date").order("id").range(from, to), "delivery records");
  const posts = new Map<string, ZPost | null>();
  const ids = verify ? [...new Set([...items].reverse().map((i) => i.zernio_post_id).filter((id): id is string => !!id && id !== "pending"))].slice(0, 120) : [];
  // Keep service traffic bounded. Lookup failure stays unverified and never rewrites a calendar record.
  for (let i = 0; i < ids.length; i += 6) await Promise.all(ids.slice(i, i + 6).map(async (id) => {
    try { posts.set(id, await lookup(id)); } catch { posts.set(id, null); }
  }));
  return items.flatMap((item) => item.channels.map((channel) => deliveryState(item, channel, posts.get(item.zernio_post_id ?? ""))));
}
