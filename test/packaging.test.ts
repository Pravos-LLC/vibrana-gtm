import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PROFILES, TEMPLATES, TOOLKIT_VERSION, SIZES } from "../lib/packaging/catalog";
import { png } from "./support/image";
import { Thumbnail } from "../lib/packaging/Thumbnail";
import { briefProblems, catalogHash, checkPackage, fileHash, packagingGate, legacyPackagingRecord, type PackagingBrief, type PackagingManifest } from "../lib/packaging/model";
import { deriveBrief, reviseBrief } from "../lib/packaging/ops";
import { generatePlate } from "../lib/packaging/plate";
import { renderPackage } from "../lib/packaging/render";
import { COVER_STYLES, HEADLINE_TYPES, headlineType } from "../lib/packaging/styles";
import { motionState, motionDocument } from "../lib/packaging/motion";

function brief(): PackagingBrief {
  return { schema: 1, story: "test-story", brand: "sample-author", theme: "dark", template: "clear-conversation", ready: true,
    audience: "Conscious builders", promise: "An account of community-owned language data", thumbnail: "Their language. Their model.",
    opening: { text: "Give us microphones", spoken: "There's the tribe of the Māori", source: "transcript.json" },
    payoff: { source: "transcript.json", seconds: 49, explanation: "The community asks to record its own language" },
    title: "Who owns the recordings?", description: "A conversation with example_approveroesg Steele.", sources: [{ path: "transcript.json", role: "transcript" }],
    portraits: [], shapes: ["landscape"], selection: "Question and human account" };
}
test("all 72 style/profile/theme combinations use engagement type independently of identity", () => {
  let count=0;
  for(const brand of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) for(const theme of ["light","dark"] as const) for(const style of Object.keys(COVER_STYLES) as Array<keyof typeof COVER_STYLES>){
    const b={...brief(),brand,theme,style,template:COVER_STYLES[style].family,backdropText:"VOICE",portraits:[{path:"one",name:"One"},{path:"two",name:"Two"}]};
    assert.deepEqual(briefProblems(b),[]);
    const html=renderToStaticMarkup(createElement(Thumbnail,{brief:b,shape:"landscape",portraits:["one","two"]}));
    assert.ok(html.includes(HEADLINE_TYPES[headlineType(b)].family));assert.ok(html.includes(PROFILES[brand].display));
    assert.ok(html.includes("data-layer=\"headline\""));assert.equal((html.match(/data-layer="subject"/g)??[]).length,2);count++;
  }
  assert.equal(count,72);assert.equal(headlineType({style:"editorial-take",typography:"impact"}),"impact");
  assert.match(briefProblems({...brief(),style:"unregistered" as never}).join(),/unregistered cover style/);
  assert.match(briefProblems({...brief(),typography:"website-font" as never}).join(),/unregistered headline/);
});
test("native motion clamps boundaries and its exact hold frame equals the still",()=>{
  for(const preset of ["reveal","editorial","split"] as const){
    assert.deepEqual(motionState(30,30,4,preset),{opacity:1,offset:0,scale:1,accent:1});
    assert.equal(motionState(0,30,4,preset).opacity,0);assert.equal(motionState(120,30,4,preset).opacity,0);
    assert.deepEqual(motionState(-50,30,4,preset),motionState(0,30,4,preset));
  }
  assert.throws(()=>motionState(NaN),/finite frame/);
});
test("changed native motion artifacts invalidate their package",()=>{
  const f=fixture();try{
    writeFileSync(join(f.dir,"motion.html"),"verified native motion");f.manifest.artifacts=[{path:"motion.html",sha256:fileHash(join(f.dir,"motion.html")),role:"motion"}];
    writeFileSync(f.path,JSON.stringify(f.manifest));assert.deepEqual(checkPackage(f.path),[]);
    writeFileSync(join(f.dir,"motion.html"),"changed");assert.match(checkPackage(f.path).join(),/changed or missing motion/);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("every family supports every brand and theme without leaking another brand identity", () => {
  let rendered = 0;
  for (const brand of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) for (const theme of ["light", "dark"] as const)
    for (const template of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const b = { ...brief(), brand, theme, template };
      assert.deepEqual(briefProblems(b), []);
      const html = renderToStaticMarkup(createElement(Thumbnail, { brief: b, shape: "landscape", portraits: [] }));
      assert.ok(html.includes(PROFILES[brand].display));
      assert.ok(html.includes(b.thumbnail));
      for (const other of Object.keys(PROFILES).filter(k => k !== brand) as Array<keyof typeof PROFILES>) assert.ok(!html.includes(PROFILES[other].name));
      rendered++;
    }
  assert.equal(rendered, 42);
});
test("bad brand/theme/template, incomplete proof, oversized text and duplicate shapes are actionable failures", () => {
  const b = brief(); b.ready = false; b.payoff.seconds = -1; b.thumbnail = "x".repeat(101); b.shapes = ["portrait", "portrait"];
  assert.ok(briefProblems(b).length >= 4);
  for (const k of ["brand", "theme", "template"] as const) {
    const b = { ...brief(), [k]: "../unregistered" } as PackagingBrief;
    assert.ok(briefProblems(b).some(e => /unregistered|invalid theme/.test(e)));
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "packaging-"));
  writeFileSync(join(dir, "brief.json"), JSON.stringify(brief()));
  writeFileSync(join(dir, "transcript.json"), "spoken account");
  writeFileSync(join(dir, "landscape.png"), png({ w: 1920, h: 1080 }));
  const manifest: PackagingManifest = {
    schema: 1, story: "test-story", toolkit: TOOLKIT_VERSION, brief: "brief.json", briefHash: fileHash(join(dir, "brief.json")),
    brand: "sample-author", theme: "dark", template: "clear-conversation", catalogHash: catalogHash(), renderedAt: "2026-10-14",
    inputs: [{ path: "transcript.json", sha256: fileHash(join(dir, "transcript.json")) }],
    assets: [{ path: "landscape.png", sha256: fileHash(join(dir, "landscape.png")), width: SIZES.landscape[0], height: SIZES.landscape[1], role: "cover" }],
    generation: { provider: "source-assets", costUsd: 0 }, validation: { passed: true, checks: [] },
  };
  const path = join(dir, "manifest.json"); writeFileSync(path, JSON.stringify(manifest));
  return { dir, path, manifest };
}
test("provenance detects changed copy, source, output and a cover from another Story", () => {
  const f = fixture();
  try {
    assert.deepEqual(checkPackage(f.path), []);
    assert.ok(checkPackage(f.path, { story: "another-story", assetPath: join(f.dir, "landscape.png"), sha256: f.manifest.assets[0].sha256 }).length);
    writeFileSync(join(f.dir, "transcript.json"), "changed");
    assert.match(checkPackage(f.path).join(), /stale input/);
    writeFileSync(join(f.dir, "landscape.png"), "changed");
    assert.match(checkPackage(f.path).join(), /changed or missing export/);
    const b = brief(); b.thumbnail = "A different promise"; writeFileSync(join(f.dir, "brief.json"), JSON.stringify(b));
    assert.match(checkPackage(f.path).join(), /brief changed/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("new covers cannot bypass provenance by renaming, unchanged legacy bytes retain approval compatibility", () => {
  const a = { id: "plain-image", title: "Artwork", kind: "image", abs: "/tmp/x.jpg", sha256: "abc", channels: ["youtube"], stage: "final" };
  assert.throws(() => packagingGate("test", [a], [], "short"), /gtm packaging brief/);
  assert.doesNotThrow(() => packagingGate("test", [a], [{ id: a.id, sha256: a.sha256, stage: "final", updated_at: "2026-10-13T00:00:00Z" }], "short"));
  assert.throws(() => packagingGate("test", [{ ...a, sha256: "new" }], [{ id: a.id, sha256: a.sha256, stage: "final", updated_at: "2026-10-13T00:00:00Z" }], "short"));
  assert.doesNotThrow(() => packagingGate("test", [a], [], "carousel"));
  assert.doesNotThrow(() => packagingGate("test", [{ ...a, stage: "rough-cut" }], [], "short"));
});
test("brief derives owner copy without approving it; revision requests preserve original bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "packaging-derive-")), saved = process.env.GTM_CALENDAR;
  try {
    process.env.GTM_CALENDAR = join(dir, "calendar.yaml");
    writeFileSync(join(dir, "owner.md"), '---\nyoutube_title: "Owner title"\n---\nOwner words.');
    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, 'id: test-story\ntitle: test\npipeline: episode\nassets:\n  - kind: copy\n    source: owner.md\n    channels: [youtube]\n');
    const result = deriveBrief("test-story", { manifest, brand: "aios", theme: "light" });
    const original = readFileSync(result.brief, "utf8"), b = JSON.parse(original);
    assert.equal(b.title, "Owner title"); assert.equal(b.description, "Owner words.");
    assert.equal(b.ready, false); assert.equal(b.brand, "aios"); assert.equal(b.theme, "light");
    assert.equal(deriveBrief("test-story", { manifest }).created, false);
    reviseBrief(result.brief, [{ id: "feedback-1", text: "Use the light theme" }]);
    assert.equal(readFileSync(result.brief, "utf8"), original);
  } finally {
    if (saved === undefined) delete process.env.GTM_CALENDAR; else process.env.GTM_CALENDAR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing brand font refuses rendering instead of substituting a different brand", async () => {
  const f = fixture();
  try { await assert.rejects(renderPackage(join(f.dir, "brief.json"), { assetRoot: join(f.dir, "missing") }), /Missing licensed font/); }
  finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("plate generation resumes a failed poll, caches completed bytes, and never rebills on a rerun", async () => {
  const dir = mkdtempSync(join(tmpdir(), "packaging-plate-")), original = globalThis.fetch, oldKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "synthetic-test-key";
  let submits = 0, firstPoll = true;
  const output = join(dir, "plate.png");
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") {
      submits++;
      return Response.json({ request_id: "test", status_url: "https://queue.fal.run/status/test", response_url: "https://queue.fal.run/result/test" });
    }
    if (String(url).includes("/status/")) {
      if (firstPoll) { firstPoll = false; return new Response("", { status: 503 }); }
      return Response.json({ status: "COMPLETED" });
    }
    if (String(url).includes("/result/")) return Response.json({ images: [{ url: "https://fal.media/test.png" }] });
    return new Response(new Uint8Array(png()));
  };
  try {
    await assert.rejects(generatePlate("An empty mountain plate", undefined, output), /polling failed/);
    await generatePlate("An empty mountain plate", undefined, output);
    const cached = await generatePlate("An empty mountain plate", undefined, output);
    assert.equal(cached.cached, true); assert.equal(submits, 1);
    await assert.rejects(generatePlate("A different plate", undefined, output), /different request/);
    assert.equal(submits, 1);
  } finally {
    globalThis.fetch = original;
    if (oldKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rough-cut promotion and post-toolkit assets cannot masquerade as legacy covers", () => {
  const a = { id: "cover", title: "Cover", kind: "image", abs: "/tmp/cover.jpg", sha256: "abc", channels: ["youtube"], stage: "final" };
  assert.throws(() => packagingGate("test", [a], [{ id: "cover", sha256: "abc", stage: "rough-cut", updated_at: "2026-10-13T00:00:00Z" }], "short"), /missing packaging/);
  assert.throws(() => packagingGate("test", [a], [{ id: "cover", sha256: "abc", stage: "final", updated_at: "2026-10-15T00:00:00Z" }], "short"), /missing packaging/);
  assert.throws(() => packagingGate("test", [a], [{ id: "cover", sha256: "abc" }], "short"), /missing packaging/);
});
test("opening and payoff proofs must be tracked even when omitted from general sources", () => {
  const f = fixture();
  try {
    const b = brief(); b.opening.source = "missing-opening.json"; b.payoff.source = "missing-payoff.json";
    writeFileSync(join(f.dir, "brief.json"), JSON.stringify(b));
    f.manifest.briefHash = fileHash(join(f.dir, "brief.json")); writeFileSync(f.path, JSON.stringify(f.manifest));
    assert.match(checkPackage(f.path).join(), /untracked input/);
    writeFileSync(join(f.dir, "missing-opening.json"), "opening"); writeFileSync(join(f.dir, "missing-payoff.json"), "payoff");
    for (const path of [b.opening.source, b.payoff.source]) f.manifest.inputs.push({ path, sha256: fileHash(join(f.dir,path)) });
    writeFileSync(f.path, JSON.stringify(f.manifest)); assert.deepEqual(checkPackage(f.path), []);
    writeFileSync(join(f.dir, b.payoff.source), "changed outcome"); assert.match(checkPackage(f.path).join(), /stale input/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("concurrent paid requests have one submission; ambiguous failures never resubmit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "packaging-race-")), original = globalThis.fetch, oldKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "synthetic-test-key"; let submits = 0;
  globalThis.fetch = async () => { submits++; await new Promise(r => setTimeout(r,20)); throw new Error("ambiguous timeout"); };
  try {
    const out = join(dir,"plate.png"), results = await Promise.allSettled([generatePlate("A plate",undefined,out),generatePlate("A plate",undefined,out)]);
    assert.equal(submits,1); assert.ok(results.every(r => r.status === "rejected"));
    await assert.rejects(generatePlate("A plate",undefined,out), /no automatic resubmission/); assert.equal(submits,1);
  } finally { globalThis.fetch = original; if (oldKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = oldKey; rmSync(dir,{recursive:true,force:true}); }
});

test("null-stage historical finals retain hash-bound legacy evidence after repeated restage", () => {
 const e={id:"cover",sha256:"abc",stage:null,updated_at:"2026-10-13T00:00:00Z"};
 const marker=legacyPackagingRecord(e);assert.ok(marker);
 const restaged={...e,updated_at:"2026-10-15T00:00:00Z",metadata:{packaging_legacy:marker}};
 assert.deepEqual(legacyPackagingRecord(restaged),marker);
 assert.equal(legacyPackagingRecord({...restaged,sha256:"changed"}),undefined);
 assert.equal(legacyPackagingRecord({...restaged,stage:"rough-cut"}),undefined);
 assert.equal(legacyPackagingRecord({...e,updated_at:"2026-10-15T00:00:00Z"}),undefined);
});

test("illustrations are explicit source art, never automatic schematic decoration", () => {
 const b={...brief(),template:"explain-mechanism" as const,backgroundTreatment:"photographic" as const,focal:"source-art.png"};
 const html=renderToStaticMarkup(createElement(Thumbnail,{brief:b,shape:"landscape",portraits:[],focal:"data:image/png;base64,test"}));
 assert.ok(html.includes("focal-art"));assert.ok(html.includes("photographic"));assert.ok(!html.includes("<svg"));
 const f=fixture();try{writeFileSync(join(f.dir,"brief.json"),JSON.stringify(b));assert.match(checkPackage(f.path).join(),/untracked input/);}finally{rmSync(f.dir,{recursive:true,force:true});}
});

test("native playback keeps running when its first animation timestamps are equal", () => {
  const nodes: Record<string, any> = Object.fromEntries([".canvas", "#seek", "#stage", "#frame", "#play", "#still", "#outro"].map(key => [key, { style: {}, value: "30", addEventListener() {} }]));
  const frames = new Map<number, (timestamp: number) => void>();
  let id = 0;
  const tick = (timestamp: number) => {
    const next = frames.entries().next().value;
    assert.ok(next, "playback must remain scheduled until its directional endpoint");
    frames.delete(next[0]); next[1](timestamp);
  };
  const html = motionDocument("<html><head></head><body><main class='canvas'></main></body></html>", 1920, 1080, "reveal");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  runInNewContext(script, {
    window: {}, innerWidth: 1920, innerHeight: 1142,
    document: { querySelector: (key: string) => nodes[key], querySelectorAll: () => [] },
    addEventListener() {}, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: (timestamp: number) => void) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
  });
  nodes["#play"].onclick(); tick(10); tick(10); tick(110);
  assert.ok(Number(nodes["#seek"].value) > 0);
  nodes["#outro"].onclick(); tick(200); tick(200); tick(300);
  assert.ok(Number(nodes["#seek"].value) < 120);
});
