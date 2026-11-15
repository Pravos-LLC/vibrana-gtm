// The network desk's mailbox connection (VIB-522): the OAuth state purpose, the account and scope checks on the callback,
// revoke-only-if-unused, env-before-database precedence, reconnect marking, and that nothing reaches the team mailbox table.
// Synthetic addresses and tokens only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { installFetchMock } from "./support/fetch-mock.ts";

Object.assign(process.env, { TEAM_MAILBOX_KEY: randomBytes(32).toString("base64") });
const N = await import("../lib/outreach/network-mailbox.ts");
const { signState, verifyState, sealToken, openToken } = await import("../lib/team/crypto.ts");
const { authUrl, READONLY_SCOPE, METADATA_SCOPE } = await import("../lib/team/mailbox.ts");
const { grantInUse } = await import("../lib/team/grants.ts");
const { parseMembers } = await import("../lib/team/members.ts");
const outcomes = await import("../lib/sales/outcomes.ts");
const { runProblems } = await import("../lib/sales/run.ts");
const { MailboxRenewError, GmailReader } = await import("../lib/outreach/mailbox.ts");

const ACCOUNT = "jo@fixture.example";
const CLIENT = { clientId: "client-test", clientSecret: "secret-test" };
const TEAM_ENV = { TEAM_GMAIL_CLIENT_ID: CLIENT.clientId, TEAM_GMAIL_CLIENT_SECRET: CLIENT.clientSecret, NETWORK_GMAIL_ACCOUNT: ACCOUNT };
const NETWORK_KEYS = ["NETWORK_GMAIL_CLIENT_ID", "NETWORK_GMAIL_CLIENT_SECRET", "NETWORK_GMAIL_REFRESH_TOKEN", "NETWORK_GMAIL_ACCOUNT", "TEAM_GMAIL_CLIENT_ID", "TEAM_GMAIL_CLIENT_SECRET", "GTM_TEAM_MEMBERS"];

let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });

/** Runs `fn` with exactly these NETWORK_/TEAM_GMAIL_ values in process.env, restoring the rest afterwards. */
async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(NETWORK_KEYS.map((k) => [k, process.env[k]]));
  for (const k of NETWORK_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

type Row = Record<string, unknown>;
/** Just enough of the Supabase client: eq/neq filters, limit, maybeSingle, upsert by id, update, delete; every call recorded.
 *  `fail` makes reads of a table answer with an error. */
function fakeDb(tables: Record<string, Row[]>, fail: string[] = []) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const st: { op: string; payload: Row | null; filters: ((r: Row) => boolean)[] } = { op: "select", payload: null, filters: [] };
    const run = () => {
      const rows = (tables[table] ??= []);
      if (fail.includes(table)) return { data: null, error: { message: "boom" } };
      const hit = (r: Row) => st.filters.every((f) => f(r));
      if (st.op === "select") return { data: rows.filter(hit).map((r) => ({ ...r })), error: null };
      if (st.op === "update") for (const r of rows.filter(hit)) Object.assign(r, st.payload);
      if (st.op === "delete") tables[table] = rows.filter((r) => !hit(r));
      if (st.op === "upsert") {
        const i = rows.findIndex((r) => r.id === st.payload!.id);
        if (i >= 0) Object.assign(rows[i], st.payload); else rows.push({ ...st.payload });
      }
      return { data: null, error: null };
    };
    const api: Record<string, unknown> = {
      select: (...a: unknown[]) => { calls.push({ table, op: "select", args: a }); return api; },
      update: (p: Row) => { calls.push({ table, op: "update", args: [p] }); st.op = "update"; st.payload = p; return api; },
      upsert: (p: Row) => { calls.push({ table, op: "upsert", args: [p] }); st.op = "upsert"; st.payload = p; return api; },
      delete: () => { calls.push({ table, op: "delete", args: [] }); st.op = "delete"; return api; },
      eq: (k: string, v: unknown) => { st.filters.push((r) => r[k] === v); return api; },
      neq: (k: string, v: unknown) => { st.filters.push((r) => r[k] !== v); return api; },
      limit: () => api, order: () => api, range: () => api,
      maybeSingle: () => { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return api;
  };
  return { db: { from } as never, calls, tables };
}

const idToken = (email: string, verified = true) => `h.${Buffer.from(JSON.stringify({ email, email_verified: verified })).toString("base64url")}.s`;
/** Google's token endpoint and revoke endpoint, recording what was revoked. */
function google(answer: { email: string; scope: string; verified?: boolean }) {
  const revoked: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/revoke") { revoked.push(new URLSearchParams(String(init?.body)).get("token")!); return new Response(null, { status: 200 }); }
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ refresh_token: "refresh-new", access_token: "at", id_token: idToken(answer.email, answer.verified ?? true), scope: answer.scope });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetcher, revoked };
}
const GRANTED = `openid https://www.googleapis.com/auth/userinfo.email ${READONLY_SCOPE}`;
const save = (db: never, fetcher: typeof fetch, expected: string | null = ACCOUNT) =>
  N.saveNetworkGrant(db, CLIENT, { code: "code", verifier: "verifier", redirectUri: "https://cockpit.test/api/team/mailbox/callback", member: "JOHN", expected, fetcher, now: new Date("2026-11-13T01:00:00Z") });

