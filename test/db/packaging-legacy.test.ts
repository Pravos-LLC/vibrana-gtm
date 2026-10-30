// Real schema regression: timestamp triggers must not withdraw an unchanged legacy cover's approval.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, seed, signedIn } from "../support/seed.ts";
import { stageStory, digest } from "../../lib/story.ts";
import { png } from "../support/image.ts";
before(seed);
const dir = mkdtempSync(join(tmpdir(), "packaging-db-"));
const previousWorkspace = process.env.GTM_WORKSPACE;
process.env.GTM_WORKSPACE = dir;
const cal = { path: join(dir,"calendar.yaml"), timezone:"Europe/Berlin", accounts:{}, manual:[], items:[] };
const bytes = png({w:1920,h:1080}), sha256 = digest(bytes);
writeFileSync(join(dir,"cover.png"),bytes);
after(async()=> {
 await admin().from("gtm_stories").delete().in("id",["pkg-legacy-null","pkg-rough-promotion"]);
 if (previousWorkspace === undefined) delete process.env.GTM_WORKSPACE; else process.env.GTM_WORKSPACE = previousWorkspace;
 rmSync(dir,{recursive:true,force:true});
});
function manifest(id:string,stage?:string) {
 const path=join(dir,id+".yaml");
 writeFileSync(path,`id: ${id}\ntitle: Test cover\nlink: https://example.com\npipeline: short\nassets:\n  - id: ${id}-cover\n    title: Cover\n    kind: image\n    source: cover.png\n    channels: [youtube]\n${stage ? `    stage: ${stage}\n`:""}`);
 return path;
}
test("real null-stage legacy cover retains approval and persisted evidence on two identical restages",async()=> {
 const db=admin(),id="pkg-legacy-null",asset=id+"-cover",storage=`stories/${id}/${asset}-${sha256.slice(0,16)}.png`;
 await db.from("gtm_stories").delete().eq("id",id);
 assert.equal((await db.from("gtm_stories").insert({id,title:"Legacy",link_url:"https://example.com",pipeline:"short"})).error,null);
 assert.equal((await db.storage.from("content-review").upload(storage,bytes,{contentType:"image/png",upsert:true})).error,null);
 assert.equal((await db.from("gtm_story_assets").insert({id:asset,story_id:id,title:"Cover",kind:"image",source:"cover.png",sha256,storage_path:storage,stage:null,metadata:{},updated_at:"2026-10-13T00:00:00Z"})).error,null);
 assert.equal((await db.from("gtm_story_asset_channels").insert({asset_id:asset,channel:"youtube"})).error,null);
 const owner=await signedIn("owner");
 const row=(await db.from("gtm_story_assets").select("revision").eq("id",asset).single()).data!;
 assert.equal((await owner.rpc("gtm_decide_story_asset",{p_asset_id:asset,p_channel:"youtube",p_status:"approved",p_note:"",p_expected_sha256:sha256,p_expected_revision:row.revision})).error,null);
 const file=manifest(id);
 await stageStory(db,file,cal,true); // DB-backed dry run authenticates legacy, with no writes.
 for(let i=0;i<2;i++) {
  await stageStory(db,file,cal);
  const after=(await db.from("gtm_story_assets").select("metadata,stage").eq("id",asset).single()).data!;
  assert.equal(after.metadata.packaging_legacy.sha256,sha256); assert.equal(after.stage,null);
  const approval=(await db.from("gtm_story_asset_channels").select("status,approved_sha256").eq("asset_id",asset).single()).data!;
  assert.deepEqual(approval,{status:"approved",approved_sha256:sha256});
 }
});
test("real newly staged rough cover cannot be promoted through the legacy exemption",async()=> {
 const db=admin(),id="pkg-rough-promotion";
 await db.from("gtm_stories").delete().eq("id",id);
 await stageStory(db,manifest(id,"rough-cut"),cal);
 await assert.rejects(stageStory(db,manifest(id,"final"),cal),/missing packaging manifest/);
 const row=(await db.from("gtm_story_assets").select("stage").eq("id",id+"-cover").single()).data!;
 assert.equal(row.stage,"rough-cut");
});
