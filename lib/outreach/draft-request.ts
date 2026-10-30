import type { OfferOverride } from "./offers";
import type { DeskResult } from "../../app/outreach/write/actions";
import type { OutreachAngles } from "./ai-draft-core";
import type { Track } from "./desk";

export const DRAFT_WAIT_MS = 60_000;

/** A plain request runs independently of React's serialized Server Action queue. */
export async function requestDeskAngles(personId: string, track: Track, signal?: AbortSignal, offerOverride: OfferOverride = "auto"): Promise<DeskResult<OutreachAngles>> {
  const response = await fetch("/outreach/write/angles", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personId, track, offerOverride }), signal,
  });
  if (!response.ok) {
    const error = response.status === 401 || response.status === 403
      ? "Your session could not authorize drafting. Sign in again, then retry."
      : response.status === 504
        ? "The drafting server timed out. Try again or keep writing."
        : `The drafting server could not complete the request (HTTP ${response.status}). Try again.`;
    return { ok: false, error };
  }
  try {
    const result = await response.json();
    if (result?.ok === false && typeof result.error === "string") return result;
    if (result?.ok === true && Array.isArray(result.value?.angles) && result.value.angles.length === 3 && Array.isArray(result.value.evidence)) return result;
  } catch { /* A login redirect or platform error may return HTML instead of JSON. */ }
  return { ok: false, error: "The drafting server returned an unreadable response. Reload the desk to check your session, then try again." };
}
