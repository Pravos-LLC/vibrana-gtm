"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, CircleSlash, Copy, EyeOff, Globe, HelpCircle, Link2, MessageCircle, Scale, Send, ShieldAlert, ShieldCheck, Users, XCircle, Zap } from "lucide-react";
import { approveReply, hideReply, markReplyCopied, notSpam, skipReply } from "@/app/engage/actions";
import { PLATFORM } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export type EngageCard = {
  id: string; platform: string; kind: "comment" | "dm"; author: string; handle: string | null; when: string;
  text: string; isReply: boolean; postPreview: string | null; postUrl: string | null; commentUrl: string | null;
  draft: string; classification: "reply" | "needs_john" | "spam" | "skip" | null; reason: string | null; note: string | null;
  status: string; mode: "zernio" | "manual"; canHide: boolean; error: string | null; finalText: string | null; edited: boolean;
  stance?: string | null; objection?: string | null;
  /** Who they are (VIB-428): photo, follower count, headline, company, website and profile link when known. */
  picture?: string | null; followers?: number | null; headline?: string | null; company?: string | null;
  website?: string | null; profileUrl?: string | null; reclassified?: boolean;
  /** What they linked to, read and summarized by the drafting run. */
  linked?: { url: string; title: string | null; summary: string }[] | null;
  /** DM photos, videos and shares: shown from a live link (app/api/engage/attachment), never stored. */
  attachments?: { type: string; original_type: string | null; mime: string | null; name: string | null }[] | null;
};

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}]+/gi;
/** Comment text split into plain runs and clickable http(s) links (trailing punctuation stays text). */
export function linkParts(text: string): ({ text: string } | { text: string; href: string })[] {
  const out: ({ text: string } | { text: string; href: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?…]+$/, "");
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(href)) continue;
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: raw, href });
    at = m.index! + raw.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

function Linkified({ text }: { text: string }) {
  return <>{linkParts(text).map((p, i) => "href" in p
    ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-violet-strong underline-offset-2 hover:underline">{p.text}</a>
    : <span key={i}>{p.text}</span>)}</>;
}


/** 10366 → "10.4k". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const LABEL: Record<string, string> = { image: "Photo", video: "Video", audio: "Voice message", file: "File", sticker: "Sticker", share: "Shared post", template: "Message", unsupported_type: "Shared post" };

/** A DM's attachments. Photos and stickers show inline, voice messages play; videos, shares and files open the live media in a new tab (WatchedVideo is for stored content and files BLOCK notes on it, so a DM video is a link). */
function Attachments({ id, items }: { id: string; items: NonNullable<EngageCard["attachments"]> }) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="engage-attachments">
      {items.map((a, i) => {
        const src = `/api/engage/attachment/${id}/${i}`;
        const label = a.original_type === "story_mention" ? "Story mention" : LABEL[a.type] ?? "Attachment";
        if (a.type === "image" || a.type === "sticker") {
          return (
            <a key={i} href={src} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed platform CDN link; next/image cannot optimize that. */}
              <img src={src} alt={label} loading="lazy" referrerPolicy="no-referrer" className="max-h-80 max-w-full rounded-md border border-line object-contain" />
            </a>
          );
        }
        if (a.type === "audio") return <audio key={i} src={src} controls preload="none" aria-label={label} />;
        return <a key={i} href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-2 text-sm text-violet-strong hover:underline"><Link2 className="size-3.5" aria-hidden />{a.name ?? label}</a>;
      })}
    </div>
  );
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** The commenter's photo, or their initials when there is none or it fails to load (LinkedIn photo links expire). */
function Avatar({ name, src }: { name: string; src?: string | null }) {
  const [broken, setBroken] = useState(false);
  const initials = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  if (src && !broken) {
    // eslint-disable-next-line @next/next/no-img-element -- remote platform photos, any host; next/image would need every CDN allow-listed.
    return <img src={src} alt="" width={40} height={40} referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-10 shrink-0 rounded-full border border-line object-cover" />;
  }
  return <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-sm font-semibold text-ink-2">{initials}</span>;
}

// Pushback stances (VIB-424), each an icon plus a word. Supportive and question need no badge.
const STANCE: Record<string, { label: string; Icon: typeof Check; variant: "warning" | "destructive" | "outline" }> = {
  constructive_dissent: { label: "Disagrees", Icon: Scale, variant: "outline" },
  misread: { label: "Misread the post", Icon: HelpCircle, variant: "warning" },
  hostile: { label: "Hostile", Icon: Zap, variant: "destructive" },
  troll_or_bad_faith: { label: "Bad faith", Icon: ShieldAlert, variant: "destructive" },
};

