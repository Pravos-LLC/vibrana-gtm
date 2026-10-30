"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { addInspiration, KINDS, type InspirationKind } from "@/lib/inspiration";
import { sessionDb } from "@/lib/supabase/server";

/** Owner-only: save a URL; title and thumbnail come from oEmbed or Open Graph when left blank. */
export async function addInspirationAction(_prev: { ok: boolean; message: string } | null, form: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) return { ok: false, message: "Not signed in as the cockpit owner." };
  const url = String(form.get("url") ?? "").trim();
  const kind = String(form.get("kind") ?? "") as InspirationKind;
  if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, message: "Choose a kind." };
  const pillar = String(form.get("pillar") ?? "") || null;
  try {
    const saved = await addInspiration(adminDb(), {
      url, kind, pillar, title: String(form.get("title") ?? "").trim() || undefined,
      tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean),
      why_we_like: String(form.get("why") ?? "").trim(), added_by: (claims?.claims?.email as string | undefined) ?? "dashboard",
    });
    revalidatePath("/inspiration");
    revalidatePath("/guide");
    return { ok: true, message: `Saved ${saved.title || saved.url}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save it." };
  }
}
