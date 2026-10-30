import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { assertDemoDatabase, demoDatabaseFetch, providerFetch } from "../lib/demo-safety";
import { adminDb } from "../lib/db";
import { demoEnvironment } from "../scripts/demo.mjs";
import { openRouterWriter } from "../lib/signals/brief";
import { openRouterReplyWriter } from "../lib/engage/draft";
import { openRouterStanceClassifier } from "../lib/engage/stance";
import { openRouterLessonWriter } from "../lib/engage/learn";
import { openRouterReportWriter } from "../lib/reports/writer";
import { openRouterFitScorer } from "../lib/candidates/fit";
import { openRouterLearnWriter } from "../lib/outreach/learn";
import { openRouterTagger } from "../lib/playbook/tag";
import { requestOutreachAngles } from "../lib/outreach/ai-draft-core";
import { sendEngageEmail } from "../lib/engage/digest";
import { sendCandidatesEmail } from "../lib/candidates/email";
import { notifyJohn } from "../lib/reviewer/notify";
import { aiRunner } from "../lib/signals/cloudflare";
import { apifyProfileReader } from "../lib/engage/profile";
import { firecrawlReader } from "../lib/engage/links";
import { GmailReader, mailboxConfig } from "../lib/outreach/mailbox";
import { readLinkedInEmails, postIntake } from "../lib/engage/linkedin-email";
import { tinyfishText } from "../lib/signals/sources";
import { publishStoryMedia } from "../lib/public-media";

const disabled = /Demo mode:/;
const env = (t: TestContext, updates: Record<string, string>) => {
  const previous = Object.fromEntries(Object.keys(updates).map(k => [k, process.env[k]]));
  Object.assign(process.env, updates);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
};

test("demo denies live provider factories and injected transports even with inherited credentials", async t => {
  env(t, { DEMO_MODE: "1", OPENROUTER_API_KEY: "synthetic-inherited", RESEND_API_KEY: "synthetic-inherited", APIFY_TOKEN: "synthetic-inherited", FIRECRAWL_API_KEY: "synthetic-inherited", CLOUDFLARE_ACCOUNT_ID: "synthetic", CLOUDFLARE_API_TOKEN: "synthetic" });
  let called = 0;
  const fetcher: typeof fetch = async () => { called++; throw new Error("Transport reached"); };
  for (const factory of [openRouterWriter, openRouterReplyWriter, openRouterStanceClassifier, openRouterLessonWriter, openRouterReportWriter, openRouterFitScorer, openRouterLearnWriter, openRouterTagger, firecrawlReader]) {
    assert.throws(() => factory({ key: "explicit-synthetic", fetcher }), disabled);
  }
  assert.throws(() => aiRunner(fetcher), disabled);
  assert.throws(() => apifyProfileReader("explicit-synthetic", fetcher), disabled);
  assert.equal(mailboxConfig({ OUTREACH_GMAIL_CLIENT_ID: "synthetic", OUTREACH_GMAIL_CLIENT_SECRET: "synthetic", OUTREACH_GMAIL_REFRESH_TOKEN: "synthetic" }), null);
  await assert.rejects(() => GmailReader.connect({ email: "owner@example.test", clientId: "synthetic", clientSecret: "synthetic", refreshToken: "synthetic" }, fetcher), disabled);
  await assert.rejects(() => new GmailReader("synthetic", fetcher).thread("abc"), disabled);
  await assert.rejects(() => tinyfishText("https://example.test", fetcher, "synthetic"), disabled);
  assert.throws(() => readLinkedInEmails({ exec: () => { called++; return "[]"; } }), disabled);
  await assert.rejects(() => postIntake([], { url: "https://example.test", secret: "synthetic", fetcher }), disabled);
  await assert.rejects(() => sendEngageEmail([], { to: "owner@example.test", cockpitUrl: "http://localhost", date: "today", fetcher }), disabled);
  await assert.rejects(() => sendCandidatesEmail([], "2026-10-26", { to: "owner@example.test", cockpitUrl: "http://localhost", fetcher }), disabled);
  await assert.rejects(() => notifyJohn({ party: "Sample", piece: "Sample", storyId: "sample", kind: "note", note: "Sample" }, { fetcher }), disabled);
  await assert.rejects(() => requestOutreachAngles({} as never, "sample", { key: "synthetic", fetcher }), disabled);
  await assert.rejects(() => publishStoryMedia({} as never, "sample", { config: { accountId: "synthetic", token: "synthetic", bucket: "synthetic", baseUrl: "https://example.test" } }), disabled);
  assert.equal(called, 0);
});

