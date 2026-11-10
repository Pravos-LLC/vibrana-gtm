// An owner-supplied cover: an image John (or an agent he asked) made outside the packaging toolkit, such as a
// Riverside thumbnail or a generated cover, handed in as is. Nothing is composed or re-rendered, so there is no
// brief or brand to attest. The manifest records who supplied it, where it came from and its hash, and the staging
// gate accepts it only when the file still has those exact bytes, is a publishable image, is the shape of the
// Story's video, and belongs to this Story. It is not approval: the cover is still approved with the rest of the piece.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SIZES, TOOLKIT_VERSION, type Shape } from "./catalog";
import { imageProblems, sniffImage, IMAGE_TYPES, PUBLISH_IMAGE_BYTES } from "../image-loadable";
import { probeVideo, shapeFor, type StagedVideo } from "./frame";

export type OwnerManifest = {
  schema: 1; kind: "owner"; story: string; toolkit: string; suppliedAt: string;
  /** Who handed the image in, for example "John Ellison". */
  suppliedBy: string;
  /** Where it came from, for example "Riverside thumbnail" or "fal nano-banana-pro edit of a frame of the cut". */
  origin: string;
  note?: string;
  assets: Array<{ path: string; sha256: string; width: number; height: number; role: "cover"; shape: Shape }>;
};

/** Registered shapes are 1080 wide or more; a thumbnail below this is not a cover. */
const MIN_COVER_WIDTH = 540;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const text = (v: unknown) => typeof v === "string" && !!v.trim();

/** Copy the image next to a new manifest. The directory is addressed by Story and image bytes, so the same request returns the same files. */
export function renderOwnerCover(story: string, image: string, outDir: string, opts: { by: string; origin: string; note?: string }): { manifest: string; cover: string; cached: boolean } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(story)) throw new Error("invalid Story id");
  if (!text(opts.by) || !text(opts.origin)) throw new Error("an owner-supplied cover needs --by (who supplied it) and --origin (where it came from)");
  const src = resolve(image);
  if (!existsSync(src)) throw new Error(`image not found: ${image}`);
  const bytes = readFileSync(src);
  const check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
  if (check.problems.length) throw new Error(`${basename(src)} is not a publishable image: ${check.problems.join(", ")} (a JPEG or PNG under 5 MB, sRGB)`);
  const format = sniffImage(bytes);
  if (format !== "jpeg" && format !== "png") throw new Error(`${basename(src)} is ${format}; an owner cover must be a JPEG or PNG`);
  const width = check.width!, height = check.height!;
  if (width < MIN_COVER_WIDTH) throw new Error(`${basename(src)} is ${width}px wide; a cover needs at least ${MIN_COVER_WIDTH}px`);
  const shape = shapeFor(width, height);
  if (!shape) throw new Error(`${basename(src)} is ${width}x${height}; a cover needs a registered shape (${Object.keys(SIZES).join(", ")})`);
  const digest = sha(bytes);
  const dir = resolve(outDir, `owner-${sha(Buffer.from(`${story}|${digest}`)).slice(0, 20)}`);
  const manifestPath = join(dir, "manifest.json");
  const name = `${shape}${format === "png" ? ".png" : ".jpg"}`;
  const coverPath = join(dir, name);
  if (existsSync(manifestPath) && existsSync(coverPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as OwnerManifest;
    if (m.suppliedBy === opts.by.trim() && m.origin === opts.origin.trim() && (m.note ?? "") === (opts.note?.trim() ?? "")
      && checkOwnerManifest(manifestPath, m, { story, assetPath: coverPath, sha256: digest }).length === 0) return { manifest: manifestPath, cover: coverPath, cached: true };
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, coverPath);
  const manifest: OwnerManifest = {
    schema: 1, kind: "owner", story, toolkit: TOOLKIT_VERSION, suppliedAt: new Date().toISOString(),
    suppliedBy: opts.by.trim(), origin: opts.origin.trim(), ...(text(opts.note) ? { note: opts.note!.trim() } : {}),
    assets: [{ path: name, sha256: digest, width, height, role: "cover", shape }],
  };
  const tmp = `${manifestPath}.tmp-${process.pid}`;   // atomic: an interrupted write never leaves a half manifest
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, manifestPath);
  return { manifest: manifestPath, cover: coverPath, cached: false };
}

