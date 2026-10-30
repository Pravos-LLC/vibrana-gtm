// The one way a calendar post is drawn: thumbnail, platform mark, time, title, caption and status. Used by the
// Calendar week grid, the Calendar list and Today. No hooks and no server imports, so client and server
// components can both render it.
import { FileText, Film, Globe, ImageIcon, Mail, Type } from "lucide-react";
import { PLATFORM } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import type { Post } from "@/lib/posts";
import { cn } from "@/lib/ui/cn";
import { WatchedImage } from "@/components/media/watched-media";

export const STATUS_TONE: Record<string, "default" | "success" | "warning" | "destructive" | "info" | "outline"> = {
  idea: "outline", drafted: "warning", approved: "default", scheduled: "info", published: "success", failed: "destructive", skipped: "outline",
};

const OTHER = { newsletter: { label: "Newsletter", Icon: Mail }, website: { label: "Website", Icon: Globe } } as const;

export function ChannelMark({ channel, className = "size-4" }: { channel: string; className?: string }) {
  const brand = PLATFORM[channel as keyof typeof PLATFORM];
  if (brand) return <brand.Icon className={className} title={brand.label} />;
  const other = OTHER[channel as keyof typeof OTHER];
  if (other) return <other.Icon className={cn(className, "text-ink-2")} aria-label={other.label} />;
  return <span className="text-xs text-ink-3">{channel}</span>;
}

export const channelLabel = (c: string) => PLATFORM[c as keyof typeof PLATFORM]?.label ?? OTHER[c as keyof typeof OTHER]?.label ?? c;

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge variant={STATUS_TONE[status] ?? "outline"} className={className}>{status}</Badge>;
}

function KindIcon({ kind }: { kind: Post["mediaKind"] }) {
  const Icon = kind === "video" ? Film : kind === "image" ? ImageIcon : kind === "document" ? FileText : Type;
  return <Icon aria-hidden className="size-4" />;
}

/**
 * The asset thumbnail with the platform mark in the corner. With no image, a large tile (`text`) shows the
 * opening of the caption, as a text post reads in the feed; a small one shows a quiet media-type icon.
 */
export function PostThumb({ post, className, text = false }: { post: Post; className?: string; text?: boolean }) {
  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-md bg-[color:var(--surface-inset)]", className)}>
      {post.thumb
                ? <WatchedImage src={post.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        : text && post.caption
          ? <p className="absolute inset-0 overflow-hidden whitespace-pre-line p-3 pt-6 text-xs leading-snug text-ink-2 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">{post.caption}</p>
          : <div className="absolute inset-0 grid place-items-center text-ink-3"><KindIcon kind={post.mediaKind} /></div>}
      {post.thumb && post.mediaKind === "video" && (
        <span className="absolute bottom-1 left-1 rounded bg-black/60 p-0.5 text-white"><Film aria-hidden className="size-3" /></span>
      )}
      <span className="absolute right-1 top-1 flex gap-0.5 rounded bg-white/85 p-0.5 shadow-sm">
        {post.channels.map((c) => <ChannelMark key={c} channel={c} className="size-3.5" />)}
      </span>
    </div>
  );
}

/** Week-grid chip: thumbnail on top, then time, title and status. */
export function PostChip({ post }: { post: Post }) {
  return (
    <div className="space-y-2">
      <PostThumb post={post} className="aspect-[4/5] w-full" text />
      <div className="text-xs text-ink-3 tabular-nums">{post.time ?? "Anytime"} · {post.channels.map(channelLabel).join(", ")}</div>
      <div className="line-clamp-2 text-sm font-medium text-ink">{post.title}</div>
      <div className="flex flex-wrap gap-1">
        <StatusBadge status={post.status} />
        {post.linkProblems.length > 0 && <Badge variant="destructive">breaks a channel rule</Badge>}
      </div>
    </div>
  );
}

/** List row: thumbnail, title and caption preview, then status and links. */
export function PostRow({ post, overdue }: { post: Post; overdue?: boolean }) {
  return (
    <div className="flex gap-4">
      <PostThumb post={post} className="h-24 w-20" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
          <span className="tabular-nums">{post.date} {post.time ?? ""}</span>
          <span className="flex items-center gap-1">{post.channels.map((c) => <ChannelMark key={c} channel={c} className="size-3.5" />)}{post.channels.map(channelLabel).join(", ")}</span>
          {post.pillar && <span>{post.pillar}</span>}
          <span>{post.format}</span>
        </div>
        <div className="mt-1 truncate font-medium text-ink">{post.title}</div>
        <p className="mt-1 line-clamp-2 text-sm text-ink-2">{post.caption || <span className="italic text-ink-3">No caption attached yet</span>}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={post.status} />
        {overdue && <Badge variant="destructive">overdue</Badge>}
        {post.linkProblems.length > 0 && <Badge variant="destructive">breaks a channel rule</Badge>}
      </div>
    </div>
  );
}
