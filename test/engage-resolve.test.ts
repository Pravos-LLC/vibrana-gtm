// Closing a red flag: the lesson text, and when a closed flag comes back. No database: a stub answers the one query.
import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
const { unresolvedFlags, lessonFor } = await import("../lib/engage/resolve.ts");

const flag = (post_key: string, last_at: string | null) => ({ post_key, last_at }) as never;
const stub = (rows: { post_key: string; resolved_at: string }[]) => ({
  from: () => ({ select: () => ({ in: () => ({ order: async () => ({ data: rows, error: null }) }) }) }),
}) as never;

test("a closed flag stays closed until a newer comment arrives on that post", async () => {
  const db = stub([{ post_key: "linkedin|a", resolved_at: "2026-10-27T10:00:00Z" }, { post_key: "linkedin|b", resolved_at: "2026-10-27T10:00:00Z" }]);
  const kept = await unresolvedFlags(db, [flag("linkedin|a", "2026-10-27T09:00:00Z"), flag("linkedin|b", "2026-10-27T11:00:00Z"), flag("linkedin|c", "2026-10-20T00:00:00Z")]);
  assert.deepEqual(kept.map((f) => f.post_key), ["linkedin|b", "linkedin|c"], "a was resolved after its last comment; b got a comment since; c was never resolved");
});

test("the lesson says what was flagged and what John decided, within one lesson's length", () => {
  const t = lessonFor("not_landing", "The AI factory", "The guest already answered these comments, so it is fine");
  assert.match(t, /"not landing" flag on "The AI factory" was closed by John: The guest already answered/);
  assert.ok(lessonFor("backlash", "x".repeat(300), "y".repeat(400)).length <= 500);
});

// ---- attachment link, resolveFlag guards, and the owner-only route ---------------------------------------------

import { installFetchMock } from "./support/fetch-mock.ts";
Object.assign(process.env, { ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test" });
const { resolveAttachmentUrl } = await import("../lib/zernio-inbox.ts");
const { resolveFlag, NOTE_MAX } = await import("../lib/engage/resolve.ts");

test("the attachment link is read from either response shape, asked for as JSON with the account, and must be https", async () => {
  for (const [body, want] of [[{ url: "https://cdn.test/a.jpg" }, "https://cdn.test/a.jpg"], [{ data: { url: "https://cdn.test/b.jpg" } }, "https://cdn.test/b.jpg"], [{ url: "http://cdn.test/c.jpg" }, null], [{}, null]] as const) {
    const m = installFetchMock([{ url: "https://zernio.test/api/v1/inbox/conversations/c1/messages/pm1/attachments/2", status: 200, json: body }]);
    assert.equal(await resolveAttachmentUrl("c1", "pm1", 2, "acc1"), want);
    const u = new URL(m.calls[0].url);
    assert.equal(u.searchParams.get("accountId"), "acc1");
    assert.equal(u.searchParams.get("format"), "json");
    m.restore();
  }
});

test("an over-long note is refused before anything is read or written", async () => {
  const db = { from: () => { throw new Error("must not touch the database"); } } as never;
  const r = await resolveFlag(db, "linkedin|a", "x".repeat(NOTE_MAX + 1), "john");
  assert.deepEqual(r, { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` });
});

test("the attachment route is closed to anyone without the owner session and reaches neither Zernio nor the database", async () => {
  const m = installFetchMock([]);
  const { GET } = await import("../app/api/engage/attachment/[id]/[index]/route.ts");
  const res = await GET(new Request("https://cockpit.test/api/engage/attachment/x/0"), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000001", index: "0" }) });
  assert.equal(res.status, 401);
  assert.equal(m.calls.length, 0);
  m.restore();
});
