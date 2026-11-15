// The network desk's mailbox (VIB-522) against the real LOCAL database: a stored network connection on the very address a
// team member lists as their mailbox is never synced as that member's team mailbox, and the save path writes only its own
// table. Gmail and Twenty are mocked; synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"),
  TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test", TEAM_GMAIL_CLIENT_ID: "cid", TEAM_GMAIL_CLIENT_SECRET: "cs" });
const N = await import("../../lib/outreach/network-mailbox.ts");
const { sealToken } = await import("../../lib/team/crypto.ts");
const { READONLY_SCOPE } = await import("../../lib/team/mailbox.ts");
const { parseMembers } = await import("../../lib/team/members.ts");

const BOX = "tnet@hq.test";
before(async () => { await seed(); });

test("team run: a network connection on a member's own address is not their team mailbox; nothing of it is read or counted", async () => {
  const db = admin();
  const { runTeam } = await import("../../lib/team/run.ts");
  const members = parseMembers(JSON.stringify([{ code: "TNET", authEmail: "tnet@team.test", apiKeyNames: ["tnet-key"], mailboxes: [BOX] }]));
  await db.from("gtm_team_mailboxes").delete().eq("member", "TNET");
  assert.equal((await db.from("gtm_network_mailbox").upsert({ id: 1, address: BOX, token_ciphertext: sealToken("refresh", N.networkAad(BOX)), granted_scopes: [READONLY_SCOPE], connected_by: "TNET" }, { onConflict: "id" })).error, null);
  const google: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/googleapis\.com/.test(url)) { google.push(url); return new Response("{}", { status: 500 }); }
    if (!url.startsWith("https://crm.test")) return original(input, init);
    const { query } = JSON.parse(String(init!.body)) as { query: string };
    const object = /\{ (\w+)\(/.exec(query)?.[1] ?? "people";
    if (/totalCount/.test(query)) return Response.json({ data: { [object]: { totalCount: 0 } } });
    return Response.json({ data: { [object]: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } });
  }) as typeof fetch;
  try {
    const out = await runTeam(db, members, { deadline: Date.now() + 120_000 });
    assert.equal(out.TNET?.mailbox, "not connected", "the member has no team mailbox, whatever the network table holds");
    assert.deepEqual(google, [], "no Google call: the network token is never used by the team sync");
    const { data: events } = await db.from("gtm_team_mail_events").select("id").eq("member", "TNET");
    assert.deepEqual(events, []);
    const { data: boxes } = await db.from("gtm_team_mailboxes").select("member").eq("address", BOX);
    assert.deepEqual(boxes, [], "nothing was copied into the team mailbox table");
  } finally {
    globalThis.fetch = original;
    await db.from("gtm_network_mailbox").delete().eq("id", 1);
    await db.from("gtm_sync_state").delete().like("key", "team.%tnet%");
    await db.from("gtm_team_stock_daily").delete().eq("member", "TNET");
  }
});

test("saving a grant writes the one network row through the service role, and a second save replaces it", async () => {
  const db = admin();
  await db.from("gtm_network_mailbox").delete().eq("id", 1);
  const idToken = `h.${Buffer.from(JSON.stringify({ email: BOX, email_verified: true })).toString("base64url")}.s`;
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ refresh_token: "refresh-new", id_token: idToken, scope: `openid email ${READONLY_SCOPE}` });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const o = { code: "c", verifier: "v", redirectUri: "https://cockpit.test/api/team/mailbox/callback", member: "JOHN", expected: BOX, fetcher };
  try {
    assert.equal(await N.saveNetworkGrant(db, { clientId: "cid", clientSecret: "cs" }, o), "connected");
    await db.from("gtm_network_mailbox").update({ reconnect_needed_at: new Date().toISOString() }).eq("id", 1);
    assert.equal(await N.saveNetworkGrant(db, { clientId: "cid", clientSecret: "cs" }, o), "connected");
    const { data } = await db.from("gtm_network_mailbox").select("address,connected_by,reconnect_needed_at,granted_scopes");
    assert.deepEqual(data, [{ address: BOX, connected_by: "JOHN", reconnect_needed_at: null, granted_scopes: [READONLY_SCOPE] }]);
    const src = await N.networkMailbox(db, { TEAM_GMAIL_CLIENT_ID: "cid", TEAM_GMAIL_CLIENT_SECRET: "cs", NETWORK_GMAIL_ACCOUNT: BOX });
    assert.ok(!("skipped" in src) && src.cfg.refreshToken === "refresh-new" && src.stored?.address === BOX, "the stored grant reads back and unseals");
  } finally {
    await db.from("gtm_network_mailbox").delete().eq("id", 1);
  }
});
