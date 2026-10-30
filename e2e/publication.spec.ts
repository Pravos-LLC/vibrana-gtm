import {test,expect,type Page} from "@playwright/test";
import {admin,PASSWORD,USERS} from "../test/support/seed";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const story="s1-98-publication-fixture", catalog=`packaging-${story}`,clipStory=`${story}-clip`,asset="publication-template-fixture";
async function login(page:Page){await page.goto("/login");await page.getByLabel("Email").fill(USERS.owner.email);await page.getByLabel("Password").fill(PASSWORD);await page.getByRole("button",{name:"Sign in"}).click();await page.waitForURL(u=>!u.pathname.startsWith("/login"));}
test.beforeAll(async()=>{
 const db=admin(),bytes=readFileSync("test/fixtures/card.png"),sha256=createHash("sha256").update(bytes).digest("hex"),key=`stories/${catalog}/${asset}.png`;
 const check=(result:{error:{message:string}|null})=>{if(result.error)throw new Error(result.error.message);};
 check(await db.from("gtm_stories").upsert([{id:story,title:"Publication fixture",link_url:"https://example.com/episode",pipeline:"episode"},{id:clipStory,title:"A selected promotional clip",link_url:"https://example.com/clip"},{id:catalog,title:"Thumbnail template review: Publication fixture",link_url:"https://example.com/episode"}]));
 check(await db.storage.from("content-review").upload(key,bytes,{contentType:"image/png",upsert:true}));
 check(await db.from("gtm_story_assets").upsert({id:asset,story_id:catalog,title:"make-clear / sample-author / dark / landscape",kind:"image",source:"template.jpg",storage_path:key,sha256,stage:"package",metadata:{packaging_candidate:true,publication_story_id:story,packaging_brand:"sample-author",packaging_style:"make-clear",packaging_theme:"dark",packaging_shape:"landscape",width:1920,height:1080,publication_title:"A descriptive title",publication_companion_stories:[clipStory]}}));
 const episodeBody="---\nyoutube_title: Descriptive episode title\n---\nActual episode description",clipBody="---\nyoutube_title: Promotional clip title\n---\nClip description",digest=(body:string)=>createHash("sha256").update(body).digest("hex");
 check(await db.from("gtm_story_assets").upsert([{id:`${story}-copy`,story_id:story,kind:"copy",title:"Episode copy",source:"episode.md",body:episodeBody,sha256:digest(episodeBody),metadata:{}},{id:`${story}-clip-copy`,story_id:clipStory,kind:"copy",title:"Promotional clip title",source:"clip.md",body:clipBody,sha256:digest(clipBody),metadata:{}}]));
 check(await db.from("gtm_story_asset_channels").upsert([{asset_id:`${story}-copy`,channel:"youtube",status:"pending"},{asset_id:`${story}-clip-copy`,channel:"youtube",status:"pending"}]));
});
test.afterAll(async()=>{await admin().from("gtm_stories").delete().in("id",[story,catalog,clipStory]);});
test("asset-first template review persists owner feedback and schedules nothing",async({page})=>{
 await login(page);await page.goto(`/content?view=templates&story=${story}`);
 const card=page.getByTestId("template-candidate");await expect(card).toHaveCount(1);
 await expect(card.getByRole("textbox")).not.toBeVisible();await card.getByText("Feedback",{exact:true}).click();
 await card.getByRole("textbox").fill("Keep the faces clear; use stronger type");await card.getByRole("button",{name:"Save iteration note"}).click();await expect(card.getByRole("status")).toContainText("Saved");
 const db=admin();expect((await db.from("gtm_story_feedback").select("body").eq("asset_id",asset)).data?.some(n=>n.body.includes("Keep the faces clear"))).toBe(true);
 expect((await db.from("gtm_story_asset_channels").select("asset_id").eq("asset_id",asset)).data).toEqual([]);
 await card.getByRole("link",{name:"See in publication mockups"}).click();await expect(page.getByRole("heading",{name:"Publication review",exact:true})).toBeVisible();
 await page.getByRole("combobox",{name:"Promotion clip"}).selectOption(clipStory);await expect(page.getByTestId("publication-youtube").getByRole("heading",{name:"Promotional clip title"})).toBeVisible();
 await page.getByRole("tab",{name:"spotify",exact:true}).click();await expect(page.getByRole("combobox",{name:"Promotion clip"})).toHaveCount(0);await expect(page.getByTestId("publication-spotify").getByRole("heading",{name:"A descriptive title"})).toBeVisible();await page.getByText("About this episode",{exact:true}).click();await expect(page.getByTestId("publication-spotify")).toContainText("Actual episode description");
 for(const platform of ["spotify","youtube","linkedin","instagram"]){await page.getByRole("tab",{name:platform,exact:true}).click();await expect(page.getByTestId(`publication-${platform}`)).toBeVisible();}
});
