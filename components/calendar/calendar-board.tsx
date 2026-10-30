"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { calendarFailure, calendarPieceLegs, killCalendarPiece, moveCalendarPost, publishCalendarPost, retryCalendarPost } from "@/app/calendar/actions";
import { SHIFT_EVENT } from "@/components/calendar/calendar-toolbar";
import { ChannelMark, PostChip, PostRow, StatusBadge, channelLabel } from "@/components/content/post-card";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/button";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { movable, pieceLegs, reviewHref, type Post } from "@/lib/posts";
import { addDays, mondayOf, monthLastDay } from "@/lib/week";
import { WatchedImage } from "@/components/media/watched-media";
import { RhythmLabel } from "@/components/calendar/rhythm-label";

type ListGroups = { overdue: Post[]; weeks: { monday: string; posts: Post[] }[]; done: Post[] };


const DOT: Record<string, string> = {
  idea: "bg-line", drafted: "bg-line", approved: "bg-violet", scheduled: "bg-emerald-500", published: "bg-ink-3", failed: "bg-red-strong", skipped: "bg-line",
};

type MoveOpts = { time?: string; all?: boolean; force?: boolean };

/**
 * The calendar in month, week or list view. A click on any post opens the same detail sheet, where its date and time can
 * be changed. In the month and week views a post that has not gone out can be dragged to another day, or onto Previous
 * week / Next week: the whole piece moves (every leg of its Story that has not gone out, each keeping its time). The move
 * is saved (and sent to Zernio for scheduled legs) before the page refreshes; a refused move snaps back with the reason.
 */
export function CalendarBoard(props: { rhythmLabels: Record<string, { primary: string; fallback: string[] }> } & ({ view: "month"; posts: Post[]; month: string; today: string } | { view: "week"; posts: Post[]; monday: string; today: string } | { view: "list"; groups: ListGroups })) {
  const router = useRouter();
  const [selected, setSelected] = useState<Post | null>(null);
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A move onto a day another piece holds waits here for "Move anyway" (two pieces can swap days without a detour).
  const [clash, setClash] = useState<{ id: string; date: string; opts: MoveOpts } | null>(null);
  const [, start] = useTransition();
  const all = props.view === "list" ? [...props.groups.overdue, ...props.groups.weeks.flatMap((w) => w.posts), ...props.groups.done] : props.posts;
  const open = (post: Post) => setSelected(post);
  const move = (id: string, date: string, opts: MoveOpts = {}) => {
    setError(null);
    setNotice(null);
    setClash(null);
    const before = moved;
    const legs = pieceLegs(all, id, opts.all !== false);
    setMoved((m) => ({ ...m, ...Object.fromEntries(legs.map((l) => [l, date])) }));
    start(async () => {
      const r = await moveCalendarPost(id, date, opts);
      if (!r.ok) {
        setError(r.clash ? `${r.error} Move it there anyway, or pick another day.` : r.error);
        if (r.clash) setClash({ id, date, opts: { ...opts, force: true } });
        setMoved(before);
        return;
      }
      // Every leg that moved is named, so one from another week never moves unseen.
      if (r.moved.length > 1) setNotice(`Moved ${r.moved.length} posts of this piece: ${r.moved.map((m) => `${m.id} ${m.from} → ${m.to}`).join("; ")}.`);
      if (r.failed.length) setError(`Not moved: ${r.failed.map((f) => `${f.id} (${f.error})`).join("; ")}`);
      router.refresh();
    });
  };
  // A drop on Previous week / Next week (calendar-toolbar.tsx) moves the post seven days.
  useEffect(() => {
    const onShift = (e: Event) => {
      const { id, days } = (e as CustomEvent<{ id: string; days: number }>).detail;
      const post = all.find((p) => p.id === id);
      if (post) move(id, addDays(moved[id] ?? post.date, days));
    };
    window.addEventListener(SHIFT_EVENT, onShift);
    return () => window.removeEventListener(SHIFT_EVENT, onShift);
  });
  const place = (posts: Post[]) => posts.map((p) => (moved[p.id] ? { ...p, date: moved[p.id] } : p));
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--border-strong)] p-3 text-sm text-red-strong">
          <span className="min-w-0 flex-1">{error}</span>
          {clash && <Button size="sm" variant="outline" onClick={() => move(clash.id, clash.date, clash.opts)}>Move anyway</Button>}
        </div>
      )}
      {notice && <p role="status" className="mb-3 rounded-md border border-line p-3 text-sm text-ink-2">{notice}</p>}
      {props.view === "month" && <Month rhythmLabels={props.rhythmLabels} posts={place(props.posts)} month={props.month} today={props.today} onOpen={open} onMove={move} />}
      {props.view === "week" && <Week rhythmLabels={props.rhythmLabels} posts={place(props.posts)} monday={props.monday} today={props.today} onOpen={open} onMove={move} />}
      {props.view === "list" && <List groups={props.groups} onOpen={open} />}
      <Sheet open={selected !== null} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        {selected && <PostSheet key={selected.id} post={selected}
          onStatus={(status) => setSelected({ ...selected, status })}
          onMove={(date, opts) => { move(selected.id, date, opts); setSelected(null); }}
          onClose={() => setSelected(null)} />}
      </Sheet>
    </>
  );
}

