// Pure helpers for the Content review screen: version selection, part state, filtering and the overview
// numbers. No React, no database, so every rule here is unit tested.
import type { EditableField, PartStatus, ReviewChannel, Role } from "./season";
import { REVIEW_CHANNELS, ROLES } from "./season";
import type { NewsletterExport } from "./newsletter-card";
import { PIPELINES, isFormat } from "./pipelines";
import { pipelineView, type FinalState, type PipelineView, type StageRow, type ThirdParty } from "./pipeline-state";
import type { Stage } from "./pipelines";
import { initialPartState, partKey, type PartState } from "./review-state";
import { parseFixNote, videoBase } from "./approve-note";

export type FeedbackItem = {
  id: string; asset_id: string; channel: string | null; body: string; created_at: string;
  resolved_at: string | null; resolution: string; revision: number | null;
  /** "john" (default), "agent", or "third_party:<who>" for a note left from a review link (/shared). */
  author?: string | null;
};
export type AssetVersion = {
  revision: number; label: string; createdAt: string; src: string | null; poster: string | null;
  prose: string; fields: Partial<Record<EditableField, string>>;
  /** The stage these bytes were made at, the agent's "what changed", and the version's own description. */
  stage?: string | null; changes?: string;
  meta?: { label?: string; review_points?: Array<{ t: number; label: string }>; inputs?: Record<string, string> };
};
export type PieceAsset = {
  id: string; title: string; kind: "video" | "image" | "copy"; revision: number; source: string;
  src: string | null; poster: string | null; ratio: number; prose: string; fields: Partial<Record<EditableField, string>>;
  status: "approved" | "pending" | "rejected"; feedback: FeedbackItem[]; versions: AssetVersion[];
  /** Pipeline stage (gtm_story_assets.stage); null or "final" is final. A rough cut is approved as a stage, never scheduled. */
  stage?: string | null;
  /** The bytes on screen, sent with a decision so a stale page is refused. */
  sha256?: string;
  /** The pipeline's own version label (metadata.label, e.g. v4). */
  label?: string | null;
};
export type CardData = {
  channel: ReviewChannel; copy: PieceAsset; media: PieceAsset[]; textStatus: PartStatus; assetStatus: PartStatus;
  /** A newsletter card: what "Copy for Substack" pastes and where John pastes it. Published by hand, never scheduled. */
  substack?: NewsletterExport;
  /** Newsletter images the essay does not name: shown as options, never decided (`assetStatus` leaves them out). */
  alternatives?: string[];
};
/** The media a card's asset decision covers: every file, less a newsletter's alternative images. */
export const decidedMedia = (card: Pick<CardData, "media" | "alternatives">): PieceAsset[] =>
  card.alternatives?.length ? card.media.filter((m) => !card.alternatives!.includes(m.id)) : card.media;
/** A card for a Zernio platform (LinkedIn, Instagram, YouTube): shared text, shared media, scheduled on approval. */
export type PlatformCard = CardData & { channel: Role };
export const isPlatformCard = (card: CardData): card is PlatformCard => card.channel !== "newsletter";

/**
 * The id of a card's parts. A platform has one card per piece, so its channel names it; a Story can carry two newsletter
 * essays (the personal Substack and Regenera), so a newsletter card is named by its essay.
 */
export const cardSlot = (card: Pick<CardData, "channel" | "copy">): string => (card.channel === "newsletter" ? `newsletter:${card.copy.id}` : card.channel);
/** Pending third-party approval (gtm_stories.held_at): approval never schedules a held piece. */
export type StoryHold = { who: string; note: string; heldAt: string | null; kind?: "hold" | "third_party"; finalStaged?: boolean };

