import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, seed, signedIn } from "../support/seed";
import { stageStory, digest, writeStory, checkStoryApprovalDb } from "../../lib/story";
import { loadPieceReview, decidePiecePart, savePieceText, completePieceFix } from "../../lib/piece-review";
import { mp4 } from "../support/mp4";
import type { SupabaseClient } from "@supabase/supabase-js";
before(seed);

test("one shared piece: identical restaging keeps both decisions; only changed text reopens; stale tabs fail and queued content stays frozen", async () => {
  const db=admin(), owner=await signedIn("owner"), dir=mkdtempSync(join(tmpdir(),"shared-piece-"));
  const old=process.env.GTM_WORKSPACE; process.env.GTM_WORKSPACE=dir;
  const storyId="shared-stage-test";
  const manifest=join(dir,"story.yaml"), cal={path:join(dir,"calendar.yaml"),timezone:"Europe/Berlin",accounts:{},manual:[],items:[]};
  try {
    await db.from("gtm_stories").delete().eq("id",storyId);
    writeFileSync(join(dir,"text.md"),"The one caption."); writeFileSync(join(dir,"video.mp4"),mp4());
    writeFileSync(manifest,`id: ${storyId}\ntitle: Shared staging\nlink: https://example.com/shared\nassets:\n  - { id: shared-stage-text, title: Text, kind: copy, source: text.md, channels: [linkedin,instagram,youtube] }\n  - { id: shared-stage-video, title: Video, kind: video, source: video.mp4, channels: [linkedin,instagram,youtube], stage: final }\n`);
    let inject=true;
    const flaky=new Proxy(db,{get(target,key){if(key!=="from"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
      return (table:string)=>{const builder=target.from(table);return new Proxy(builder,{get(b,k){if(k==="insert")return (row:{id?:string})=>{if(inject&&table==="gtm_story_assets"&&row.id==="shared-stage-video"){inject=false;return Promise.resolve({data:null,error:{message:"injected partial failure"}});}return b.insert(row);};const value=Reflect.get(b,k);return typeof value==="function"?value.bind(b):value;}});};}});
    // This build has the dispatcher and the database has the delivery ledger: --shared needs no override (review #145 N1).
    assert.deepEqual(await (await import("../../lib/piece-review")).sharedDeliveryInstalled(db),{ok:true});
    const on={shared:true};
    // An offline --shared dry run cannot check anything, so it fails instead of passing (review #145 R2).
    await assert.rejects(stageStory(null,manifest,cal,true,false,undefined,on),/A --shared dry run needs the database/);
    await assert.rejects(stageStory(flaky,manifest,cal,false,false,undefined,on),/injected partial failure/);
    assert.equal(await loadPieceReview(db,storyId),null);

    // Part-way: a restage without --shared would leave shared assets with no review; it says how to finish (#145 N5).
    await assert.rejects(stageStory(db,manifest,cal),/part-way into shared review .* restage with --shared/);
    await stageStory(db,manifest,cal,false,false,undefined,on);
    let s=(await loadPieceReview(db,storyId))!; assert.deepEqual(s.channels,["linkedin","instagram","youtube"]);
    assert.equal((await db.from("gtm_story_asset_channels").select("asset_id").in("asset_id",[s.text.asset.id,s.video.asset.id])).data?.length,0,"no maintained channel copies or decisions");
    for (const part of ["text","video"] as const) s=await decidePiecePart(owner,{storyId,part,decision:"approved",note:"",fingerprint:s[part].fingerprint,revision:s[part].asset.revision});
    await stageStory(db,manifest,cal);
    s=(await loadPieceReview(db,storyId))!; assert.equal(s.text.status,"approved");assert.equal(s.video.status,"approved");
    const originalManifest=String((await import("node:fs")).readFileSync(manifest));
    writeFileSync(manifest,originalManifest.replaceAll("linkedin,instagram,youtube","instagram"));
    await assert.rejects(stageStory(db,manifest,cal),/Selected channels differ/);
    assert.deepEqual((await loadPieceReview(db,storyId))!.channels,["linkedin","instagram","youtube"]);
    // A Substack companion on the copy is not drift: configure and the restage check share one channel rule (#145 N3).
    writeFileSync(manifest,originalManifest.replace("kind: copy, source: text.md, channels: [linkedin,instagram,youtube]","kind: copy, source: text.md, channels: [linkedin,instagram,youtube,newsletter]"));
    await stageStory(db,manifest,cal,true,false,undefined,on);
    writeFileSync(manifest,originalManifest);
    const stale=s.text;
    await db.from("gtm_content_items").upsert({id:"shared-queued",story_id:storyId,week:42,date:"2030-10-08",time:"08:30",pillar:"proof",title:"Queued",format:"video",channels:["linkedin"],status:"scheduled",body:"Frozen caption",media:["frozen.mp4"],zernio_post_id:"provider-frozen"});
    s=await savePieceText(owner,{storyId,body:"A human edit.",fingerprint:s.text.fingerprint,revision:s.text.asset.revision});
    assert.equal(s.text.status,"pending"); assert.equal(s.video.status,"approved");
    await assert.rejects(savePieceText(owner,{storyId,body:"Stale edit",fingerprint:stale.fingerprint,revision:stale.asset.revision}),/changed while/);
    await assert.rejects(stageStory(db,manifest,cal),/edited in the dashboard/);
    assert.equal((await db.from("gtm_content_items").select("body").eq("id","shared-queued").single()).data?.body,"Frozen caption");
    // Shared: a change request on a part waiting for its fix is John's newer decision; the fix authorisation ends (#143 F3).
    let w=await decidePiecePart(owner,{storyId,part:"text",decision:"fixing",note:"First fix",fingerprint:s.text.fingerprint,revision:s.text.asset.revision});
    const first=w.fixes[0];
    w=await decidePiecePart(owner,{storyId,part:"text",decision:"changes",note:"Rewrite it instead",fingerprint:w.text.fingerprint,revision:w.text.asset.revision});
    assert.equal(w.text.status,"changes"); assert.equal(w.fixes.length,0);
    await assert.rejects(completePieceFix(db,{fixId:first.id,fingerprint:w.text.fingerprint,revision:w.text.asset.revision,actor:"test-worker",verification:"Applied the first fix only",onlyAuthorisedChanges:true}),/no longer authorised|fix|not/i);
    s=await decidePiecePart(owner,{storyId,part:"text",decision:"fixing",note:"Change human to owner",fingerprint:w.text.fingerprint,revision:w.text.asset.revision});
    const f=s.fixes[0]; assert.equal(s.ready,false);
    // gtm story resolve cannot close the fix's note: it names complete-fix instead (review #147 F1).
    const { assertNotSharedFix } = await import("../../lib/piece-review");
    await assert.rejects(assertNotSharedFix(db,f.feedback_id!),new RegExp(`shared fix authorisation .*gtm piece complete-fix ${f.id}`));
    await assertNotSharedFix(db,"00000000-0000-0000-0000-000000000000");
    await db.from("gtm_story_assets").update({body:"An owner edit.",sha256:digest("An owner edit.")}).eq("id",s.text.asset.id);
    s=(await loadPieceReview(db,storyId))!;
    s=await completePieceFix(db,{fixId:f.id,fingerprint:s.text.fingerprint,revision:s.text.asset.revision,actor:"test-worker",verification:"Compared complete diff; only authorised word changed",onlyAuthorisedChanges:true});
    assert.equal(s.text.status,"approved"); assert.equal(s.video.status,"approved");
    await assert.rejects(completePieceFix(db,{fixId:f.id,fingerprint:s.text.fingerprint,revision:s.text.asset.revision,actor:"test-worker",verification:"Repeated",onlyAuthorisedChanges:true}),/no longer authorised/);
  } finally { if(old===undefined)delete process.env.GTM_WORKSPACE;else process.env.GTM_WORKSPACE=old; await db.from("gtm_content_items").delete().eq("id","shared-queued");await db.from("gtm_stories").delete().eq("id",storyId);rmSync(dir,{recursive:true,force:true}); }
});

test("staging detects a concurrent human edit after its read", async () => {
 const rows: unknown[]=[];
 const existing={id:"cas-text",kind:"copy",story_id:"cas-story",sha256:digest("old"),revision:1,storage_path:null,metadata:{},stage:"final"};
 const db={from(table:string){return {
   select(){return {in:async()=>({data:table==="gtm_story_assets"?[existing]:[],error:null}),eq:async()=>({data:table==="gtm_story_assets"?[existing]:[],error:null})};},
   upsert:async()=>({data:null,error:null}),
   update(row:unknown){rows.push(row);const q={eq:()=>q,select:()=>q,maybeSingle:async()=>({data:null,error:null})};return q;}
 };}} as unknown as SupabaseClient;
 await assert.rejects(writeStory(db,{id:"cas-story",title:"CAS",link:"https://example.com"},[{id:"cas-text",title:"Text",kind:"copy",source:"text.md",abs:"text.md",sha256:digest("new"),body:"new",url:null,content:Buffer.from("new"),bytes:3,channels:[]}]),/changed while staging/);
 assert.equal(rows.length,1);
});

test("--shared refuses a Story with any asset outside a shared piece, so a legacy image is never stranded (review #145 N4)", async () => {
  const db=admin(), dir=mkdtempSync(join(tmpdir(),"shared-legacy-"));
  const old=process.env.GTM_WORKSPACE; process.env.GTM_WORKSPACE=dir;
  const storyId="shared-legacy-test";
  const manifest=join(dir,"story.yaml"), cal={path:join(dir,"calendar.yaml"),timezone:"Europe/Berlin",accounts:{},manual:[],items:[]};
  try {
    await db.from("gtm_stories").delete().eq("id",storyId);
    assert.equal((await db.from("gtm_stories").insert({id:storyId,title:"Legacy carousel",link_url:"https://example.com/legacy"})).error,null);
    assert.equal((await db.from("gtm_story_assets").insert({id:"shared-legacy-slide",story_id:storyId,title:"Slide",kind:"image",source:"slide.png",storage_path:"stories/shared-legacy-test/slide.png",sha256:digest("slide"),metadata:{}})).error,null);
    writeFileSync(join(dir,"text.md"),"Follow-up caption."); writeFileSync(join(dir,"video.mp4"),mp4());
    writeFileSync(manifest,`id: ${storyId}\ntitle: Legacy carousel\nlink: https://example.com/legacy\nassets:\n  - { id: shared-legacy-text, title: Text, kind: copy, source: text.md, channels: [linkedin] }\n  - { id: shared-legacy-video, title: Video, kind: video, source: video.mp4, channels: [linkedin], stage: final }\n`);
    for (const dry of [true,false]) await assert.rejects(stageStory(db,manifest,cal,dry,false,undefined,{shared:true,assumeSharedDelivery:true}),/not part of a shared piece: shared-legacy-slide/);
    assert.equal(await loadPieceReview(db,storyId),null);
    assert.deepEqual((await db.from("gtm_story_assets").select("id,metadata").eq("story_id",storyId)).data,[{id:"shared-legacy-slide",metadata:{}}],"nothing written, nothing stamped");
  } finally { if(old===undefined)delete process.env.GTM_WORKSPACE;else process.env.GTM_WORKSPACE=old; await db.from("gtm_stories").delete().eq("id",storyId);rmSync(dir,{recursive:true,force:true}); }
});

test("a part-way shared piece whose manifest renames the video is refused before any write (review #145 R1)", async () => {
  const db=admin(), dir=mkdtempSync(join(tmpdir(),"shared-rename-"));
  const old=process.env.GTM_WORKSPACE; process.env.GTM_WORKSPACE=dir;
  const storyId="shared-rename-test";
  const manifest=join(dir,"story.yaml"), cal={path:join(dir,"calendar.yaml"),timezone:"Europe/Berlin",accounts:{},manual:[],items:[]};
  try {
    await db.from("gtm_stories").delete().eq("id",storyId);
    assert.equal((await db.from("gtm_stories").insert({id:storyId,title:"Rename",link_url:"https://example.com/rename"})).error,null);
    assert.equal((await db.from("gtm_story_assets").insert([
      {id:"shared-rename-text",story_id:storyId,title:"Text",kind:"copy",source:"text.md",sha256:digest("Caption"),body:"Caption",metadata:{shared_review:true}},
      {id:"shared-rename-video",story_id:storyId,title:"Video",kind:"video",source:"video.mp4",storage_path:"stories/shared-rename-test/v1.mp4",stage:"final",sha256:digest("v1"),metadata:{shared_review:true}},
    ])).error,null);
    writeFileSync(join(dir,"text.md"),"Caption"); writeFileSync(join(dir,"video.mp4"),mp4());
    writeFileSync(manifest,`id: ${storyId}\ntitle: Rename\nlink: https://example.com/rename\nassets:\n  - { id: shared-rename-text, title: Text, kind: copy, source: text.md, channels: [linkedin] }\n  - { id: shared-rename-video-v2, title: Video, kind: video, source: video.mp4, channels: [linkedin], stage: final }\n`);
    await assert.rejects(stageStory(db,manifest,cal,false,false,undefined,{shared:true,assumeSharedDelivery:true}),/exactly one video; this piece would have 2/);
    assert.equal((await db.from("gtm_story_assets").select("id").eq("id","shared-rename-video-v2")).data?.length,0,"nothing uploaded or stamped");
  } finally { if(old===undefined)delete process.env.GTM_WORKSPACE;else process.env.GTM_WORKSPACE=old; await db.from("gtm_stories").delete().eq("id",storyId);rmSync(dir,{recursive:true,force:true}); }
});
