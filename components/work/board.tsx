import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { agoLabel, etaLabel, pieceHref, STATUS_LABEL, type Board, type BoardRow, type WorkStatus } from "@/lib/work/model";
import { WatchedImage } from "@/components/media/watched-media";

export type Piece = { name: string; thumb: string | null };

const TONE: Record<WorkStatus | "waiting", "default" | "success" | "warning" | "destructive" | "info" | "outline"> = {
  waiting: "warning", queued: "outline", working: "default", rendering: "default", checking: "info", staged: "success", done: "success", blocked: "destructive",
};

function Thumb({ src, name }: { src: string | null; name: string }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-[color:var(--surface-inset)]">
      {src ? <WatchedImage src={src} alt={`Preview of ${name}`} loading="lazy" decoding="async" className="size-full object-cover" /> : <Clapperboard className="size-4 text-ink-3" aria-hidden />}
    </div>
  );
}

/** One job: thumbnail, title, status, when it last moved, ETA, and the way to the piece. Nothing else. */
function Row({ row, piece, now }: { row: BoardRow; piece: Piece | null; now: Date }) {
  const isItem = row.kind === "item";
  const ref = isItem ? { storyId: row.item.story_id, storyboardId: row.item.storyboard_id } : { storyId: row.storyId, storyboardId: row.storyboardId };
  const href = pieceHref(ref);
  const name = piece?.name ?? (isItem ? row.item.title : ref.storyboardId ?? ref.storyId ?? "A piece");
  const title = isItem ? row.item.title : `${name}: ${row.notes.length} note${row.notes.length === 1 ? "" : "s"}`;
  const status = isItem ? row.item.status : "waiting";
  const line = isItem ? (row.item.status === "blocked" ? row.item.blocked_reason : row.item.last_update) : "";
  return (
    <li className="flex items-center gap-4 border-b border-line py-3 last:border-b-0" data-testid="work-row" data-status={status}>
      <Thumb src={piece?.thumb ?? null} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium text-ink">{title}</span>
          <Badge variant={TONE[status]}>{status === "waiting" ? "Waiting for an agent" : STATUS_LABEL[status]}</Badge>
        </div>
        {line && <p className={`mt-0.5 truncate text-xs ${status === "blocked" ? "text-red-strong" : "text-ink-3"}`}>{line}</p>}
      </div>
      <div className="hidden w-28 shrink-0 text-right text-xs text-ink-3 sm:block">{isItem ? `updated ${agoLabel(row.item.updated_at, now)}` : `sent ${agoLabel(row.since, now)}`}</div>
      <div className="w-24 shrink-0 text-right text-xs tabular-nums text-ink-2" title="Estimated time to finish">{isItem ? etaLabel(row.item.eta_at, row.item.status, now) : "—"}</div>
      <div className="w-24 shrink-0 text-right text-xs">
        {href ? <Link href={href} className="font-medium text-ink underline underline-offset-4">Open in Review</Link> : null}
      </div>
    </li>
  );
}

const GROUPS: Array<{ key: keyof Board; label: string; empty: string; hint?: string }> = [
  // The note dispatcher (ops/work-dispatch.sh) runs on John's Mac; while it is asleep or the dispatcher is off, nothing
  // picks a note up, so the hint says where to look. A run that dies or notes it gave up on become Blocked jobs.
  { key: "waiting", label: "Waiting for an agent", empty: "Every note you left has been picked up.",
    hint: "Your Mac picks these up every 3 minutes, one piece at a time, on your Claude subscription. A note still waiting after that means the Mac is asleep, the dispatcher is off, or the piece has a job still running. If the dispatcher gives up on a note, or a run dies, the job shows below as Blocked with the reason (log: ~/Library/Logs/vibrana/work-dispatch.log)." },
  { key: "inProgress", label: "In progress", empty: "Nothing is being worked on right now." },
  { key: "review", label: "Ready for your review", empty: "Nothing new staged in the last 24 hours." },
  { key: "doneToday", label: "Done today", empty: "Nothing finished yet today." },
];

export function WorkBoard({ board, pieceOf, now }: { board: Board; pieceOf: (row: BoardRow) => Piece | null; now: Date }) {
  return (
    <div className="space-y-8">
      {GROUPS.map((g) => (
        <section key={g.key} aria-label={g.label} data-testid={`work-${g.key}`}>
          <h2 className="mb-1 flex items-baseline gap-2 font-display text-sm font-semibold uppercase tracking-wide text-ink-2">
            {g.label}<span className="font-mono text-xs text-ink-3">{board[g.key].length}</span>
          </h2>
          {g.hint && board[g.key].length > 0 && <p className="mb-2 text-xs text-ink-3">{g.hint}</p>}
          {board[g.key].length
            ? <ul>{board[g.key].map((r) => <Row key={r.key} row={r} piece={pieceOf(r)} now={now} />)}</ul>
            : <p className="py-3 text-sm text-ink-3">{g.empty}</p>}
        </section>
      ))}
    </div>
  );
}