export type PieceData = {
  storyId: string; slot: string; name: string; pillar: string | null; date: string | null; cards: CardData[];
  /** Every active calendar leg has been scheduled or published; skipped platforms are intentional. */
  scheduled?: boolean;
  hold?: StoryHold | null;
  /** The earliest non-final stage of the piece's media (e.g. "rough-cut"); null when everything is final. */
  stage?: string | null;
  /** The piece's pipeline and progress (gtm_stories.pipeline, gtm_story_stages); absent or null for a legacy Story. */
  pipeline?: StagePiece | null;
  /** Media grouped by the platforms that post it: one file on several platforms is one group, approved once. */
  groups?: MediaGroup[];
  /** The media staged at the current stage when it is reviewed in /content before the final (a rough cut). */
  stageAssets?: PieceAsset[];
  /** John's stage decisions, each bound to the bytes he looked at (for "what changed since your approval"). */
  decisions?: Array<{ stage: string; decision: string; assets: Array<{ asset_id: string; sha256: string; revision?: number }>; decided_at: string }>;
  /** Set by filterPieces under a status, platform or search filter: the cards (cardSlot) that matched, so the page opens
   *  the one that explains why the piece is listed instead of whatever tab comes first. */
  matched?: string[];
};

export type MediaGroup = {
  /** The platforms that post these files, sorted and joined: "instagram+youtube". */
  key: string; channels: Role[]; assets: PieceAsset[]; status: PartStatus;
};

/** Groups each card's media by the set of platforms that post it. A file's status is approved only on every platform. */
export function buildGroups(cards: CardData[]): MediaGroup[] {
  const byAsset = new Map<string, { asset: PieceAsset; channels: Role[]; statuses: string[]; notes: Map<string, FeedbackItem> }>();
  // Newsletter images are reviewed on the newsletter card; they are never platform media.
  for (const card of cards.filter(isPlatformCard)) {
    for (const m of card.media) {
      const e = byAsset.get(m.id) ?? { asset: m, channels: [] as Role[], statuses: [] as string[], notes: new Map<string, FeedbackItem>() };
      e.channels.push(card.channel);
      e.statuses.push(m.status);
      for (const n of m.feedback) e.notes.set(n.id, n);
      byAsset.set(m.id, e);
    }
  }
  const groups = new Map<string, MediaGroup & { statuses: string[] }>();
  for (const e of byAsset.values()) {
    const channels = ROLES.filter((r) => e.channels.includes(r));
    const key = channels.join("+");
    const g = groups.get(key) ?? { key, channels, assets: [], status: "pending" as PartStatus, statuses: [] };
    g.assets.push({ ...e.asset, feedback: [...e.notes.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)) });
    g.statuses.push(...e.statuses);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ statuses, ...g }) => ({
    ...g, assets: g.assets.sort((a, b) => a.id.localeCompare(b.id)),
    status: statuses.some((x) => x === "rejected") ? "rejected" : statuses.every((x) => x === "approved") ? "approved" : "pending",
  }));
}

/**
 * The groups that hold formats of the same video as `group` (itself first): the 4:5 cut LinkedIn posts and the 9:16 cuts
 * Instagram and YouTube post are one video to John (2026-10-13). A note or a decision on any of them covers all of them,
 * unless he ticks "Only this format". A group with no video, or a video named another way, stands alone.
 */
export function mediaFamily(groups: MediaGroup[], group: MediaGroup): MediaGroup[] {
  const bases = (g: MediaGroup) => new Set(g.assets.map(videoBase).filter((b): b is string => !!b));
  const mine = bases(group);
  if (!mine.size) return [group];
  return [group, ...groups.filter((g) => g.key !== group.key && [...bases(g)].some((b) => mine.has(b)))];
}

/** One decision across a family of groups: every file, every platform, and the bytes on screen for each file. */
export function familyTarget(family: MediaGroup[]) {
  const assets = family.flatMap((g) => g.assets);
  return {
    assetIds: [...new Set(assets.map((a) => a.id))],
    channels: ROLES.filter((r) => family.some((g) => g.channels.includes(r))),
    expected: assets.map((a) => ({ asset_id: a.id, sha256: a.sha256 ?? "", revision: a.revision })),
  };
}

/**
 * What the piece's media column reviews now. Before the final it is the stage (a rough cut), or a line
 * saying who has it (agent work has nothing to look at).
 * At the final, and for a Story without a pipeline, it is the media itself, approved once across platforms.
 */
export type ReviewMode =
  | { kind: "final" }
  | { kind: "stage"; stage: Stage }
  | { kind: "agent"; stage: Stage };

