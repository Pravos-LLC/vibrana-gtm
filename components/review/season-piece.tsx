"use client";

import { memo, useEffect, useId, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Clapperboard, Coins, Undo2 } from "lucide-react";
import { SignedVideo } from "@/components/media/signed-video";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PLATFORM } from "@/components/brand-icons";
import { cn } from "@/lib/ui/cn";
import { hasPlaceholder, isRole, type EditableField, type ReviewChannel, type Role } from "@/lib/season";
import {
  assetVersions, buildGroups, cardSlot, decidedMedia, familyTarget, openParts, stillMatchesFilter, isPlatformCard, latestText, latestVersion, mediaFamily, nextLabel, partUi, partVersions, pieceView, resolvedNotes, reviewMode, sharedTextBaseline, sharedTextDirty, versionAt,
  type AssetVersion, type CardData, type FeedbackItem, type MediaGroup, type PieceAsset, type PieceData, type PlatformCard, type ReviewMode, type StatusFilter,
} from "@/lib/season-review";
import { SubstackExportPanel } from "./substack-export";
import { SubstackIcon } from "@/components/brand-icons";
import { pipelineView, type PipelineView } from "@/lib/pipeline-state";
import { PIPELINES, isFormat, type Stage } from "@/lib/pipelines";
import { initialPartState, partKey, partReducer, usePartStates, useReviewActions, type Expected, type Op, type PartState, type Result } from "./review-store";
import { PartPanel } from "./part-panel";
import { StatusChip, VersionSwitcher } from "./review-ui";
import { ShareForReview } from "@/components/review/share-for-review";
import { ThirdPartyHold } from "./third-party-hold";
import { StageBadge } from "./stage-badge";
import { StageBadges, WaitingBadge } from "./stage-badges";
import { PipelineStepper } from "./pipeline-stepper";
import { History, TextDiff, VersionCompare, WhatChangedPanel, useCompare } from "./what-changed";
import { NoteItem, ResolvedNotes } from "./review-ui";
import { whatChanged, type JohnDecision } from "@/lib/what-changed";
import { diffWords, hasChanges } from "@/lib/text-diff";
import { encodeFixNote } from "@/lib/approve-note";
import { WatchedImage } from "@/components/media/watched-media";
import { MentionCheck } from "./mention-check";

export type { FeedbackItem, AssetVersion, PieceAsset, CardData } from "@/lib/season-review";

const textArea = "w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-3 text-sm leading-relaxed text-ink read-only:bg-transparent read-only:text-ink-2";
const EXTRA: Record<Role, Extra | null> = {
  linkedin: { key: "first_comment", label: "First comment", multiline: true, first: false },
  instagram: null,
  youtube: { key: "youtube_title", label: "YouTube title", multiline: false, first: true },
};
const ROLES_WITH_EXTRA: Role[] = ["youtube", "linkedin"];
const TEXT_LABEL: Record<Role, string> = { linkedin: "LinkedIn post", instagram: "Instagram caption", youtube: "YouTube description" };
const names = (channels: Role[]) => channels.map((c) => PLATFORM[c].label).join(" and ");
/**
 * The hero size for a video or image (John, 2026-10-13: "the video needs to be THE MAIN FOCUS"): as tall as the
 * viewport allows under the page chrome, its width from the media's own ratio, never wider than its column.
 */
