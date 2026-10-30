"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock, MessageSquare, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PLATFORM } from "@/components/brand-icons";
import { SignedVideo } from "@/components/media/signed-video";
import { WatchedImage } from "@/components/media/watched-media";
import type { SharedAsset, SharedPiece } from "@/lib/reviewer/shared";

type Result = { ok: true } | { ok: false; error: string };
export type DecideAsset = (input: { assetId: string; decision: "approved" | "changes" | "note"; note: string; sha256: string; revision: number }) => Promise<Result>;

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The platform logos an asset is for, easy to scan: the logo and its name. */
function Platforms({ channels }: { channels: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {channels.map((c) => {
        const p = PLATFORM[c as keyof typeof PLATFORM];
        return p
          ? <span key={c} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><p.Icon className="size-5" />{p.label}</span>
          : <span key={c} className="text-sm font-medium text-ink">{c}</span>;
      })}
    </span>
  );
}

function DecisionBadge({ asset }: { asset: SharedAsset }) {
  if (asset.decision === "approved") return <Badge variant="success" className="gap-1"><Check className="size-3" aria-hidden /> You approved this</Badge>;
  if (asset.decision === "changes") return <Badge variant="destructive" className="gap-1"><Undo2 className="size-3" aria-hidden /> You asked for changes</Badge>;
  return <Badge variant="warning" className="gap-1"><Clock className="size-3" aria-hidden /> {asset.newVersion ? "New version, waiting for you" : "Waiting for you"}</Badge>;
}

/** Approve, request changes or note, on one asset. It decides only this asset, bound to the bytes on screen. */
function Decision({ asset, decide, preview }: { asset: SharedAsset; decide: DecideAsset; preview: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "note" | "changes">("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (decision: "approved" | "changes" | "note", note: string) => {
    setError(null);
    start(async () => {
      const r = await decide({ assetId: asset.id, decision, note, sha256: asset.sha256, revision: asset.revision });
      if (!r.ok) { setError(r.error); return; }
      setMode("idle"); setText("");
      router.refresh();
    });
  };
  return (
    <div className="space-y-3" data-asset={asset.id}>
      {asset.notes.length > 0 && (
        <ul className="space-y-2">
          {asset.notes.map((n) => (
            <li key={n.id} className="rounded-md border border-line p-2.5 text-sm">
              <p className="mb-0.5 text-xs font-medium text-ink-3">{n.kind === "changes" ? "Changes requested" : "Note"}</p>
              <p className="whitespace-pre-wrap text-ink">{n.body}</p>
              <p className="mt-1 text-xs text-ink-3">{when(n.createdAt)}{n.label ? ` · on ${n.label}` : ""}</p>
            </li>
          ))}
        </ul>
      )}
      {preview ? (
        <p className="text-xs text-ink-3">Preview: this is what they see. Their buttons are not shown to you.</p>
      ) : mode === "idle" ? (
        <div className="flex flex-wrap gap-2">
          {asset.decision !== "approved" && (
            <Button disabled={busy} onClick={() => run("approved", "")}><Check /> {busy ? "Saving…" : "Approve"}</Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => setMode("changes")}><Undo2 /> Request changes</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setMode("note")}><MessageSquare /> Add a note</Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(mode === "changes" ? "changes" : "note", text); }}>
          <label className="block text-xs font-medium text-ink-2" htmlFor={`${asset.id}-text`}>
            {mode === "changes" ? "What would you like changed? Timestamps help (for example 12:30)." : "Your note"}
          </label>
          <textarea id={`${asset.id}-text`} value={text} maxLength={5000} rows={4} autoFocus onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-[color:var(--border-default)] bg-transparent p-2.5 text-sm text-ink outline-none focus:border-[color:var(--border-strong)]" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !text.trim()}>{busy ? "Sending…" : mode === "changes" ? "Send change request" : "Send note"}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setMode("idle"); setText(""); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-strong">{error}</p>}
    </div>
  );
}

