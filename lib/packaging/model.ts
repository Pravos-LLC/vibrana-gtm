import { COVER_STYLES, HEADLINE_TYPES, type CoverStyle, type HeadlineType } from "./styles";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { BRANDS, PROFILES, SIZES, TEMPLATES, TOOLKIT_VERSION, type Brand, type Shape, type Template, type Theme } from "./catalog";
import { imageProblems, sniffImage, IMAGE_TYPES, PUBLISH_IMAGE_BYTES } from "../image-loadable";

export type PackagingBrief = {
  schema: 1; story: string; brand: Brand; theme: Theme; template: Template; ready: boolean;
  style?: CoverStyle; typography?: HeadlineType; backdropText?: string;
  publication?: { companionStories: string[] };
  coverText?: Partial<Record<Shape,{text:string;emphasis?:string}>>;
  audience: string; promise: string; thumbnail: string; emphasis?: string; eyebrow?: string;
  opening: { text: string; spoken: string; source: string };
  payoff: { source: string; seconds: number; explanation: string };
  title: string; description: string;
  /** All paths relative to this brief, never inferred from the process working directory. */
  sources: Array<{ path: string; role: "video" | "transcript" | "copy" | "decision" | "image" }>;
  portraits: Array<{ path: string; name: string; position?: string }>;
  background?: string; backgroundTreatment?: "atmosphere" | "photographic"; focal?: string; shapes: Shape[];
  selection: string; notes?: Array<{ id: string; text: string }>;
};
export type PackagingManifest = {
  schema: 1; story: string; toolkit: string; brief: string; briefHash: string; renderedAt: string;
  brand: Brand; theme: Theme; template: Template; style?: CoverStyle; typography?: HeadlineType; catalogHash: string;
  inputs: Array<{ path: string; sha256: string }>;
  assets: Array<{ path: string; sha256: string; width: number; height: number; role: "cover" | "preview" }>;
  artifacts?: Array<{ path: string; sha256: string; role: "motion" | "timeline" }>;
  generation: { provider: "source-assets"; costUsd: 0 };
  validation: { passed: true; checks: string[] };
};
export const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export function fileHash(path: string): string {
  const fd = openSync(path, "r"), h = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  try { let n: number; while ((n = readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest("hex");
}
export function catalogHash(): string { return hash(JSON.stringify({ version: TOOLKIT_VERSION, profiles: PROFILES, templates: TEMPLATES, styles: COVER_STYLES, typography: HEADLINE_TYPES, sizes: SIZES })); }
const text = (v: unknown) => typeof v === "string" && !!v.trim();
export function briefProblems(b: PackagingBrief): string[] {
  const errors: string[] = [];
  if (!b || b.schema !== 1) return ["packaging schema must be 1"];
  if (!text(b.story) || !/^[a-z0-9][a-z0-9-]*$/.test(b.story)) errors.push("invalid story id");
  if (!BRANDS.includes(b.brand)) errors.push("unregistered brand");
  if (!["light", "dark"].includes(b.theme)) errors.push("invalid theme");
  if (!Object.hasOwn(TEMPLATES, b.template)) errors.push("unregistered template");
  if (b.style !== undefined && !Object.hasOwn(COVER_STYLES, b.style)) errors.push("unregistered cover style");
  if (b.style && Object.hasOwn(COVER_STYLES,b.style) && b.template !== COVER_STYLES[b.style].family) errors.push("cover style needs its registered semantic family");
  if (b.typography !== undefined && !Object.hasOwn(HEADLINE_TYPES, b.typography)) errors.push("unregistered headline typography");
  if (b.backdropText !== undefined && (!text(b.backdropText) || b.backdropText.length > 24)) errors.push("backdrop text must be 1 to 24 characters");
  if (b.coverText && (typeof b.coverText !== "object" || Object.entries(b.coverText).some(([shape,c]) => !Object.hasOwn(SIZES,shape) || !c || !text(c.text) || c.text.length > 100 || (c.emphasis !== undefined && (!text(c.emphasis) || !c.text.includes(c.emphasis)))))) errors.push("shape cover text needs registered shapes, short text and matching emphasis");
  if (b.publication && (!Array.isArray(b.publication.companionStories) || b.publication.companionStories.length > 32 || b.publication.companionStories.some(s => typeof s !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s)))) errors.push("publication companion Stories must be registered id-shaped strings, at most 32");
  if (b.ready !== true) errors.push("brief needs agent completion: ready must be true");
  for (const k of ["audience", "promise", "thumbnail", "title", "description", "selection"] as const) if (!text(b[k])) errors.push(`missing ${k}`);
  if (text(b.thumbnail) && b.thumbnail.length > 100) errors.push("thumbnail exceeds 100 characters: shorten the promise");
  if (!b.opening || !text(b.opening.text) || !text(b.opening.spoken) || !text(b.opening.source)) errors.push("opening needs text, spoken opening and source");
  if (!b.payoff || !text(b.payoff.source) || !text(b.payoff.explanation) || !Number.isFinite(b.payoff.seconds) || b.payoff.seconds < 0) errors.push("payoff needs source, non-negative seconds and explanation");
  if (!Array.isArray(b.sources) || !b.sources.length || b.sources.some(s => !text(s.path) || !["video", "transcript", "copy", "decision", "image"].includes(s.role))) errors.push("sources need paths and roles");
  if (!Array.isArray(b.portraits) || b.portraits.length > 2 || b.portraits.some(p => !text(p.path) || !text(p.name))) errors.push("portraits must be zero to two named source images");
  if (b.backgroundTreatment && !["atmosphere", "photographic"].includes(b.backgroundTreatment)) errors.push("invalid background treatment");
  if (b.focal !== undefined && !text(b.focal)) errors.push("focal artwork needs a source path");
  if (!Array.isArray(b.shapes) || !b.shapes.length || b.shapes.some(s => !Object.hasOwn(SIZES, s)) || new Set(b.shapes).size !== b.shapes.length) errors.push("shapes must be unique registered sizes");
  return errors;
}
export function readBrief(path: string): PackagingBrief {
  const b = JSON.parse(readFileSync(path, "utf8")) as PackagingBrief;
  const errors = briefProblems(b);
  if (errors.length) throw new Error(errors.join("; "));
  return b;
}
export function inputPaths(b: PackagingBrief, briefPath: string): string[] {
  return [...new Set([...b.sources.map(s => s.path), b.opening.source, b.payoff.source, ...b.portraits.map(p => p.path), ...(b.background ? [b.background] : []), ...(b.focal ? [b.focal] : [])].map(p => resolve(dirname(briefPath), p)))];
}
export function checkPackage(path: string, expected?: { story: string; assetPath: string; sha256: string }): string[] {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as PackagingManifest;
    if (m.schema !== 1 || m.toolkit !== TOOLKIT_VERSION || m.catalogHash !== catalogHash()) return ["stale or unsupported packaging toolkit: rerender"];
    const root = dirname(path), bp = resolve(root, m.brief), b = readBrief(bp);
    const errors: string[] = [];
    if (m.briefHash !== fileHash(bp)) errors.push("brief changed since render");
    if (m.story !== b.story || m.brand !== b.brand || m.theme !== b.theme || m.template !== b.template || m.style !== b.style || m.typography !== b.typography) errors.push("manifest identity does not match brief");
    if (expected && m.story !== expected.story) errors.push("manifest belongs to another Story");
    if (!Array.isArray(m.inputs) || !Array.isArray(m.assets) || !m.assets.length) return ["packaging inputs/assets missing"];
    for (const p of inputPaths(b, bp)) if (!m.inputs.some(i => resolve(root, i.path) === p)) errors.push(`untracked input: ${p}`);
    for (const i of m.inputs) {
      const p = resolve(root, i.path);
      if (!existsSync(p) || i.sha256 !== fileHash(p)) errors.push(`stale input: ${i.path}`);
    }
    for (const a of m.assets) {
      const p = resolve(root, a.path);
      if (!existsSync(p) || a.sha256 !== fileHash(p)) errors.push(`changed or missing export: ${a.path}`);
      else {
        const bytes = readFileSync(p), check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
        if (check.problems.length) errors.push(`invalid image ${a.path}: ${check.problems.join(", ")}`);
        if (check.width !== a.width || check.height !== a.height) errors.push(`export dimensions do not match manifest: ${a.path}`);
      }
    }
    for (const a of m.artifacts ?? []) {
      const p = resolve(root, a.path);
      if (!existsSync(p) || a.sha256 !== fileHash(p)) errors.push(`changed or missing motion artifact: ${a.path}`);
    }
    for (const shape of b.shapes) {
      const [width, height] = SIZES[shape];
      if (!m.assets.some(a => a.role === "cover" && a.width === width && a.height === height)) errors.push(`missing ${shape} cover`);
    }
    if (expected && !m.assets.some(a => a.role === "cover" && resolve(root, a.path) === resolve(expected.assetPath) && a.sha256 === expected.sha256)) errors.push("cover is not bound to this packaging manifest");
    return errors;
  } catch (e) { return [`packaging unreadable: ${(e as Error).message}`]; }
}

export type ExistingPackagingAsset = { id: string; sha256: string; stage?: string | null; updated_at?: string; metadata?: Record<string, unknown> };
/** The schema has updated_at, not a creation date. Preserve authenticated first-use evidence
 * in existing metadata so a harmless restage's timestamp trigger cannot revoke legacy status. */
export function legacyPackagingRecord(e: ExistingPackagingAsset | undefined): { sha256: string; evidenceUpdatedAt: string } | undefined {
  if (!e || (e.stage != null && e.stage !== "final")) return;
  const marker = e.metadata?.packaging_legacy as { sha256?: string; evidenceUpdatedAt?: string } | undefined;
  const evidence = marker?.sha256 === e.sha256 ? marker.evidenceUpdatedAt : e.updated_at;
  if (evidence && Date.parse(evidence) < Date.parse("2026-10-14T03:00:00Z")) return { sha256: e.sha256, evidenceUpdatedAt: evidence };
}
export function packagingGate(
  story: string,
  assets: Array<{ id: string; kind: string; title: string; abs: string; sha256: string; channels: string[]; stage?: string; packaging?: string; role?: string }>,
  existing: ExistingPackagingAsset[],
  pipeline?: string | null,
): void {
  for (const a of assets) {
    const cover = a.kind === "image" && a.channels.length > 0 && (!a.stage || a.stage === "final") && (assets.some(x => x.kind === "video") || ["short", "episode", "video"].includes(pipeline ?? "") || a.role === "cover" || /cover|thumbnail/i.test(`${a.id} ${a.title}`));
    if (!cover) continue;
    // Existing identical assets are a legacy import; no fabricated attestation or withdrawn approval.
    if (!a.packaging && existing.some(e => e.id === a.id && e.sha256 === a.sha256 && legacyPackagingRecord(e))) continue;
    const errors = a.packaging ? checkPackage(a.packaging, { story, assetPath: a.abs, sha256: a.sha256 }) : ["missing packaging manifest"];
    if (errors.length) throw new Error(`${a.id}: ${errors.join("; ")}. Run gtm packaging brief ${story}, complete the brief, then gtm packaging render ${story} and gtm packaging check ${story}.`);
  }
}