/** A day that takes a dropped post. */
function DayDrop({ day, className, onMove, children }: { day: string; className?: string; onMove: (id: string, date: string, opts?: MoveOpts) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <section
      onDragOver={(e) => { if (e.dataTransfer.types.includes("text/x-post")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData("text/x-post"); if (id) onMove(id, day); }}
      className={cn(className, over && "ring-2 ring-violet")}
    >
      {children}
    </section>
  );
}

const dragProps = (post: Post) => movable(post)
  ? { draggable: true, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/x-post", post.id); e.dataTransfer.effectAllowed = "move"; } }
  : {};

function Month({ rhythmLabels, posts, month, today, onOpen, onMove }: { rhythmLabels: Record<string, { primary: string; fallback: string[] }>; posts: Post[]; month: string; today: string; onOpen: (p: Post) => void; onMove: (id: string, date: string) => void }) {
  const start = mondayOf(`${month}-01`);
  const weeks = Math.round((Date.parse(`${mondayOf(monthLastDay(month))}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 604_800_000) + 1;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[64rem]">
        <div className="mb-1 grid grid-cols-7 gap-1 text-xs font-medium text-ink-3">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1">{d}<RhythmLabel day={d} labels={rhythmLabels} /></div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i)).map((day) => {
            const inMonth = day.startsWith(month);
            const dayPosts = posts.filter((p) => p.date === day).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
            return (
              <DayDrop key={day} day={day} onMove={onMove}
                className={cn("min-h-28 rounded-md border p-1.5", inMonth ? "border-line bg-[color:var(--surface-frost)]" : "border-transparent bg-transparent opacity-60", day === today && "border-violet")}>
                <h2 className={cn("mb-1 text-xs tabular-nums", day === today ? "font-semibold text-violet-strong" : "text-ink-3")}>{Number(day.slice(8))}</h2>
                <div className="space-y-1">
                  {dayPosts.map((post) => (
                    <button key={post.id} type="button" onClick={() => onOpen(post)} title={`${post.title} · ${post.status}`} {...dragProps(post)}
                      className={cn("flex w-full items-center gap-1 rounded border border-line bg-[color:var(--surface-card)] px-1.5 py-1 text-left text-[11px] leading-tight hover:border-[color:var(--border-strong)]", movable(post) ? "cursor-grab active:cursor-grabbing" : "opacity-70")}>
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[post.status] ?? "bg-line")} />
                      {post.channels.map((c) => <ChannelMark key={c} channel={c} className="size-3 shrink-0" />)}
                      <span className="min-w-0 flex-1 truncate text-ink">{post.title}</span>
                    </button>
                  ))}
                </div>
              </DayDrop>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Week({ rhythmLabels, posts, monday, today, onOpen, onMove }: { rhythmLabels: Record<string, { primary: string; fallback: string[] }>; posts: Post[]; monday: string; today: string; onOpen: (p: Post) => void; onMove: (id: string, date: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[70rem] grid-cols-7 gap-2">
        {days.map((day) => {
          const dayPosts = posts.filter((p) => p.date === day).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
          return (
            <DayDrop key={day} day={day} onMove={onMove} className={cn("min-h-64 min-w-36 rounded-lg border bg-[color:var(--surface-frost)] p-2", day === today ? "border-violet" : "border-line")}>
              <div className="mb-2 flex flex-col gap-1"><h2 className="text-xs font-medium text-ink-2">{dayLabel(day, false)}</h2><RhythmLabel day={day} labels={rhythmLabels} /></div>
              <div className="space-y-2">
                {dayPosts.map((post) => (
                  <button key={post.id} type="button" onClick={() => onOpen(post)} {...dragProps(post)}
                    className={cn("w-full rounded-md border border-line bg-[color:var(--surface-card)] p-2 text-left hover:border-[color:var(--border-strong)]", movable(post) && "cursor-grab active:cursor-grabbing")}>
                    <PostChip post={post} />
                  </button>
                ))}
              </div>
            </DayDrop>
          );
        })}
      </div>
    </div>
  );
}

function List({ groups, onOpen }: { groups: ListGroups; onOpen: (p: Post) => void }) {
  const rows = (posts: Post[], overdue = false) => (
    <div className="divide-y divide-[color:var(--border-default)] overflow-hidden rounded-lg border border-line bg-[color:var(--surface-card)]">
      {posts.map((post) => (
        <button key={post.id} type="button" onClick={() => onOpen(post)} className="block w-full p-3 text-left hover:bg-[color:var(--surface-card-hover)]">
          <PostRow post={post} overdue={overdue} />
        </button>
      ))}
    </div>
  );
  const empty = !groups.overdue.length && !groups.weeks.length && !groups.done.length;
  return (
    <div className="space-y-8">
      {empty && <p className="rounded-lg border border-line p-8 text-center text-ink-2">No posts match.</p>}
      {groups.overdue.length > 0 && <Group title="Overdue" note={`${groups.overdue.length} not out yet`}>{rows(groups.overdue, true)}</Group>}
      {groups.weeks.map((w) => (
        <Group key={w.monday} title={`Week of ${dayLabel(w.monday, true)}`} note={`${w.posts.length} ${w.posts.length === 1 ? "post" : "posts"}`}>{rows(w.posts)}</Group>
      ))}
      {groups.done.length > 0 && <Group title="Went out" note="newest first">{rows(groups.done)}</Group>}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-base font-semibold tracking-tight text-ink">{title}</h2>
        {note && <span className="text-xs text-ink-3">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function PostSheet({ post, onStatus, onMove, onClose }: {
  post: Post; onStatus: (status: string) => void; onMove: (date: string, opts: MoveOpts) => void; onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [date, setDate] = useState(post.date);
  const [time, setTime] = useState(post.time ?? "");
  const [allLegs, setAllLegs] = useState(true);
  const [confirmKill, setConfirmKill] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const failed = post.status === "failed";
  const changed = date !== post.date || (time !== "" && time !== post.time);
  // The piece's legs come from the database, not the screen: a leg in another week or hidden by a filter still counts.
  const [legs, setLegs] = useState<Array<{ id: string; date: string; time: string | null; channels: string[] }> | null>(post.storyId ? null : []);
  useEffect(() => {
    if (!post.storyId || !movable(post)) return;
    let live = true;
    calendarPieceLegs(post.id).then((r) => { if (live) setLegs(r.ok ? r.legs : []); });
    return () => { live = false; };
  }, [post]);

  useEffect(() => {
    if (!failed) return;
    let live = true;
    calendarFailure(post.id).then((r) => { if (live) setFailure(r.ok ? r.reason ?? "Zernio gave no reason." : r.error); });
    return () => { live = false; };
  }, [failed, post.id]);

  function retry() {
    setMessage(null);
    start(async () => {
      const r = await retryCalendarPost(post.id);
      if (!r.ok) { setMessage(r.error); return; }
      onStatus("scheduled");
      setFailure(null);
      setMessage(r.summary);
      router.refresh();
    });
  }

  function kill() {
    if (!post.storyId) return;
    setMessage(null);
    start(async () => {
      const r = await killCalendarPiece(post.storyId!);
      if (!r.ok) { setMessage(r.error); setConfirmKill(false); return; }
      onClose();
      router.refresh();
    });
  }
  const blocked = post.linkProblems.length > 0;
  const ready = post.status === "approved" && !post.handsOn && !blocked;
  const sent = post.status === "scheduled" || post.status === "published";
  const review = reviewHref(post);

  function send(mode: "now" | "schedule") {
    setMessage(null);
    start(async () => {
      const result = await publishCalendarPost(post.id, mode);
      if (!result.ok) { setMessage(result.error); return; }
      onStatus(result.status);
      setMessage(result.summary);
      router.refresh();
    });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{post.title}</SheetTitle>
        <p className="flex items-center gap-2 text-sm text-ink-2">
          {post.channels.map((c) => <ChannelMark key={c} channel={c} />)}
          {post.date} · {post.time ?? "Anytime"} · {post.channels.map(channelLabel).join(", ")}
        </p>
      </SheetHeader>
      <div className="space-y-4">
        {post.thumb && (
                    <WatchedImage src={post.thumb} alt="" className="max-h-72 w-full rounded-md object-contain bg-[color:var(--surface-inset)]" />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={post.status} />
          {post.pillar && <span className="text-xs text-ink-3">{post.pillar} · {post.format}</span>}
        </div>
        {post.caption
          ? <p className="max-h-64 overflow-y-auto whitespace-pre-line rounded-md border border-line p-3 text-sm text-ink-2">{post.caption}</p>
          : <p className="text-sm italic text-ink-3">No caption attached yet.</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {review && <Link href={review} className="text-violet-strong underline-offset-2 hover:underline">Review text and asset</Link>}
          {Object.entries(post.urls).map(([p, u]) => (
            <a key={p} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-strong underline-offset-2 hover:underline">
              Live on {channelLabel(p)} <ExternalLink aria-hidden className="size-3" />
            </a>
          ))}
        </div>
        {blocked && (
          <div role="alert" className="rounded-md border border-[color:var(--border-strong)] p-3 text-sm text-red-strong">
            <div className="font-medium">Channel rule: this post cannot be sent</div>
            <ul className="mt-1 list-disc space-y-1 pl-4">{post.linkProblems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        {failed && (
          <div role="alert" className="space-y-2 rounded-md border border-[color:var(--border-strong)] p-3 text-sm">
            <div className="font-medium text-red-strong">This post failed on Zernio</div>
            <p className="text-ink-2">{failure ?? "Asking Zernio why..."}</p>
            <Button size="sm" disabled={pending} onClick={retry}>Retry with the current text</Button>
            <p className="text-xs text-ink-3">Fix the text in review first if the reason is the text. Retry sends at this post&apos;s slot; move it first if that slot has passed.</p>
          </div>
        )}
        {movable(post) && (
          <form className="space-y-2 rounded-md border border-line p-3" onSubmit={(e) => { e.preventDefault(); if (changed) onMove(date, { ...(time && time !== post.time ? { time } : {}), all: allLegs && (legs?.length ?? 0) > 1 }); }}>
            <div className="text-xs font-medium text-ink-2">When</div>
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" required
                className="h-9 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm text-ink" />
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time (Berlin)" step={300}
                className="h-9 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm text-ink" />
              <Button type="submit" size="sm" variant="outline" disabled={!changed || pending || legs === null}>Move</Button>
            </div>
            {post.storyId && (
              <div className="space-y-1 text-xs text-ink-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={allLegs && (legs?.length ?? 0) > 1} disabled={(legs?.length ?? 0) <= 1} onChange={(e) => setAllLegs(e.target.checked)} />
                  {legs === null ? "Loading this piece's platforms..." : `Move all ${legs.length} ${legs.length === 1 ? "platform" : "platforms"} of this piece to that day (each keeps its own time)`}
                </label>
                {legs && legs.length > 1 && (
                  <ul className="pl-6 text-ink-3">
                    {legs.map((l) => <li key={l.id}>{l.channels.map(channelLabel).join(", ")} · {l.date} {l.time ?? ""}</li>)}
                  </ul>
                )}
              </div>
            )}
          </form>
        )}
        {post.handsOn && <p className="text-sm text-ink-2">Newsletter and website posts go out by hand. Zernio is not used for this one.</p>}
        {!post.handsOn && !sent && (
          <div className="space-y-2">
            <Button className="w-full" disabled={!ready || pending} onClick={() => send("now")}>Publish now</Button>
            <Button className="w-full" variant="outline" disabled={!ready || pending} onClick={() => send("schedule")}>
              Schedule publishing{post.time ? ` · ${post.time} Berlin` : ""}
            </Button>
          </div>
        )}
        {post.storyId && movable(post) && (
          confirmKill ? (
            <div className="space-y-2 rounded-md border border-[color:var(--border-strong)] p-3 text-sm">
              <p className="text-ink">Kill this piece on every platform? It leaves the calendar and /content, and any post Zernio has not sent yet is deleted.</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={pending} onClick={kill}>Kill it</Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmKill(false)}>Keep it</Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="w-full text-red-strong" disabled={pending} onClick={() => setConfirmKill(true)}>Kill piece</Button>
          )
        )}
        <p className="text-xs text-ink-3">
          {message ?? (post.handsOn ? "Copy it from the story when you are ready." : sent ? "Zernio already has this post." : blocked ? "Fix the link rule above, then approve again." : ready ? "Publish now sends it immediately. Schedule uses this day's time." : "Both stay off until the caption is approved.")}
        </p>
      </div>
    </>
  );
}

export function dayLabel(iso: string, withMonth: boolean) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", ...(withMonth ? { month: "short" as const } : {}), timeZone: "UTC",
  });
}