const heroWidth = (ratio: number) => `min(calc(78vh * ${ratio || 9 / 16}), 56rem)`;
/** One video, and the image beside it if there is one: that image is the video's cover, not a slide. */
function videoWithCover(media: PieceAsset[]): { video?: PieceAsset; cover?: PieceAsset } {
  const videos = media.filter((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");
  if (videos.length !== 1 || images.length > 1 || videos.length + images.length !== media.length) return {};
  return { video: videos[0], cover: images[0] };
}
const expectedOf = (assets: PieceAsset[]): Expected[] => assets.map((a) => ({ asset_id: a.id, sha256: a.sha256 ?? "", revision: a.revision }));

/** Every piece on screen, in slot order. Reads the live part states so one click re-renders one part. */
export function PieceList({ pieces, focus = false, open, status = "", platform = "" }: { pieces: PieceData[]; focus?: boolean; status?: StatusFilter | ""; platform?: ReviewChannel | ""; open?: { storyId: string; channel: ReviewChannel } | null }) {
  if (focus) return <FocusReview pieces={pieces} />;
  return (
    <div className="grid gap-10">
      {pieces.map((p) => <PieceSection key={p.storyId} piece={p} status={status} platform={platform} channel={open?.storyId === p.storyId ? open.channel : undefined} />)}
    </div>
  );
}

/**
 * One piece at a time ("Review 3 rough cuts"): J/K next and previous, A approves the stage on screen, N jumps to the
 * note box. It starts at the first piece not yet decided at its stage.
 */
function FocusReview({ pieces }: { pieces: PieceData[] }) {
  const states = usePartStates();
  const decided = (p: PieceData) => {
    const mode = reviewMode(pieceView(p), p.stageAssets);
    return mode.kind === "stage" && states[partKey("stage", p.storyId, mode.stage.key)]?.status === "approved";
  };
  const [at, setAt] = useState(() => Math.max(0, pieces.findIndex((p) => !decided(p))));
  const box = useRef<HTMLDivElement>(null);
  const i = Math.min(at, Math.max(0, pieces.length - 1));
  const move = (d: number) => setAt((x) => Math.min(pieces.length - 1, Math.max(0, x + d)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j") { e.preventDefault(); move(1); }
      else if (k === "k") { e.preventDefault(); move(-1); }
      else if (k === "a") { const b = box.current?.querySelector<HTMLButtonElement>("[data-approve=stage]:not([disabled])"); if (b) { e.preventDefault(); b.click(); } }
      else if (k === "n") { const n = box.current?.querySelector<HTMLTextAreaElement>("textarea[aria-label^='Note to the agent']"); if (n) { e.preventDefault(); n.focus(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!pieces.length) return null;
  const left = pieces.filter((p) => !decided(p)).length;
  return (
    <div className="grid gap-4">
      <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-[color:var(--surface-raised)] px-4 py-2 text-sm shadow-sm" role="navigation" aria-label="Focused review">
        <Button size="sm" variant="ghost" onClick={() => move(-1)} disabled={i === 0} aria-label="Previous piece"><ChevronLeft /></Button>
        <span className="tabular-nums text-ink" aria-live="polite">{i + 1} of {pieces.length}</span>
        <Button size="sm" variant="ghost" onClick={() => move(1)} disabled={i === pieces.length - 1} aria-label="Next piece"><ChevronRight /></Button>
        <span className="text-xs text-ink-3">{left} left to decide · J/K next and previous · A approve · N note</span>
      </div>
      <div ref={box} id="focus-piece"><PieceSection key={pieces[i].storyId} piece={pieces[i]} /></div>
    </div>
  );
}

function PieceSection({ piece: p, channel, status = "", platform = "" }: { piece: PieceData; channel?: ReviewChannel; status?: StatusFilter | ""; platform?: ReviewChannel | "" }) {
  const states = usePartStates();
  // The states as the page loaded: a part counts as changed only once a click moves it off these.
  const loaded = useRef(states);
  const { actions } = useReviewActions();
  const serverView = useMemo(() => pieceView(p), [p]);
  const mode = useMemo(() => reviewMode(serverView, p.stageAssets), [serverView, p.stageAssets]);
  const groups = useMemo(() => p.groups ?? buildGroups(p.cards), [p.groups, p.cards]);
  // The stepper follows a stage decision made on this page at once (approving a rough cut moves it on).
  const stagePart = mode.kind === "stage" ? states[partKey("stage", p.storyId, mode.stage.key)] : undefined;
  const view: PipelineView | null = useMemo(() => {
    if (!serverView || !p.pipeline || !isFormat(p.pipeline.format) || mode.kind !== "stage" || !stagePart) return serverView;
    const live = stagePart.status === "approved" ? "approved" : stagePart.status === "rejected" ? "changes" : "review";
    const rows = [...p.pipeline.rows.filter((r) => r.stage !== mode.stage.key), { stage: mode.stage.key, status: live } as const];
    return pipelineView(PIPELINES[p.pipeline.format], rows, { stagedStages: p.pipeline.staged, final: p.pipeline.final });
  }, [serverView, p.pipeline, mode, stagePart]);
  // The platforms post on approval; each newsletter essay is a card of its own, pasted into Substack by hand.
  const platforms = useMemo(() => p.cards.filter(isPlatformCard), [p.cards]);
  const letters = p.cards.filter((c) => !isPlatformCard(c));
  const shared = mode.kind === "final" ? groups.filter((g) => g.channels.length > 1) : [];
  // The page leaves out media John sent back (lib/content-visibility.ts) and keeps its text; say where it went.
  const mediaSentBack = mode.kind === "final" && platforms.some((c) => c.assetStatus === "rejected" && !c.media.length);
  const allApproved = mode.kind === "final" && p.cards.length > 0
    && p.cards.every((c) => states[partKey("text", p.storyId, cardSlot(c))]?.status === "approved")
    && letters.every((c) => !decidedMedia(c).length || states[partKey("media", p.storyId, cardSlot(c))]?.status === "approved")
    && groups.every((g) => states[partKey("media", p.storyId, g.key)]?.status === "approved");
  // What the piece waits on, named from the live part states: "Waiting on John: Substack essay, Substack image".
  const open = useMemo(() => openParts({ ...p, groups }, states), [p, groups, states]);
  // Under a filter, the card that matched is the one opened: its platform tab, or the Substack card moved above the
  // platform tabs when only it matched (kb-tokenmaxxing: an approved LinkedIn tab hid the pending essay, 2026-10-17).
  const matchedPlatform = p.matched?.find((m) => isRole(m)) as Role | undefined;
  const lettersFirst = !!p.matched && !matchedPlatform && p.matched.some((m) => m.startsWith("newsletter:"));
  const mediaColumn = mode.kind === "stage"
    ? <StageReview storyId={p.storyId} stage={mode.stage} assets={p.stageAssets ?? []} view={view} state={states[partKey("stage", p.storyId, mode.stage.key)]} decisions={p.decisions ?? []} />
    : mode.kind === "agent" ? <Notice icon={<Clapperboard className="size-4" />} title={`${mode.stage.label}: ${mode.stage.owner} is on it`}>
        {mode.stage.does} Nothing to review until the next stage is staged here.
      </Notice>
    : shared.length ? <div className="grid gap-6">{shared.map((g) => <MediaReview key={g.key} storyId={p.storyId} group={g} family={mediaFamily(groups, g)} state={states[partKey("media", p.storyId, g.key)]} pipeline={p.pipeline?.format ?? null} decisions={p.decisions ?? []} />)}</div>
    : mediaSentBack ? <Notice icon={<Clapperboard className="size-4" />} title="Media sent back for changes">
        It comes back here when the new version is staged. The text stays to review and edit meanwhile.
      </Notice>
    : null;
  const heroRatio = mode.kind === "stage" ? p.stageAssets?.[0]?.ratio : (videoWithCover(shared[0]?.assets ?? []).video ?? shared[0]?.assets[0])?.ratio;
  // The media column is exactly as wide as its video, so nothing in it can spill over the platform tabs.
  const hero = mode.kind === "stage" || shared.length > 0;
  const newsletters = letters.map((c) => (
    <NewsletterReview key={c.copy.id} storyId={p.storyId} card={c} focus={channel === "newsletter"} matched={!!p.matched?.includes(cardSlot(c))}
      text={states[partKey("text", p.storyId, cardSlot(c))]} media={states[partKey("media", p.storyId, cardSlot(c))]} />
  ));
  // The filter was applied on the server; drop the piece once a click here takes it out of the filter.
  if (!stillMatchesFilter(p, groups, states, loaded.current, status, platform)) return null;
  return (
    <section id={p.storyId} className="scroll-mt-20" aria-label={p.name}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-pl-lg font-semibold text-ink">{p.name}</h2>
        <span className="text-sm text-ink-3">{p.slot}</span>
        {p.pillar && <Badge variant="outline">{p.pillar}</Badge>}
        {view ? <StageBadges view={view} label={p.pipeline?.label} thirdParty={p.pipeline?.thirdParty} storyId={p.storyId} parts={mode.kind === "final" ? open : null} />
          : <><StageBadge stage={p.stage} />
            {open.john.length ? <WaitingBadge waiting={{ who: "john", label: "John", parts: open.john }} />
              : open.fixing.length ? <WaitingBadge waiting={{ who: "agent", label: "the agent (fix)", parts: open.fixing }} /> : null}</>}
        {allApproved && <Badge variant="success">Fully approved</Badge>}
        {p.pipeline?.thirdParty && (
          <span className="ml-auto self-center"><ShareForReview party={p.pipeline.thirdParty.who} pieces={p.pipeline.final.staged ? [p.name] : []} share={actions.shareForReview} /></span>
        )}
      </div>
      {lettersFirst && newsletters}
      {(platforms.length > 0 || !letters.length || mediaColumn) && (
        <Card glow={false} className={cn("overflow-hidden p-0", lettersFirst && "mt-4")}>
          <div className={cn("grid gap-8 p-5", mediaColumn && "lg:grid-cols-[minmax(0,auto)_minmax(24rem,1fr)]")}>
            {mediaColumn && (hero
              ? <div className="min-w-0 max-w-full" style={{ width: heroWidth(heroRatio ?? 9 / 16) }}>{mediaColumn}</div>
              : <div className="min-w-0 lg:w-[22rem]">{mediaColumn}</div>)}
            <PlatformTabs storyId={p.storyId} cards={platforms} groups={mode.kind === "final" ? groups.filter((g) => g.channels.length === 1) : []} all={mode.kind === "final" ? groups : []} mode={mode} pipeline={p.pipeline?.format ?? null} decisions={p.decisions ?? []} initial={channel && isRole(channel) ? channel : matchedPlatform} />
          </div>
        </Card>
      )}
      {!lettersFirst && newsletters}
      <div className="mt-3 grid justify-items-start gap-3 [&>*]:max-w-full">
        <ThirdPartyHold storyId={p.storyId} initial={p.hold ?? null} onSet={actions.setStoryHold} final={mode.kind === "final"} defaultWho={p.pipeline?.thirdParty?.who ?? ""} />
        <KillPiece storyId={p.storyId} name={p.name} kill={actions.killPiece} />
        {view && <div className="opacity-80"><PipelineStepper view={view} thirdParty={p.pipeline?.thirdParty} scheduled={p.scheduled} /></div>}
      </div>
    </section>
  );
}

/**
 * "Kill piece" (John, 2026-10-17: "when I ask to kill a post in content review it should be removed"). Not a note for an
 * agent: the piece leaves /content and the calendar at once, on every platform. An inline confirm, never a browser dialog.
 */
function KillPiece({ storyId, name, kill }: { storyId: string; name: string; kill: (input: { storyId: string }) => Promise<Result> }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!confirm) return <Button size="sm" variant="secondary" className="text-red-strong" onClick={() => setConfirm(true)}>Kill piece</Button>;
  return (
    <div className="space-y-2 rounded-md border border-[color:var(--border-strong)] p-3 text-sm" role="group" aria-label="Kill this piece">
      <p className="text-ink">Kill &ldquo;{name}&rdquo; on every platform? It leaves /content and the calendar, and any post Zernio has not sent yet is deleted.</p>
      {error && <p role="alert" className="text-red-strong">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => start(async () => {
          const r = await kill({ storyId });
          if (!r.ok) { setError(r.error); return; }
          router.refresh();
        })}>Kill it</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setConfirm(false); setError(null); }}>Keep it</Button>
      </div>
    </div>
  );
}

function Notice({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-4 text-sm" role="note">
      <p className="flex items-center gap-2 font-medium text-ink">{icon}{title}</p>
      <p className="mt-1 text-ink-2">{children}</p>
    </div>
  );
}

/** One part's optimistic state and a runner that commits it when the server call succeeds. */
function usePart(key: string, state: PartState) {
  const { commit } = useReviewActions();
  // The optimistic copy shows the click at once; React drops it when the server call settles, by which
  // time the committed state has caught up (or the call failed and the old state returns).
  const [view, applyOp] = useOptimistic(state, partReducer);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (op: Op, call: () => Promise<Result>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      applyOp(op);
      const result = await call();
      if (result.ok) startTransition(() => { commit(key, op); after?.(); });
      else startTransition(() => setError(`Not saved. ${result.error}`));
    });
  };
  return { view, applyOp, run, error, setError, startTransition, commit };
}

const pendingNote = (assetId: string, channel: string | null, body: string, revision: number | null): FeedbackItem =>
  ({ id: `pending-${Date.now()}`, asset_id: assetId, channel, body, created_at: new Date().toISOString(), resolved_at: null, resolution: "", revision });

/**
 * A stage before the final, reviewed once for the piece: the rough cut, a note, and "Approve rough cut"
 * / "Approve plan". It never schedules anything, and the line under the button says what happens next.
 */
const StageReview = memo(function StageReview({ storyId, stage, assets, view, state, decisions }: { storyId: string; stage: Stage; assets: PieceAsset[]; view: PipelineView | null; state: PartState; decisions: JohnDecision[] }) {
  const { actions } = useReviewActions();
  const { view: s, run, error } = usePart(partKey("stage", storyId, stage.key), state);
  const versions = useMemo(() => partVersions(assets), [assets]);
  const latest = latestVersion(versions);
  const [viewing, setViewing] = useState<number | null>(null);
  const shown = viewing ?? latest?.revision ?? 1;
  const ui = partUi(s.status, latest, s.notes);
  const label = assets.find((a) => a.label)?.label;
  const pipeline = view?.pipeline;
  const next = pipeline ? pipeline.stages[pipeline.stages.findIndex((x) => x.key === stage.key) + 1] : undefined;
  const changed = useChanged(assets, decisions, s.notes, shown);
  const done = resolvedNotes(s.notes);
  return (
    <div aria-label={`${stage.label} review`} role="group" className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-2">
          <Clapperboard className="size-3.5" aria-hidden /> {stage.label}{label ? ` · ${label}` : ""}
          {stage.spends && <Coins className="size-3.5 text-amber-strong" aria-label="approving authorizes spend" />}
        </h4>
        <VersionSwitcher label={stage.label} versions={versions} viewing={shown} onView={setViewing} isNew={ui === "new"} />
      </div>
      <Media media={assets} revision={shown} videoRef={changed.ref} />
      <PartPanel label={stage.label} verb={stage.approve?.verb} approveAttr="stage" ui={ui === "none" ? "pending" : ui} versions={versions} viewing={shown} notes={s.notes} error={error}
        consequence={stage.spends ? `Authorizes ${stage.spends}` : undefined}
        approvedNote={`Nothing is scheduled. Next: ${next ? `${next.label} (${next.owner})` : "the final"}`}
        onApprove={() => run({ type: "approve" }, () => actions.decideStage({ storyId, stage: stage.key, decision: "approved", note: "", expected: expectedOf(assets) }))}
        onUnapprove={null}
        onRequest={(body) => run({ type: "request", note: pendingNote(assets[0].id, null, body, latest?.revision ?? null) }, () => actions.decideStage({ storyId, stage: stage.key, decision: "changes", note: body, expected: expectedOf(assets) }))} />
      {(changed.history || done.length > 0) && <History>{changed.history}<ResolvedNotes notes={done} versions={versions} /></History>}
    </div>
  );
});

/**
 * Final media, approved once for every platform that posts it (John, 2026-10-12): "Approve final for YouTube and
 * Instagram". A platform schedules when its media and its text are both approved. On a pipeline piece, an edit note can
 * send it back to an earlier stage instead.
 *
 * The formats of one video (the 4:5 cut LinkedIn posts, the 9:16 cuts Instagram and YouTube post) are one review (John,
 * 2026-10-13): Approve, Request changes and Approve with note on any format cover every format, and the note is stored
 * once. "Only this format" keeps a note (and its decision) to the format on screen.
 */
const MediaReview = memo(function MediaReview({ storyId, group, family = [group], state, pipeline, decisions, inTab = false }: { storyId: string; group: MediaGroup; family?: MediaGroup[]; state: PartState; pipeline: string | null; decisions: JohnDecision[]; inTab?: boolean }) {
  const { actions } = useReviewActions();
  const key = partKey("media", storyId, group.key);
  const { view: s, run: runOne, error, commit } = usePart(key, state);
  // A decision on every format lands on each sibling's part too, so all of them read the same at once.
  const siblings = family.filter((g) => g.key !== group.key).map((g) => partKey("media", storyId, g.key));
  const run = (op: Op, call: () => Promise<Result>, only = false) => runOne(op, call, only ? undefined : () => siblings.forEach((k) => commit(k, op)));
  const versions = useMemo(() => partVersions(group.assets), [group.assets]);
  const latest = latestVersion(versions);
  const [viewing, setViewing] = useState<number | null>(null);
  const shown = viewing ?? latest?.revision ?? 1;
  const ui = partUi(s.status, latest, s.notes);
  const lead = videoWithCover(group.assets);
  const what = lead.video ? `Video ${lead.video.ratio < 0.6 ? "9:16" : "4:5"}${lead.cover ? " with cover" : ""}` : group.assets.length > 1 ? `Slides (${group.assets.length})` : "Image";
  const input = { storyId, assetIds: group.assets.map((a) => a.id), channels: group.channels, expected: expectedOf(group.assets) };
  const all = family.length > 1 ? { storyId, ...familyTarget(family) } : input;
  const scope = (only: boolean) => (only ? input : all);
  const changed = useChanged(lead.video ? [lead.video] : group.assets, decisions, s.notes, shown);
  const done = resolvedNotes(s.notes);
  return (
    <div role="group" aria-label={`${what} for ${names(group.channels)}`} className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-2">
          {what}
          {!inTab && <span className="inline-flex items-center gap-1">{group.channels.map((c) => { const { Icon, label } = PLATFORM[c]; return <Icon key={c} className="size-3.5" aria-label={label} />; })}</span>}
        </h4>
        <VersionSwitcher label={what} versions={versions} viewing={shown} onView={setViewing} isNew={ui === "new"} />
      </div>
      <Media media={group.assets} revision={shown} videoRef={changed.ref} />
      {ui !== "none" && (
        <PartPanel label={what} verb={`Approve final for ${names(all.channels)}`} ui={ui} versions={versions} viewing={shown} notes={s.notes} error={error}
          onlyThisFormat={family.length > 1}
          onApprove={() => run({ type: "approve" }, () => actions.setMediaApproval({ ...all, approve: true }))}
          onUnapprove={() => run({ type: "unapprove" }, () => actions.setMediaApproval({ ...all, approve: false }))}
          onRequest={(body, only = false) => { const t = scope(only); run({ type: "request", note: pendingNote(t.assetIds.slice().sort()[0], t.channels.length === 1 ? t.channels[0] : null, body, latest?.revision ?? null) }, () => actions.requestMediaChanges({ ...t, note: body }), only); }}
          onApproveWithNote={(body, only = false) => { const t = scope(only); run({ type: "approveWithNote", note: pendingNote(t.assetIds.slice().sort()[0], t.channels.length === 1 ? t.channels[0] : null, encodeFixNote({ part: "media", channels: t.channels, assets: t.assetIds.slice().sort() }, body), latest?.revision ?? null) }, () => actions.approveMediaWithNote({ ...t, note: body }), only); }}
          extra={pipeline ? <SendBack storyId={storyId} pipeline={pipeline} expected={input.expected} /> : undefined} />
      )}
      {(changed.history || done.length > 0) && <History>{changed.history}<ResolvedNotes notes={done} versions={versions} /></History>}
    </div>
  );
});

/** "Send back to <stage>": an edit note on the final goes to the stage it is about; nothing goes out meanwhile. */
function SendBack({ storyId, pipeline, expected }: { storyId: string; pipeline: string; expected: Expected[] }) {
  const { actions } = useReviewActions();
  const router = useRouter();
  const stages = isFormat(pipeline) ? PIPELINES[pipeline].stages.filter((s) => s.gate === "john" && s.review === "cockpit" && !s.final) : [];
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState(stages[0]?.key ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const id = useId();
  if (!stages.length) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs text-ink-3 underline underline-offset-4 hover:text-ink">
        <Undo2 className="size-3" aria-hidden /> Send back to an earlier stage
      </button>
    );
  }
  return (
    <div className="grid gap-2 border-t border-line pt-3">
      <label className="text-xs text-ink-2" htmlFor={`${id}-stage`}>Send back to</label>
      <select id={`${id}-stage`} value={stage} onChange={(e) => setStage(e.target.value)} className="h-8 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-2 text-sm">
        {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <textarea aria-label="What needs to change at that stage" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What should change?"
        className="w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-2.5 text-sm" />
      <span className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !note.trim()} onClick={() => start(async () => {
          setError(null);
          const r = await actions.reopenStage({ storyId, stage, note, expected });
          if (!r.ok) { setError(`Not saved. ${r.error}`); return; }
          setOpen(false); setNote(""); router.refresh();
        })}>Send back to {stages.find((s) => s.key === stage)?.label.toLowerCase()}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </span>
      {error && <p role="alert" className="text-xs text-red-strong">{error}</p>}
    </div>
  );
}

