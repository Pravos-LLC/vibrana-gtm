import { loadContent } from "../../lib/content-overlay.mjs";
// The Content Guide's canonical data. content/guide/*.json is the single source for the structured
// strategy facts (pillars, dials, story types, formats, channel rules, banned words, pipeline).
// Prose rationale stays in the hub (gtm/content/STRATEGY.md, context/voice/), which points here.
// Every quoted line carries a `source` path; scripts/guide-check.mjs verifies it still appears verbatim.
const pillarsJson = loadContent("guide/pillars.json") as typeof import("../../content/sample/guide/pillars.json");
const whyJson = loadContent("guide/why.json") as typeof import("../../content/sample/guide/why.json");
const storiesJson = loadContent("guide/stories.json") as typeof import("../../content/sample/guide/stories.json");
const voiceJson = loadContent("guide/voice.json") as typeof import("../../content/sample/guide/voice.json");
const regeneraJson = loadContent("guide/regenera.json") as typeof import("../../content/sample/guide/regenera.json");
const personalJson = loadContent("guide/personal.json") as typeof import("../../content/sample/guide/personal.json");
const assetsJson = loadContent("guide/assets.json") as typeof import("../../content/sample/guide/assets.json");
const channelsJson = loadContent("guide/channels.json") as typeof import("../../content/sample/guide/channels.json");
const inspirationJson = loadContent("guide/inspiration.json") as typeof import("../../content/sample/guide/inspiration.json");
const pipelineJson = loadContent("guide/pipeline.json") as typeof import("../../content/sample/guide/pipeline.json");
const phaseJson = loadContent("guide/phase.json") as typeof import("../../content/sample/guide/phase.json");
import { signalsConfig } from "../signals/config";

export type PillarSlug = "proof" | "perspective" | "build" | "lists";

/** A line lifted from a real file. `source` is relative to ~/Projects (e.g. "vibrana/brand.example.com/brand/manifesto.md"). */
export type Quote = { text: string; source: string };

/** A real post. `media` is a key in content/guide/media.json. */
export type ExamplePost = { title: string; channel: string; hook: Quote; excerpt?: Quote; media?: string; why: string };

/** What a pillar does in the funnel: 70% reach, 20% how-we-think, 10% conversation (STRATEGY.md). */
export type FunnelRole = "reach" | "how_we_think" | "conversation";

/** The one number a pillar is judged on in the current phase (the report and the dashboard read it). */
export type LeadingMetric = { key: "conversations" | "reach" | "comments" | "saves_sends"; label: string; per: "post" };

export type Pillar = {
  slug: PillarSlug; name: string; share: number; role: string;
  funnel_role: FunnelRole; awareness_job: string; leading_metric: LeadingMetric;
  purpose: string;
  dial: { operator: number; soul: number } | null; dial_label: string; speaks_as: string; opening: string;
  /** Guidance for the human editor, who makes the final call. `notes` holds judgment calls, not rules. */
  dos: string[]; donts: string[]; notes: string[]; formats: string[]; hero_media: string;
  /** Public links this pillar may point to (always in the first comment on LinkedIn, never an Instagram caption). */
  links?: { label: string; url: string }[];
  examples: ExamplePost[];
  contrasts: { weak: string; great: Quote; why: string }[];
};

/** The thesis, quoted from the hub's context/brand.md ("Why we exist"). */
export type Why = {
  inquiries: { question: string; answer: Quote; more?: Quote }[]; inquiries_note: Quote;
  belief: Quote[]; refuse: Quote; mission: Quote; how: Quote[];
  credo: Quote[]; wall: { media: string; alt: string }[];
};

export type StoryType = {
  slug: string; name: string; pillar: PillarSlug; summary: string;
  template: string[]; example_hook: Quote; hook_pattern: string; dos: string[]; donts: string[];
  /** The evidence that would tell us this story type works. */
  signal: string;
  real_example?: { title: string; quote: Quote; media?: string };
};

/** The story types are a hypothesis; `review` is when and how it gets tested against the evidence. */
export type Review = { first_read: string; full_review: string; questions: string[]; where: string };

export type Voice = {
  voices: { slug: string; name: string; file: string; who_speaks: string; for: string; core: string[]; media?: string; image_url?: string; alt?: string }[];
  core_five: Quote[];
  before_after: { pillar: PillarSlug; label: string; before: string; after: Quote; why: string }[];
  soul_meaning: Quote;
  banned_words: string[];
  /** Words to use, set by John, so an agent never swaps them for a weaker one. */
  preferred_terms: { term: string; note: string; source: string }[];
  banned_phrases: string[];
  shared_bans: string[];
  /** Rows of the voice file's Captured edits table; that table stays canonical (the writers room appends to it). */
  captured_edits: { date: string; pattern: Quote; rule: Quote }[];
  /** Do and Don't for an editor, distilled from John's edits to agent drafts; `after` is his line, quoted from the voice file. */
  editing?: { lead: string; items: { do: string; dont: string; before: string; after: Quote }[] };
};

