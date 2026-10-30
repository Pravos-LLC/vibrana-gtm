import test from "node:test";
import assert from "node:assert/strict";
import { publicationPackage } from "../lib/packaging/publication";
import type { StoryAsset, StoryChannel } from "../lib/story";
const asset=(id:string,story:string,kind:StoryAsset["kind"],body:string|null=null,meta:Record<string,unknown>={}):StoryAsset=>({id,story_id:story,kind,title:id,source:id+".mp4",sha256:"a".repeat(64),revision:1,storage_path:id,body,url:null,metadata:meta,stage:"final"});
const row=(id:string,ch:string):StoryChannel=>({asset_id:id,channel:ch,status:"pending",approved_sha256:null,note:""});
test("publication keeps same-ratio companion exports bound to their actual platforms",()=>{
 const assets=[asset("main-copy","ep","copy","---\nyoutube_title: Descriptive episode title\n---\nEpisode description"),asset("ig-video","clip","video"),asset("yt-video","clip","video"),asset("ig-copy","clip","copy","---\nfirst_comment: Actual IG comment\n---\nIG caption"),asset("yt-copy","clip","copy","YT caption")];
 const channels=[row("main-copy","youtube"),row("ig-video","instagram"),row("yt-video","youtube"),row("ig-copy","instagram"),row("yt-copy","youtube")];
 const p=publicationPackage({id:"ep",title:"Episode",link_url:"https://example.com/ep"},assets,channels,new Map(assets.map(a=>[a.id,"https://example.com/"+a.id])),"Sample Author Show");
 assert.equal(p.clips[0].media.instagram?.[0].id,"ig-video");assert.equal(p.clips[0].media.youtube?.[0].id,"yt-video");assert.deepEqual(p.clips[0].media.linkedin,[]);
 assert.equal(p.clips[0].captions.instagram,"IG caption");assert.equal(p.clips[0].firstComments.instagram,"Actual IG comment");assert.equal(p.title,"Descriptive episode title");
});
test("selected template pairs its actual square/portrait exports without changing staged copy",()=>{
 const meta={packaging_candidate:true,publication_story_id:"ep",packaging_style:"make-clear",packaging_brand:"sample-author",packaging_theme:"dark",publication_title:"A descriptive candidate title"};
 const assets=[asset("copy","ep","copy","---\nyoutube_title: Owner title\n---\nOwner description"),asset("wide","packaging-ep","image",null,{...meta,width:1920,height:1080}),asset("square","packaging-ep","image",null,{...meta,width:1080,height:1080}),asset("vertical","packaging-ep","image",null,{...meta,width:1080,height:1920})];
 const p=publicationPackage({id:"ep",title:"Episode",link_url:"https://example.com"},assets,[row("copy","youtube")],new Map(),"Sample Author Show","wide");
 assert.equal(p.channels.spotify.cover?.id,"square");assert.equal(p.channels.youtube.cover?.id,"wide");assert.equal(p.channels.instagram.cover?.id,"vertical");assert.equal(p.title,"A descriptive candidate title");
 assert.equal(p.description,"Owner description");assert.equal(assets[0].body,"---\nyoutube_title: Owner title\n---\nOwner description");assert.equal(p.clips.length,0);
});
