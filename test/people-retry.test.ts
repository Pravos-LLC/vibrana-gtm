import test from "node:test";
import assert from "node:assert/strict";
import { retryUnresolved } from "../lib/people";

// A minimal stand-in for the Supabase client: just the calls lib/people.ts makes on gtm_people.
function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    rows,
    from() {
      return {
        select() { return { order: async () => ({ data: rows.map((r) => ({ ...r })), error: null }) }; },
        update(patch: Record<string, unknown>) { return { eq: async (_: string, id: string) => { Object.assign(rows.find((r) => r.id === id)!, patch); return { error: null }; } }; },
      };
    },
  };
}
const person = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, linkedin_url: `https://www.linkedin.com/in/${id}`, linkedin_name: id, linkedin_urn: null, linkedin_error: "", linkedin_checked_at: null, instagram_handle: null, source: "", ...extra });

test("the daily retry resolves untagged profiles and stops at the first rate limit, once, without Zernio's own 429 retries", async () => {
  process.env.ZERNIO_API_KEY = "test";
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: URL) => {
    const who = new URL(url).searchParams.get("url")!.split("/").pop()!;
    calls.push(who);
    if (who === "b") return new Response(JSON.stringify({ error: "LinkedIn rate limit reached. Please try again later." }), { status: 429 });
    return new Response(JSON.stringify({ urn: `urn:li:person:${who}`, displayName: who, type: "person" }), { status: 200 });
  }) as typeof fetch;
  try {
    const db = fakeDb([person("a"), person("b"), person("c"), person("z", { linkedin_urn: "urn:li:person:z" }),
      person("gone", { linkedin_error: "LinkedIn did not find this profile", linkedin_checked_at: new Date().toISOString() })]);
    const r = await retryUnresolved(db as never, { max: 10 });
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual({ tried: r.tried, resolved: r.resolved, stopped: r.stopped }, { tried: 2, resolved: 1, stopped: "LinkedIn rate limit" });
    assert.equal(db.rows.find((x) => x.id === "a")!.linkedin_urn, "urn:li:person:a");
    assert.match(String(db.rows.find((x) => x.id === "b")!.linkedin_error), /rate limit/);
  } finally { globalThis.fetch = real; }
});

test("no lookup starts without a full timeout's worth of time before the deadline", async () => {
  const db = fakeDb([person("a")]);
  const r = await retryUnresolved(db as never, { deadline: Date.now() + 30_000 });
  assert.deepEqual({ tried: r.tried, stopped: r.stopped }, { tried: 0, stopped: "deadline" });
});

test("the team (auto_tag) is retried first, whatever was tried least recently", async () => {
  process.env.ZERNIO_API_KEY = "test";
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: URL) => {
    const who = new URL(url).searchParams.get("url")!.split("/").pop()!;
    calls.push(who);
    return new Response(JSON.stringify({ urn: `urn:li:person:${who}`, displayName: who, type: "person" }), { status: 200 });
  }) as typeof fetch;
  try {
    const db = fakeDb([person("old", { linkedin_checked_at: "2026-01-01T00:00:00Z" }), person("abe", { auto_tag: true, linkedin_checked_at: "2026-10-16T00:00:00Z" })]);
    await retryUnresolved(db as never, { max: 1 });
    assert.deepEqual(calls, ["abe"]);
  } finally { globalThis.fetch = real; }
});