export function reviewMode(view: PipelineView | null, stageAssets: PieceAsset[] = []): ReviewMode {
  const c = view?.current;
  if (!view || !c || c.stage.final) return { kind: "final" };
  if (c.stage.review === "cockpit" && stageAssets.length && (c.status === "review" || c.status === "changes" || c.status === "approved")) return { kind: "stage", stage: c.stage };
  return { kind: "agent", stage: c.stage };
}

/** A stage row's status as a part status: waiting for review is pending, changes requested is rejected. */
export function stagePartStatus(status: string | undefined): PartStatus {
  return status === "approved" ? "approved" : status === "changes" ? "rejected" : "pending";
}

/** What the page knows about a piece's pipeline, enough to derive the stage view in the browser (pipelineView). */
export type StagePiece = {
  format: string; series: string | null; rows: StageRow[]; staged: string[]; final: FinalState;
  /** The pipeline's own version label of the current stage's media (metadata.label, e.g. v4). */
  label: string | null;
  thirdParty: ThirdParty | null;
};

/** The pipeline view of a piece, or null for a legacy Story without a pipeline. */
export function pieceView(piece: Pick<PieceData, "pipeline">): PipelineView | null {
  const p = piece.pipeline;
  if (!p || !isFormat(p.format)) return null;
  return pipelineView(PIPELINES[p.format], p.rows, { stagedStages: p.staged, final: p.final });
}

export type Part = "text" | "asset";

/* ------------------------------------------------------------------ versions */

/** Every version of an asset, oldest first. An asset with no version rows yet reads as a single v1. */
export function assetVersions(asset: PieceAsset): AssetVersion[] {
  if (asset.versions.length) return [...asset.versions].sort((a, b) => a.revision - b.revision);
  return [{ revision: asset.revision, label: "v1", createdAt: "", src: asset.src, poster: asset.poster, prose: asset.prose, fields: asset.fields }];
}

export type PartVersion = { revision: number; label: string; createdAt: string };

/** The versions a part can be switched between: the union over its assets (a carousel has one asset per slide). */
export function partVersions(assets: PieceAsset[]): PartVersion[] {
  const byRevision = new Map<number, PartVersion>();
  for (const asset of assets) {
    for (const v of assetVersions(asset)) {
      if (!byRevision.has(v.revision)) byRevision.set(v.revision, { revision: v.revision, label: v.label, createdAt: v.createdAt });
    }
  }
  return [...byRevision.values()].sort((a, b) => a.revision - b.revision);
}

/** The latest version, which is the only one that can be approved. */
export const latestVersion = (versions: PartVersion[]): PartVersion | undefined => versions[versions.length - 1];

/** The content an asset showed at a revision: the newest version at or before it (or the oldest if none is). */
export function versionAt(asset: PieceAsset, revision: number): AssetVersion {
  const all = assetVersions(asset);
  let picked = all[0];
  for (const v of all) if (v.revision <= revision) picked = v;
  return picked;
}

/** The newest content of a copy file, counting the versions saved in this session (its part state's addedVersions). */
export function latestText(copy: PieceAsset, state?: Pick<PartState, "addedVersions">): AssetVersion {
  return versionAt({ ...copy, versions: [...assetVersions(copy), ...(state?.addedVersions ?? [])] }, Infinity);
}

/** The field each platform edits next to the shared text (LinkedIn's first comment, YouTube's title). */
export const EXTRA_FIELD: Partial<Record<ReviewChannel, EditableField>> = { linkedin: "first_comment", youtube: "youtube_title" };

export type SharedTextValue = { prose: string; fields: Partial<Record<EditableField, string>> };

/**
 * What the one-text editor holds when nothing is unsaved: the primary card's latest prose, and each platform's field
 * from that platform's own copy file as saved now. Every file is read through its live part state, never the page's
 * props alone: those are not refreshed after a save, so a saved YouTube title read from them stayed "unsaved" forever
 * (s1-08, example-reference-38, 2026-10-16: "Edited. Approve again." with Approve blocked on "Save first.").
 */
export function sharedTextBaseline(storyId: string, cards: CardData[], primary: CardData, primaryLatest: AssetVersion, states: Record<string, PartState | undefined>): SharedTextValue {
  const fields: Partial<Record<EditableField, string>> = {};
  for (const c of cards) {
    const key = EXTRA_FIELD[c.channel];
    if (!key) continue;
    const latest = c === primary ? primaryLatest : latestText(c.copy, states[partKey("text", storyId, c.channel)]);
    fields[key] = latest.fields[key] ?? "";
  }
  return { prose: primaryLatest.prose, fields };
}

