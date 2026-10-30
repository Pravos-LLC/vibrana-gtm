"use server";

import { adminDb } from "@/lib/db";
import { sessionDb } from "@/lib/supabase/server";
import { upsertPerson, type NewPerson } from "@/lib/people";
import type { Person } from "@/lib/mentions";

async function isOwner(): Promise<boolean> {
  const db = await sessionDb();
  const { data } = await db.auth.getClaims();
  return (data?.claims as { app_metadata?: { gtm_owner?: boolean } } | undefined)?.app_metadata?.gtm_owner === true;
}

/** /content: add someone John typed after "@" (a LinkedIn link and/or an Instagram handle); the LinkedIn tag is resolved
 *  through Zernio at once, so the check under the text says straight away whether it will tag. */
export async function addPerson(input: NewPerson): Promise<{ ok: true; person: Person; linkedinError?: string } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  const r = await upsertPerson(adminDb(), { ...input, rename: false, source: "added in /content" });
  if (!r.ok) return r;
  const { name, linkedin_name, linkedin_urn, linkedin_error, instagram_handle, auto_tag } = r.person;
  return { ok: true, person: { name, linkedin_name, linkedin_urn, linkedin_error, instagram_handle, auto_tag }, ...(r.linkedin && !r.linkedin.ok ? { linkedinError: r.linkedin.error } : {}) };
}