/* ------------------------------------------------------------------------------------------------ the state and the consent URL */

test("the OAuth state carries the network purpose inside its signature; the consent asks for Gmail read-only as the network account", () => {
  const s = signState({ sub: "u1", member: "JOHN", nonce: "n1", exp: 2_000, purpose: "network" });
  assert.deepEqual(verifyState(s, "n1", 1_000), { sub: "u1", member: "JOHN", nonce: "n1", exp: 2_000, purpose: "network" });
  // Swapping the purpose (to land in another flow) breaks the signature.
  const [body, sig] = s.split(".");
  const swapped = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace('"network"', '"calendar"')).toString("base64url");
  assert.equal(verifyState(`${swapped}.${sig}`, "n1", 1_000), null);
  assert.deepEqual(N.networkScopes(), ["openid", "email", READONLY_SCOPE]);
  const u = new URL(authUrl({ clientId: "c", redirectUri: "https://cockpit.test/api/team/mailbox/callback", state: s, challenge: "x", loginHint: ACCOUNT, scopes: N.networkScopes(), prompt: "consent" }));
  assert.equal(u.searchParams.get("scope"), `openid email ${READONLY_SCOPE}`);
  assert.equal(u.searchParams.get("login_hint"), ACCOUNT);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

test("the callback routes the network purpose to its own save, for the network owner only, returning to Pipeline > Conversations", () => {
  const src = readFileSync(new URL("../app/api/team/mailbox/callback/route.ts", import.meta.url), "utf8");
  assert.match(src, /if \(purpose === "network"\) page = `\$\{NETWORK_PAGE\}\?network=`;/);
  assert.match(src, /if \(s\.purpose === "network"\) \{\s*if \(v\.member\.code !== NETWORK_OWNER\) return back\("not-owner"\);\s*return back\(await saveNetworkGrant\(adminDb\(\), cfg, \{[^}]*expected: networkAccount\(\) \}\)\);/);
  // The network branch returns before the team mailbox upsert: its grant never reaches gtm_team_mailboxes.
  assert.ok(src.indexOf('s.purpose === "network"') < src.indexOf('from("gtm_team_mailboxes").upsert'));
  assert.equal(N.NETWORK_PAGE, "/pipeline/conversations");
  const actions = readFileSync(new URL("../app/pipeline/conversations/actions.ts", import.meta.url), "utf8");
  assert.equal((actions.match(/v\.member\.code !== NETWORK_OWNER\) redirect/g) ?? []).length, 2, "connect and disconnect both require the network owner");
  assert.match(actions, /purpose: "network"/);
  assert.match(actions, /loginHint: account, scopes: networkScopes\(\)/);
});

/* ------------------------------------------------------------------------------------------------ the expected account */

