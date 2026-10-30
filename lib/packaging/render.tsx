import { motionDocument, type MotionPreset } from "./motion";
import { HEADLINE_TYPES, headlineType, coverStyleCss } from "./styles";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { guardMediaBytes } from "../media-guard";
import { PROFILES, SIZES, TOOLKIT_VERSION } from "./catalog";
import { catalogHash, checkPackage, fileHash, hash, inputPaths, readBrief, type PackagingManifest } from "./model";
import { Thumbnail, thumbnailCss } from "./Thumbnail";
const assetsRoot = fileURLToPath(new URL("../../assets/packaging/", import.meta.url));
const dataUrl = (path: string) => `data:${({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" } as Record<string,string>)[extname(path)] ?? "application/octet-stream"};base64,${readFileSync(path).toString("base64")}`;
export async function renderPackage(briefPath: string, options: { assetRoot?: string } = {}): Promise<{ manifest: string; cached: boolean }> {
  const b = readBrief(briefPath), root = dirname(resolve(briefPath)), profile = PROFILES[b.brand];
  const rootAssets = options.assetRoot ?? assetsRoot;
  const headline = HEADLINE_TYPES[headlineType(b)];
  const fonts = [...profile.fonts, headline.file].map(f => resolve(rootAssets, "fonts", f));
  for (const f of fonts) if (!existsSync(f)) throw new Error(`Missing licensed font ${f}. Restore assets/packaging/fonts before rendering; do not silently substitute.`);
  const inputs = [...inputPaths(b, briefPath), ...fonts, fileURLToPath(new URL("./Thumbnail.tsx", import.meta.url)), fileURLToPath(new URL("./render.tsx", import.meta.url)), fileURLToPath(new URL("./styles.ts", import.meta.url)), fileURLToPath(new URL("./motion.ts", import.meta.url))];
  const logoPath = b.brand === "aios" ? resolve(rootAssets, `aios-wordmark-${b.theme === "dark" ? "white" : "black"}.svg`) : undefined;
  if (logoPath) inputs.push(logoPath);
  const fingerprints = inputs.map(path => ({ path, sha256: fileHash(path) }));
  const key = hash(JSON.stringify({ brief: fileHash(briefPath), catalog: catalogHash(), inputs: fingerprints })).slice(0, 20);
  const out = resolve(root, "renders", key), manifestPath = resolve(out, "manifest.json");
  if (existsSync(manifestPath) && checkPackage(manifestPath).length === 0) {
    writeFileSync(resolve(root, "latest.json"), JSON.stringify({ manifest: relative(root, manifestPath) }, null, 2) + "\n");
    return { manifest: manifestPath, cached: true };
  }
  mkdirSync(out, { recursive: true });
  const portraits = await Promise.all(b.portraits.map(async p => {
    const path = resolve(root, p.path), metadata = await sharp(path).metadata();
    // Transparent source-frame cutouts arrive on the recording's canvas. Trim empty alpha as layout,
    // keeping all original subject pixels and giving the face appropriate visual weight.
    return metadata.hasAlpha ? `data:image/webp;base64,${(await sharp(path).trim().resize({ height: 1920, withoutEnlargement: true }).webp({ quality: 95, alphaQuality: 100 }).toBuffer()).toString("base64")}` : dataUrl(path);
  }));
  const background = b.background ? `data:image/webp;base64,${(await sharp(resolve(root,b.background)).resize({width:2048,withoutEnlargement:true}).webp({quality:95}).toBuffer()).toString("base64")}` : undefined;
  const focal = b.focal ? dataUrl(resolve(root, b.focal)) : undefined;
  const fontCss = fonts.map((p, i) => `@font-face{font-family:"${i === 2 ? headline.family : i ? profile.body : profile.display}";src:url(data:font/woff2;base64,${readFileSync(p).toString("base64")});font-weight:100 900;font-display:block}`).join("");
  const browser = await chromium.launch({ headless: true });
  const assets: PackagingManifest["assets"] = [];
  const artifacts: NonNullable<PackagingManifest["artifacts"]> = [];
  try {
    for (const shape of b.shapes) {
      const [width, height] = SIZES[shape];
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      // All images and fonts are embedded; no outbound browser requests or executable brief text.
      await page.route("**/*", route => route.abort());
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}${thumbnailCss}${coverStyleCss}</style></head><body>${renderToStaticMarkup(<Thumbnail brief={b} shape={shape} portraits={portraits} background={background} focal={focal} logo={logoPath ? dataUrl(logoPath) : undefined}/>)}</body></html>`);
      await page.evaluate(async (families) => { await Promise.all(families.map(f => document.fonts.load(`400 24px "${f}"`))); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); }, [profile.display, profile.body, headline.family]);
      const loaded = await page.evaluate(() => document.fonts.size > 0 && [...document.fonts].every(f => f.status === "loaded"));
      if (!loaded) throw new Error("Brand fonts failed to load");
      const fits = await page.evaluate(() => {
        const h = document.querySelector("h1")!, box = document.querySelector(".headline-wrap")!;
        let n = parseFloat(getComputedStyle(h).fontSize);
        while ((h.getBoundingClientRect().height > box.clientHeight || h.scrollWidth > box.clientWidth) && n > 48) { n -= 2; (h as HTMLElement).style.fontSize = n + "px"; }
        return h.getBoundingClientRect().height <= box.clientHeight && h.scrollWidth <= box.clientWidth;
      });
      if (!fits) throw new Error(`${shape}: headline cannot fit. Shorten it; never crop text.`);
      if (b.style === "make-statement") await page.evaluate(() => {
        const h = document.querySelector(".backdrop-type") as HTMLElement;
        let n = parseFloat(getComputedStyle(h).fontSize);
        while (h.scrollWidth > h.clientWidth && n > 48) { n -= 2; h.style.fontSize = n + "px"; }
        if (h.scrollWidth > h.clientWidth) throw new Error("Backdrop keyword cannot fit; shorten backdropText");
      });
      if (b.style) {
        const preset: MotionPreset = b.style === "debate-perspectives" ? "split" : ["editorial-take", "share-story", "open-conversation"].includes(b.style) ? "editorial" : "reveal";
        const html = motionDocument(await page.content(), width, height, preset);
        const motionPath = resolve(out, `${shape}-motion.html`); writeFileSync(motionPath, html);
        artifacts.push({ path: relative(out, motionPath), sha256: hash(html), role: "motion" });
        const timeline = JSON.stringify({ schema: 1, story: b.story, shape, width, height, fps: 30, durationSeconds: 4, stillFrame: 30, preset, layers: ["background", "atmosphere", "identity", "backdrop", "subject", "focal", "headline", "names", "accent"], export: "Use window.packagingSeek(frame) to deterministically render at 30 fps; reverse the timeline for an outro. No synthetic speech or audio." }, null, 2) + "\n";
        const timelinePath = resolve(out, `${shape}-timeline.json`);writeFileSync(timelinePath, timeline);
        artifacts.push({ path: relative(out, timelinePath), sha256: hash(timeline), role: "timeline" });
      }
      const png = await page.screenshot({ type: "png" });
      const bytes = await sharp(png).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      guardMediaBytes(bytes, "image/jpeg", `${b.story}/${shape}.jpg`, { publish: true });
      const path = resolve(out, `${shape}.jpg`);
      writeFileSync(path, bytes);
      assets.push({ path: relative(out, path), sha256: hash(bytes), width, height, role: "cover" });
      const preview = await sharp(bytes).resize({ width: shape === "landscape" ? 320 : 180 }).jpeg({ quality: 85 }).toBuffer();
      const previewPath = resolve(out, `${shape}-small.jpg`);
      writeFileSync(previewPath, preview);
      const meta = await sharp(preview).metadata();
      assets.push({ path: relative(out, previewPath), sha256: hash(preview), width: meta.width!, height: meta.height!, role: "preview" });
      await page.close();
    }
  } finally { await browser.close(); }
  const manifest: PackagingManifest = {
    schema: 1, story: b.story, toolkit: TOOLKIT_VERSION, brief: relative(out, briefPath), briefHash: fileHash(briefPath),
    renderedAt: new Date().toISOString(), brand: b.brand, theme: b.theme, template: b.template, ...(b.style ? { style: b.style } : {}), ...(b.typography ? { typography: b.typography } : {}), catalogHash: catalogHash(),
    artifacts, inputs: fingerprints.map(i => ({ ...i, path: relative(out, i.path) })), assets,
    generation: { provider: "source-assets", costUsd: 0 },
    validation: { passed: true, checks: ["source hashes", "brand fonts", "text fit", "dimensions", "GTM media guard"] },
  };
  const temp = manifestPath + ".tmp";
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n"); renameSync(temp, manifestPath);
  writeFileSync(resolve(root, "latest.json"), JSON.stringify({ manifest: relative(root, manifestPath) }, null, 2) + "\n");
  return { manifest: manifestPath, cached: false };
}
