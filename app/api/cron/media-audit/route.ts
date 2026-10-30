import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron-auth";
import { RECENT_HOURS, recordAudit, runAudit } from "@/lib/media-audit";

// Daily media audit (John, 2026-10-13): re-probe, from their box headers only, every video and image stored or changed
// in the last two days, everything already flagged, and the media on every Zernio post that has not gone out. A file
// that will not play or load becomes a BLOCK in /content's findings (linked to its piece) and an agent note on its
// Story asset; the next agent runs `gtm media audit --fix`. Vercel has no ffmpeg, so this route only finds and flags.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const db = adminDb();
  const since = new Date(Date.now() - RECENT_HOURS * 3_600_000).toISOString();
  // No probe starts after 200 s, and a probe's reads are bounded (lib/media-guard.ts getWithRetry, about 50 s at worst),
  // so the findings are always recorded inside the 300 s limit. Flagged files and Zernio go
  // first; whatever the deadline leaves is listed as skipped and probed on the next run (or by `gtm media audit`).
  const audit = await runAudit(db, { since, deadline: started + 200_000, concurrency: 8 /* 12 left six files rate-limited past their retries on the first run */ });
  const recorded = await recordAudit(db, audit);
  for (const b of audit.bad) console.error(`media-audit BLOCK ${b.kind ?? "video"} ${b.key}${b.story_id ? ` (${b.story_id})` : ""}: ${b.problems.join("; ")}`);
  for (const u of audit.unreadable) console.warn(`media-audit unreadable ${u.key}: ${u.error}`);
  if (audit.skipped) console.warn(`media-audit: deadline reached, ${audit.skipped} of ${audit.probed} files not probed this run`);
  return NextResponse.json({
    ran_at: audit.ran_at, since, seconds: Math.round((Date.now() - started) / 1000), listed: audit.probed, probed: audit.probedKeys.length, skipped: audit.skipped, videos: audit.videos, images: audit.images, zernio: audit.zernio,
    bad: audit.bad.map((b) => ({ key: b.key, kind: b.kind ?? "video", story: b.story_id, problems: b.problems })), unreadable: audit.unreadable.length, ...recorded,
  });
}
