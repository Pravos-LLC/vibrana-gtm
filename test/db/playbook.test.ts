// Playbook tags (VIB-421) against the LOCAL stack: what the real PostgREST answers decide. Before the brand.example.com
// migration adds gtm_content_items.playbook_tags, a real run must skip (no model call, nothing written) and a dry
// run must still read every row. Once the column exists, a run writes the tags and leaves the approval intact
// (the approval trigger fires on body or media changes only). The model is a fake; nothing reaches a service.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const { contentHash } = await import("../../lib/calendar-db.ts");
const { COLUMN_MISSING, bodyHash, tagPlaybook } = await import("../../lib/playbook/tag.ts");
import type { Tagger } from "../../lib/playbook/tag.ts";
before(seed);

const ID = "playbook-db-approved";
const BODY = "Which of the three is your blocker?";
const tag: Tagger = async () => ({ raw: { hook: "direct-question", storyline: "one-liner", cta: "open-question", rationale: "Asks readers directly.", confidence: "high" }, model: "test/model" });

test("playbook tag: real PostgREST, with or without the playbook_tags column", async () => {
  const db = admin();
  await db.from("gtm_content_items").delete().eq("id", ID);
  const row = { id: ID, week: 45, date: "2030-11-04", pillar: "perspective", title: "Playbook DB", format: "text", channels: ["linkedin"], status: "approved", body: BODY, media: [] as string[] };
  const ins = await db.from("gtm_content_items").insert({ ...row, approved_hash: contentHash(row) });
  assert.equal(ins.error, null, ins.error?.message ?? "");

  const probe = await db.from("gtm_content_items").select("playbook_tags").limit(1);
  const hasColumn = !probe.error;

  const dry = await tagPlaybook(db, { dryRun: true, tag });
  assert.ok(dry.tagged.some((t) => t.id === ID), "a dry run reads and tags the approved row either way");

  const real = await tagPlaybook(db, { tag });
  const after = (await db.from("gtm_content_items").select("*").eq("id", ID).single()).data as Record<string, unknown>;
  assert.equal(after.status, "approved", "tagging never touches the approval");
  assert.equal(after.approved_hash, contentHash(row));
  if (!hasColumn) {
    assert.equal(real.skipped, COLUMN_MISSING, "the real 42703 from PostgREST is recognized as the missing column");
    assert.deepEqual(real.tagged, []);
    assert.match(dry.skipped ?? "", /^dry run only/);
  } else {
    assert.ok(real.tagged.some((t) => t.id === ID));
    const tags = after.playbook_tags as Record<string, unknown>;
    assert.equal(tags.hook, "direct-question");
    assert.equal(tags.body_hash, bodyHash(BODY));
    const again = await tagPlaybook(db, { tag });
    assert.ok(!again.tagged.some((t) => t.id === ID), "current tags are not redone");
  }
  await db.from("gtm_content_items").delete().eq("id", ID);
});
