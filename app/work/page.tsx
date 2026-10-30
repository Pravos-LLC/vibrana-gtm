import { Shell } from "@/components/shell";
import { AutoRefresh } from "@/components/work/auto-refresh";
import { WorkBoard, type Piece } from "@/components/work/board";
import { calendarConfig } from "@/lib/calendar-db";
import { BUCKET } from "@/lib/review";
import { sessionDb } from "@/lib/supabase/server";
import { buildBoard, IN_PROGRESS, type BoardRow, type WorkItem } from "@/lib/work/model";
import { pieceInfo, waitingNotes } from "@/lib/work/store";
import { signedUrls } from "@/lib/sign-urls";

export const dynamic = "force-dynamic";

const COLUMNS = "id,created_at,updated_at,story_id,asset_id,storyboard_id,source_note_ids,title,status,agent,eta_at,last_update,blocked_reason,staged_at,done_at";

export const metadata = { title: "Work" };

/**
 * The work board: what happens to John's notes. Nothing in the web app runs an agent: the note dispatcher on John's Mac
 * (ops/work-dispatch.sh, a LaunchAgent every 3 minutes) starts one headless Claude Code run per waiting piece, and the
 * run reports here with `gtm work`. Minimal on purpose (John, 2026-10-13).
 */
export default async function WorkPage() {
  const db = await sessionDb(); // RLS: only the owner reads gtm_work_items and the notes
  const now = new Date();
  const since = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
  const [{ data, error }, waiting] = await Promise.all([
    db.from("gtm_work_items").select(COLUMNS).or(`status.in.(${IN_PROGRESS.join(",")}),updated_at.gte.${since}`).order("updated_at", { ascending: false }).limit(300),
    waitingNotes(db).catch(() => null),
  ]);
  if (error || !waiting) return <Shell title="Work" active="/work"><p className="text-sm text-red-strong">The work board could not load: {error?.message ?? "waiting notes"}</p></Shell>;
  const board = buildBoard((data ?? []) as WorkItem[], waiting, now, calendarConfig().timezone);
  const rows = [...board.waiting, ...board.inProgress, ...board.review, ...board.doneToday];
  const ref = (r: BoardRow) => (r.kind === "item" ? { story: r.item.story_id, board: r.item.storyboard_id, asset: r.item.asset_id } : { story: r.storyId, board: r.storyboardId, asset: r.notes[0]?.asset_id ?? null });
  const refs = rows.map(ref);
  const info = await pieceInfo(db, [...new Set(refs.map((r) => r.story).filter((x): x is string => !!x))], refs.map((r) => r.asset).filter((x): x is string => !!x));
  const paths = [...new Set([...info.story.values()].map((p) => p.thumbPath).filter((p): p is string => !!p))];
  const { data: signed } = await signedUrls(db, paths, 60 * 60, BUCKET);
  const urls = new Map((signed ?? []).flatMap((s) => (s.signedUrl && s.path && !s.error ? [[s.path, s.signedUrl] as const] : [])));
  const pieceOf = (r: BoardRow): Piece | null => {
    const x = ref(r);
    const p = x.story ? info.story.get(x.story) : undefined;
    return p ? { name: p.name, thumb: p.thumbPath ? urls.get(p.thumbPath) ?? null : null } : null;
  };
  return (
    <Shell title="Work" active="/work">
      <AutoRefresh seconds={60} />
      <WorkBoard board={board} pieceOf={pieceOf} now={now} />
    </Shell>
  );
}
