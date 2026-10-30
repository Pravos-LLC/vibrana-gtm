// Season findings link to the piece they are about (John, 2026-10-13: "I want to be able to CLICK on the warning and go
// to that piece of content so I can fix it"). Kept apart from season-analysis so the client bundle stays small.
import type { Check } from "./season-analysis";

/** /content?piece=<story>&channel=<platform>#<story>-platforms, or null when the finding has no Story behind it. */
export function findingHref(c: Pick<Check, "storyId" | "platform">, path = "/content"): string | null {
  if (!c.storyId) return null;
  const q = new URLSearchParams({ piece: c.storyId });
  if (c.platform) q.set("channel", c.platform);
  return `${path}?${q.toString()}#${encodeURIComponent(c.storyId)}${c.platform ? "-platforms" : ""}`;
}

