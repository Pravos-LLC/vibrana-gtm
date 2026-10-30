import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import type { Attachment } from "@/lib/engage/parse";
import { sessionDb } from "@/lib/supabase/server";
import { resolveAttachmentUrl } from "@/lib/zernio-inbox";

// A DM attachment as a live media link (Instagram and Facebook expire theirs). proxy.ts skips /api, so the
// owner claim is checked here: without it this would hand any visitor a way to read John's DMs. The browser
// follows the redirect straight to the platform's CDN; the bytes never pass through this server.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await ctx.params;
  // Any failure reading the session (no cookies, a tampered token) is signed out.
  let claims: { app_metadata?: unknown } | undefined;
  try { claims = (await (await sessionDb()).auth.getClaims()).data?.claims; } catch { claims = undefined; }
  if ((claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const position = Number(index);
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(position) || position < 0) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { data: row } = await adminDb().from("gtm_comments").select("kind,conversation_id,account_id,attachments").eq("id", id).maybeSingle();
  const attachment = (row?.attachments as Attachment[] | null)?.[position];
  if (!row || row.kind !== "dm" || !row.conversation_id || !row.account_id || !attachment) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const url = await resolveAttachmentUrl(row.conversation_id, attachment.message_id, position, row.account_id);
    if (!url) return NextResponse.json({ error: "no media link" }, { status: 404 });
    return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Zernio could not resolve this attachment" }, { status: 502 });
  }
}
