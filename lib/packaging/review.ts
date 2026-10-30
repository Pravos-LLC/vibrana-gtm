import { chunks } from "../seasons";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPackage, fileHash, readBrief, type PackagingManifest } from "./model";
import { guardMediaBytes } from "../media-guard";
import { BUCKET } from "../review";
import { must } from "../db";

/** Import reviewed template specimens into the existing asset/version/feedback store. No platform assignment. */
export async function stageReviewGallery(db: SupabaseClient, story: string, galleryPath: string, dryRun = false) {
  const root = dirname(resolve(galleryPath));
  const workspace = realpathSync(process.env.GTM_WORKSPACE ?? resolve(homedir(), "Projects/john-workspace"));
  const entries = JSON.parse(readFileSync(galleryPath, "utf8")) as Array<{ manifest: string }>;
  if (!Array.isArray(entries) || !entries.length || entries.length > 72) throw new Error("Review gallery needs 1 to 72 registered specimens");
  // Validate every candidate before uploading or writing any of them.
  const planned = entries.flatMap(e => {
    const manifest = resolve(root, e.manifest), inside = relative(workspace, realpathSync(manifest));
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Review manifests must be inside GTM_WORKSPACE");
    const errors = checkPackage(manifest); if (errors.length) throw new Error(`${manifest}: ${errors.join("; ")}. Repair: gtm packaging render ${story} --brief <brief.json>`);
    const m = JSON.parse(readFileSync(manifest, "utf8")) as PackagingManifest;
    if (m.story !== story || !m.style) throw new Error("Review candidate must be a registered style for this Story");
    const brief = readBrief(resolve(dirname(manifest), m.brief));
    return m.assets.filter(a => a.role === "cover").map(a => {
      const shape = a.width > a.height ? "landscape" : a.width < a.height ? "portrait" : "square";
      const file = resolve(dirname(manifest), a.path), sourceInside = relative(workspace, realpathSync(file));
      if (sourceInside.startsWith("..") || isAbsolute(sourceInside)) throw new Error("Review images must be inside GTM_WORKSPACE");
      const bytes = readFileSync(file); guardMediaBytes(bytes, "image/jpeg", file, { publish: false });
      const id = `${story}-template-${m.style}-${m.brand}-${m.theme}-${shape}`;
      return { id, file, bytes, sha256: a.sha256, title: `${m.style} / ${m.brand} / ${m.theme} / ${shape}`, metadata: {
        publication_story_id: story, packaging_candidate: true, packaging_style: m.style, packaging_brand: m.brand, packaging_theme: m.theme, packaging_shape: shape,
        packaging_manifest_sha256: fileHash(manifest), packaging_toolkit: m.toolkit, width: a.width, height: a.height,
        publication_title: brief.title, publication_companion_stories: brief.publication?.companionStories ?? [], thumbnail_text: brief.coverText?.[shape as keyof typeof brief.coverText]?.text ?? brief.thumbnail, promise: brief.promise, selection: brief.selection,
      } };
    });
  });
  if (new Set(planned.map(a => a.id)).size !== planned.length) throw new Error("Duplicate template specimen");
  if (dryRun) return { story, candidates: planned.length, publishingAssignments: 0, dryRun: true };
  const head = must(await db.from("gtm_stories").select("id,title,link_url").eq("id", story).maybeSingle(), "review Story");
  if (!head) throw new Error("Stage the Story before its template review");
  const prior = (await Promise.all(chunks(planned.map(a => a.id),20).map(async ids => must(await db.from("gtm_story_assets").select("id,metadata").in("id",ids), "prior template assets") ?? []))).flat();
  for (const p of prior ?? []) if (p.metadata?.packaging_candidate !== true) throw new Error(`Candidate id already belongs to a publishing asset: ${p.id}`);
  const assigned = (await Promise.all(chunks(planned.map(a => a.id),20).map(async ids => must(await db.from("gtm_story_asset_channels").select("asset_id").in("asset_id",ids), "candidate channel assignments") ?? []))).flat();
  if (assigned?.length) throw new Error("Template candidates must have no publishing assignments");
  // Isolate catalog specimens from the publishing Story's stage and asset completeness checks.
  const reviewStory = `packaging-${story}`;
  const catalogHead = must(await db.from("gtm_stories").select("id,title,link_url,pipeline").eq("id",reviewStory).maybeSingle(), "prior review catalog");
  const catalogAssets = must(await db.from("gtm_story_assets").select("id,metadata").eq("story_id",reviewStory), "prior catalog assets");
  if (catalogHead && (catalogHead.pipeline != null || catalogHead.link_url !== head.link_url || !catalogHead.title.startsWith("Thumbnail template review: "))) throw new Error("Review catalog id belongs to another Story; it was left unchanged");
  if ((catalogAssets ?? []).some(a => a.metadata?.packaging_candidate !== true || a.metadata?.publication_story_id !== story)) throw new Error("Review catalog contains non-candidate assets; it was left unchanged");
  if (catalogAssets?.length) {
    const catalogChannels = (await Promise.all(chunks(catalogAssets.map(a => a.id),20).map(async ids => must(await db.from("gtm_story_asset_channels").select("asset_id").in("asset_id",ids), "prior catalog publishing assignments") ?? []))).flat();
    if(catalogChannels?.length)throw new Error("Review catalog has publishing assignments; it was left unchanged");
  }
  must(await db.from("gtm_stories").upsert({id:reviewStory,title:`Thumbnail template review: ${head.title}`,link_url:head.link_url}), "template review catalog");
  for (const a of planned) {
    const key = `stories/${reviewStory}/${a.id}-${a.sha256.slice(0,16)}.jpg`;
    const upload = await db.storage.from(BUCKET).upload(key, a.bytes, { contentType: "image/jpeg", upsert: true });
    if (upload.error) throw new Error(`Candidate upload: ${upload.error.message}`);
    must(await db.from("gtm_story_assets").upsert({ id: a.id, story_id: reviewStory, title: a.title, kind: "image", source: a.file,
      sha256: a.sha256, storage_path: key, body: null, url: null, stage: "package", metadata: a.metadata }), "stage template candidate");
  }
  return { story, reviewStory, candidates: planned.length, publishingAssignments: 0, review: `/content?view=templates&story=${encodeURIComponent(story)}` };
}

/** Resolve explicit feedback IDs from either the publishing Story or its isolated template catalog. */
export async function revisionFeedback(db: SupabaseClient, story: string, ids: string[]) {
  if(!ids.length || ids.length>256 || new Set(ids).size!==ids.length)throw new Error("Revision needs 1 to 256 distinct feedback IDs");
  const notes=(await Promise.all(chunks(ids,20).map(async part=>must(await db.from("gtm_story_feedback").select("id,body,asset_id").in("id",part).is("resolved_at",null),"revision feedback")??[]))).flat();
  if(notes.length!==ids.length)throw new Error("Each feedback id must be open and belong to this Story");
  const assetIds=[...new Set(notes.map(n=>n.asset_id))];
  const assets=(await Promise.all(chunks(assetIds,20).map(async part=>must(await db.from("gtm_story_assets").select("id,story_id,metadata").in("id",part),"revision assets")??[]))).flat();
  if(notes.some(n=>!assets.some(a=>a.id===n.asset_id && (a.story_id===story || (a.metadata?.packaging_candidate===true && a.metadata?.publication_story_id===story)))))throw new Error("Each feedback id must be open and belong to this Story");
  return notes.map(n=>({id:n.id,text:n.body}));
}
