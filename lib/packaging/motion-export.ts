import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { dirname, resolve, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { checkPackage, fileHash, type PackagingManifest } from "./model";
import { SIZES, type Shape } from "./catalog";
/** Native, seekable layers -> video. WebM carries alpha; MP4 is an opaque review/export option. */
export async function exportMotion(manifestPath: string, output: string, shape: Shape = "landscape") {
  const errors=checkPackage(manifestPath);if(errors.length)throw new Error(errors.join("; "));
  if(![".mp4",".webm"].includes(extname(output)))throw new Error("Motion output must be .mp4 or .webm (alpha)");
  const m=JSON.parse(readFileSync(manifestPath,"utf8")) as PackagingManifest;
  const a=m.artifacts?.find(a=>a.role==="motion" && a.path===`${shape}-motion.html`);
  if(!a)throw new Error("Render a registered style with this shape before exporting motion");
  const ffmpeg=spawnSync("ffmpeg",["-version"],{stdio:"ignore"});if(ffmpeg.status!==0)throw new Error("ffmpeg is needed for native motion video export; the HTML preview remains available");
  const dir=mkdtempSync(join(tmpdir(),"packaging-motion-")), [width,height]=SIZES[shape], browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width,height:height+62}});
    await page.route("**/*",route=>route.request().url().startsWith("file:")?route.continue():route.abort());
    await page.goto(pathToFileURL(resolve(dirname(manifestPath),a.path)).href);
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
    await page.addStyleTag({content:"body{background:transparent!important}"});
    for(let frame=0;frame<120;frame++){
      await page.evaluate(f=>(window as unknown as {packagingSeek:(f:number)=>void}).packagingSeek(f),frame*120/119);
      await page.locator(".canvas").screenshot({path:join(dir,`${String(frame).padStart(4,"0")}.png`),omitBackground:true,animations:"disabled"});
    }
    mkdirSync(dirname(resolve(output)),{recursive:true});
    const codec=extname(output)===".webm"?["-c:v","libvpx-vp9","-pix_fmt","yuva420p","-auto-alt-ref","0","-b:v","0","-crf","24"]:["-c:v","libx264","-pix_fmt","yuv420p","-crf","18","-movflags","+faststart"];
    const run=spawnSync("ffmpeg",["-y","-v","error","-framerate","30","-i",join(dir,"%04d.png"),...codec,resolve(output)],{encoding:"utf8",maxBuffer:1024*1024});
    if(run.status!==0)throw new Error(`Motion encoding failed: ${run.stderr.slice(0,600)}`);
    const record={schema:1,story:m.story,shape,fps:30,durationSeconds:4,alpha:extname(output)===".webm",inputManifestHash:fileHash(manifestPath),motionHtmlHash:a.sha256,outputHash:fileHash(output),costUsd:0};
    writeFileSync(output+".motion.json",JSON.stringify(record,null,2)+"\n");return {path:resolve(output),...record};
  } finally {await browser.close();rmSync(dir,{recursive:true,force:true});}
}
