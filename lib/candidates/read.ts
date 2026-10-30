// Reads what `gtm candidates put` is given: a JSON file ({week_start?, candidates: [...]}) or the routine's
// working directory, one folder per candidate:
//
//   <dir>/selection.json            the `gtm candidates select --json` output (week_start, and per-slug defaults)
//   <dir>/<slug>/candidate.json     title, sources, rubric, score, playbook (and anything the selection set)
//   <dir>/<slug>/linkedin.md        the post text, or the caption that goes with the slides or the video
//   <dir>/<slug>/instagram.md       optional Instagram caption (no links)
//   <dir>/<slug>/slides.json        carousel: the vibrana-carousel content file
//   <dir>/<slug>/video-lines.md     video: "Hook: ..." then numbered beats (or {hook, beats} in candidate.json)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Pick, Selection } from "./select";
import type { CandidateInput, VideoScript } from "./validate";

const readJson = (path: string) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${path}: ${(e as Error).message}`); }
};
const maybe = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** Hook and beats from a video-lines.md: a `Hook:` line, then numbered or bulleted beats. */
export function parseVideoLines(text: string): VideoScript {
  const lines = text.split("\n");
  const hook = lines.map((l) => l.match(/^\s*(?:\*\*)?hook(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/i)?.[1]).find(Boolean)?.trim() ?? "";
  const beats = lines.map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim()).filter((b): b is string => !!b);
  return { hook, beats, lines: text };
}

export type PutInput = { week_start: string | null; candidates: CandidateInput[]; selection: Selection | null };

export function readPutInput(path: string): PutInput {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (statSync(path).isFile()) {
    const data = readJson(path) as { week_start?: string; candidates?: CandidateInput[] } | CandidateInput[];
    const list = Array.isArray(data) ? data : data.candidates;
    if (!Array.isArray(list)) throw new Error(`${path}: expected {week_start, candidates: [...]}`);
    return { week_start: Array.isArray(data) ? null : data.week_start ?? null, candidates: list, selection: null };
  }
  const selPath = join(path, "selection.json");
  const selection = existsSync(selPath) ? readJson(selPath) as Selection : null;
  const dirs = readdirSync(path).filter((d) => existsSync(join(path, d, "candidate.json"))).sort();
  const candidates = dirs.map((slug): CandidateInput => {
    const dir = join(path, slug);
    const meta = readJson(join(dir, "candidate.json")) as Partial<CandidateInput>;
    const pick: Partial<Pick> = selection?.candidates.find((c) => c.slug === (meta.slug ?? slug)) ?? {};
    const lines = maybe(join(dir, "video-lines.md"));
    const slides = existsSync(join(dir, "slides.json")) ? readJson(join(dir, "slides.json")) : meta.slides;
    const video = meta.video ? { ...meta.video, ...(lines ? { lines } : {}) } : lines ? parseVideoLines(lines) : undefined;
    return {
      ...meta,
      slug: meta.slug ?? slug,
      title: meta.title ?? pick.title ?? "",
      format: meta.format ?? pick.format!,
      lens: meta.lens ?? pick.lens!,
      pillar: meta.pillar ?? pick.pillar!,
      channels: meta.channels ?? pick.channels,
      body: maybe(join(dir, "linkedin.md")) ?? meta.body ?? "",
      instagram: maybe(join(dir, "instagram.md")) ?? meta.instagram ?? null,
      slides: slides ?? null,
      video: video ?? null,
      sources: meta.sources ?? pick.sources ?? [],
      signal_id: meta.signal_id !== undefined ? meta.signal_id : pick.signal_id ?? null,
      report_action_id: meta.report_action_id !== undefined ? meta.report_action_id : pick.report_action_id ?? null,
      position: meta.position ?? pick.position,
    };
  });
  return { week_start: selection?.week_start ?? null, candidates, selection };
}
