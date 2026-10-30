import { isOfferOverride } from "@/lib/outreach/offers";
import { generateDeskAngles } from "../actions";
import { isPersonId, isTrack } from "@/lib/outreach/desk";

export const maxDuration = 60;

/** Separate from the Server Action queue so drafting cannot hold up autosave or navigation. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ ok: false, error: "Open the writing desk to generate drafts." }, { status: 403 });
  }
  let input;
  try { input = await request.json(); } catch {
    return Response.json({ ok: false, error: "Invalid drafting request." }, { status: 400 });
  }
  if (!input || !isPersonId(input.personId) || !isTrack(input.track) || (input.offerOverride !== undefined && !isOfferOverride(input.offerOverride))) {
    return Response.json({ ok: false, error: "Choose a person and stream before drafting." }, { status: 400 });
  }
  // Retains the owner claim, stream and client-exclusion gates in the action.
  const result = await generateDeskAngles(input.personId, input.track, input.offerOverride ?? "auto");
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
