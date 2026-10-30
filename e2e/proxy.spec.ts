// proxy.ts gates every page on the gtm_owner claim. Logged out, nothing but /login and static
// brand assets may render, whatever the path encoding, method or RSC/prefetch headers.
// Raw node:http requests: fetch/Playwright would normalise the path tricks before sending them.
import { test, expect, type Browser } from "@playwright/test";
import { createHmac } from "node:crypto";
import { request as http } from "node:http";
import { PASSWORD, USERS, type Who } from "../test/support/seed.ts";

const PORT = Number(process.env.GTM_E2E_PORT ?? 3100);
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Res = { status: number; location: string | undefined; body: string };
function raw(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

// Strings that only appear when a protected page (or its RSC payload) renders seeded data.
// "Sign out" is the authenticated shell's nav: even an empty page render (RLS hiding the data) is a leak.
const MARKERS = ["Sign out", "Fixture grid strain story", "Fixture upcoming approved", "Fixture published post", "Cursor Usage", "Mystery Fixture SaaS", "fx-run-1", "Fixture Story", "Fixture clip", "fx-series", "Active subscriptions", "Traction by pillar", "Fixture Reader", "How did you measure adoption"];
/** Follows redirects (Next normalises e.g. `/costs/.` to `/costs`): every hop must leak nothing and the chain must end at /login or a 4xx. */
async function assertGated(first: Res, what: string, method = "GET") {
  let r = first;
  for (let hop = 0; ; hop++) {
    for (const m of MARKERS) expect(r.body, `${what} leaked "${m}"`).not.toContain(m);
    if (r.status < 300 || r.status >= 400) break;
    const next = new URL(r.location!, ORIGIN);
    expect(next.host, `${what} redirects off-site`).toBe(`127.0.0.1:${PORT}`);
    if (next.pathname === "/login") return;
    expect(hop, `${what} redirect chain`).toBeLessThan(3);
    r = await raw(next.pathname + next.search, method === "HEAD" ? "HEAD" : "GET");
  }
  expect([400, 404, 405], `${what} returned ${r.status}`).toContain(r.status);
}

test("every page redirects to /login when logged out (307)", async () => {
  for (const path of ["/", "/performance", "/funnel", "/front-doors", "/costs", "/stories/fx-story", "/content", "/content?status=approved&q=wave", "/calendar", "/calendar?week=2026-10-05", "/inspiration", "/inspiration?kind=video", "/ideas", "/ideas?kind=lead_magnet", "/outreach", "/outreach?batch=fx-batch-1&status=accepted", "/outreach/write", "/outreach/write?p=fx-p-tria", "/guide", "/signals", "/signals?view=queued", "/engage", "/engage?view=done", "/studio", "/studio/sb-fx-story-enhance-plan", "/studio/sb-fx-story-enhance-plan?v=1&scene=sc-hook", "/studio/series/fx-series"]) {
    const r = await raw(path);
    expect(r.status, path).toBe(307);
    expect(new URL(r.location!, "http://x").pathname, path).toBe("/login");
    await assertGated(r, path);
  }
});

test("static files under public/ (a one-off review page and its audio) redirect to /login when logged out", async () => {
  for (const path of ["/one-off/review.html", "/one-off/audio/sample.mp3"]) {
    const r = await raw(path);
    expect(r.status, path).toBe(307);
    expect(new URL(r.location!, "http://x").pathname, path).toBe("/login");
  }
});

test("the old /season, /stories and /review links redirect to /content and still end at login when logged out", async () => {
  for (const path of ["/season?status=approved", "/stories", "/review", "/review?batch=x", "/review/00000000-0000-0000-0000-000000000000", "/review/00000000-0000-0000-0000-000000000000?t=1000"]) {
    const r = await raw(path);
    expect(r.status, path).toBe(308);
    expect(new URL(r.location!, "http://x").pathname, path).toBe("/content");
    await assertGated(r, path);
  }
});

test("path tricks never render a protected page", async () => {
  const tricks = [
    "/costs.png", "/costs.PNG", "/costs.webp", "/costs.svg", "/costs.jpg", "/costs.ico", "/costs.rsc", "/costs.txt", "/costs.json",
    "/x.png/../costs", "/x.png/%2E%2E/costs", "/favicon.png/../costs", "/favicon./../costs", "/_next/static/../../costs", "/_next/image/../../costs",
    "/costs%2F", "/%2Fcosts", "/%63osts", "/costs%2Epng", "/costs%2epng", "/cost%73", "/costs%00", "/costs%00.png", "/%2E%2E/costs", "/costs/.", "/costs/",
    "//costs", "/content%2Fx", "/content/x.png", "/stories/fx-story.png", "/stories/fx-story.ico", "/stories/x.png/y", "/content/%2E%2E/costs", "/api/../costs", "/api%2F../costs", "/login/../costs", "/login%2F../costs",
    "/_next/data/development/costs.json", "/_next/data/x/costs.json", "/_next/data/x/index.json", "/costs?_rsc=1", "/index", "/COSTS",
  ];
  for (const path of tricks) await assertGated(await raw(path), path);
});

test("RSC, prefetch and server-action headers never render a protected page", async () => {
  const variants: Record<string, string>[] = [
    { RSC: "1" }, { RSC: "1", "Next-Router-Prefetch": "1" }, { "Next-Router-State-Tree": "%5B%22%22%5D", RSC: "1" },
    { Purpose: "prefetch" }, { "x-middleware-prefetch": "1" }, { "Next-Url": "/costs" }, { "x-nextjs-data": "1" },
    { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
    { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" }, { "x-middleware-subrequest": "src/middleware" },
  ];
  for (const path of ["/costs", "/", "/content", "/stories/fx-story"]) {
    for (const h of variants) await assertGated(await raw(path, "GET", h), `${path} ${JSON.stringify(h)}`);
  }
});

test("POST, HEAD and other methods never render a protected page", async () => {
  for (const path of ["/costs", "/content", "/stories/fx-story"]) {
    for (const method of ["POST", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"]) await assertGated(await raw(path, method), `${method} ${path}`, method);
    await assertGated(await raw(path, "POST", { "Next-Action": "0".repeat(40), "Content-Type": "text/plain;charset=UTF-8" }), `server action ${path}`);
  }
});

test("login, the logo and the favicon still load logged out", async () => {
  expect((await raw("/login")).status).toBe(200);
  for (const path of ["/favicon.png", "/vibrana-v-prism.png", "/vibrana-v-prism-96.webp"]) {
    const r = await raw(path);
    expect(r.status, path).toBe(200);
  }
});

test("API routes authenticate themselves: cron and webhook refuse unauthenticated calls", async () => {
  expect((await raw("/api/cron/sync")).status).toBe(401);
  expect((await raw("/api/cron/sync", "GET", { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await raw("/api/webhooks/zernio", "POST", { "x-zernio-signature": "00" })).status).toBe(401);
  expect((await raw("/api/cron/engage", "GET", { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await raw("/api/engage/intake", "POST", { Authorization: "Bearer wrong" })).status).toBe(401);
});

// proxy.ts is only as strong as getClaims() rejecting a tampered session cookie. Sign in for real,
// take the @supabase/ssr cookie, rewrite the JWT to claim gtm_owner, and replay it.
const b64u = (x: string | Buffer) => Buffer.from(x).toString("base64url");
async function sessionCookie(browser: Browser, who: Who) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByLabel("Email").fill(USERS[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(async () => (await ctx.cookies()).filter((c) => /^sb-.*-auth-token/.test(c.name)).length).toBeGreaterThan(0);
  const parts = (await ctx.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => Number(a.name.split(".")[1] ?? -1) - Number(b.name.split(".")[1] ?? -1));
  await ctx.close();
  const name = parts[0].name.replace(/\.\d+$/, "");
  const raw = parts.map((c) => c.value).join("");
  const session = JSON.parse(Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"));
  const cookie = (s: unknown) => `${name}=base64-${b64u(JSON.stringify(s))}`;
  return { session, cookie };
}

test("a tampered session cookie claiming gtm_owner never passes the proxy", async ({ browser }) => {
  const owner = await sessionCookie(browser, "owner");
  const control = await raw("/costs", "GET", { Cookie: owner.cookie(owner.session) });
  expect(control.status, "positive control: a genuine owner cookie is accepted").toBe(200);
  expect(control.body).toContain("Mystery Fixture SaaS");

  const member = await sessionCookie(browser, "member");
  const [h, p] = member.session.access_token.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const forged = b64u(JSON.stringify({ ...claims, app_metadata: { ...claims.app_metadata, gtm_owner: true } }));
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const tokens = {
    "payload rewritten, original signature": `${h}.${forged}.${member.session.access_token.split(".")[2]}`,
    "alg none": `${b64u(JSON.stringify({ ...header, alg: "none" }))}.${forged}.`,
    "HS256 with the wrong key": (() => { const hh = b64u(JSON.stringify({ ...header, alg: "HS256" })); return `${hh}.${forged}.${createHmac("sha256", "not-the-jwt-secret").update(`${hh}.${forged}`).digest("base64url")}`; })(),
  };
  for (const [what, access_token] of Object.entries(tokens)) {
    for (const session of [{ ...member.session, access_token }, { ...member.session, access_token, refresh_token: "invalid" }]) {
      await assertGated(await raw("/costs", "GET", { Cookie: member.cookie(session) }), `forged cookie (${what})`);
      await assertGated(await raw("/", "GET", { Cookie: member.cookie(session), RSC: "1" }), `forged cookie RSC (${what})`);
    }
  }
});