/** A long description shows its first lines, with the rest one click away. */
function Expandable({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div>
      <p className={`whitespace-pre-wrap text-sm text-ink ${long && !open ? "line-clamp-6" : ""}`}>{text}</p>
      {long && <button type="button" className="mt-1 text-xs text-ink-3 underline underline-offset-4 hover:text-ink" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show the full text"}</button>}
    </div>
  );
}

/** One piece for a third party: the final full width, then what it will be posted with, each asset decided on its own. */
export function SharedPieceCard({ piece, decide, preview = false }: { piece: SharedPiece; decide: DecideAsset; preview?: boolean }) {
  if (piece.state !== "final") {
    return (
      <Card glow={false} className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-ink">{piece.name}</h2>
          <Badge variant="outline">In production</Badge>
        </div>
        <p className="mt-2 text-sm text-ink-2">The final version will appear here when it is ready for you.</p>
      </Card>
    );
  }
  const short = piece.format === "short";
  const videos = piece.assets.filter((a) => a.kind === "video");
  const rest = piece.assets.filter((a) => a.kind !== "video");
  const overall = piece.decision === "approved"
    ? <Badge variant="success" className="gap-1"><Check className="size-3" aria-hidden /> Approved</Badge>
    : piece.decision === "changes" ? <Badge variant="destructive" className="gap-1"><Undo2 className="size-3" aria-hidden /> Changes requested</Badge>
    : <Badge variant="warning" className="gap-1"><Clock className="size-3" aria-hidden /> Waiting for you</Badge>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={`font-display font-semibold text-ink ${short ? "text-lg" : "text-xl"}`}>{piece.name}</h2>
        {overall}
      </div>

      {videos.map((v) => (
        <Card key={v.id} glow={false} className="overflow-hidden p-0">
          <div className={short ? "bg-black" : ""}>
            <SignedVideo key={`${v.id}-${v.revision}`} src={v.src ?? undefined} poster={v.poster ?? undefined} controls playsInline preload={v.poster ? "none" : "metadata"}
              className={short ? "mx-auto block aspect-[9/16] max-h-[34rem] w-auto max-w-full bg-black object-contain" : "block aspect-video w-full bg-black object-contain"} />
          </div>
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-ink-3">{v.label ? `Final ${v.label}` : "Final"}{short ? "" : ""}</p>
                {!short && <Platforms channels={v.channels} />}
              </div>
              <DecisionBadge asset={v} />
            </div>
            <Decision asset={v} decide={decide} preview={preview} />
          </div>
        </Card>
      ))}

      {rest.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-display text-base font-semibold text-ink">What it will be posted with</h3>
          <p className="text-sm text-ink-2">For your information. You only approve the video above.</p>
          {rest.map((a) => (
            <Card key={a.id} glow={false} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Platforms channels={a.channels} />
                {a.reviewable && <DecisionBadge asset={a} />}
              </div>
              <div className={`mt-4 grid gap-4 ${a.listing?.thumbnail ? "md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" : ""}`}>
                {a.kind === "image" && <WatchedImage key={`${a.id}-${a.revision}`} src={a.src ?? undefined} alt={a.title} className="block w-full rounded-lg bg-black object-contain md:col-span-2 md:max-w-xl" />}
                {a.kind === "copy" && a.listing && (
                  <>
                    {a.listing.thumbnail && <WatchedImage key={`${a.id}-thumb`} src={a.listing.thumbnail} alt="Thumbnail" className="block w-full rounded-lg bg-black object-contain" />}
                    <div className="min-w-0 space-y-2">
                      {a.listing.title && <p className="font-display text-lg font-semibold leading-snug text-ink">{a.listing.title}</p>}
                      <Expandable text={a.listing.text} />
                    </div>
                  </>
                )}
              </div>
              {a.reviewable && <div className="mt-4 border-t border-line pt-4"><Decision asset={a} decide={decide} preview={preview} /></div>}
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
