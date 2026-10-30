// Per-format content pipelines (John, 2026-10-12). Each format (a podcast short, a carousel, a text post, a long-form
// episode, a branded video) moves through stages; some stages wait on John, the rest are agent work. Definitions are
// code, imported (never read from disk, see auto-schedule.ts), so the gate logic is reviewed, tested and versioned with
// the code that enforces it. Progress lives in the database (gtm_story_stages, gtm_story_stage_decisions).
//
// The rules John set:
// - Only the final stage schedules. An approval at any earlier stage never reaches Zernio.
// - /content shows only what goes out to the world: rough cuts and finals of the actual posts. There are no plan or
//   storyboard gates (John, 2026-10-28: "I just want to see the first draft"): the agent builds the whole draft and John
//   reviews it in /content. A decision John gave elsewhere can still be recorded with
//   `gtm story progress <id> <stage> approved --note "John approved in the terminal"`.
// - A third party (example_approver) sees the final only. Their sign-off blocks publishing, never a version.
// - Motion.so credit spend is capped per piece in the vibrana-motion skill; there is no approval step for it.

export type Gate = "none" | "john";
/** Where a gated stage is reviewed: in /content (a post: a rough cut, a final). */
export type ReviewIn = "cockpit" | "none";
/** The cockpit surface a gate is reviewed on: /content holds what goes out to the world. */
export type Surface = "content";
export const surfaceOf = (s: Pick<Stage, "review">): Surface | null => (s.review === "cockpit" ? "content" : null);
export type Format = "short" | "carousel" | "text" | "episode" | "video";
export type Feature = "broll" | "motion";

export type Stage = {
  key: string;
  label: string;
  /** The skill or agent that does the work. */
  owner: string;
  /** What happens at this stage, in a sentence (the stepper's tooltip). */
  does: string;
  gate: Gate;
  review: ReviewIn;
  /** What this stage puts into the piece; the stages after the current one give the "no X" badges. */
  adds?: Feature[];
  /** Shown on the gate, so John knows the approval authorizes spend. Only on a John gate. */
  spends?: string;
  /** A stage that is skipped unless a piece asks for it. */
  optional?: true;
  /** Agent-only steps that fold into one stepper node. */
  group?: string;
  /** Exactly one per pipeline, the last: only a final approval schedules. */
  final?: true;
  /** The approve button and the line under it. */
  approve?: { verb: string; consequence: string };
};

export type Pipeline = { format: Format; label: string; stages: readonly Stage[] };

export const FINAL = "final";
/** Stage keys, matching the database check on gtm_story_assets.stage. */
export const STAGE_KEY = /^[a-z][a-z0-9-]{0,39}$/;
export const FEATURE_LABEL: Record<Feature, string> = { broll: "B-roll", motion: "Motion" };

const final = (does: string): Stage => ({
  key: FINAL, label: "Final", owner: "content-engine", does, gate: "john", review: "cockpit", final: true,
  approve: { verb: "Approve final", consequence: "Schedules into the next open slot once the platform's text is approved" },
});