test("the expected account: NETWORK_GMAIL_ACCOUNT, else the JOHN member's login; a malformed setting is no account, never a fallback", () => {
  const members = parseMembers(JSON.stringify([
    { code: "ABE", authEmail: "abe@fixture.example", apiKeyNames: ["k"] },
    { code: "JOHN", authEmail: "John@Owner.example", apiKeyNames: ["j"] },
  ]));
  assert.equal(N.networkAccount({ NETWORK_GMAIL_ACCOUNT: " Jo@Fixture.example " }, members), ACCOUNT);
  assert.equal(N.networkAccount({}, members), "john@owner.example");
  assert.equal(N.networkAccount({ NETWORK_GMAIL_ACCOUNT: "Jo <jo@fixture.example>" }, members), null);
  assert.equal(N.networkAccount({}, members.filter((m) => m.code !== "JOHN")), null);
  assert.equal(N.networkAccount({ GTM_TEAM_MEMBERS: "{" }), null, "a malformed member list is no account");
});

/* ------------------------------------------------------------------------------------------------ saving a grant */

test("the expected account with gmail.readonly is sealed into gtm_network_mailbox, and nowhere else", async () => {
  const { db, calls, tables } = fakeDb({});
  const g = google({ email: "Jo@Fixture.example", scope: GRANTED });
  assert.equal(await save(db, g.fetcher), "connected");
  assert.deepEqual(g.revoked, []);
  const row = tables.gtm_network_mailbox[0];
  assert.deepEqual([row.id, row.address, row.connected_by, row.reconnect_needed_at, row.last_error], [1, ACCOUNT, "JOHN", null, null]);
  assert.deepEqual(row.granted_scopes, [READONLY_SCOPE]);
  assert.equal(openToken(String(row.token_ciphertext), N.networkAad(ACCOUNT)), "refresh-new");
  assert.doesNotMatch(String(row.token_ciphertext), /refresh-new/);
  assert.deepEqual([...new Set(calls.filter((c) => c.op !== "select").map((c) => c.table))], ["gtm_network_mailbox"], "no team mailbox or calendar row is written");
});

test("a reconnect replaces the row and clears the reconnect mark, and never revokes the previous token", async () => {
  const { db, tables } = fakeDb({ gtm_network_mailbox: [{ id: 1, address: ACCOUNT, token_ciphertext: sealToken("refresh-old", N.networkAad(ACCOUNT)), granted_scopes: [READONLY_SCOPE], connected_by: "JOHN", connected_at: "2026-11-01T00:00:00Z", reconnect_needed_at: "2026-11-12T00:00:00Z", last_error: "refused" }] });
  const g = google({ email: ACCOUNT, scope: GRANTED });
  assert.equal(await save(db, g.fetcher), "connected");
  assert.deepEqual(g.revoked, []);
  assert.equal(tables.gtm_network_mailbox.length, 1);
  assert.deepEqual([tables.gtm_network_mailbox[0].reconnect_needed_at, tables.gtm_network_mailbox[0].last_error], [null, null]);
  assert.equal(openToken(String(tables.gtm_network_mailbox[0].token_ciphertext), N.networkAad(ACCOUNT)), "refresh-new");
});

test("a wrong account is rejected; its grant is revoked only when no connection uses that address", async () => {
  const other = "someone@fixture.example";
  // In use: the same Google account has a calendar connection on this client (revoking would kill it).
  for (const table of ["gtm_team_calendars", "gtm_team_mailboxes"]) {
    const { db, tables } = fakeDb({ [table]: [{ member: "JOHN", address: other }] });
    const g = google({ email: other, scope: GRANTED });
    assert.equal(await save(db, g.fetcher), "wrong-account");
    assert.deepEqual(g.revoked, [], `${table} on the address keeps the grant`);
    assert.equal(tables.gtm_network_mailbox?.length ?? 0, 0, "nothing stored");
  }
  // A failed lookup counts as in use.
  const failing = fakeDb({}, ["gtm_team_calendars"]);
  const g1 = google({ email: other, scope: GRANTED });
  assert.equal(await save(failing.db, g1.fetcher), "wrong-account");
  assert.deepEqual(g1.revoked, [], "when unsure, the grant is kept");
  // Unused: revoked.
  const { db } = fakeDb({});
  const g2 = google({ email: other, scope: GRANTED });
  assert.equal(await save(db, g2.fetcher), "wrong-account");
  assert.deepEqual(g2.revoked, ["refresh-new"]);
});

