// Email health against the real LOCAL database (VIB-511): an incident opens once, is emailed once to both owners,
// refreshes while it lasts and resolves when the check passes; the 2% bounce rule fires at small n. Resend is mocked.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"), RESEND_API_KEY: "re_test", EMAIL_ALERT_TO: "a@team.test,b@team.test", EMAIL_HEALTH_DOMAINS: "off" });
const { runEmailHealth } = await import("../../lib/email/run.ts");
const { parseMembers } = await import("../../lib/team/members.ts");

const DB: Route = { url: l.url, passthrough: true };
const member = parseMembers(JSON.stringify([{ code: "THLTH", label: "Health", authEmail: "h@team.test", apiKeyNames: ["k"], mailboxes: ["h@hq.test"] }]))[0];
const P = "00000000-0000-4000-8000-0000000000b1";
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });
before(async () => { await seed(); });

async function reset(lastError: string | null, lastSync: string) {
  const db = admin();
  const { data: ev } = await db.from("gtm_team_mail_events").select("id").eq("member", "THLTH");
  if (ev?.length) await db.from("gtm_email_attempts").delete().in("event_id", ev.map((e) => e.id));
  await db.from("gtm_team_mail_events").delete().eq("member", "THLTH");
  await db.from("gtm_team_mailboxes").delete().eq("member", "THLTH");
  await db.from("gtm_email_incidents").delete().like("incident_key", "%thlth%");
  assert.equal((await db.from("gtm_team_mailboxes").insert({ member: "THLTH", address: "h@hq.test", token_ciphertext: "x".repeat(60), backfill_done: true, last_error: lastError, last_sync_at: lastSync })).error, null);
}

test("a failing mailbox opens one incident, emailed once to both owners; it resolves when the sync recovers", async () => {
  const now = new Date();
  await reset("Google no longer accepts the stored connection. Reconnect the mailbox.", now.toISOString());
  mock = installFetchMock([{ url: "https://api.resend.com/emails", json: { id: "e1" } }, DB]);
  const r1 = await runEmailHealth(admin(), [member], { now, mail: { to: "fallback@team.test", from: "cockpit@team.test" } });
  assert.equal(r1.notified, true);
  const sent = mock.calls.filter((c) => c.url.startsWith("https://api.resend.com"));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body!).to, ["a@team.test", "b@team.test"]);
  const r2 = await runEmailHealth(admin(), [member], { now: new Date(now.getTime() + 3_600_000), mail: { to: "fallback@team.test", from: "cockpit@team.test" } });
  assert.equal(r2.notified, false, "an open incident is not emailed again");
  assert.equal(mock.calls.filter((c) => c.url.startsWith("https://api.resend.com")).length, 1);
  await admin().from("gtm_team_mailboxes").update({ last_error: null, last_sync_at: new Date(now.getTime() + 2 * 3_600_000).toISOString() }).eq("member", "THLTH");
  await runEmailHealth(admin(), [member], { now: new Date(now.getTime() + 2 * 3_600_000), mail: { to: "fallback@team.test", from: "cockpit@team.test" } });
  const rows = (await admin().from("gtm_email_incidents").select("kind,resolved_at,notified_at").like("incident_key", "collection:thlth:%")).data!;
  assert.equal(rows.length, 1); assert.ok(rows[0].resolved_at && rows[0].notified_at);
});

test("one failed recipient of one cold send in 7 days is above 2%: a critical incident at n=1", async () => {
  const now = new Date();
  await reset(null, now.toISOString());
  const db = admin();
  const e = (await db.from("gtm_team_mail_events").insert({ member: "THLTH", gmail_message_id: "b1", thread_id: "b10", kind: "outreach", at: new Date(now.getTime() - 86_400_000).toISOString(), person_ids: [P], mailbox: "h@hq.test", calc_version: 2 }).select("id").single()).data!;
  assert.equal((await db.from("gtm_email_attempts").insert({ event_id: e.id, recipient_hash: "b".repeat(32), field: "to", match: "matched", person_id: P, stream: "cold", episode_id: "c".repeat(32), delivery: "failed_invalid_address", delivery_at: now.toISOString() })).error, null);
  mock = installFetchMock([{ url: "https://api.resend.com/emails", json: { id: "e2" } }, DB]);
  await runEmailHealth(db, [member], { now, mail: { to: "fallback@team.test", from: "cockpit@team.test" } });
  const [inc] = (await db.from("gtm_email_incidents").select("kind,severity,detail").eq("incident_key", "bounce:thlth").is("resolved_at", null)).data!;
  assert.deepEqual(inc, { kind: "bounce_rate", severity: "critical", detail: { num: 1, n: 1 } });
});