test("a transport captured before demo mode is enabled is still denied at invocation", async t => {
  env(t, { DEMO_MODE: "0" });
  let called = 0;
  const guarded = providerFetch(async () => { called++; return new Response("ok"); });
  process.env.DEMO_MODE = "1";
  assert.throws(() => guarded("https://example.test"), disabled);
  assert.equal(called, 0);
});

test("demo database rejects production, alternate local ports and redirecting transports", async t => {
  env(t, { DEMO_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: "https://production.example.test", SUPABASE_SECRET_KEY: "synthetic-inherited" });
  assert.throws(adminDb, disabled);
  for (const url of [undefined, "https://127.0.0.1:61321", "http://127.0.0.1:54321", "http://127.0.0.1.evil.test:61321", "http://user:pass@localhost:61321", "http://localhost:61321/path"]) assert.throws(() => assertDemoDatabase(url), disabled);
  for (const url of ["http://127.0.0.1:61321", "http://localhost:61321", "http://[::1]:61321"]) assert.doesNotThrow(() => assertDemoDatabase(url));
  let called = 0;
  const transport = demoDatabaseFetch(async (_input, init) => { called++; assert.equal(init?.redirect, "error"); return new Response("ok"); });
  await transport("http://127.0.0.1:61321/rest/v1/gtm_stories");
  assert.throws(() => transport("https://production.example.test/rest/v1/gtm_stories"), disabled);
  assert.equal(called, 1);
});

test("launcher ignores inherited production credentials and forces local sample mode", () => {
  const status = { API_URL: "http://127.0.0.1:61321", DB_URL: "postgresql://postgres:synthetic@127.0.0.1:61322/postgres", PUBLISHABLE_KEY: "synthetic-local-public", SECRET_KEY: "synthetic-local-secret" };
  const result = demoEnvironment(status, { PATH: process.env.PATH!, NEXT_PUBLIC_SUPABASE_URL: "https://production.example.test", RESEND_API_KEY: "synthetic-live", PRIVATE_OVERLAY_ROOT: "/private", CONTENT_MODE: "private", OPENROUTER_API_KEY: "synthetic-live", UNKNOWN_SECRET: "synthetic-live" });
  assert.equal(result.DEMO_MODE, "1");
  assert.equal(result.CONTENT_MODE, "sample");
  assert.equal(result.NEXT_PUBLIC_SUPABASE_URL, status.API_URL);
  assert.equal(result.SUPABASE_SECRET_KEY, status.SECRET_KEY);
  assert.equal(result.UNKNOWN_SECRET, undefined);
  assert.ok(!result.RESEND_API_KEY && !result.OPENROUTER_API_KEY && !result.PRIVATE_OVERLAY_ROOT);
  assert.throws(() => demoEnvironment({ ...status, API_URL: "https://production.example.test" }), /loopback/);
  assert.throws(() => demoEnvironment({ ...status, DB_URL: "postgresql://postgres:synthetic@production.example.test:61322/postgres" }), /loopback/);
});

test('guide media uploader rejects demo mode before reading output roots or production credentials', () => {
 const result=spawnSync(process.execPath,['--import','tsx','scripts/guide-media.mjs'],{
  cwd:process.cwd(),encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',DEMO_MODE:'1',NEXT_PUBLIC_SUPABASE_URL:'https://production.example.test',SUPABASE_SECRET_KEY:'synthetic-live'}
 });
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Demo mode: live providers are disabled/);
 assert.ok(!result.stderr.includes('Content overlay validation failed'));
});