test("a grant without gmail.readonly is refused and nothing stored; revoked only when unused", async () => {
  for (const scope of [`openid email ${METADATA_SCOPE}`, "openid email"]) {
    const used = fakeDb({ gtm_team_calendars: [{ member: "JOHN", address: ACCOUNT }] });
    const g = google({ email: ACCOUNT, scope });
    assert.equal(await save(used.db, g.fetcher), "scope-missing");
    assert.deepEqual(g.revoked, [], "the calendar grant on this account stays");
    assert.equal(used.tables.gtm_network_mailbox?.length ?? 0, 0);
  }
  const free = fakeDb({});
  const g = google({ email: ACCOUNT, scope: "openid email" });
  assert.equal(await save(free.db, g.fetcher), "scope-missing");
  assert.deepEqual(g.revoked, ["refresh-new"]);
});

test("an unconfirmed address, a refused exchange or no configured account stores nothing", async () => {
  const { db, tables } = fakeDb({});
  assert.equal(await save(db, google({ email: ACCOUNT, scope: GRANTED, verified: false }).fetcher), "google-refused");
  assert.equal(await save(db, (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch), "google-refused");
  assert.equal(await save(db, google({ email: ACCOUNT, scope: GRANTED }).fetcher, null), "no-account");
  assert.equal(tables.gtm_network_mailbox?.length ?? 0, 0);
});

/* ------------------------------------------------------------------------------------------------ the shared revoke guard */

test("grantInUse: every connection on the address counts, except the one being removed; a failed lookup counts", async () => {
  const { db } = fakeDb({ gtm_team_mailboxes: [{ member: "ABE", address: "a@fixture.example" }], gtm_team_calendars: [{ member: "JOHN", address: ACCOUNT }], gtm_network_mailbox: [{ id: 1, address: ACCOUNT }] });
  assert.equal(await grantInUse(db, "nobody@fixture.example"), false);
  assert.equal(await grantInUse(db, "A@Fixture.example"), true);
  assert.equal(await grantInUse(db, ACCOUNT, { table: "gtm_network_mailbox" }), true, "the calendar still uses the account");
  assert.equal(await grantInUse(db, ACCOUNT, { table: "gtm_team_calendars", member: "JOHN" }), true, "the network mailbox still uses it");
  assert.equal(await grantInUse(db, "a@fixture.example", { table: "gtm_team_mailboxes", member: "ABE" }), false);
  assert.equal(await grantInUse(fakeDb({}, ["gtm_network_mailbox"]).db, "x@fixture.example"), true);
});

test("disconnecting deletes the row and revokes only when no other connection uses the account", async () => {
  const sealed = sealToken("refresh-stored", N.networkAad(ACCOUNT));
  const withCalendar = fakeDb({ gtm_network_mailbox: [{ id: 1, address: ACCOUNT, token_ciphertext: sealed }], gtm_team_calendars: [{ member: "JOHN", address: ACCOUNT }] });
  const g = google({ email: ACCOUNT, scope: GRANTED });
  assert.equal(await N.disconnectNetwork(withCalendar.db, g.fetcher), "disconnected");
  assert.deepEqual(g.revoked, [], "the calendar on the same account keeps working");
  assert.equal(withCalendar.tables.gtm_network_mailbox.length, 0);
  const alone = fakeDb({ gtm_network_mailbox: [{ id: 1, address: ACCOUNT, token_ciphertext: sealed }] });
  const g2 = google({ email: ACCOUNT, scope: GRANTED });
  assert.equal(await N.disconnectNetwork(alone.db, g2.fetcher), "disconnected");
  assert.deepEqual(g2.revoked, ["refresh-stored"]);
  assert.equal(await N.disconnectNetwork(fakeDb({}).db, g2.fetcher), "not-connected");
});

/* ------------------------------------------------------------------------------------------------ reading: env first, then the stored grant */

const storedRow = (over: Row = {}) => ({ id: 1, address: ACCOUNT, token_ciphertext: sealToken("refresh-stored", N.networkAad(ACCOUNT)), granted_scopes: [READONLY_SCOPE],
  connected_by: "JOHN", connected_at: "2026-11-13T01:00:00.000+00:00", last_sync_at: null, last_error: null, reconnect_needed_at: null, ...over });

test("NETWORK_GMAIL_* deployment settings win over the stored connection, without reading the table", async () => {
  const { db, calls } = fakeDb({ gtm_network_mailbox: [storedRow()] });
  const env = { ...TEAM_ENV, NETWORK_GMAIL_CLIENT_ID: "env-client", NETWORK_GMAIL_CLIENT_SECRET: "env-secret", NETWORK_GMAIL_REFRESH_TOKEN: "env-refresh" };
  assert.deepEqual(await N.networkMailbox(db, env), { cfg: { email: ACCOUNT, clientId: "env-client", clientSecret: "env-secret", refreshToken: "env-refresh" }, stored: null });
  assert.equal(calls.length, 0);
  assert.deepEqual(await N.networkStatus(db, env), { source: "env" });
});

test("without the settings, the stored grant is unsealed and used with the TEAM_GMAIL client", async () => {
  const { db } = fakeDb({ gtm_network_mailbox: [storedRow()] });
  assert.deepEqual(await N.networkMailbox(db, TEAM_ENV), {
    cfg: { email: ACCOUNT, clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret, refreshToken: "refresh-stored" },
    stored: { address: ACCOUNT, connectedAt: "2026-11-13T01:00:00.000+00:00" },
  });
  // Partial settings are not settings: the stored grant is still used.
  assert.ok(!("skipped" in await N.networkMailbox(db, { ...TEAM_ENV, NETWORK_GMAIL_REFRESH_TOKEN: "only-one" })));
  // Nothing stored: not connected (a state, not a pipeline problem).
  const none = await N.networkMailbox(fakeDb({}).db, TEAM_ENV);
  assert.deepEqual(none, { skipped: N.NETWORK_NOT_CONNECTED });
  // Another account than the configured one, or no TEAM_GMAIL client: skipped with the reason.
  assert.match((await N.networkMailbox(db, { ...TEAM_ENV, NETWORK_GMAIL_ACCOUNT: "other@fixture.example" }) as { skipped: string }).skipped, /another account/);
  assert.match((await N.networkMailbox(db, { NETWORK_GMAIL_ACCOUNT: ACCOUNT }) as { skipped: string }).skipped, /TEAM_GMAIL_CLIENT_ID/);
  // A failed read of the table is an error, never "not connected".
  await assert.rejects(N.networkMailbox(fakeDb({}, ["gtm_network_mailbox"]).db, TEAM_ENV), /network mailbox: boom/);
});

test("a stored grant without gmail.readonly, or one that cannot be unsealed, is marked for a reconnect", async () => {
  const meta = fakeDb({ gtm_network_mailbox: [storedRow({ granted_scopes: [METADATA_SCOPE] })] });
  assert.deepEqual(await N.networkMailbox(meta.db, TEAM_ENV), { skipped: N.NETWORK_RECONNECT });
  assert.ok(meta.tables.gtm_network_mailbox[0].reconnect_needed_at);
  const garbled = fakeDb({ gtm_network_mailbox: [storedRow({ token_ciphertext: sealToken("refresh-stored", N.networkAad("other@fixture.example")) })] });
  assert.deepEqual(await N.networkMailbox(garbled.db, TEAM_ENV), { skipped: N.NETWORK_RECONNECT });
  assert.ok(garbled.tables.gtm_network_mailbox[0].reconnect_needed_at);
  // Once marked, the job does not try again until a reconnect.
  assert.deepEqual(await N.networkMailbox(garbled.db, TEAM_ENV), { skipped: N.NETWORK_RECONNECT });
});

/* ------------------------------------------------------------------------------------------------ reconnect marking in the hourly job */

test("Google refusing the stored token (invalid_grant) marks the row for a reconnect; the run reports it and the page says reconnect", async () => {
  const { db, tables } = fakeDb({ gtm_network_mailbox: [storedRow()], gtm_outreach_tracks: [{ track: "network", from_address: "jo@alias.example" }], gtm_outreach_drafts: [] });
  mock = installFetchMock([{ url: "https://oauth2.googleapis.com/token", status: 400, json: { error: "invalid_grant" } }]);
  await withEnv(TEAM_ENV, async () => {
    await assert.rejects(outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000 }), /network mailbox connection needs to be renewed\. Reconnect it on Pipeline > Conversations/);
    const row = tables.gtm_network_mailbox[0];
    assert.ok(row.reconnect_needed_at, "marked");
    assert.match(String(row.last_error), /Reconnect the network mailbox/);
    const status = await N.networkStatus(db, TEAM_ENV);
    assert.equal(status.source === "stored" && status.reconnect, true, "the page shows Reconnect");
    // The next run does not hammer Google: it skips with a reason the pipeline reports as a problem.
    const next = await outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000 });
    assert.equal(next.skipped, N.NETWORK_RECONNECT);
    assert.match(runProblems({ at: new Date().toISOString(), result: { networkOutcomes: next } }, new Date()).join(), /Network inbox outcomes: the network mailbox needs reconnecting/);
  });
  assert.equal(mock.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")).length, 1);
});