/**
 * Problems with an owner manifest. Without `expected` (a local check): well formed, supplier and origin recorded, the
 * image intact. With `expected` (the staging gate): also the staged cover is this manifest's exact export for this
 * Story, and its shape matches the display shape of the staged video when one is staged.
 */
export function checkOwnerManifest(path: string, m: OwnerManifest, expected?: { story: string; assetPath: string; sha256: string; videos?: StagedVideo[] }): string[] {
  if (!m || m.schema !== 1 || m.kind !== "owner") return ["not an owner-supplied cover manifest"];
  const errors: string[] = [];
  const root = dirname(path);
  if (expected && m.story !== expected.story) errors.push("manifest belongs to another Story");
  if (!text(m.suppliedBy)) errors.push("owner cover has no supplier recorded");
  if (!text(m.origin)) errors.push("owner cover has no origin recorded");
  if (!Array.isArray(m.assets) || !m.assets.length || m.assets.some(a => !a || typeof a.path !== "string" || !Object.hasOwn(SIZES, a.shape))) return [...errors, "owner manifest has no valid cover"];
  for (const a of m.assets) {
    const p = resolve(root, a.path);
    if (!existsSync(p)) { errors.push(`missing export: ${a.path}`); continue; }
    const bytes = readFileSync(p);
    if (sha(bytes) !== a.sha256) { errors.push(`changed export: ${a.path}`); continue; }
    const check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
    if (check.problems.length) errors.push(`invalid image ${a.path}: ${check.problems.join(", ")}`);
    else if (check.width !== a.width || check.height !== a.height) errors.push(`export dimensions do not match manifest: ${a.path}`);
    else if (shapeFor(a.width, a.height) !== a.shape) errors.push(`export shape does not match manifest: ${a.path}`);
    else if (a.width < MIN_COVER_WIDTH) errors.push(`export is only ${a.width}px wide: ${a.path}`);
    else if (!["jpeg", "png"].includes(sniffImage(bytes)) || extname(p).toLowerCase() !== (sniffImage(bytes) === "png" ? ".png" : ".jpg")) errors.push(`export is ${sniffImage(bytes)} but named ${extname(p)}: ${a.path}`);
  }
  if (expected) {
    const bound = m.assets.find(a => a.role === "cover" && resolve(root, a.path) === resolve(expected.assetPath) && a.sha256 === expected.sha256);
    if (!bound) errors.push("cover is not bound to this owner manifest");
    else if ((expected.videos ?? []).length) {
      // Fail closed: a video whose shape cannot be measured (no ffprobe, unreadable) or is not a registered shape refuses the cover.
      const shapes: Array<Shape | null> = [];
      for (const v of expected.videos!) {
        try { const d = probeVideo(v.abs); shapes.push(shapeFor(d.width, d.height)); }
        catch (e) { errors.push(`cannot read the staged video's shape: ${(e as Error).message}`); shapes.push(null); }
      }
      if (!errors.length) {
        if (shapes.some((x) => x === null)) errors.push("a staged video is not a registered cover shape");
        else if (!shapes.includes(bound.shape)) errors.push(`cover is ${bound.shape} but the staged video is ${[...new Set(shapes)].join("/")}`);
      }
    }
  }
  return errors;
}

/** What staging records beside an owner cover so /content and the audit trail can show who supplied it (self-asserted, like any `--by`). */
export function ownerCoverMeta(manifestPath: string): Record<string, unknown> | undefined {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as OwnerManifest;
    if (m?.kind !== "owner") return undefined;
    return { owner_cover: { supplied_by: m.suppliedBy, origin: m.origin, ...(m.note ? { note: m.note } : {}), supplied_at: m.suppliedAt } };
  } catch { return undefined; }
}