const SLOT = /\[(?:JOHN|TODO|NOTE)\b[^\]]*\]/i;
const DONE: Record<string, { label: string; Icon: typeof Check }> = {
  sent: { label: "Sent", Icon: Check }, skipped: { label: "Skipped", Icon: CircleSlash }, hidden: { label: "Hidden", Icon: EyeOff },
};

function Glyph({ platform }: { platform: string }) {
  const p = PLATFORM[platform as keyof typeof PLATFORM];
  if (p) return <p.Icon className="size-5 shrink-0" title={p.label} />;
  return <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-surface-overlay text-[0.6rem] font-semibold uppercase text-ink-2" aria-label={platform}>{platform.slice(0, 2)}</span>;
}

/** One comment or DM: what they said, on what, the editable draft, and the one-tap decisions. */
export function CommentCard({ card }: { card: EngageCard }) {
  const [text, setText] = useState(card.finalText ?? card.draft);
  const [state, setState] = useState<{ status: string; message?: string; error?: string }>({ status: card.status, error: card.error ?? undefined });
  const [pending, start] = useTransition();
  const [cls, setCls] = useState(card.classification);
  const [reason, setReason] = useState(card.reason);
  const [draft, setDraft] = useState(card.draft);
  const open = ["new", "drafted", "failed", "approved"].includes(state.status);
  const slot = SLOT.test(text);
  const run = (fn: () => Promise<{ ok: true; status: string; message: string } | { ok: false; error: string }>) => start(async () => {
    const r = await fn();
    setState(r.ok ? { status: r.status, message: r.message } : { ...state, error: r.error });
  });
  const copyAndOpen = () => {
    // Both must start inside the tap itself, or mobile browsers block the clipboard and the new tab.
    const copied = navigator.clipboard?.writeText(text).catch(() => undefined);
    const url = card.commentUrl ?? card.postUrl;
    if (url) window.open(url, "_blank", "noopener");
    run(async () => { await copied; return markReplyCopied(card.id, text); });
  };

  const markNotSpam = () => start(async () => {
    const r = await notSpam(card.id);
    if (!r.ok) { setState({ ...state, error: r.error }); return; }
    setCls(r.classification);
    setText(r.draft);
    setDraft(r.draft);
    setReason(r.reason);
    setState({ status: r.status, message: r.message });
  });

  if (!open) {
    const d = DONE[state.status] ?? { label: state.status, Icon: Check };
    return (
      <Card glow={false} className="flex items-center gap-3 px-4 py-3 text-sm">
        <Glyph platform={card.platform} />
        <span className="min-w-0 flex-1 truncate text-ink-2"><span className="text-ink">{card.author}</span>: {card.text || "(no text)"}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-ink-2" role="status"><d.Icon className="size-4" aria-hidden />{d.label}{card.edited || (state.status === "sent" && text.trim() !== draft.trim()) ? ", edited" : ""}</span>
      </Card>
    );
  }

  return (
    <Card glow={false} className="space-y-3 p-4 sm:p-5" data-testid="engage-card">
      <div className="flex items-start gap-3">
        <Avatar name={card.author} src={card.picture} />
        <div className="min-w-0 flex-1 space-y-0.5" data-testid="engage-who">
          <div className="flex flex-wrap items-center gap-x-2 text-sm">
            <Glyph platform={card.platform} />
            {card.profileUrl
              ? <a href={card.profileUrl} target="_blank" rel="noreferrer" className="font-medium text-ink hover:underline">{card.author}</a>
              : <span className="font-medium text-ink">{card.author}</span>}
            {card.handle && card.handle !== card.author && card.platform !== "linkedin" && <span className="text-ink-3">@{card.handle}</span>}
            <span className="text-ink-3">· {card.when}</span>
          </div>
          {card.headline && <p className="line-clamp-2 text-xs text-ink-2">{card.headline}</p>}
          {(card.followers != null || card.website || (card.company && !card.headline?.includes(card.company))) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
              {card.followers != null && <span className="inline-flex items-center gap-1" title={`${card.followers.toLocaleString("en-US")} followers`}><Users className="size-3" aria-hidden />{compactCount(card.followers)} followers</span>}
              {card.company && !card.headline?.includes(card.company) && <span>{card.company}</span>}
              {card.website && <a href={card.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-strong hover:underline"><Globe className="size-3" aria-hidden />{host(card.website)}</a>}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm empty:hidden">
        {card.kind === "dm" && <Badge variant="info"><MessageCircle className="mr-1 size-3" aria-hidden />DM</Badge>}
        {card.isReply && <Badge variant="outline">Reply in a thread</Badge>}
        {cls === "needs_john" && <Badge variant="warning"><AlertTriangle className="mr-1 size-3" aria-hidden />Needs you</Badge>}
        {cls === "spam" && <Badge variant="destructive"><ShieldAlert className="mr-1 size-3" aria-hidden />Looks like spam</Badge>}
        {(card.reclassified || (card.classification === "spam" && cls !== "spam")) && <Badge variant="outline"><ShieldCheck className="mr-1 size-3" aria-hidden />Not spam (you)</Badge>}
        {state.status === "failed" && <Badge variant="destructive"><XCircle className="mr-1 size-3" aria-hidden />Not sent</Badge>}
        {card.stance && STANCE[card.stance] && (() => { const s = STANCE[card.stance!]; return <Badge variant={s.variant}><s.Icon className="mr-1 size-3" aria-hidden />{s.label}</Badge>; })()}
      </div>
      {card.objection && <p className="text-xs text-ink-2"><span className="font-medium text-ink">Objecting to:</span> {card.objection}</p>}

      {(card.text && !(card.attachments?.length && card.text === "(attachment)")) || !card.attachments?.length
        ? <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-ink">{card.text ? <Linkified text={card.text} /> : <span className="text-ink-3">{card.note ?? "(no text)"}</span>}</p>
        : null}
      {!!card.attachments?.length && <Attachments id={card.id} items={card.attachments} />}

      {!!card.linked?.length && (
        <div className="space-y-1.5 rounded-md border border-line bg-[color:var(--surface-inset)] px-3 py-2 text-sm" data-testid="engage-linked">
          {card.linked.map((l) => (
            <div key={l.url}>
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium text-violet-strong hover:underline">
                <Link2 className="size-3.5 shrink-0" aria-hidden />{l.title || host(l.url)}
              </a>
              {l.summary && <p className="text-ink-2"><span className="text-ink-3">They linked to this. </span>{l.summary}</p>}
            </div>
          ))}
        </div>
      )}

      {(card.postPreview || card.postUrl) && (
        <div className="rounded-md border border-line px-3 py-2 text-xs text-ink-2">
          {card.postPreview && <p className="line-clamp-2">On: {card.postPreview}</p>}
          {card.postUrl && <a href={card.commentUrl ?? card.postUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-violet-strong hover:underline">Open {card.kind === "dm" ? "conversation" : card.commentUrl ? "comment" : "post"}</a>}
        </div>
      )}

      {cls !== "spam" && (
        <div className="space-y-1">
          <label htmlFor={`reply-${card.id}`} className="text-xs font-medium text-ink-2">Reply as John</label>
          <textarea id={`reply-${card.id}`} value={text} rows={3} onChange={(e) => setText(e.target.value)}
            placeholder={card.mode === "manual" ? "Write the reply, then copy it and open the comment" : "Write a reply"}
            className="w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-3 text-base leading-relaxed text-ink" />
          {slot && <p className="flex items-center gap-1 text-xs text-amber-strong"><AlertTriangle className="size-3.5" aria-hidden />Fill in the [JOHN: ...] part before it can go out.</p>}
          {reason && <p className="text-xs text-ink-3">Why: {reason}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {cls !== "spam" && (card.mode === "zernio"
          ? <Button className="col-span-2 h-11 sm:h-10" disabled={pending || slot || !text.trim()} onClick={() => run(() => approveReply(card.id, text))}><Send aria-hidden />{state.status === "failed" ? "Try again" : "Approve and send"}</Button>
          : <Button className="col-span-2 h-11 sm:h-10" disabled={pending || slot || !text.trim()} onClick={copyAndOpen}><Copy aria-hidden />Copy reply and open</Button>)}
        {cls === "spam" && <Button variant="secondary" className="h-11 sm:h-10" disabled={pending} onClick={markNotSpam}><ShieldCheck aria-hidden />Not spam</Button>}
        {card.canHide && <Button variant={cls === "spam" ? "default" : "secondary"} className="h-11 sm:h-10" disabled={pending} onClick={() => run(() => hideReply(card.id))}><EyeOff aria-hidden />Hide</Button>}
        <Button variant="secondary" className="h-11 sm:h-10" disabled={pending} onClick={() => run(() => skipReply(card.id))}><CircleSlash aria-hidden />Skip</Button>
      </div>
      {state.error && <p className="flex items-start gap-1 text-sm text-red-strong" role="alert"><XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />{state.error}</p>}
      {state.message && !state.error && open && <p className="text-xs text-ink-2" role="status">{state.message}</p>}
      {pending && <p className="text-xs text-ink-3" role="status">Working…</p>}
    </Card>
  );
}