test("other token failures are recorded as the last error, not as a reconnect; a good run records its time", async () => {
  const { db, tables } = fakeDb({ gtm_network_mailbox: [storedRow()], gtm_outreach_tracks: [{ track: "network", from_address: "jo@alias.example" }], gtm_outreach_drafts: [] });
  mock = installFetchMock([{ url: "https://oauth2.googleapis.com/token", status: 401, json: { error: "invalid_client" } }]);
  await withEnv(TEAM_ENV, async () => {
    await assert.rejects(outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000 }), /^Error: The network mailbox connection needs to be renewed\.$/);
  });
  assert.equal(tables.gtm_network_mailbox[0].reconnect_needed_at, null);
  assert.match(String(tables.gtm_network_mailbox[0].last_error), /needs to be renewed/);
  mock.restore();
  mock = installFetchMock([
    { url: "https://oauth2.googleapis.com/token", json: { access_token: "at" } },
    { url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", json: { emailAddress: ACCOUNT } },
    { url: "https://gmail.googleapis.com/gmail/v1/users/me/threads", json: { threads: [] } },
  ]);
  await withEnv(TEAM_ENV, async () => {
    const run = await outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000 });
    assert.deepEqual([run.skipped, run.pages], [undefined, 1]);
  });
  assert.equal(tables.gtm_network_mailbox[0].last_error, null);
  assert.ok(tables.gtm_network_mailbox[0].last_sync_at);
  const search = mock.calls.find((c) => c.url.includes("/users/me/threads"))!;
  assert.match(new URL(search.url).searchParams.get("q")!, /from:jo@alias\.example/, "searched for the alias, read from the connected account");
});

