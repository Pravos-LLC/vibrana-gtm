import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { calendarPath } from "../calendar";
import { splitFrontmatterRaw, frontmatterMeta } from "../frontmatter";
import { PROFILES, selectTemplate, type Brand, type Theme } from "./catalog";
import { checkPackage, hash, type PackagingBrief } from "./model";

/** Resolve one exact Story. Never guess from fuzzy titles or overwrite somebody else's Story. */
export function findStory(id: string, explicit?: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("invalid Story id");
  if (explicit) {
    const path = resolve(explicit), doc = parseDocument(readFileSync(path, "utf8")).toJS();
    if (doc?.id !== id) throw new Error("Story id does not match --manifest");
    return path;
  }
  const root = resolve(process.env.GTM_WORKSPACE ?? join(homedir(), "Projects/john-workspace"), "2-work/vibrana-gtm");
  const hits: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 6 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || ["node_modules", ".git", "archive", "raw", "media", "renders"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.ya?ml$/.test(e.name)) {
        try { if (parseDocument(readFileSync(p, "utf8")).toJS()?.id === id) hits.push(p); } catch { /* unrelated malformed file */ }
      }
    }
  }
  walk(root, 0);
  if (hits.length !== 1) throw new Error(`Found ${hits.length} manifests for ${id}. Use --manifest <exact-path>.`);
  return hits[0];
}
export function briefPathFor(id: string, manifest?: string): string {
  return resolve(dirname(findStory(id, manifest)), "packaging", id, "brief.json");
}
export function deriveBrief(id: string, opts: { manifest?: string; brand?: Brand; theme?: Theme; out?: string } = {}) {
  const path = findStory(id, opts.manifest), story = parseDocument(readFileSync(path, "utf8")).toJS();
  const bp = opts.out ? resolve(opts.out) : briefPathFor(id, path);
  if (existsSync(bp)) return { brief: bp, created: false, next: `gtm packaging check ${id}` };
  const brand = opts.brand ?? "sample-author", profile = PROFILES[brand];
  if (!profile) throw new Error("unregistered brand");
  // Immutable evidence snapshot avoids a circular dependency: adding a generated cover to the
  // Story manifest must not invalidate the source package that produced it.
  const rawStory = readFileSync(path, "utf8");
  const snapshot = resolve(dirname(bp), `story-source-${hash(rawStory).slice(0, 16)}.yaml`);
  mkdirSync(dirname(bp), { recursive: true }); writeFileSync(snapshot, rawStory);
  const sources: PackagingBrief["sources"] = [{ path: relative(dirname(bp), snapshot), role: "decision" }];
  let title = story.title as string, description = "";
  for (const a of story.assets ?? []) {
    if (!["copy", "video"].includes(a.kind)) continue;
    const abs = resolve(dirname(calendarPath()), a.source);
    if (!existsSync(abs)) continue;
    sources.push({ path: relative(dirname(bp), abs), role: a.kind });
    if (a.kind === "copy" && a.channels?.includes("youtube")) {
      const raw = readFileSync(abs, "utf8"), split = splitFrontmatterRaw(raw), meta = frontmatterMeta(split?.frontmatter ?? "");
      title = String(meta.youtube_title ?? title);
      description = (split?.body ?? raw).trim();
    }
  }
  const b: PackagingBrief = {
    schema: 1, story: id, brand, theme: opts.theme ?? profile.defaultTheme, template: selectTemplate(title),
    ready: false, audience: "", promise: "", thumbnail: "", opening: { text: "", spoken: "", source: "" },
    payoff: { source: "", seconds: 0, explanation: "" }, title, description, sources, portraits: [],
    shapes: story.pipeline === "episode" ? ["landscape"] : ["portrait"],
    selection: "Initial composition inferred from title; the agent must confirm against the cut.",
  };
  mkdirSync(dirname(bp), { recursive: true }); writeFileSync(bp, JSON.stringify(b, null, 2) + "\n");
  return { brief: bp, created: true, next: "Complete audience, promise, thumbnail, opening, payoff and source portraits, then set ready: true." };
}
export function currentPackage(bp: string): string {
  const p = resolve(dirname(bp), "latest.json");
  if (!existsSync(p)) throw new Error("No render. Run gtm packaging render.");
  return resolve(dirname(bp), JSON.parse(readFileSync(p, "utf8")).manifest);
}
export function checkStoryPackage(bp: string) {
  const manifest = currentPackage(bp), errors = checkPackage(manifest);
  return { manifest, valid: errors.length === 0, errors };
}
/** Revision requests do not silently rewrite copy, generate images or overwrite approved artifacts. */
export function reviseBrief(bp: string, notes: Array<{ id: string; text: string }>) {
  if (!notes.length || notes.some(n => !n.id || !n.text.trim())) throw new Error("Revision needs exact feedback ids and text");
  const b = JSON.parse(readFileSync(bp, "utf8")) as PackagingBrief;
  const request = resolve(dirname(bp), "revision-request.json");
  writeFileSync(request, JSON.stringify({ story: b.story, brief: bp, notes, createdAt: new Date().toISOString(), instruction: "Read these notes and revise only affected brief fields. Preserve owner copy. Render to a new hash directory, check, then dry-run restaging. Never approve or schedule." }, null, 2) + "\n");
  return { request, brief: bp, notes, next: "Agent edits the affected brief fields, then runs render and check. Existing renders are immutable." };
}