/**
 * Each platform's text in its own tab, with a clear icon and label, approved separately. Media that only one platform
 * posts (a YouTube thumbnail, a 4:5 cut, a Short with its own end card) sits in the column to the left, switching with the
 * tab, so the tabs head the text column only (John, 2026-10-13). A tab's mark is its text's approval; the media shows its
 * own. The tab moves on once both are approved.
 */
function PlatformTabs({ storyId, cards, groups, all, mode, pipeline, decisions, initial }: { storyId: string; cards: PlatformCard[]; groups: MediaGroup[]; all: MediaGroup[]; mode: ReviewMode; pipeline: string | null; decisions: JohnDecision[]; initial?: Role }) {
  const states = usePartStates();
  // A finding's link (/content?piece=<id>&channel=<platform>) opens that platform's tab and scrolls to it.
  const [active, setActive] = useState<Role | undefined>(cards.find((c) => c.channel === initial)?.channel ?? cards[0]?.channel);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initial && cards.some((c) => c.channel === initial)) box.current?.scrollIntoView({ block: "start" }); }, [initial, cards]);
  const tabState = (c: PlatformCard) => {
    const parts = [states[partKey("text", storyId, c.channel)], ...groups.filter((g) => g.channels[0] === c.channel).map((g) => states[partKey("media", storyId, g.key)])].filter(Boolean);
    return parts.some((p) => p.status === "rejected") ? "changes" : parts.every((p) => p.status === "approved") ? "approved" : "pending";
  };
  // The tab on screen. A status filter ("Waiting on John") drops a card from the list once it is approved; the tab then
  // falls to the first platform still waiting instead of showing an empty panel.
  const shown = cards.some((c) => c.channel === active) ? active : (cards.find((c) => tabState(c) !== "approved") ?? cards[0])?.channel;
  const shownCard = cards.find((c) => c.channel === shown);
  const shownState = shownCard ? tabState(shownCard) : undefined;
  // Approving the tab on screen moves on to the next platform still waiting, and brings it into view (John, 2026-10-13).
  const last = useRef<{ channel?: Role; state?: string }>({});
  useEffect(() => {
    const was = last.current;
    last.current = { channel: shown, state: shownState };
    let next: Role | undefined;
    if (was.channel && was.channel === shown && was.state !== "approved" && shownState === "approved") {
      const i = cards.findIndex((c) => c.channel === shown);
      next = [...cards.slice(i + 1), ...cards.slice(0, i)].find((c) => tabState(c) !== "approved")?.channel;
    } else if (was.channel && shown !== was.channel && shown !== active) next = shown;
    if (!next) return;
    setActive(next);
    if ((box.current?.getBoundingClientRect().top ?? 0) < 0) box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [shown, shownState]);
  if (!cards.length) return <p className="rounded-lg border border-dashed border-line p-6 text-sm text-ink-3">No platform text staged yet.</p>;
  if (cards.length > 1) {
    // One text for every platform; media only one platform posts (rare now: one 9:16 video for all) sits beside it.
    return (
      <div className={cn("grid min-w-0 scroll-mt-20 gap-8", groups.length > 0 && "lg:grid-cols-[minmax(0,auto)_minmax(24rem,1fr)]")} ref={box} id={`${storyId}-platforms`}>
        {groups.length > 0 && (
          <div className="grid min-w-0 max-w-full content-start gap-6" style={{ width: heroWidth((videoWithCover(groups[0].assets).video ?? groups[0].assets[0])?.ratio ?? 9 / 16) }}>
            {groups.map((g) => <MediaReview key={g.key} storyId={storyId} group={g} family={mediaFamily(all, g)} state={states[partKey("media", storyId, g.key)]} pipeline={pipeline} decisions={decisions} />)}
          </div>
        )}
        <SharedText storyId={storyId} cards={cards} />
      </div>
    );
  }
  const ownOf = (c: PlatformCard) => groups.filter((g) => g.channels[0] === c.channel);
  const textState = (c: PlatformCard) => {
    const st = states[partKey("text", storyId, c.channel)]?.status;
    return st === "rejected" ? "changes" : st === "approved" ? "approved" : "pending";
  };
  const firstOwn = cards.map(ownOf).find((own) => own.length)?.[0];
  return (
    <div className={cn("grid min-w-0 scroll-mt-20 gap-8", firstOwn && "lg:grid-cols-[minmax(0,auto)_minmax(24rem,1fr)]")} ref={box} id={`${storyId}-platforms`}>
      {firstOwn && (
        <div className="min-w-0 max-w-full" style={{ width: heroWidth(firstOwn.assets[0]?.ratio ?? 9 / 16) }}>
          {cards.map((c) => {
            const own = ownOf(c);
            return own.length > 0 && (
              <div key={c.channel} className="grid min-w-0 content-start gap-6" hidden={c.channel !== shown} aria-label={`${PLATFORM[c.channel].label} media`}>
                {own.map((g) => <MediaReview key={g.key} storyId={storyId} group={g} family={mediaFamily(all, g)} state={states[partKey("media", storyId, g.key)]} pipeline={pipeline} decisions={decisions} inTab />)}
              </div>
            );
          })}
        </div>
      )}
      <div className="min-w-0">
      <div role="tablist" aria-label="Platforms" className="mb-4 flex min-w-0 flex-wrap gap-1 border-b border-line">
        {cards.map((c) => {
          const { Icon, label } = PLATFORM[c.channel];
          const st = textState(c);
          const on = c.channel === shown;
          return (
            <button key={c.channel} type="button" role="tab" id={`${id}-${c.channel}`} aria-selected={on} aria-controls={`${id}-${c.channel}-panel`} onClick={() => setActive(c.channel)}
              className={cn("-mb-px inline-flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-violet text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
              <Icon className="size-5" />{label}
              <span aria-label={st === "approved" ? "text approved" : st === "changes" ? "text needs changes" : "text needs approval"}
                className={cn("inline-flex size-4 items-center justify-center rounded-full", st === "approved" ? "bg-[color:var(--emerald)] text-white" : st === "changes" ? "bg-amber-strong" : "border border-violet")}>
                {st === "approved" && <Check className="size-3" />}
              </span>
            </button>
          );
        })}
      </div>
      {cards.map((c) => (
        <div key={c.channel} role="tabpanel" id={`${id}-${c.channel}-panel`} aria-labelledby={`${id}-${c.channel}`} hidden={c.channel !== shown} className="min-w-0">
          <TextReview storyId={storyId} card={c} state={states[partKey("text", storyId, c.channel)]} />
        </div>
      ))}
      </div>
    </div>
  );
}

const TextReview = memo(function TextReview({ storyId, card, state }: { storyId: string; card: PlatformCard; state: PartState }) {
  const { actions } = useReviewActions();
  const key = partKey("text", storyId, card.channel);
  const { view, applyOp, run, error, startTransition, commit } = usePart(key, state);
  const extra = EXTRA[card.channel];
  const { label } = PLATFORM[card.channel];
  const [viewing, setViewing] = useState<number | null>(null);
  const copy = useMemo<PieceAsset>(() => ({ ...card.copy, revision: view.revision, versions: [...assetVersions(card.copy), ...view.addedVersions] }), [card.copy, view.revision, view.addedVersions]);
  const versions = useMemo(() => partVersions([copy]), [copy]);
  const latest = latestVersion(versions);
  const ui = partUi(view.status, view.reset ? undefined : latest, view.notes);
  const latestContent = versionAt(copy, latest?.revision ?? 1);
  const initialField = extra ? latestContent.fields[extra.key] ?? "" : "";
  const [text, setText] = useState<{ prose: string; fields: Partial<Record<EditableField, string>> }>({ prose: latestContent.prose, fields: extra ? { [extra.key]: initialField } : {} });
  const field = extra ? text.fields[extra.key] ?? "" : "";
  const dirty = text.prose !== latestContent.prose || field !== initialField;
  const placeholder = hasPlaceholder(text.prose) || hasPlaceholder(field);
  const shownRevision = viewing ?? latest?.revision ?? 1;
  const readOnly = latest ? shownRevision !== latest.revision : false;
  const shown = readOnly ? versionAt(copy, shownRevision) : null;
  // The caption John last commented on, if a newer one has come back since: show what changed, word by word.
  const notedRevision = Math.max(0, ...view.notes.filter((n) => n.asset_id === copy.id && n.revision != null && n.revision < (latest?.revision ?? 0)).map((n) => n.revision!));
  const diff = useMemo(() => {
    if (!notedRevision || !latest) return null;
    const base = versionAt(copy, notedRevision);
    const parts = diffWords(base.prose, latestContent.prose);
    return hasChanges(parts) ? { parts, since: base.label } : null;
  }, [notedRevision, latest, copy, latestContent.prose]);

  const doneNotes = resolvedNotes(view.notes);
  const save = async (overwrite = false): Promise<Result & { conflict?: boolean }> => {
    const fields = extra ? { [extra.key]: field } : {};
    const version: AssetVersion = { revision: view.revision + 1, label: nextLabel(versions), createdAt: new Date().toISOString(), src: null, poster: null, prose: text.prose, fields };
    applyOp({ type: "saved", version });
    const result = await actions.saveSeasonCopy({ assetId: copy.id, prose: text.prose, fields, expectedRevision: state.revision, overwrite });
    if (!result.ok) return { ok: false, error: result.error, conflict: !!result.conflict };
    startTransition(() => { commit(key, { type: "saved", version: { ...version, revision: result.revision } }); setViewing(null); });
    return { ok: true };
  };
  return (
    <div className="min-w-0">
      <TextEditor label={TEXT_LABEL[card.channel]} extras={extra ? [extra] : []} text={shown ? { prose: shown.prose, fields: extra ? { [extra.key]: shown.fields[extra.key] ?? "" } : {} } : text} setText={setText}
        readOnly={readOnly} dirty={dirty} onSave={save}
        switcher={<span className="inline-flex items-center gap-2"><StatusChip part="Text" ui={ui} version={latest?.label} /><VersionSwitcher label={`${label} text`} versions={versions} viewing={shownRevision} onView={setViewing} isNew={ui === "new"} /></span>} />
      <div className="mt-3 grid gap-2">
        <MentionCheck texts={[shown ? shown.prose : text.prose]} channels={[card.channel]} />
        {card.channel === "linkedin" && <MentionCheck texts={[shown ? shown.fields.first_comment ?? "" : field]} channels={["linkedin"]} comment />}
      </div>
      {ui !== "none" && (
        <PartPanel label={`${label} text`} ui={ui} versions={versions} viewing={shownRevision} notes={view.notes} error={error} textReset={view.reset}
          blocked={placeholder ? "Fill in the [JOHN: ...] placeholder, then save." : dirty ? "Save first." : undefined}
          onApprove={() => run({ type: "approve" }, () => actions.setPartApproval({ storyId, channel: card.channel, part: "text", approve: true }))}
          onUnapprove={() => run({ type: "unapprove" }, () => actions.setPartApproval({ storyId, channel: card.channel, part: "text", approve: false }))}
          onRequest={(body) => run({ type: "request", note: pendingNote(copy.id, card.channel, body, latest?.revision ?? null) }, () => actions.requestChanges({ storyId, channel: card.channel, part: "text", note: body }))}
          onApproveWithNote={(body) => run({ type: "approveWithNote", note: pendingNote(copy.id, card.channel, encodeFixNote({ part: "text", channels: [card.channel], assets: [copy.id] }, body), latest?.revision ?? null) }, () => actions.approveTextWithNote({ storyId, channel: card.channel, note: body }))} />
      )}
      {((diff && !readOnly) || doneNotes.length > 0) && (
        <History>
          {diff && !readOnly && <TextDiff parts={diff.parts} since={diff.since} />}
          <ResolvedNotes notes={doneNotes} versions={versions} />
        </History>
      )}
    </div>
  );
});

/**
 * One text for every platform (John, 2026-10-16: "I don't want to approve three sets of text"). The piece's caption is
 * edited and approved once: saving writes it to every platform's copy (LinkedIn keeps its first comment, YouTube its
 * title), and Approve approves it on every platform. Links go in the LinkedIn first comment, since Instagram takes none.
 */
const SharedText = memo(function SharedText({ storyId, cards }: { storyId: string; cards: PlatformCard[] }) {
  const states = usePartStates();
  const { actions } = useReviewActions();
  const primary = cards.find((c) => c.channel === "linkedin") ?? cards[0];
  const channels = cards.map((c) => c.channel);
  const key = partKey("text", storyId, primary.channel);
  const others = cards.filter((c) => c.channel !== primary.channel).map((c) => partKey("text", storyId, c.channel));
  // The text reads as one part: approved only when every platform's is, changes when any was sent back, every note once.
  const merged = useMemo<PartState>(() => {
    const parts = [states[key], ...others.map((k) => states[k])].filter(Boolean);
    const status = parts.some((x) => x.status === "rejected") ? "rejected" : parts.every((x) => x.status === "approved") ? "approved" : "pending";
    const notes = [...new Map(parts.flatMap((x) => x.notes).map((n) => [n.id, n])).values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { ...states[key], status, notes };
  }, [states, key, others.join("|")]);
  const { view, applyOp, run: runOne, error, startTransition, commit } = usePart(key, merged);
  const run = (op: Op, call: () => Promise<Result>) => runOne(op, call, () => others.forEach((k) => commit(k, op)));
  const [viewing, setViewing] = useState<number | null>(null);
  const copy = useMemo<PieceAsset>(() => ({ ...primary.copy, revision: view.revision, versions: [...assetVersions(primary.copy), ...view.addedVersions] }), [primary.copy, view.revision, view.addedVersions]);
  const versions = useMemo(() => partVersions([copy]), [copy]);
  const latest = latestVersion(versions);
  const ui = partUi(view.status, view.reset ? undefined : latest, view.notes);
  const latestContent = versionAt(copy, latest?.revision ?? 1);
  // Every other card through its live part state: the page's props are not refreshed after a save.
  const latestOf = (c: PlatformCard) => latestText(c.copy, states[partKey("text", storyId, c.channel)]);
  const extras = ROLES_WITH_EXTRA.filter((r) => channels.includes(r)).map((r) => EXTRA[r]!);
  const initial = useMemo(() => sharedTextBaseline(storyId, cards, primary, latestContent, states), [storyId, cards, primary, latestContent, states]);
  const [text, setText] = useState(initial);
  const dirty = sharedTextDirty(text, initial);
  const placeholder = hasPlaceholder(text.prose) || Object.values(text.fields).some((v) => hasPlaceholder(v ?? ""));
  const shownRevision = viewing ?? latest?.revision ?? 1;
  const readOnly = latest ? shownRevision !== latest.revision : false;
  const shown = readOnly ? versionAt(copy, shownRevision) : null;
  // Pieces staged before 2026-10-16 carry a different text per platform; the first save puts this one on all of them.
  const differs = cards.some((c) => c !== primary && latestOf(c).prose.trim() !== latestContent.prose.trim());
  const doneNotes = resolvedNotes(view.notes);

  const commitSaved = (saved: Array<{ keys: string[]; revision: number; version?: AssetVersion }>) => startTransition(() => {
    for (const f of saved) for (const k of f.keys) commit(k, { type: "saved", version: { ...f.version!, revision: f.revision } });
    if (saved.length) setViewing(null);
  });
  const save = async (overwrite = false): Promise<Result & { conflict?: boolean }> => {
    if (channels.includes("instagram") && /https?:\/\/|www\./i.test(text.prose)) return { ok: false, error: "Put links in the LinkedIn first comment. This text also goes to Instagram, which can't carry a link." };
    const version: AssetVersion = { revision: view.revision + 1, label: nextLabel(versions), createdAt: new Date().toISOString(), src: null, poster: null, prose: text.prose, fields: text.fields };
    applyOp({ type: "saved", version });
    // One copy file can serve several platforms; each file is saved once, with the fields of the platforms it serves.
    const files = new Map<string, PlatformCard[]>();
    for (const c of cards) files.set(c.copy.id, [...(files.get(c.copy.id) ?? []), c]);
    const saved: Array<{ keys: string[]; revision: number; version: AssetVersion }> = [];
    for (const [assetId, served] of files) {
      const fields: Partial<Record<EditableField, string>> = {};
      for (const c of served) { const x = EXTRA[c.channel]; if (x) fields[x.key] = text.fields[x.key] ?? ""; }
      const k = partKey("text", storyId, served[0].channel);
      const now = states[k] ? versionAt({ ...served[0].copy, versions: [...assetVersions(served[0].copy), ...states[k].addedVersions] }, states[k].revision) : null;
      if (now && now.prose === text.prose && Object.entries(fields).every(([f, v]) => (now.fields[f as EditableField] ?? "") === v)) continue;
      const result = await actions.saveSeasonCopy({ assetId, prose: text.prose, fields, expectedRevision: states[k]?.revision ?? served[0].copy.revision, overwrite });
      if (!result.ok) {
        // Keep what did save, so a retry saves only the rest against the revisions now on the server.
        commitSaved(saved);
        return { ok: false, error: saved.length ? `Saved on some platforms only. ${result.error}` : result.error, conflict: !!result.conflict };
      }
      saved.push({ keys: served.map((c) => partKey("text", storyId, c.channel)), revision: result.revision, version });
    }
    commitSaved(saved);
    return { ok: true };
  };
  // One call for every platform: the server decides them in parallel and auto-schedule runs once per approval.
  const approve = (yes: boolean): Promise<Result> => actions.setTextApprovalAll({ storyId, channels, approve: yes });
  return (
    <div className="min-w-0" role="group" aria-label="Post text">
      <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
        One text for {cards.map((c) => { const { Icon, label } = PLATFORM[c.channel]; return <Icon key={c.channel} className="size-4" aria-label={label} />; })}
      </p>
      <TextEditor label="Post text" extras={extras} text={shown ? { prose: shown.prose, fields: shown.fields } : text} setText={setText}
        readOnly={readOnly} dirty={dirty} onSave={save}
        hint={differs && !readOnly ? <p className="text-xs text-ink-3">This piece was written with a different text per platform. Saving puts this one on all of them.</p> : undefined}
        switcher={<span className="inline-flex items-center gap-2"><StatusChip part="Text" ui={ui} version={latest?.label} /><VersionSwitcher label="Post text" versions={versions} viewing={shownRevision} onView={setViewing} isNew={ui === "new"} /></span>} />
      <div className="mt-3 grid gap-2">
        <MentionCheck texts={[(shown ?? text).prose]} channels={channels} />
        {channels.includes("linkedin") && <MentionCheck texts={[(shown ?? text).fields.first_comment ?? ""]} channels={["linkedin"]} comment />}
      </div>
      {ui !== "none" && (
        <PartPanel label="Post text" verb={`Approve text for ${names(channels)}`} ui={ui} versions={versions} viewing={shownRevision} notes={view.notes} error={error} textReset={view.reset}
          blocked={placeholder ? "Fill in the [JOHN: ...] placeholder, then save." : dirty ? "Save first." : undefined}
          onApprove={() => run({ type: "approve" }, () => approve(true))}
          onUnapprove={() => run({ type: "unapprove" }, () => approve(false))}
          onRequest={(body) => run({ type: "request", note: pendingNote(copy.id, null, body, latest?.revision ?? null) }, () => actions.requestTextChangesAll({ storyId, channels, note: body }))}
          onApproveWithNote={(body) => run({ type: "approveWithNote", note: pendingNote(copy.id, null, encodeFixNote({ part: "text", channels, assets: [...new Set(cards.map((c) => c.copy.id))].sort() }, body), latest?.revision ?? null) }, () => actions.approveTextWithNoteAll({ storyId, channels, note: body }))} />
      )}
      {doneNotes.length > 0 && <History><ResolvedNotes notes={doneNotes} versions={versions} /></History>}
    </div>
  );
});

/**
 * A newsletter essay (John, 2026-10-16: "add substack as a channel, and I'll copy paste to publish"). The essay and its
 * images are approved here like any platform, with notes and changes, and John publishes by hand: "Copy body for Substack"
 * puts rich HTML and plain text on the clipboard, and "Open Substack editor" opens a new post on its publication.
 * Approving it never schedules or sends anything (lib/hand-published.ts).
 */
const NO_PART: PartState = initialPartState({ status: "none", notes: [] });
const NewsletterReview = memo(function NewsletterReview({ storyId, card, text, media, focus = false, matched = false }: { storyId: string; card: CardData; text: PartState; media?: PartState; focus?: boolean; matched?: boolean }) {
  const { actions } = useReviewActions();
  const slot = cardSlot(card);
  const t = usePart(partKey("text", storyId, slot), text);
  const m = usePart(partKey("media", storyId, slot), media ?? NO_PART);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) box.current?.scrollIntoView({ block: "start" }); }, [focus]);
  const textVersions = useMemo(() => partVersions([card.copy]), [card.copy]);
  const textLatest = latestVersion(textVersions);
  const textUi = partUi(t.view.status, textLatest, t.view.notes);
  // Only the images the essay names are decided; the others are options shown beside them (lib/newsletter-card.ts).
  const decided = useMemo(() => decidedMedia(card), [card]);
  const options = card.media.filter((a) => !decided.includes(a));
  // Images the essay names that are not staged: the paste would leave them out (review #143 F2).
  const missing = card.substack?.data.missing ?? [];
  // John's open notes on the options stay on screen (one note can cover several files: listed once).
  const optionNotes = [...new Map(options.flatMap((a) => a.feedback).filter((n) => !n.resolved_at && !decided.some((d) => d.feedback.some((f) => f.id === n.id))).map((n) => [n.id, n])).values()];
  const mediaVersions = useMemo(() => partVersions(decided), [decided]);
  const mediaLatest = latestVersion(mediaVersions);
  const mediaUi = decided.length ? partUi(m.view.status, mediaLatest, m.view.notes) : "none";
  const copyId = card.copy.id;
  const target = { storyId, assetIds: decided.map((a) => a.id), channels: ["newsletter"], expected: expectedOf(decided) };
  const sub = card.substack;
  const title = sub?.data.title || card.copy.title;
  const images = decided.length === 1 ? "Header image" : `Images (${decided.length})`;
  const doneNotes = resolvedNotes([...t.view.notes, ...m.view.notes]);
  return (
    <div ref={box} className="mt-4 scroll-mt-20" role="group" aria-label={`Substack: ${title}`} data-testid="newsletter-card" data-matched={matched || undefined}>
      <Card glow={false} className={cn("overflow-hidden p-5", matched && "ring-2 ring-violet/40")}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SubstackIcon className="size-5" />
          <h3 className="text-sm font-medium text-ink">Substack</h3>
          <StatusChip part="Text" ui={textUi} version={textLatest?.label} />
          <span className="text-xs text-ink-3">Published by hand. Approving never schedules it.</span>
          {sub?.editorUrl && <a href={sub.editorUrl} target="_blank" rel="noreferrer" className="ml-auto text-sm font-medium text-violet underline-offset-2 hover:underline">Open Substack editor</a>}
        </div>
        <MarkPublished storyId={storyId} assetId={copyId} title={title} mark={actions.markPublished} />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
          <div className="min-w-0">
            {sub
              ? <SubstackExportPanel data={sub.data} images={sub.images} />
              : <pre className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{card.copy.prose}</pre>}
          </div>
          <div className="grid min-w-0 content-start gap-6 overflow-hidden">
            <div>
              <h4 className="mb-2 text-xs font-medium text-ink-2">Essay</h4>
              {textUi !== "none" && (
                <PartPanel label="Essay" verb="Approve essay" ui={textUi} versions={textVersions} viewing={textLatest?.revision ?? 1} notes={t.view.notes} error={t.error}
                  blocked={hasPlaceholder(card.copy.prose) ? "Fill in the [JOHN: ...] placeholder on the Story page, then approve." : undefined}
                  approvedNote="Nothing is scheduled. Paste it into Substack when you publish"
                  onApprove={() => t.run({ type: "approve" }, () => actions.setPartApproval({ storyId, channel: "newsletter", part: "text", approve: true, assetId: copyId }))}
                  onUnapprove={() => t.run({ type: "unapprove" }, () => actions.setPartApproval({ storyId, channel: "newsletter", part: "text", approve: false, assetId: copyId }))}
                  onRequest={(body) => t.run({ type: "request", note: pendingNote(copyId, "newsletter", body, textLatest?.revision ?? null) }, () => actions.requestChanges({ storyId, channel: "newsletter", part: "text", note: body, assetId: copyId }))}
                  onApproveWithNote={(body) => t.run({ type: "approveWithNote", note: pendingNote(copyId, "newsletter", encodeFixNote({ part: "text", channels: ["newsletter"], assets: [copyId] }, body), textLatest?.revision ?? null) }, () => actions.approveTextWithNote({ storyId, channel: "newsletter", note: body, assetId: copyId }))} />
              )}
            </div>
            {missing.length > 0 && (
              <p role="alert" className="text-sm font-medium text-amber-strong" data-testid="newsletter-missing">
                The essay names {missing.join(", ")}, which {missing.length === 1 ? "is" : "are"} not staged, so the paste has no {missing.length === 1 ? "image there" : "images there"}. The agent stages {missing.length === 1 ? "it" : "them"} or points the essay at an option below.
              </p>
            )}
            {decided.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-xs font-medium text-ink-2">{images}</h4>
                  <StatusChip part="Asset" ui={mediaUi} version={mediaLatest?.label} />
                </div>
                <div className={cn("grid gap-2", decided.length > 1 && "grid-cols-2")}>
                  {decided.map((a) => {
                    const v = versionAt(a, mediaLatest?.revision ?? 1);
                    return v.src
                      ? <WatchedImage key={`${a.id}-${v.revision}`} src={v.src} alt={a.title} className="max-h-72 w-full rounded-lg bg-black/5 object-contain" />
                      : <p key={a.id} className="text-sm text-red-strong">Could not load {a.title}.</p>;
                  })}
                </div>
                {mediaUi !== "none" && (
                  <PartPanel label={images} verb={`Approve ${images.toLowerCase()}`} ui={mediaUi} versions={mediaVersions} viewing={mediaLatest?.revision ?? 1} notes={m.view.notes} error={m.error}
                    approvedNote="Nothing is scheduled"
                    onApprove={() => m.run({ type: "approve" }, () => actions.setMediaApproval({ ...target, approve: true }))}
                    onUnapprove={() => m.run({ type: "unapprove" }, () => actions.setMediaApproval({ ...target, approve: false }))}
                    onRequest={(body) => m.run({ type: "request", note: pendingNote(target.assetIds.slice().sort()[0], "newsletter", body, mediaLatest?.revision ?? null) }, () => actions.requestMediaChanges({ ...target, note: body }))}
                    onApproveWithNote={(body) => m.run({ type: "approveWithNote", note: pendingNote(target.assetIds.slice().sort()[0], "newsletter", encodeFixNote({ part: "media", channels: ["newsletter"], assets: target.assetIds.slice().sort() }, body), mediaLatest?.revision ?? null) }, () => actions.approveMediaWithNote({ ...target, note: body }))} />
                )}
              </div>
            )}
            {options.length > 0 && (
              <div data-testid="newsletter-alternatives">
                <h4 className="mb-1 text-xs font-medium text-ink-2">{options.length === 1 ? "Alternative image" : `Alternative images (${options.length})`}</h4>
                {missing.length
                  ? <p className="mb-2 text-xs text-ink-3">Name one of these in the essay to use it as {missing.length === 1 ? "that image" : "those images"}.</p>
                  : <p className="mb-2 text-xs text-ink-3">The essay does not use {options.length === 1 ? "it" : "them"}, so {options.length === 1 ? "it needs" : "they need"} no approval. Name one in the essay to use it instead.</p>}
                {optionNotes.length > 0 && <ul className="mb-2 space-y-1.5" aria-label="Your open notes on the options">{optionNotes.map((n) => <NoteItem key={n.id} note={n} versions={mediaVersions} />)}</ul>}
                <div className="grid grid-cols-2 gap-2">
                  {options.map((a) => {
                    const v = versionAt(a, Infinity);
                    return v.src
                      ? <WatchedImage key={`${a.id}-${v.revision}`} src={v.src} alt={a.title} className="max-h-40 w-full rounded-lg bg-black/5 object-contain opacity-80" />
                      : <p key={a.id} className="text-sm text-red-strong">Could not load {a.title}.</p>;
                  })}
                </div>
              </div>
            )}
            <a href={`/stories/${storyId}`} className="text-xs text-ink-3 underline underline-offset-4 hover:text-ink">Edit the essay on its Story page</a>
            {doneNotes.length > 0 && <History><ResolvedNotes notes={doneNotes} versions={textVersions} /></History>}
          </div>
        </div>
      </Card>
    </div>
  );
});

