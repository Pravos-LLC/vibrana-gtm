// The people list behind @mentions (gtm_people; lib/mentions.ts has the rules). Reads take any client RLS lets read it;
// writes take the secret-key client. A LinkedIn profile is resolved to its mention URN once, through Zernio, and cached.
import type { SupabaseClient } from "@supabase/supabase-js";
import { CALENDAR } from "../config/calendar";
import { typedName, type Person } from "./mentions";
import { zernio, ZernioError } from "./zernio";

export type PersonRow = Person & { id: string; linkedin_url: string | null; linkedin_checked_at: string | null; source: string };

const COLUMNS = "id,name,linkedin_url,linkedin_name,linkedin_urn,linkedin_error,linkedin_checked_at,instagram_handle,auto_tag,source";

export async function loadPeople(db: SupabaseClient): Promise<PersonRow[]> {
  const { data, error } = await db.from("gtm_people").select(COLUMNS).order("name");
  if (error) throw new Error(`people: ${error.message}`);
  return (data ?? []) as PersonRow[];
}

/** `linkedin.com/in/x`, `https://www.linkedin.com/in/x/?utm=...` or a bare `x` -> `https://www.linkedin.com/in/x`. */
export function normalizeLinkedIn(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company)\/([^/?#\s]+)\/?/i.exec(s);
  if (m) return `https://www.linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`;
  if (/^[A-Za-z0-9_%\p{L}\p{N}-]+$/u.test(s) && !s.includes(".")) return `https://www.linkedin.com/in/${s}`;
  return null;
}

/** `@Handle`, `instagram.com/handle/` or `handle` -> `handle`. */
export function normalizeInstagram(input: string): string | null {
  const s = input.trim().replace(/^@/, "").replace(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

type Resolved = { urn: string; displayName: string; type: string };

/** The mention URN for a profile, from Zernio (it resolves through an organization John administers; posts still go out
 *  from his personal profile). The name must be the exact LinkedIn name for a person tag to be clickable. */
export async function resolveLinkedIn(url: string, displayName?: string | null): Promise<{ ok: true; urn: string; name: string } | { ok: false; error: string; notFound?: boolean; rateLimited?: boolean }> {
  try {
    const r = await zernio<Resolved>(`/accounts/${CALENDAR.accounts.linkedin}/linkedin-mentions`, { query: { url, displayName: displayName ?? undefined }, timeoutMs: 60000, retry429: false });
    if (!/^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(r.urn ?? "")) return { ok: false, error: "Zernio returned no usable URN" };
    return { ok: true, urn: r.urn, name: displayName?.trim() || r.displayName };
  } catch (e) {
    let said = "";
    if (e instanceof ZernioError) { try { said = String((JSON.parse(e.body) as { error?: string }).error ?? ""); } catch { said = ""; } }
    const rateLimited = /rate limit/i.test(said) || (e instanceof ZernioError && e.status === 429);
    const msg = rateLimited ? "LinkedIn rate limit; retried by the daily sync"
      : e instanceof ZernioError ? (e.status === 404 ? "LinkedIn did not find this profile" : `Zernio ${e.status}${said ? `: ${said}` : ""}`)
      : /aborted|timeout/i.test((e as Error).message) ? "Zernio timed out; retried by the daily sync" : (e as Error).message;
    return { ok: false, error: msg.slice(0, 300), notFound: e instanceof ZernioError && e.status === 404 && !rateLimited, rateLimited };
  }
}

/** Resolves one row's URN and stores the outcome either way. */
export async function refreshLinkedIn(admin: SupabaseClient, row: Pick<PersonRow, "id" | "linkedin_url" | "linkedin_name">) {
  if (!row.linkedin_url) return { ok: false as const, error: "no LinkedIn profile" };
  const r = await resolveLinkedIn(row.linkedin_url, row.linkedin_name);
  const patch = r.ok
    ? { linkedin_urn: r.urn, linkedin_name: r.name, linkedin_error: "", linkedin_checked_at: new Date().toISOString() }
    // Only "not found" clears a cached tag; an outage, timeout or rate limit keeps the URN that worked.
    : { ...(r.notFound ? { linkedin_urn: null } : {}), linkedin_error: r.error, linkedin_checked_at: new Date().toISOString() };
  const { error } = await admin.from("gtm_people").update(patch).eq("id", row.id);
  if (error) return { ok: false as const, error: error.message, rateLimited: !r.ok && !!r.rateLimited };
  return r;
}

/** `autoTag`: tag them on LinkedIn whenever John writes their name, no "@" (lib/mentions.ts); unset keeps what is stored. */
export type NewPerson = { name?: string; linkedin?: string; linkedinName?: string; instagram?: string; source?: string; rename?: boolean; autoTag?: boolean };

/** Adds (or updates, matched by LinkedIn profile, Instagram handle or name) a person, and resolves the LinkedIn tag. */
export async function upsertPerson(admin: SupabaseClient, input: NewPerson): Promise<{ ok: true; person: PersonRow; linkedin?: { ok: boolean; error?: string } } | { ok: false; error: string }> {
  const linkedin_url = input.linkedin ? normalizeLinkedIn(input.linkedin) : null;
  if (input.linkedin && !linkedin_url) return { ok: false, error: "That is not a LinkedIn profile link." };
  const instagram_handle = input.instagram ? normalizeInstagram(input.instagram) : null;
  if (input.instagram && !instagram_handle) return { ok: false, error: "That is not an Instagram handle." };
  const linkedin_name = input.linkedinName?.trim() || null;
  const name = (input.name?.trim() || (linkedin_name ? typedName(linkedin_name) : "")).replace(/^@/, "");
  if (!name) return { ok: false, error: "Give the name you will type after @." };
  if (!linkedin_url && !instagram_handle && input.autoTag === undefined) return { ok: false, error: "Give a LinkedIn profile link or an Instagram handle." };
  const all = await loadPeople(admin);
  // One person per row: a LinkedIn link identifies them; without one, the name John types does. A name, link or handle
  // already held by someone else is refused rather than merged into the wrong person.
  const byUrl = linkedin_url ? all.find((p) => p.linkedin_url?.toLowerCase() === linkedin_url.toLowerCase()) : undefined;
  const byName = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const same = byUrl ?? (byName && (!linkedin_url || !byName.linkedin_url) ? byName : undefined);
  if (byName && same && byName.id !== same.id) return { ok: false, error: `${byName.name} is already someone else in your list; use a different name for this person.` };
  if (byName && !same) return { ok: false, error: `${byName.name} is already in your list with a different LinkedIn profile; use a different name for this person.` };
  // Turning a plain-name tag on or off needs no new link, only someone already on the list.
  if (!linkedin_url && !instagram_handle && !same) return { ok: false, error: "Give a LinkedIn profile link or an Instagram handle." };
  const handleOwner = instagram_handle ? all.find((p) => p.instagram_handle === instagram_handle) : undefined;
  if (handleOwner && handleOwner.id !== same?.id) return { ok: false, error: `@${instagram_handle} already belongs to ${handleOwner.name}.` };
  const row = {
    // Only `gtm people add --name` renames someone; /content's add form never does (a rename would break every queued
    // post that already says "@<old name>").
    name: input.rename && input.name?.trim() ? name : same?.name ?? name,
    linkedin_url: linkedin_url ?? same?.linkedin_url ?? null,
    linkedin_name: linkedin_name ?? same?.linkedin_name ?? null,
    instagram_handle: instagram_handle ?? same?.instagram_handle ?? null,
    auto_tag: input.autoTag ?? same?.auto_tag ?? false,
    source: input.source ?? same?.source ?? "",
  };
  const q = same ? admin.from("gtm_people").update(row).eq("id", same.id) : admin.from("gtm_people").insert(row);
  const { data, error } = await q.select(COLUMNS).single();
  if (error || !data) return { ok: false, error: error?.message ?? "not saved" };
  let person = data as PersonRow;
  let linkedin: { ok: boolean; error?: string } | undefined;
  if (person.linkedin_url && (linkedin_url || linkedin_name || !person.linkedin_urn)) {
    const r = await refreshLinkedIn(admin, person);
    linkedin = r.ok ? { ok: true } : { ok: false, error: r.error };
    person = (await loadPeople(admin)).find((p) => p.id === person.id) ?? person;
  }
  return { ok: true, person, linkedin };
}

/**
 * The daily sync's retry (LinkedIn rate-limits URN lookups: the 2026-10-16 import of 310 people hit it after ~240). Up to
 * `max` profiles without a tag, least recently tried first; it stops at the first rate limit so it never burns the quota.
 */
export async function retryUnresolved(admin: SupabaseClient, opts: { max?: number; deadline?: number } = {}) {
  // A profile LinkedIn said it cannot find is retried weekly, not daily, so it never crowds out the rest.
  const week = Date.now() - 7 * 86_400_000;
  const rows = (await loadPeople(admin)).filter((p) => p.linkedin_url && !p.linkedin_urn
      && !(/did not find/.test(p.linkedin_error ?? "") && p.linkedin_checked_at && Date.parse(p.linkedin_checked_at) > week))
    // The team (auto_tag) first: their names tag without an "@", so a missing tag on them costs the most.
    .sort((a, b) => Number(!!b.auto_tag) - Number(!!a.auto_tag) || (a.linkedin_checked_at ?? "").localeCompare(b.linkedin_checked_at ?? ""))
    .slice(0, opts.max ?? 15);
  const out = { tried: 0, resolved: 0, left: 0, stopped: "" };
  for (const p of rows) {
    // Each lookup may take its full 60 s timeout; none starts without that much time left.
    if (opts.deadline && Date.now() > opts.deadline - 65_000) { out.stopped = "deadline"; break; }
    out.tried++;
    const r = await refreshLinkedIn(admin, p);
    if (r.ok) out.resolved++;
    else if ("rateLimited" in r && r.rateLimited) { out.stopped = "LinkedIn rate limit"; break; }
  }
  out.left = (await loadPeople(admin)).filter((p) => p.linkedin_url && !p.linkedin_urn).length;
  return out;
}