test("a reconnect made during a run is never marked by that run", async () => {
  const { db, tables } = fakeDb({ gtm_network_mailbox: [storedRow({ connected_at: "2026-11-13T02:00:00.000+00:00" })] });
  await N.markNetworkFailure(db, { address: ACCOUNT, connectedAt: "2026-11-13T01:00:00.000+00:00" }, new MailboxRenewError("x"));
  assert.equal(tables.gtm_network_mailbox[0].reconnect_needed_at, null);
});

test("GmailReader.connect: invalid_grant is a renew error, other refusals are plain errors", async () => {
  const cfg = { email: ACCOUNT, clientId: "c", clientSecret: "s", refreshToken: "r" };
  await assert.rejects(GmailReader.connect(cfg, (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch, "network mailbox"), (e) => e instanceof MailboxRenewError);
  await assert.rejects(GmailReader.connect(cfg, (async () => Response.json({ error: "invalid_client" }, { status: 401 })) as typeof fetch, "network mailbox"), (e) => !(e instanceof MailboxRenewError));
});

/* ------------------------------------------------------------------------------------------------ the team sync never sees it */

test("the team email sync reads gtm_team_mailboxes only: the network connection is in its own table", () => {
  for (const f of ["../lib/team/run.ts", "../lib/team/mailbox.ts", "../lib/email/run.ts", "../lib/email/load.ts", "../app/performance/team/page.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /gtm_network_mailbox|network-mailbox/, `${f} never reads the network mailbox`);
  }
  const callback = readFileSync(new URL("../app/api/team/mailbox/callback/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(callback, /from\("gtm_network_mailbox"\)/, "the callback writes the network row only through saveNetworkGrant");
  // End to end against the local database, with a network row on a member's own address: test/db/network-mailbox.test.ts.
});