/**
 * "Mark published" on a Substack essay card (John, 2026-10-18): the essay is live, so John pastes its link and the card
 * leaves /content. It is a row write (lib/mark-published.ts), not a deploy, and needs no approval first.
 */
function MarkPublished({ storyId, assetId, title, mark }: { storyId: string; assetId: string; title: string; mark: (input: { storyId: string; assetId: string; url: string }) => Promise<Result> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <div className="mb-4"><Button size="sm" variant="outline" data-testid="mark-published" onClick={() => setOpen(true)}>Mark published</Button></div>;
  return (
    <form className="mb-4 space-y-2 rounded-md border border-[color:var(--border-strong)] p-3 text-sm" aria-label={`Mark ${title} published`} data-testid="mark-published-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await mark({ storyId, assetId, url });
          if (!r.ok) { setError(r.error); return; }
          router.refresh();
        });
      }}>
      <label className="block text-ink" htmlFor={`published-url-${assetId}`}>Link to the published post. This essay leaves /content.</label>
      <Input id={`published-url-${assetId}`} type="url" required autoFocus placeholder="https://sample_author.substack.com/p/..." value={url} onChange={(e) => setUrl(e.target.value)} disabled={pending} />
      {error && <p role="alert" className="text-red-strong">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={pending || !url.trim()}>{pending ? "Marking…" : "Mark published"}</Button>
        <Button size="sm" type="button" variant="outline" disabled={pending} onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * What changed in a single video (or image) since John last decided on it: the panel, jump chips that seek the player,
 * and a side-by-side compare with the decided version when both play.
 */
function useChanged(assets: PieceAsset[], decisions: JohnDecision[], notes: FeedbackItem[], shown: number) {
  const ref = useRef<HTMLVideoElement>(null);
  const { on, toggle } = useCompare();
  const primary = assets.length === 1 ? assets[0] : undefined;
  const info = useMemo(() => (primary ? whatChanged(primary, decisions, notes) : null), [primary, decisions, notes]);
  if (!primary || !info || (!info.since && !info.points.length)) return { ref, history: null };
  const latest = primary.versions.at(-1);
  const base = info.since ? primary.versions.find((v) => v.revision === info.since!.revision) : undefined;
  const canCompare = primary.kind === "video" && !!base?.src && !!latest?.src && shown === latest?.revision;
  const seek = (t: number) => { const v = ref.current; if (v) { v.currentTime = t; void v.play().catch(() => undefined); } };
  const history = (
    <>
      <WhatChangedPanel info={info} onSeek={seek} />
      {canCompare && toggle(base!.label)}
      {canCompare && on && <VersionCompare before={{ src: base!.src!, label: base!.label }} after={{ src: latest!.src!, label: latest!.label }} width={320} ratio={primary.ratio} />}
    </>
  );
  return { ref, history };
}

function Media({ media, revision, videoRef }: { media: PieceAsset[]; revision: number; videoRef?: React.Ref<HTMLVideoElement> }) {
  const [at, setAtRaw] = useState(0);
  // Only the slide on screen and the next one load (a page of carousels used to fire every slide at once, and Storage
  // answered the burst with 429s: s1-29's blank slides 4 and 5). A slide once loaded stays in the page.
  const [wanted, setWanted] = useState<Set<number>>(() => new Set([0, 1]));
  const setAt = (i: number) => { setAtRaw(i); setWanted((w) => (w.has(i) && w.has((i + 1) % media.length) ? w : new Set([...w, i, (i + 1) % media.length]))); };
  if (!media.length) return null;
  const ratio = media[0].ratio;
  const box = { width: heroWidth(ratio), maxWidth: "100%", aspectRatio: String(ratio) } as const;
  // A video with an image beside it is one video and its cover (publishing reads it the same way: the cover is never a
  // slide). John, 2026-10-16: "I thought this was a video not a slide deck".
  const { video, cover } = videoWithCover(media);
  if (video) {
    const v = versionAt(video, revision);
    const poster = v.poster ?? cover?.src ?? undefined;
    const vbox = { ...box, aspectRatio: String(video.ratio) };
    return v.src
      ? <SignedVideo ref={videoRef} key={`${video.id}-${v.revision}`} src={v.src} poster={poster} controls playsInline preload={poster ? "none" : "metadata"} style={vbox} className="block rounded-lg bg-black object-contain" />
      : <p className="text-sm text-red-strong">Could not load this video.</p>;
  }
  return (
    <div>
      <div className="relative overflow-hidden rounded-lg bg-black/5" style={box}>
        {media.map((m, i) => {
          const v = versionAt(m, revision);
          if (!wanted.has(i)) return null;
          // Eager: a lazy image inside a hidden slide would never load. The wrapper hides the slide and its badge together.
          return v.src ? <div key={`${m.id}-${v.revision}`} className={`absolute inset-0 ${i === at ? "" : "hidden"}`}>
            {m.kind === "video"
              ? <SignedVideo src={v.src} poster={v.poster ?? undefined} controls playsInline preload="metadata" className="absolute inset-0 size-full bg-black object-contain" />
              : <WatchedImage src={v.src} alt={m.title} loading="eager" badge="overlay" className="absolute inset-0 size-full object-contain" />}
          </div> : null;
        })}
        {media.length > 1 && (
          <>
            <button type="button" aria-label="Previous slide" onClick={() => setAt((at + media.length - 1) % media.length)} className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white"><ChevronLeft className="size-4" /></button>
            <button type="button" aria-label="Next slide" onClick={() => setAt((at + 1) % media.length)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white"><ChevronRight className="size-4" /></button>
          </>
        )}
      </div>
      {media.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1" style={{ width: box.width, maxWidth: "100%" }}>
          {media.map((m, i) => (
            <button key={m.id} type="button" onClick={() => setAt(i)} aria-label={`Slide ${i + 1}`}
              className={`size-6 rounded-md border text-[11px] ${i === at ? "border-violet bg-violet/10 text-violet-strong" : "border-line text-ink-2"}`}>{i + 1}</button>
          ))}
        </div>
      )}
    </div>
  );
}

type Extra = { key: EditableField; label: string; multiline: boolean; first: boolean };

function TextEditor({ label, extras, text, setText, readOnly, dirty, onSave, switcher, hint }: {
  label: string; extras: Extra[]; text: { prose: string; fields: Partial<Record<EditableField, string>> }; setText: (t: { prose: string; fields: Partial<Record<EditableField, string>> }) => void;
  readOnly: boolean; dirty: boolean; onSave: (overwrite?: boolean) => Promise<Result & { conflict?: boolean }>; switcher: React.ReactNode; hint?: React.ReactNode;
}) {
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [busy, start] = useTransition();
  const save = (overwrite = false) => {
    setError(null);
    start(async () => { const result = await onSave(overwrite); if (!result.ok) setError({ message: result.error, conflict: !!result.conflict }); });
  };
  const field = (extra: Extra) => (
    <label key={extra.key} className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-ink-2">{extra.label}</span>
      {extra.multiline
        ? <textarea aria-label={extra.label} value={text.fields[extra.key] ?? ""} readOnly={readOnly} onChange={(e) => setText({ ...text, fields: { ...text.fields, [extra.key]: e.target.value } })} rows={3} className={textArea} />
        : <Input aria-label={extra.label} value={text.fields[extra.key] ?? ""} readOnly={readOnly} onChange={(e) => setText({ ...text, fields: { ...text.fields, [extra.key]: e.target.value } })} />}
    </label>
  );
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">{switcher}</div>
      {extras.filter((x) => x.first).map(field)}
      <label className="block min-w-0">
        <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
        <textarea aria-label={label} value={text.prose} readOnly={readOnly} onChange={(e) => setText({ ...text, prose: e.target.value })}
          rows={Math.min(24, Math.max(6, text.prose.split("\n").length + 2))} className={textArea} />
      </label>
      {hint}
      {extras.filter((x) => !x.first).map(field)}
      {!readOnly && <Button size="sm" variant="outline" onClick={() => save()} disabled={busy || !dirty}>Save text</Button>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-strong">
          <span>{error.message}</span>
          {error.conflict && <Button size="sm" onClick={() => save(true)} disabled={busy}>Save mine over it</Button>}
        </div>
      )}
    </div>
  );
}
