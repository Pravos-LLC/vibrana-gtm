import { test, expect } from "@playwright/test";
import { thumbnailCss } from "../lib/packaging/Thumbnail";
import { motionDocument } from "../lib/packaging/motion";
import { coverStyleCss } from "../lib/packaging/styles";

test("native title/outro actually play, seek and return to an exact still",async({page})=>{
  await page.setContent(motionDocument('<html><head></head><body><main class="canvas"><div data-layer="headline">Title</div><div data-layer="subject">One</div><div data-layer="subject">Two</div></main></body></html>',1920,1080,'reveal'));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Play title'}).click();
  await expect.poll(()=>page.locator('#seek').inputValue()).not.toBe('0');
  await page.getByRole('button',{name:'Still / hold'}).click();
  expect(await page.locator('.canvas').evaluate(e=>getComputedStyle(e).opacity)).toBe('1');
  expect(await page.locator('[data-layer="headline"]').evaluate(e=>getComputedStyle(e).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
  await page.getByRole('button',{name:'Play outro'}).click();
  await expect.poll(()=>page.locator('#seek').inputValue()).not.toBe('120');
  expect(errors).toEqual([]);
});

test("a registered style preserves explicit photographic opacity in either theme",async({page})=>{
  for(const theme of ['light','dark']){
    await page.setContent(`<style>${thumbnailCss}${coverStyleCss}</style><main class="canvas style-as-recorded photographic ${theme}"><div class="scene"><img></div></main>`);
    expect(await page.locator('.scene img').evaluate(e=>getComputedStyle(e).opacity)).toBe('1');
  }
});

test("photographic plates retain image opacity in every semantic theme", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await page.setContent(`<style>${thumbnailCss}</style><main class="canvas photographic landscape ${theme}"><div class="scene"><img alt="Photographic plate"></div></main>`);
    const opacity = await page.locator(".scene img").evaluate(e => getComputedStyle(e).opacity);
    expect(opacity).toBe("1");
  }
  await page.setContent(`<style>${thumbnailCss}</style><main class="canvas landscape light"><div class="scene"><img alt="Atmosphere"></div></main>`);
  expect(await page.locator(".scene img").evaluate(e => getComputedStyle(e).opacity)).toBe("0.15");
});