/** One of John's two Substacks (Regenera, the first; sample_author, the second), grounded in what engaged. */
export type Substack = {
  slug: "regenera" | "personal"; name: string; url: string; ordinal: string; summary: string; stats: string;
  /** Full dissection in the hub; this chapter carries its conclusions. */
  research: string;
  banner: { image_url: string; alt: string };
  voice_file?: string; arc: string[]; rules: string[]; key_lines: Quote[];
  differs: { title: string; items: string[] };
  what_worked: string[]; what_didnt: string[];
  visual: { dos: string[]; donts: string[] };
  essays: { title: string; status: string; source: string; url?: string; image_urls: string[] }[];
  top_posts: { title: string; url: string; image_url: string; date: string; reactions: number; comments: number; restacks: number; note: string }[];
};

export type AssetFormat = {
  slug: string; name: string; skill: string; when: string; specs: string[]; rules: string[];
  media: string[]; /** Public images (e.g. a published Substack post's) shown when there's no uploaded media. */
  image_urls?: string[]; taste_notes?: Quote[]; links?: { label: string; href: string }[]; note?: string;
};

export type Channel = {
  slug: string; name: string; account: string; formats: { format: string; pillars: string; note: string }[]; link_rule: string; specs: string[]; timing: string;
  measure: string[];
};

export type Channels = {
  channels: Channel[];
  cadence: { surface: string; rhythm: string; slot: string }[];
  /** The weekly rhythm (John, 2026-10-17); lib/rhythm.ts reads the same block. */
  rhythm: { summary: string; days: { day: string; primary: string | null; fallback: string[]; channels: string[]; note: string }[]; rules: string[] };
  format_mix: string[];
  publishing_model: string[];
  fan_out: string[];
  /** Headlines only; the reasoning behind each stays in the hub STRATEGY.md "Topic guardrails". */
  guardrails: Quote[];
};

export type InspirationSeed = {
  url: string; title: string; kind: "video" | "carousel" | "newsletter" | "post"; platform: string;
  pillar: PillarSlug | null; tags: string[]; why_we_like: string; media?: string; image_url?: string; featured?: boolean;
};

/** The phase the content program is in, and what success means in it (gtm guide phase). */
export type Phase = {
  slug: string; name: string; label: string; starts_on: string; ends_on: string; summary: string;
  success: { key: string; label: string; what: string }[];
  tracked_not_judged: string[];
  funnel_mix: Record<FunnelRole, number>; funnel_note: string; rules: string[];
};

export type PipelineStep = { slug: string; name: string; what: string; tool: string; href: string | null; gate?: string };

export const PILLARS = pillarsJson.pillars as Pillar[];
export const WHY = whyJson as Why;
export const STORIES = storiesJson.stories as StoryType[];
export const HYPOTHESIS = storiesJson.hypothesis;
export const REVIEW = storiesJson.review as Review;
export const VOICE = voiceJson as Voice;
export const REGENERA = regeneraJson as Substack;
export const PERSONAL = personalJson as Substack;
export const ASSETS = assetsJson.formats as AssetFormat[];
export const CHANNELS = channelsJson as Channels;
export const INSPIRATION = inspirationJson.seeds as InspirationSeed[];
export const PIPELINE = pipelineJson.steps as PipelineStep[];
export const PHASE = phaseJson as Phase;

/**
 * One hue per pillar, from the validated --viz palette (app/globals.css). The old violet/blue/cyan/emerald
 * set failed the colour-vision check (violet and blue collapse under deuteranopia, cyan and emerald sit too
 * close for everyone), so the Prism cool-only rule gives way to an amber here. Pillars are still always
 * labeled by name next to the color.
 */
export { PILLAR_TONE } from "./presentation";

/** The whole guide as one object: what `gtm guide --json` prints and agents read. */
export function guide() {
  return { version: 1, phase: PHASE, why: WHY, pillars: PILLARS, stories: STORIES, voice: VOICE, regenera: REGENERA, personal: PERSONAL, assets: ASSETS, channels: CHANNELS, inspiration: INSPIRATION, pipeline: PIPELINE, signals: signalsConfig() };
}