export const PIPELINES: Record<Format, Pipeline> = {
  short: {
    format: "short", label: "Short",
    stages: [
      { key: "paper-edit", label: "Paper edit", owner: "vibrana-podcast-clips", gate: "none", review: "none",
        does: "Transcript cut: what is said and in what order (keep.json, cut.py). The agent decides; John sees it as the rough cut." },
      { key: "rough-cut", label: "Rough cut", owner: "vibrana-podcast-clips", gate: "john", review: "cockpit",
        does: "Reframe, raw-track audio, captions, end card, music and loudness.",
        approve: { verb: "Approve rough cut", consequence: "Locks the edit. Nothing is scheduled; next are B-roll and Motion" } },
      { key: "broll", label: "B-roll", owner: "vibrana-podcast-clips", gate: "none", review: "none", adds: ["broll"], does: "B-roll inserts." },
      { key: "motion", label: "Motion", owner: "vibrana-motion", gate: "none", review: "none", adds: ["motion"], does: "Motion graphics (one create per clip)." },
      { key: "finish", label: "Finish", owner: "vibrana-podcast-clips", gate: "none", review: "none", does: "finish.py and assemble.sh: the per-platform exports." },
      { key: "packaging", label: "Packaging", owner: "content-packaging", gate: "none", review: "none", does: "Confirm the brief against the locked cut; render brand/theme covers and platform copy; validate provenance before final staging." },
      final("The export, per platform, with its captions."),
    ],
  },
  carousel: {
    format: "carousel", label: "Carousel",
    stages: [
      { key: "copy", label: "Copy checks", owner: "content-engine", gate: "none", review: "none", does: "Copy suite, persona-review and gtm check (automated)." },
      final("Rendered slides plus the caption."),
    ],
  },
  text: {
    format: "text", label: "Text post",
    stages: [
      { key: "draft", label: "Draft checks", owner: "vibrana-writers-room", gate: "none", review: "none", does: "Writers room draft, copy suite and gtm check (automated)." },
      final("The post as it goes out."),
    ],
  },
  episode: {
    format: "episode", label: "Episode",
    stages: [
      { key: "ingest", label: "Ingest", owner: "vibrana-podcast-episode", gate: "none", review: "none", does: "Research and transcript." },
      { key: "paper-edit", label: "Paper edit", owner: "vibrana-podcast-episode", gate: "none", review: "none",
        does: "The paper edit and the seams reel. The agent decides; John sees the result in the review copy." },
      { key: "audio", label: "Audio", owner: "vibrana-podcast-episode", gate: "none", review: "none", group: "Assembly", does: "Dialogue edit and mix." },
      { key: "picture", label: "Picture", owner: "vibrana-podcast-episode", gate: "none", review: "none", group: "Assembly", does: "Picture edit." },
      { key: "broll", label: "B-roll", owner: "vibrana-podcast-episode", gate: "none", review: "none", group: "Assembly", adds: ["broll"], does: "B-roll inserts." },
      { key: "review-copy", label: "Review copy", owner: "vibrana-podcast-episode", gate: "john", review: "cockpit",
        does: "Gate 2: the review copy with the cold-open variants, bed or no bed, sting and outro. John picks one per slot.",
        approve: { verb: "Approve review copy", consequence: "Locks the cut and the variants. Nothing is scheduled; next is the master" } },
      { key: "master", label: "Master", owner: "vibrana-podcast-episode", gate: "none", review: "none", group: "Master + package", does: "Master and QC." },
      { key: "package", label: "Package", owner: "content-packaging", gate: "none", review: "none", group: "Master + package", does: "Brand/theme packaging brief, titles, covers, descriptions and verified chapters. gtm packaging check before staging." },
      final("Gate 3: the master as it goes out. YouTube schedules; Spotify stays a manual step after publish."),
    ],
  },
  video: {
    format: "video", label: "Video",
    stages: [
      { key: "motion", label: "Motion", owner: "vibrana-motion", gate: "none", review: "none", adds: ["motion"], does: "Motion builds the video." },
      { key: "packaging", label: "Packaging", owner: "content-packaging", gate: "none", review: "none", does: "Render and validate registered brand/theme covers and platform copy against the finished video." },
      final("The video and its captions, per platform."),
    ],
  },
};

export const FORMATS = Object.keys(PIPELINES) as Format[];
export const isFormat = (v: unknown): v is Format => typeof v === "string" && (FORMATS as string[]).includes(v);

/** A Story without a pipeline (legacy) has one implicit stage: final. */
export const LEGACY: Pipeline = { format: "text", label: "", stages: [final("The post as it goes out.")] };

export const pipelineOf = (format: string | null | undefined): Pipeline => (isFormat(format) ? PIPELINES[format] : LEGACY);
export const stageOf = (p: Pipeline, key: string | null | undefined): Stage | undefined => p.stages.find((s) => s.key === (key ?? FINAL));
export const stageIndex = (p: Pipeline, key: string | null | undefined): number => p.stages.findIndex((s) => s.key === (key ?? FINAL));
export const finalStage = (p: Pipeline): Stage => p.stages[p.stages.length - 1];

/** Problems with a pipeline definition; empty when it is valid. Pure, unit tested for every pipeline. */
export function validatePipeline(p: Pipeline): string[] {
  const problems: string[] = [];
  const keys = p.stages.map((s) => s.key);
  if (new Set(keys).size !== keys.length) problems.push(`${p.format}: duplicate stage keys`);
  for (const s of p.stages) {
    if (!STAGE_KEY.test(s.key)) problems.push(`${p.format}/${s.key}: invalid key`);
    if (s.spends && s.gate !== "john") problems.push(`${p.format}/${s.key}: a stage that spends needs a John gate`);
    if (s.gate === "john" && s.review === "none") problems.push(`${p.format}/${s.key}: a John gate needs a place to review it`);
    if (s.gate === "none" && s.review !== "none") problems.push(`${p.format}/${s.key}: a stage with no gate has nothing to review`);
    if (s.review === "cockpit" && !s.approve) problems.push(`${p.format}/${s.key}: a cockpit gate needs approve wording`);
  }
  const finals = p.stages.filter((s) => s.final);
  if (finals.length !== 1) problems.push(`${p.format}: needs exactly one final stage`);
  else {
    if (p.stages[p.stages.length - 1] !== finals[0]) problems.push(`${p.format}: the final stage must be last`);
    if (finals[0].key !== FINAL) problems.push(`${p.format}: the final stage key must be "${FINAL}"`);
    if (finals[0].gate !== "john" || finals[0].review !== "cockpit") problems.push(`${p.format}: the final stage is John's, in the cockpit`);
  }
  return problems;
}

export const validatePipelines = (all: Pipeline[] = [...Object.values(PIPELINES), LEGACY]) => all.flatMap(validatePipeline);