/** True when the editor holds text or a field that differs from the baseline. */
export function sharedTextDirty(text: SharedTextValue, baseline: SharedTextValue): boolean {
  if (text.prose !== baseline.prose) return true;
  return (Object.keys(baseline.fields) as EditableField[]).some((k) => (text.fields[k] ?? "") !== (baseline.fields[k] ?? ""));
}

/** Label for the next version, mirroring the database trigger: v1, then v1.1, v1.2 ... */
export const nextLabel = (versions: { label: string }[]): string => (versions.length === 0 ? "v1" : `v1.${versions.length}`);

export const labelForRevision = (versions: PartVersion[], revision: number | null): string | null =>
  revision == null ? null : versions.find((v) => v.revision === revision)?.label ?? null;

/* --------------------------------------------------------------------- notes */

export const openNotes = (notes: FeedbackItem[]) => notes.filter((n) => !n.resolved_at);
export const resolvedNotes = (notes: FeedbackItem[]) => notes.filter((n) => n.resolved_at);

/* ---------------------------------------------------------------- part state */

/**
 * What the owner sees for one part of one platform card.
 * - approved: approved for the current version
 * - changes: sent back, waiting on the agent
 * - new: the agent answered a note with a newer version and it is waiting for review
 * - pending: nothing decided yet
 */
export type PartUi = "approved" | "changes" | "new" | "pending" | "fixing" | "none";

export function partUi(status: PartStatus, latest: PartVersion | undefined, notes: FeedbackItem[]): PartUi {
  if (status === "none") return "none";
  // Sent back wins over an open fix: "Request changes instead" on a part waiting for its fix takes effect (#143 F3).
  if (status === "rejected") return "changes";
  if (notes.some((n) => !n.resolved_at && parseFixNote(n.body))) return "fixing";
  if (status === "approved") return "approved";
  const newer = latest && latest.revision > 1 && notes.some((n) => n.resolved_at && (n.revision ?? 0) < latest.revision);
  return newer ? "new" : "pending";
}

export const UI_LABEL: Record<Exclude<PartUi, "none">, string> = {
  fixing: "Waiting for fix", approved: "Approved", pending: "Needs approval", changes: "Needs changes", new: "New version to review",
};

/* ------------------------------------------------------------------ filtering */

export const STATUS_FILTERS = ["needs-approval", "needs-changes", "new-version", "waiting-fix", "approved"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  "waiting-fix": "Waiting for fix", "needs-approval": "Needs approval", "needs-changes": "Needs changes", "new-version": "New version", approved: "Approved",
};
const FILTER_UI: Record<StatusFilter, PartUi> = { "waiting-fix": "fixing", "needs-approval": "pending", "needs-changes": "changes", "new-version": "new", approved: "approved" };

/** series: gtm_stories.series; stage: the piece's current stage key ("final" once at the final); focus: one piece at a time. */
export type Filters = { q: string; platform: ReviewChannel | ""; status: StatusFilter | ""; pillar: string; piece: string; series: string; stage: string; focus: boolean };
export const NO_FILTERS: Filters = { q: "", platform: "", status: "", pillar: "", piece: "", series: "", stage: "", focus: false };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Reads the query string into filters. Unknown values are dropped, so a stale link still opens the page. */
export function parseFilters(params: Params): Filters {
  const platform = one(params.platform);
  const status = one(params.status);
  return {
    q: one(params.q).trim().slice(0, 200),
    platform: (REVIEW_CHANNELS as string[]).includes(platform) ? (platform as ReviewChannel) : "",
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : "",
    pillar: one(params.pillar).trim().slice(0, 40),
    piece: one(params.piece).trim().slice(0, 120),
    series: /^[a-z0-9][a-z0-9-]{0,79}$/.test(one(params.series)) ? one(params.series) : "",
    stage: /^[a-z][a-z0-9-]{0,39}$/.test(one(params.stage)) ? one(params.stage) : "",
    focus: one(params.focus) === "1",
  };
}

