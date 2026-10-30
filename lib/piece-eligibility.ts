import type { PieceReviewSnapshot } from "./piece-review";
import { parseCopy } from "./calendar";
import { checkChannelLinks } from "./channel-rules";
import { findAgentNotes } from "./copy-guard";
import { createHash } from "node:crypto";
/** Shared by server reads, mutations, CLI and dispatch; provider errors remain delivery outcomes. */
export function reviewEligibility(
  snapshot: PieceReviewSnapshot,
): PieceReviewSnapshot {
  const copy = parseCopy(snapshot.text.asset.body ?? ""),
    blockers = [...snapshot.blockers];
  if (!copy.base.trim())
    blockers.push("Write the shared caption before approval and scheduling");
  if (Object.keys(copy.perChannel).length)
    blockers.push(
      "Save one shared caption to remove platform-specific variants",
    );
  blockers.push(
    ...checkChannelLinks(snapshot.storyId, snapshot.channels, copy).errors,
  );
  if (
    findAgentNotes([copy.base, copy.meta.first_comment ?? ""].join("\n")).length
  )
    blockers.push("Complete the text before approval and publishing");
  if (
    createHash("sha256")
      .update(snapshot.text.asset.body ?? "")
      .digest("hex") !== snapshot.text.asset.sha256
  )
    blockers.push(
      "Text digest differs from its recorded version; save or restage it",
    );
  const offset = copy.meta.instagram_thumb_offset_ms;
  if (
    offset !== undefined &&
    String(offset).trim() !== "" &&
    (!/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset)))
  )
    blockers.push(
      "Instagram cover offset must be a non-negative integer in milliseconds",
    );
  if (
    copy.meta.youtube_thumbnail &&
    (!snapshot.text.asset.metadata?.thumbnail_path ||
      !snapshot.text.asset.metadata?.thumbnail_sha256)
  )
    blockers.push("Restage the selected packaging before scheduling");
  return {
    ...snapshot,
    blockers: [...new Set(blockers)],
    ready: blockers.length === 0,
  };
}