export function filtersToQuery(f: Filters): string {
  const p = new URLSearchParams();
  for (const key of ["q", "platform", "status", "pillar", "piece", "series", "stage"] as const) if (f[key]) p.set(key, f[key]);
  if (f.focus) p.set("focus", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Filters that sit in the disclosure panel (the search box is always visible). */
export const activeFilterCount = (f: Filters) => (["platform", "status", "pillar", "piece", "series", "stage"] as const).filter((k) => f[k]).length;
export const hasFilters = (f: Filters) => !!f.q || activeFilterCount(f) > 0;

export type CardUi = { text: PartUi; asset: PartUi };

/** Part states of a card as the server saw them. */
export function cardUi(card: CardData): CardUi {
  const textNotes = card.copy.feedback;
  const media = decidedMedia(card);
  const assetNotes = media.flatMap((m) => m.feedback);
  return {
    text: partUi(card.textStatus, latestVersion(partVersions([card.copy])), textNotes),
    asset: partUi(card.assetStatus, latestVersion(partVersions(media)), assetNotes),
  };
}

/**
 * A card matches a status when any of its parts is in it; "approved" needs every part that exists approved. "Needs
 * approval" is everything waiting on John, so it takes a part showing a new version too: a restage after a note makes
 * the part "new", and without this the filter was empty while 28 cards waited (John, 2026-10-15).
 */
export function matchesStatus(ui: CardUi, status: StatusFilter): boolean {
  const parts = [ui.text, ui.asset].filter((p) => p !== "none");
  if (!parts.length) return false;
  const want = FILTER_UI[status];
  if (want === "approved") return parts.every((p) => p === "approved");
  return parts.some((p) => p === want || (status === "needs-approval" && p === "new"));
}

function haystack(piece: PieceData, card: CardData): string {
  const notes = [card.copy, ...card.media].flatMap((a) => a.feedback.map((n) => n.body));
  return [piece.name, piece.slot, piece.pillar ?? "", card.channel, card.copy.prose, ...Object.values(card.copy.fields), ...notes].join("\n").toLowerCase();
}

/** Pieces and cards matching every filter. A piece stays only if one of its cards matches. Order is kept. */
export function filterPieces(pieces: PieceData[], f: Filters): PieceData[] {
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out: PieceData[] = [];
  for (const piece of pieces) {
    if (f.piece && piece.storyId !== f.piece) continue;
    if (f.series && piece.pipeline?.series !== f.series) continue;
    if (f.stage && pieceStageKey(piece) !== f.stage) continue;
    if (f.pillar && piece.pillar !== f.pillar) continue;
    const cards = piece.cards.filter((card) => {
      if (f.platform && card.channel !== f.platform) return false;
      if (f.status && !matchesStatus(cardUi(card), f.status)) return false;
      if (terms.length) {
        const text = haystack(piece, card);
        if (!terms.every((t) => text.includes(t))) return false;
      }
      return true;
    });
    // One text for every platform (2026-10-16): a piece that matches on any platform shows all of them, so the shared
    // text is never edited for some platforms and left stale on the others. The matching cards are named, so the page
    // opens the one the filter found (a pending Substack essay under an approved LinkedIn tab, kb-tokenmaxxing 2026-10-17).
    if (cards.length) out.push(f.status || f.platform || terms.length ? { ...piece, matched: cards.map(cardSlot) } : piece);
  }
  return out;
}

/* -------------------------------------------------------------- open parts */

/**
 * A card's part states from the live part states (what the page shows after a click), shaped like `cardUi` so the same
 * `matchesStatus` the server filter uses decides it. A platform's media is the groups that post on it.
 */
export function liveCardUi(card: CardData, storyId: string, groups: MediaGroup[], states: Record<string, PartState | undefined>, baseline: Record<string, PartState | undefined> = states): CardUi {
  const merge = (keys: string[], from = states): { status: PartStatus; notes: FeedbackItem[] } | undefined => {
    const parts = keys.map((k) => from[k]).filter((x): x is PartState => !!x);
    if (!parts.length) return undefined;
    const status: PartStatus = parts.every((x) => x.status === "none") ? "none" : parts.some((x) => x.status === "rejected") ? "rejected" : parts.every((x) => x.status === "approved") ? "approved" : "pending";
    return { status, notes: [...new Map(parts.flatMap((x) => x.notes).map((n) => [n.id, n])).values()] };
  };
  // A part keeps what the server saw until a click on the page changes it (media short of the final has no live state,
  // and the server and page derive a group's status separately, so only a change since load counts).
  const server = cardUi(card);
  const sig = (st: ReturnType<typeof merge>) => (st ? `${st.status}|${st.notes.map((n) => `${n.id}${n.resolved_at ? "r" : ""}`).join(",")}` : "");
  const ui = (keys: string[], assets: PieceAsset[], fallback: PartUi): PartUi => {
    const live = merge(keys);
    return live && sig(live) !== sig(merge(keys, baseline)) ? partUi(live.status, latestVersion(partVersions(assets)), live.notes) : fallback;
  };
  const slot = cardSlot(card);
  const mediaKeys = isPlatformCard(card) ? groups.filter((g) => g.channels.includes(card.channel)).map((g) => partKey("media", storyId, g.key)) : [partKey("media", storyId, slot)];
  const media = decidedMedia(card);
  return { text: ui([partKey("text", storyId, slot)], [card.copy], server.text), asset: media.length ? ui(mediaKeys, media, server.asset) : "none" };
}

/** Whether a piece still belongs under a status (and platform) filter once the live part states are in. */
export function stillMatchesFilter(piece: Pick<PieceData, "storyId" | "cards">, groups: MediaGroup[], states: Record<string, PartState | undefined>, baseline: Record<string, PartState | undefined>, status: StatusFilter | "", platform: ReviewChannel | ""): boolean {
  if (!status) return true;
  return piece.cards.filter((c) => !platform || c.channel === platform).some((c) => matchesStatus(liveCardUi(c, piece.storyId, groups, states, baseline), status));
}

const CHANNEL_NAME: Record<ReviewChannel, string> = { linkedin: "LinkedIn", instagram: "Instagram", youtube: "YouTube", newsletter: "Substack" };
const joinNames = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** What is still open on a piece, by who has it, in John's words: "Substack essay", "LinkedIn and YouTube video". */
export type OpenParts = { john: string[]; fixing: string[]; changes: string[] };

/**
 * The open parts of a piece from the live part states (so the badge follows a click on the page). John has a part that
 * needs approval or shows a new version; the agent has one waiting for a fix (approved with a note) or sent back.
 * Before the final only the stage on screen counts; newsletter cards always count (they are never staged).
 */
export function openParts(piece: Pick<PieceData, "storyId" | "cards" | "groups" | "pipeline" | "stageAssets">, states: Record<string, PartState | undefined>): OpenParts {
  const out: OpenParts = { john: [], fixing: [], changes: [] };
  const add = (name: string, ui: PartUi) => {
    if (ui === "pending" || ui === "new") out.john.push(name);
    else if (ui === "fixing") out.fixing.push(name);
    else if (ui === "changes") out.changes.push(name);
  };
  const uiOf = (key: string, assets: PieceAsset[]) => { const st = states[key]; return st ? partUi(st.status, latestVersion(partVersions(assets)), st.notes) : "none" as PartUi; };
  const mode = reviewMode(pieceView(piece), piece.stageAssets);
  const platforms = piece.cards.filter(isPlatformCard);
  if (mode.kind === "stage") add(mode.stage.label, uiOf(partKey("stage", piece.storyId, mode.stage.key), piece.stageAssets ?? []));
  // One text for every platform: the platforms whose text is in the same state read as one part.
  const texts = new Map<PartUi, Role[]>();
  for (const c of platforms) { const ui = uiOf(partKey("text", piece.storyId, c.channel), [c.copy]); texts.set(ui, [...(texts.get(ui) ?? []), c.channel]); }
  for (const [ui, channels] of texts) add(`${joinNames(channels.map((c) => CHANNEL_NAME[c]))} text`, ui);
  if (mode.kind === "final") {
    for (const g of piece.groups ?? buildGroups(piece.cards)) {
      const what = g.assets.some((a) => a.kind === "video") ? "video" : g.assets.length > 1 ? "images" : "image";
      add(`${joinNames(g.channels.map((c) => CHANNEL_NAME[c]))} ${what}`, uiOf(partKey("media", piece.storyId, g.key), g.assets));
    }
  }
  for (const c of piece.cards.filter((x) => !isPlatformCard(x))) {
    add("Substack essay", uiOf(partKey("text", piece.storyId, cardSlot(c)), [c.copy]));
    const media = decidedMedia(c);
    if (media.length) add(media.length > 1 ? "Substack images" : "Substack image", uiOf(partKey("media", piece.storyId, cardSlot(c)), media));
    // An image the essay names that is not staged is the agent's to fix: the paste would leave it out (review #143 F2).
    for (const file of c.substack?.data.missing ?? []) out.changes.push(`Substack image ${file} (not staged)`);
    // Options are never decided, but a note John left on them (approved with a note: "use #1") is still the agent's work.
    const options = c.media.filter((m) => !media.includes(m));
    if (options.some((m) => m.feedback.some((n) => !n.resolved_at && parseFixNote(n.body)))) out.fixing.push("Substack header options");
  }
  return out;
}

/* ------------------------------------------------------------------ overview */

/**
 * One platform card of the season, for the overview. `assetStatus` counts the final only: a piece whose media is short
 * of final reads pending here, so a rough-cut approval never looks like progress toward publishing. `textKey` and
 * `mediaKeys` name the live parts on screen that override it.
 */
export type SummaryCard = { key: string; storyId: string; textStatus: PartStatus; assetStatus: PartStatus; openNotes: number; textKey?: string; mediaKeys?: string[] };
/** A stage waiting on John before the final ("Rough cut"), for the overview's "by stage" line. */
export type SummaryStage = { key: string; storyId: string; label: string; status: PartStatus };
export type Overview = {
  pieces: number; cards: number; textApproved: number; textTotal: number; assetApproved: number; assetTotal: number;
  openNotes: number; needsChanges: number; percent: number;
  /** Stage reviews waiting on John, by stage: [{ label: "Rough cut", n: 3 }]. */
  byStage: Array<{ label: string; n: number }>;
};

export const cardKey = (storyId: string, channel: string) => `${storyId}:${channel}`;

export function summarize(cards: SummaryCard[], stages: SummaryStage[] = []): Overview {
  const text = cards.filter((c) => c.textStatus !== "none");
  const asset = cards.filter((c) => c.assetStatus !== "none");
  const textApproved = text.filter((c) => c.textStatus === "approved").length;
  const assetApproved = asset.filter((c) => c.assetStatus === "approved").length;
  const total = text.length + asset.length;
  return {
    pieces: new Set(cards.map((c) => c.storyId)).size,
    cards: cards.length,
    textApproved, textTotal: text.length, assetApproved, assetTotal: asset.length,
    openNotes: cards.reduce((n, c) => n + c.openNotes, 0),
    needsChanges: text.filter((c) => c.textStatus === "rejected").length + asset.filter((c) => c.assetStatus === "rejected").length,
    percent: total ? Math.round(((textApproved + assetApproved) / total) * 100) : 0,
    byStage: [...stages.filter((s) => s.status !== "approved").reduce((m, s) => m.set(s.label, (m.get(s.label) ?? 0) + 1), new Map<string, number>())].map(([label, n]) => ({ label, n })),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string, withYear: boolean) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
};

/** "Oct 13 to Dec 3" from ISO dates; the year appears only when the range crosses years. */
export function dateRange(dates: (string | null)[]): string | null {
  const valid = dates.filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!valid.length) return null;
  const first = valid[0], last = valid[valid.length - 1];
  const crosses = first.slice(0, 4) !== last.slice(0, 4);
  return first === last ? short(first, false) : `${short(first, crosses)} to ${short(last, crosses)}`;
}

/* --------------------------------------------------------------------- parts */

/** Initial part states, overview rows and stage rows for the pieces on screen (the page and the dev fixture share this). */
export function pieceParts(pieces: PieceData[]): { initial: Record<string, PartState>; summary: SummaryCard[]; stages: SummaryStage[] } {
  const initial: Record<string, PartState> = {};
  const summary: SummaryCard[] = [];
  const stages: SummaryStage[] = [];
  for (const p of pieces) {
    const view = pieceView(p);
    const mode = reviewMode(view, p.stageAssets);
    const groups = p.groups ?? buildGroups(p.cards);
    if (mode.kind === "final") {
      for (const g of groups) {
        initial[partKey("media", p.storyId, g.key)] = initialPartState({ status: g.status, notes: g.assets.flatMap((a) => a.feedback).sort(byDate) });
      }
    }
    if (mode.kind === "stage") {
      const row = p.pipeline?.rows.find((r) => r.stage === mode.stage.key);
      const key = partKey("stage", p.storyId, mode.stage.key);
      const notes = (p.stageAssets ?? []).flatMap((a) => a.feedback).sort(byDate);
      initial[key] = initialPartState({ status: stagePartStatus(row?.status), notes });
      stages.push({ key, storyId: p.storyId, label: mode.stage.label, status: stagePartStatus(row?.status) });
    }
    for (const c of p.cards) {
      const textKey = partKey("text", p.storyId, cardSlot(c));
      initial[textKey] = initialPartState({ status: c.textStatus, notes: c.copy.feedback, revision: c.copy.revision });
      if (!isPlatformCard(c)) {
        // A newsletter's images are decided on its own card, whatever stage the piece's social media is at. Alternative
        // images (the essay does not name them) are shown but never decided, so they are neither a part nor counted.
        const mediaKey = partKey("media", p.storyId, cardSlot(c));
        const decided = decidedMedia(c);
        if (decided.length) initial[mediaKey] = initialPartState({ status: c.assetStatus, notes: decided.flatMap((m) => m.feedback).sort(byDate) });
        summary.push({
          key: cardKey(p.storyId, cardSlot(c)), storyId: p.storyId, textStatus: c.textStatus, assetStatus: decided.length ? c.assetStatus : "none",
          openNotes: [c.copy, ...decided].reduce((n, a) => n + a.feedback.filter((f) => !f.resolved_at).length, 0),
          textKey, mediaKeys: decided.length ? [mediaKey] : [],
        });
        continue;
      }
      summary.push({
        key: cardKey(p.storyId, c.channel), storyId: p.storyId, textStatus: c.textStatus,
        // Only the final counts: media short of final reads pending, whatever was approved at an earlier stage.
        assetStatus: mode.kind === "final" ? c.assetStatus : c.media.length ? "pending" : "none",
        openNotes: [c.copy, ...c.media].reduce((n, a) => n + a.feedback.filter((f) => !f.resolved_at).length, 0),
        textKey, mediaKeys: mode.kind === "final" ? groups.filter((g) => g.channels.includes(c.channel)).map((g) => partKey("media", p.storyId, g.key)) : [],
      });
    }
  }
  return { initial, summary, stages };
}

const byDate = (x: FeedbackItem, y: FeedbackItem) => x.created_at.localeCompare(y.created_at);

/** A combined status over several parts: changes if any, approved if all, else pending. */
export function combineStatus(statuses: PartStatus[]): PartStatus {
  const real = statuses.filter((s) => s !== "none");
  if (!real.length) return "none";
  return real.some((s) => s === "rejected") ? "rejected" : real.every((s) => s === "approved") ? "approved" : "pending";
}

/** The stage a piece is at for the stage filter: its current stage key, "final" at the final, "approved" when done. */
export function pieceStageKey(piece: Pick<PieceData, "pipeline">): string {
  const view = pieceView(piece);
  if (!view) return "final";
  return view.current?.stage.key ?? "approved";
}

/** The series and stages present in a season, for the toolbar's two selects. */
export function seriesOptions(pieces: PieceData[]) {
  const series = [...new Set(pieces.map((p) => p.pipeline?.series).filter((s): s is string => !!s))].sort();
  const stages = new Map<string, string>();
  for (const p of pieces) {
    const key = pieceStageKey(p);
    const f = p.pipeline?.format;
    const label = key === "approved" ? "Final approved" : (isFormat(f) ? PIPELINES[f].stages.find((s) => s.key === key)?.label : undefined) ?? (key === "final" ? "Final" : key);
    stages.set(key, label);
  }
  return { series, stages: [...stages].map(([key, label]) => ({ key, label })) };
}
