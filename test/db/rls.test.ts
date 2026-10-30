// Database + security layer, against the LOCAL Supabase stack only (see docs/testing.md).
// Every gtm_* and review_* table, the metrics view, the RPCs and the content-review bucket, for
// anon, a signed-in non-owner, a user_metadata impostor, the owner and the secret key.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, anon, ANGLE_RUN_ID, FIXTURE_REPORT, OUTREACH_IDS, PIECE_LEDGER, seed, signedIn, sql, TABLES, type Who } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

type Seeded = Awaited<ReturnType<typeof seed>>;
let fx: Seeded;
let db: Record<"anon" | Who, SupabaseClient>;
let sr: SupabaseClient;

before(async () => {
  fx = await seed();
  sr = admin();
  db = { anon: anon(), owner: await signedIn("owner"), member: await signedIn("member"), team: await signedIn("team"), impostor: await signedIn("impostor") };
});

const OUTREACH_IDS_SOLO = OUTREACH_IDS.solo;
// Service-key-only tables: RLS on, no policy and no grant for anon or authenticated, so not even the owner reads them.
const SERVICE_ONLY = ["review_publications", "review_publication_cancellations", "client_feedback"];
const OWNER_READABLE = TABLES.filter((t) => !SERVICE_ONLY.includes(t));
const DENIED = /permission denied|row-level security|violates row-level|not allowed|insufficient/i;

/** Full, ordered contents of every table: the "nothing changed" oracle for denied writes. */
async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const { data, error } = await sr.from(t).select("*");
    assert.equal(error, null, `${t}: ${error?.message}`);
    out[t] = (data ?? []).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

// A valid row per table, so a denial is about privilege and never about a constraint.
function probe(t: (typeof TABLES)[number]): { row: Record<string, unknown>; key: [string, unknown]; patch: Record<string, unknown> } {
  const id = `probe-${randomUUID().slice(0, 8)}`;
  switch (t) {
    case "gtm_content_items": return { row: { id, week: 1, date: "2026-01-01", pillar: "proof", title: "t", format: "f", status: "idea" }, key: ["id", id], patch: { title: "changed" } };
    case "gtm_post_metrics": return { row: { zernio_post_id: id, platform: "x", captured_at: new Date().toISOString() }, key: ["zernio_post_id", id], patch: { likes: 99 } };
    case "gtm_channel_daily": return { row: { account_id: id, platform: "x", date: "2026-01-01" }, key: ["account_id", id], patch: { followers: 99 } };
    case "gtm_crm_snapshots": return { row: { date: "2001-01-01", metrics: {} }, key: ["date", "2001-01-01"], patch: { metrics: { x: 1 } } };
    case "gtm_enrichment_runs": return { row: { run: id, status: "x" }, key: ["run", id], patch: { status: "changed" } };
    case "gtm_spend": return { row: { id, date: "2026-01-01", currency: "EUR", amount: 1, merchant: "m" }, key: ["id", id], patch: { amount: 2 } };
    case "gtm_zernio_events": return { row: { event_id: id, event: "x", payload: {} }, key: ["event_id", id], patch: { event: "changed" } };
    case "gtm_seasons": return { row: { id, title: "t", starts_on: "2026-01-01", ends_on: "2026-01-02" }, key: ["id", id], patch: { title: "changed" } };
    case "gtm_stories": return { row: { id, title: "t", link_url: "https://example.com" }, key: ["id", id], patch: { title: "changed" } };
    case "gtm_story_assets": return { row: { id, story_id: "fx-story", title: "t", kind: "link", source: "https://example.com", sha256: "a".repeat(64), url: "https://example.com" }, key: ["id", id], patch: { title: "changed" } };
    case "gtm_story_asset_channels": return { row: { asset_id: "fx-story-copy", channel: id.replace(/-/g, "_") }, key: ["channel", id.replace(/-/g, "_")], patch: { note: "changed" } };
    case "gtm_story_feedback": return { row: { asset_id: "fx-story-copy", channel: "linkedin", body: id }, key: ["body", id], patch: { resolved_at: "2026-01-01T00:00:00Z", resolution: "changed" } };
    case "gtm_story_asset_versions": { const n = 900 + Math.floor(Math.random() * 90); return { row: { asset_id: "fx-story-copy", revision: n, label: "v1", sha256: "a".repeat(64), kind: "link", title: "t", source: "https://example.com" }, key: ["revision", n], patch: { title: "changed" } }; }
    case "gtm_story_stages": return { row: { story_id: "fx-story", stage: `p${id.slice(6, 14)}`.replace(/[^a-z0-9-]/g, "a"), status: "done" }, key: ["stage", `p${id.slice(6, 14)}`.replace(/[^a-z0-9-]/g, "a")], patch: { note: "changed" } };
    case "gtm_story_stage_decisions": return { row: { story_id: "fx-story", stage: "draft", party: "john", decision: "approved", note: id }, key: ["note", id], patch: { decision: "changes" } };
    case "gtm_inspiration": return { row: { kind: "post", url: `https://example.com/${id}` }, key: ["url", `https://example.com/${id}`], patch: { title: "changed" } };
    case "gtm_signal_stories": { const u = randomUUID(); return { row: { id: u, title: id }, key: ["id", u], patch: { status: "dismissed" } }; }
    case "gtm_signal_items": return { row: { url: `https://example.com/${id}`, source: "s", source_kind: "rss", title: id }, key: ["url", `https://example.com/${id}`], patch: { title: "changed" } };
    case "gtm_signal_feedback": return { row: { story_id: "00000000-0000-4000-8000-0000000000f1", actor: id, action: "save" }, key: ["actor", id], patch: { action: "dismiss" } };
    case "gtm_signal_runs": { const u = randomUUID(); return { row: { id: u, kind: "collect" }, key: ["id", u], patch: { stats: { x: 1 } } }; }
    case "gtm_manual_metrics": return { row: { week_start: "2001-01-01", channel: "youtube" }, key: ["week_start", "2001-01-01"], patch: { note: "changed" } };
    case "gtm_content_reports": return { row: { kind: "baseline", period_start: "2001-01-01", period_end: "2001-01-02" }, key: ["period_start", "2001-01-01"], patch: { headline: "changed" } };
    case "gtm_report_actions": return { row: { report_id: FIXTURE_REPORT, type: "move", proposal: id }, key: ["proposal", id], patch: { rationale: "changed" } };
    case "gtm_sync_state": { const k = id.replace(/-/g, "_"); return { row: { key: k, value: {} }, key: ["key", k], patch: { value: { x: 1 } } }; }
    case "gtm_comments": return { row: { source: "poll", platform: "instagram", external_id: id, text: "t" }, key: ["external_id", id], patch: { status: "skipped" } };
    case "gtm_content_candidates": return { row: { week_start: "2001-01-01", slug: id, format: "text", lens: "regenerative", pillar: "perspective", channels: ["linkedin"], title: "t", body: "b", sources: [{ url: "https://example.com" }], agent_draft: {} }, key: ["slug", id], patch: { title: "changed" } };
    case "gtm_ideas": return { row: { slug: id, title: "t" }, key: ["slug", id], patch: { status: "parked" } };
    case "gtm_storyboards": { const st = `p${randomUUID().replace(/[^a-z]/g, "").slice(0, 10)}`; return { row: { id, story_id: "fx-story", stage: st, format: "short", title: "t" }, key: ["id", id], patch: { title: "changed" } }; }
    case "gtm_storyboard_versions": { const n = 900 + Math.floor(Math.random() * 90); return { row: { storyboard_id: "sb-fx-story-enhance-plan", version: n, doc: {}, doc_sha: "a".repeat(64), schema: "vibrana.storyboard/1", scene_shas: {}, produced_by: id }, key: ["produced_by", id], patch: { changes: "changed" } }; }
    case "gtm_storyboard_rules": return { row: { format: "short", rule: `rule ${id}` }, key: ["rule", `rule ${id}`], patch: { status: "retired" } };
    case "gtm_storyboard_comments": return { row: { storyboard_id: "sb-fx-story-enhance-plan", version: 1, kind: "note", body: id }, key: ["body", id], patch: { status: "resolved" } };
    case "gtm_storyboard_scene_decisions": return { row: { storyboard_id: "sb-fx-story-enhance-plan", version: 1, scene_id: "sc-hook", scene_sha: "b".repeat(64), decision: "approved", note: id }, key: ["note", id], patch: { decision: "changes" } };
    case "gtm_storyboard_spend": return { row: { storyboard_id: "sb-fx-story-enhance-plan", version: 1, kind: "spent", credits: 1, note: id }, key: ["note", id], patch: { credits: 2 } };
    case "gtm_broll_shots": return { row: { id, file: "media/probe.mp4" }, key: ["id", id], patch: { description: "changed" } };
    case "gtm_reviewer_invites": { const h = randomUUID().replaceAll("-", "").padEnd(64, "0"); return { row: { token_sha256: h, party: "Fixture Partner", expires_at: "2099-01-01T00:00:00Z" }, key: ["token_sha256", h], patch: { revoked_at: new Date().toISOString() } }; }
    case "gtm_reviewer_invite_accounts": return { row: { invite_id: "00000000-0000-4000-8000-0000000000a1", user_id: randomUUID(), email: id }, key: ["email", id], patch: { claimed_at: "2026-01-01T00:00:00Z" } };
    case "gtm_reviewer_asset_decisions": return { row: { story_id: "s1-90-fx-partner-final", asset_id: "fx-partner-video", asset_sha256: "a".repeat(64), revision: 1, party: "Fixture Partner", decision: "note", note: id }, key: ["note", id], patch: { decided_by_email: "changed@gtm.test" } };
    case "gtm_people": { const u = randomUUID(); return { row: { id: u, name: `probe ${id}` }, key: ["id", u], patch: { instagram_handle: "changed" } }; }
    case "gtm_outreach_drafts": { const u = randomUUID(); return { row: { id: u, batch: "probe", domain: `${id}.example` }, key: ["id", u], patch: { status: "accepted" } }; }
    case "gtm_outreach_draft_versions": { const u = randomUUID(); return { row: { id: u, draft_id: "00000000-0000-4000-8000-0000000000c3", version: 9, reason: "edited", subject: "s", body: "b", linkedin_note: "", followups: [], status: "pending" }, key: ["id", u], patch: { body: "changed" } }; }
    case "gtm_outreach_dossiers": return { row: { twenty_person_id: id, domain: `${id}.example`, name: "probe" }, key: ["twenty_person_id", id], patch: { skipped_at: new Date().toISOString(), skip_reason: "changed" } };
    case "gtm_outreach_tracks": return { row: { track: "guest", daily_target: 3, from_address: "probe@example.test" }, key: ["track", "guest"], patch: { daily_target: 9 } };
    case "gtm_outreach_angle_runs": { const u = randomUUID(); return { row: { id: u, person: id, angles: [] }, key: ["id", u], patch: { model: "changed" } }; }
    case "gtm_outreach_angle_edits": { const u = randomUUID(); return { row: { id: u, run_id: ANGLE_RUN_ID, draft_id: OUTREACH_IDS_SOLO, person: id, channel: "linkedin" /* the seed row is (solo, email): unique (draft_id, channel) */, angle_key: "light_touch", generated: {}, final: {} }, key: ["id", u], patch: { analyzed_at: new Date().toISOString() } }; }
    case "gtm_outreach_lessons": { const u = randomUUID(); return { row: { id: u, kind: "body", lesson: `lesson ${id}` }, key: ["id", u], patch: { lesson: "changed lesson" } }; }
    case "gtm_outreach_learn_runs": { const u = randomUUID(); return { row: { id: u }, key: ["id", u], patch: { stats: { x: 1 } } }; }
    case "gtm_outreach_desk": return { row: { id: true, daily_target: 3 }, key: ["id", true], patch: { daily_target: 9 } };
    case "gtm_work_items": { const u = randomUUID(); return { row: { id: u, title: `probe ${id}` }, key: ["id", u], patch: { status: "done" } }; }
    case "gtm_comment_runs": { const u = randomUUID(); return { row: { id: u, kind: "daily" }, key: ["id", u], patch: { stats: { x: 1 } } }; }
    case "gtm_red_flag_alerts": { const u = randomUUID(); return { row: { id: u, post_key: `instagram|${id}`, flag: "backlash" }, key: ["id", u], patch: { email_id: "changed" } }; }
    case "gtm_red_flag_resolutions": { const u = randomUUID(); return { row: { id: u, post_key: `instagram|${id}`, flag: "backlash" }, key: ["id", u], patch: { note: "changed" } }; }
    case "gtm_engage_lessons": { const u = randomUUID(); return { row: { id: u, kind: "voice", lesson: `lesson ${id}` }, key: ["id", u], patch: { lesson: "changed" } }; }
    case "client_feedback": { const u = randomUUID(); return { row: { id: u, slug: id }, key: ["id", u], patch: { respondent_name: "changed" } }; }
    case "review_batches": return { row: { series: id, round: 1, title: "t", workspace_dir: "x", status: "submitted" }, key: ["series", id], patch: { title: "changed" } };
    case "review_assets": return { row: { batch_id: fx.openBatch, position: 90 + Math.floor(Math.random() * 9), slug: id, title: "t", kind: "image", storage_path: "x" }, key: ["slug", id], patch: { title: "changed" } };
    case "review_comments": { const u = randomUUID(); return { row: { id: u, asset_id: fx.assets[0], body: id }, key: ["id", u], patch: { body: "changed" } }; }
    case "review_publications": return { row: { id: randomUUID(), series: id, round: 1, title: "t", workspace_dir: "x" }, key: ["series", id], patch: { title: "changed" } };
    case "review_publication_cancellations": { const u = randomUUID(); return { row: { id: u }, key: ["id", u], patch: { created_at: new Date().toISOString() } }; }
  }
}

// The shared piece review and delivery ledger (vendored 20261017020000 and 20261017030000): RLS on, select-only for
// the owner policy and the secret key, and no INSERT, UPDATE or DELETE grant for anyone, the secret key included.
// Every write is a checked SECURITY DEFINER function. Who may run each one, as the migrations grant it:
const PIECE_RPCS: Record<string, { anon: boolean; authenticated: boolean; service: boolean }> = Object.fromEntries(([
  // Owner decisions from the browser, never the secret key (a decision needs a person).
  ...["gtm_decide_piece_part", "gtm_save_piece_text", "gtm_convert_piece_legacy_fix", "gtm_set_piece_dispatch", "gtm_release_piece_review"].map((n) => [n, false, true, false]),
  // Owner reads and configuration, also run by the CLI with the secret key; the function checks the owner claim.
  ...["gtm_piece_snapshot", "gtm_piece_candidates", "gtm_configure_piece_review", "gtm_reviewer_decide_piece_video"].map((n) => [n, false, true, true]),
  // Staging, fix completion and the delivery ledger: the secret key only.
  ...["gtm_complete_piece_fix", "gtm_prepare_piece_delivery", "gtm_prepare_piece_deliveries", "gtm_claim_piece_delivery", "gtm_start_piece_send", "gtm_record_piece_delivery",
    "gtm_claim_legacy_send", "gtm_replan_unsent_delivery", "gtm_release_piece_delivery", "gtm_resend_uncertain_delivery", "gtm_resolve_uncertain_delivery", "gtm_retire_piece_delivery"].map((n) => [n, false, false, true]),
  // Internal helpers and the ledger's write switch: only the SECURITY DEFINER functions above call them, no role can.
  ...["gtm_piece_require_actor", "gtm_piece_asset_fingerprint", "gtm_delivery_require_service", "gtm_piece_delivery_hold", "gtm_piece_ledger_write"].map((n) => [n, false, false, false]),
] as Array<[string, boolean, boolean, boolean]>).map(([n, a, u, s]) => [n, { anon: a, authenticated: u, service: s }]));

// The lists this suite iterates must match what the migrations actually create, so a re-vendored
// migration that adds a table or a callable function cannot slip past untested.
const RPCS = ["cancel_review_publication", "finalize_review_publication", "gtm_add_story_feedback", "gtm_add_storyboard_comment", "gtm_claim_red_flag_alert", "gtm_decide_story_asset", "gtm_decide_story_stage", "gtm_decide_storyboard", "gtm_decide_storyboard_scene", "gtm_outreach_accept", "gtm_reopen_storyboard", "gtm_reviewer_add_feedback", "gtm_reviewer_claim", "gtm_reviewer_decide", "gtm_reviewer_decide_asset", "gtm_reviewer_decide_asset_by_link", "gtm_reviewer_parties", "gtm_reviewer_story", "gtm_reviewer_throttle", "gtm_set_story_hold", "gtm_storyboard_anchor_ok", "gtm_storyboard_is_owner", "gtm_storyboard_unapproved_scenes", "gtm_swap_slots", "gtm_update_season", "gtm_update_storyboard_rule", "gtm_withdraw_storyboard_comment", "gtm_work_waiting_notes", "reserve_review_publication", "submit_review"];
test("the tested inventory equals every public table, view and callable function", () => {
  const tables = sql("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'").trim().split(",");
  assert.deepEqual(tables, [...TABLES, ...PIECE_LEDGER].sort());
  const views = sql("select string_agg(viewname, ',' order by viewname) from pg_views where schemaname = 'public'").trim().split(",");
  assert.deepEqual(views, ["gtm_post_metrics_latest"]);
  const fns = sql("select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and prorettype <> 'trigger'::regtype").trim().split(",");
  assert.deepEqual(fns, [...RPCS, ...Object.keys(PIECE_RPCS)].sort());
});

/** One row in every ledger table, on its own Story, written as the superuser (the tables take no direct writes). */
const LEDGER_DELIVERY = "00000000-0000-4000-8000-0000000000d1";
function seedLedger() {
  sql(`set session_replication_role = replica;
    insert into public.gtm_stories (id, title, link_url) values ('fx-ledger', 'Fixture ledger', 'https://example.com/fx-ledger');
    insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values ('fx-ledger-text', 'fx-ledger', 'Text', 'copy', 'copy.md', repeat('a', 64), 'Hello');
    insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values ('fx-ledger-video', 'fx-ledger', 'Video', 'video', 'v.mp4', repeat('b', 64), 'stories/fx-ledger/v.mp4', 'final');
    insert into public.gtm_content_items (id, week, date, pillar, title, format, status, story_id, channels) values ('fx-ledger-linkedin', 1, '2099-01-05', 'proof', 'Ledger', 'video', 'approved', 'fx-ledger', '{linkedin}');
    insert into public.gtm_piece_reviews (story_id, text_asset_id, video_asset_id, channels) values ('fx-ledger', 'fx-ledger-text', 'fx-ledger-video', '{linkedin}');
    insert into public.gtm_piece_part_decisions (story_id, part, fingerprint, status) values ('fx-ledger', 'text', 'fp-text', 'pending');
    insert into public.gtm_piece_fixes (story_id, part, asset_id, note, base_fingerprint, base_revision, base_asset) values ('fx-ledger', 'text', 'fx-ledger-text', 'Fixture fix', 'fp-text', 1, '{}');
    insert into public.gtm_piece_deliveries (id, story_id, channel, calendar_id, slot_date, slot_time, timezone, review_snapshot) values ('${LEDGER_DELIVERY}', 'fx-ledger', 'linkedin', 'fx-ledger-linkedin', '2099-01-05', '14:00', 'Europe/Berlin', '{}');
    insert into public.gtm_piece_delivery_attempts (id, delivery_id, story_id, channel, calendar_id, request) values (gen_random_uuid(), '${LEDGER_DELIVERY}', 'fx-ledger', 'linkedin', 'fx-ledger-linkedin', '{}');
    insert into public.gtm_piece_decision_events (story_id, part, fingerprint, status, source_role) values ('fx-ledger', 'text', 'fp-text', 'pending', 'fixture');
    set session_replication_role = origin;`);
}
const ledgerState = () => sql(`select ${PIECE_LEDGER.map((t) => `(select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.${t} x)`).join(" || ',' || ")}`).trim();

test("piece review and delivery ledger: the owner and the secret key read, nobody else does, and nobody writes a table directly", async () => {
  seedLedger();
  const before = ledgerState();
  for (const t of PIECE_LEDGER) {
    const a = await db.anon.from(t).select("*");
    assert.match(a.error?.message ?? `anon read ${JSON.stringify(a.data)}`, DENIED, `anon ${t}`);
    for (const who of ["member", "impostor", "team"] as const) {
      const r = await db[who].from(t).select("*");
      assert.equal(r.error, null, `${who} ${t}: ${r.error?.message}`);
      assert.deepEqual(r.data, [], `${who} sees no ${t} rows`);
    }
    for (const [who, client] of [["owner", db.owner], ["secret key", sr]] as const) {
      const r = await client.from(t).select("*");
      assert.equal(r.error, null, `${who} ${t}: ${r.error?.message}`);
      assert.equal(r.data?.length, 1, `${who} reads the ${t} fixture`);
    }
    const key = t === "gtm_piece_deliveries" ? "id" : "story_id";
    const value = t === "gtm_piece_deliveries" ? LEDGER_DELIVERY : "fx-ledger";
    for (const [who, client] of [["anon", db.anon], ["member", db.member], ["impostor", db.impostor], ["team", db.team], ["owner", db.owner], ["secret key", sr]] as const) {
      const ins = await client.from(t).insert({ story_id: "fx-ledger" });
      assert.match(ins.error?.message ?? "insert allowed", DENIED, `${who} insert ${t}`);
      const up = await client.from(t).update({ story_id: "fx-ledger" }).eq(key, value);
      assert.match(up.error?.message ?? "update allowed", DENIED, `${who} update ${t}`);
      const del = await client.from(t).delete().eq(key, value);
      assert.match(del.error?.message ?? "delete allowed", DENIED, `${who} delete ${t}`);
    }
  }
  assert.equal(ledgerState(), before, "no refused write changed a ledger row");
});

test("piece review and delivery functions: each role can run exactly what the migrations grant it", async () => {
  const rows = sql(`select p.proname, bool_and(has_function_privilege('anon', p.oid, 'execute')), bool_and(has_function_privilege('authenticated', p.oid, 'execute')), bool_and(has_function_privilege('service_role', p.oid, 'execute'))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype and p.proname = any(array[${Object.keys(PIECE_RPCS).map((n) => `'${n}'`).join(",")}]) group by p.proname order by p.proname`)
    .trim().split("\n").map((l) => l.split("|"));
  const actual = Object.fromEntries(rows.map(([n, a, u, s]) => [n, { anon: a === "t", authenticated: u === "t", service: s === "t" }]));
  assert.deepEqual(actual, PIECE_RPCS);
  // Through the API: anon is refused; a signed-in non-owner or impostor gets the owner check's 42501, the owner and the
  // secret key read the piece.
  assert.match((await db.anon.rpc("gtm_piece_snapshot", { p_story_id: "fx-ledger" })).error?.message ?? "no error", DENIED);
  for (const who of ["member", "impostor", "team"] as const) assert.equal((await db[who].rpc("gtm_piece_snapshot", { p_story_id: "fx-ledger" })).error?.code, "42501", `${who} snapshot`);
  for (const client of [db.owner, sr]) {
    const r = await client.rpc("gtm_piece_snapshot", { p_story_id: "fx-ledger" });
    assert.equal(r.error, null, r.error?.message ?? "");
    assert.equal((r.data as { storyId: string }).storyId, "fx-ledger");
  }
  for (const who of ["member", "owner"] as const) {
    assert.match((await db[who].rpc("gtm_claim_piece_delivery", { p_id: LEDGER_DELIVERY, p_retry: false })).error?.message ?? "no error", DENIED, `${who} cannot claim a delivery`);
  }
  assert.match((await sr.rpc("gtm_decide_piece_part", { p_story_id: "fx-ledger", p_part: "text", p_decision: "approved", p_note: "", p_expected_fingerprint: "x", p_expected_revision: 1 })).error?.message ?? "no error", DENIED, "the secret key never decides");
});

test("review-link functions: anon is refused, and without a claimed invite nobody reviews anything", async () => {
  const before = await snapshot();
  const expected = [{ asset_id: "fx-partner-video", sha256: "a".repeat(64), revision: 1 }];
  for (const [fn, args] of [
    ["gtm_reviewer_parties", {}],
    ["gtm_reviewer_claim", { p_token_sha256: "1".repeat(64), p_email: "x@example.com" }],
    ["gtm_reviewer_add_feedback", { p_asset_id: "fx-partner-video", p_body: "x" }],
    ["gtm_reviewer_decide", { p_story_id: "s1-90-fx-partner-final", p_decision: "approved", p_note: "", p_expected: expected }],
    ["gtm_reviewer_decide_asset", { p_asset_id: "fx-partner-video", p_decision: "approved", p_note: "", p_sha256: "a".repeat(64), p_revision: 1 }],
    ["gtm_reviewer_decide_asset_by_link", { p_token_sha256: "1".repeat(64), p_asset_id: "fx-partner-video", p_decision: "approved", p_note: "", p_sha256: "a".repeat(64), p_revision: 1 }],
    ["gtm_reviewer_story", { p_story_id: "s1-90-fx-partner-final" }],
    ["gtm_reviewer_throttle", { p_who: "Fixture Partner" }],
  ] as const) assert.match((await db.anon.rpc(fn, args)).error?.message ?? "no error", DENIED, `anon ${fn}`);
  for (const who of ["member", "impostor", "team", "owner"] as const) {
    assert.deepEqual((await db[who].rpc("gtm_reviewer_parties")).data, [], `${who} reviews for nobody`);
    assert.match((await db[who].rpc("gtm_reviewer_story", { p_story_id: "s1-90-fx-partner-final" })).error?.message ?? "no error", DENIED, `${who} cannot call the internal scope check`);
    assert.equal((await db[who].rpc("gtm_reviewer_add_feedback", { p_asset_id: "fx-partner-video", p_body: "x" })).error?.code, "42501", `${who} note`);
    assert.equal((await db[who].rpc("gtm_reviewer_decide", { p_story_id: "s1-90-fx-partner-final", p_decision: "approved", p_note: "", p_expected: expected })).error?.code, "42501", `${who} decide`);
    assert.equal((await db[who].rpc("gtm_reviewer_decide_asset", { p_asset_id: "fx-partner-video", p_decision: "approved", p_note: "", p_sha256: "a".repeat(64), p_revision: 1 })).error?.code, "42501", `${who} decide asset`);
  }
  for (const who of ["owner", "team"] as const) {
    assert.equal((await db[who].rpc("gtm_reviewer_claim", { p_token_sha256: "1".repeat(64), p_email: "x@example.com" })).error?.code, "42501", `${who} never claims a link`);
  }
  assert.match((await db.member.rpc("gtm_reviewer_claim", { p_token_sha256: "1".repeat(64), p_email: "x@example.com" })).error?.message ?? "", /not valid/);
  assert.deepEqual(await snapshot(), before, "no refused call changed any row");
});

test("anon is denied every table and the metrics view outright", async () => {
  for (const t of [...TABLES, "gtm_post_metrics_latest"]) {
    const { data, error } = await db.anon.from(t).select("*").limit(1);
    assert.ok(error, `${t}: anon read returned ${JSON.stringify(data)}`);
    assert.match(error.message, DENIED, t);
  }
});

test("a signed-in non-owner, a gtm_team member and a user_metadata impostor read zero rows everywhere", async () => {
  // gtm_team grants /signals through the cockpit server (claim check + secret key), never RLS reads.
  for (const who of ["member", "team", "impostor"] as const) {
    for (const t of [...OWNER_READABLE, "gtm_post_metrics_latest"]) {
      const { data, error } = await db[who].from(t).select("*");
      assert.equal(error, null, `${who} ${t}: ${error?.message}`);
      assert.deepEqual(data, [], `${who} ${t}`);
    }
    for (const t of SERVICE_ONLY) {
      const { error } = await db[who].from(t).select("*");
      assert.match(error?.message ?? "", DENIED, `${who} ${t}`);
    }
  }
});

test("the owner reads every seeded gtm_* and review_* table and the view", async () => {
  for (const t of [...OWNER_READABLE, "gtm_post_metrics_latest"]) {
    const [{ data, error }, { count }] = await Promise.all([db.owner.from(t).select("*"), sr.from(t).select("*", { count: "exact", head: true })]);
    assert.equal(error, null, `${t}: ${error?.message}`);
    assert.ok((data ?? []).length > 0, `${t} has seeded rows`);
    assert.equal(data!.length, count, `${t}: owner sees every row`);
  }
  // Reservations and tombstones are CLI-internal: not even the owner can read them.
  for (const t of SERVICE_ONLY) {
    assert.match((await db.owner.from(t).select("*")).error?.message ?? "", DENIED, t);
  }
});

test("gtm_post_metrics_latest is security_invoker and returns the latest snapshot per post and platform", async () => {
  const { data } = await db.owner.from("gtm_post_metrics_latest").select("zernio_post_id,platform,impressions").order("zernio_post_id");
  assert.deepEqual(data, [{ zernio_post_id: "zp-1", platform: "linkedin", impressions: 1200 }, { zernio_post_id: "zp-ext", platform: "instagram", impressions: 0 }]);
});

test("anon, non-owner, impostor and owner cannot insert, update or delete any table (review exceptions aside)", async () => {
  const before = await snapshot();
  for (const who of ["anon", "member", "team", "impostor", "owner"] as const) {
    for (const t of TABLES) {
      if (who === "owner" && t === "review_comments") continue; // owner comments while open: covered below
      const p = probe(t);
      const ins = await db[who].from(t).insert(p.row).select();
      // For review_comments the lock trigger runs before the RLS check and, as a non-owner, cannot see
      // the asset (RLS hides it), so the refusal deterministically reads "unknown asset". Asserting exactly
      // that makes a change in which layer refuses visible. Still a denial; the snapshot proves it.
      const refused = t === "review_comments" && who !== "anon" ? /unknown asset/ : DENIED;
      assert.match(ins.error?.message ?? "no error", refused, `${who} inserted into ${t}`);
      const [col, val] = Object.entries(p.row)[0];
      const up = await db[who].from(t).update(p.patch).eq(col, val as string).select();
      assert.ok(up.error || up.data?.length === 0, `${who} updated ${t}`);
      const upAll = await db[who].from(t).update(p.patch).not(col, "is", null).select();
      assert.ok(upAll.error || upAll.data?.length === 0, `${who} bulk-updated ${t}: ${JSON.stringify(upAll.data)}`);
      const del = await db[who].from(t).delete().not(col, "is", null).select();
      assert.ok(del.error || del.data?.length === 0, `${who} deleted from ${t}`);
    }
  }
  assert.deepEqual(await snapshot(), before, "no denied write changed any row");
});

test("owner insert of a comment is column-limited: batch_id and author cannot be supplied", async () => {
  const forged = await db.owner.from("review_comments").insert({ asset_id: fx.assets[0], batch_id: fx.pastBatch, body: "forged" }).select();
  assert.match(forged.error?.message ?? "", DENIED);
  const author = await db.owner.from("review_comments").insert({ asset_id: fx.assets[0], author: fx.users.member, body: "forged" }).select();
  assert.match(author.error?.message ?? "", DENIED);
});

test("the secret key can write every table (service_role), except append-only cancellation tombstones and stage decisions", async () => {
  for (const t of TABLES) {
    const p = probe(t);
    // The desk is a single row: make room for the probe's.
    if (t === "gtm_outreach_desk") await sr.from(t).delete().eq("id", true);
    if (t === "gtm_outreach_tracks") await sr.from(t).delete().eq("track", "guest");
    const ins = await sr.from(t).insert(p.row).select();
    assert.equal(ins.error, null, `${t} insert: ${ins.error?.message}`);
    const appendOnly = ["gtm_story_stage_decisions", "gtm_storyboard_versions", "gtm_storyboard_scene_decisions"].includes(t);
    if (t === "review_publication_cancellations" || appendOnly) {
      if (appendOnly) {
        const up = await sr.from(t).update(p.patch).eq(...p.key as [string, string]).select();
        assert.match(up.error?.message ?? "", /append-only/, `${t} rows cannot be edited, even by service_role`);
      }
      const del = await sr.from(t).delete().eq(...p.key as [string, string]).select();
      assert.match(del.error?.message ?? "", appendOnly ? /append-only/ : DENIED, `${t} rows cannot be deleted, even by service_role`);
      continue;
    }
    const up = await sr.from(t).update(p.patch).eq(...p.key as [string, string]).select();
    assert.equal(up.error, null, `${t} update: ${up.error?.message}`);
    assert.equal(up.data?.length, 1, `${t} update hit the probe: ${JSON.stringify(p.key)}`);
    const del = await sr.from(t).delete().eq(...p.key as [string, string]).select();
    assert.equal(del.error, null, `${t} delete: ${del.error?.message}`);
    assert.equal(del.data?.length, 1, `${t} delete hit the probe: ${JSON.stringify(p.key)}`);
  }
});

test("RPCs: publication functions are service_role only; submit_review and story decisions are owner only", async () => {
  for (const who of ["anon", "member", "team", "impostor", "owner"] as const) {
    const id = randomUUID();
    for (const [fn, args] of [
      ["reserve_review_publication", { p_id: id, p_series: "x", p_round: 1, p_title: "t", p_workspace_dir: "x" }],
      ["finalize_review_publication", { p_id: id, p_assets: [] }],
      ["cancel_review_publication", { p_id: id }],
      ["gtm_claim_red_flag_alert", { p_post_key: `instagram|${id}`, p_flag: "backlash", p_cooldown_hours: 24 }],
      ["gtm_outreach_accept", { p_id: "00000000-0000-4000-8000-0000000000c1", p_actor: "x" }],
    ] as const) {
      const { error } = await db[who].rpc(fn, args);
      assert.match(error?.message ?? "no error", DENIED, `${who} ${fn}`);
    }
  }
  assert.match((await db.anon.rpc("submit_review", { p_batch_id: fx.openBatch })).error?.message ?? "", DENIED);
  for (const who of ["member", "impostor"] as const) {
    assert.match((await db[who].rpc("submit_review", { p_batch_id: fx.openBatch })).error?.message ?? "", /owner only/);
  }
  const decide = { p_asset_id: "fx-story-copy", p_channel: "linkedin", p_status: "approved", p_note: "", p_expected_revision: 1 };
  const sha = (await sr.from("gtm_story_assets").select("sha256").eq("id", "fx-story-copy").single()).data!.sha256;
  assert.match((await db.anon.rpc("gtm_decide_story_asset", { ...decide, p_expected_sha256: sha })).error?.message ?? "", DENIED);
  for (const who of ["member", "impostor"] as const) {
    assert.match((await db[who].rpc("gtm_decide_story_asset", { ...decide, p_expected_sha256: sha })).error?.message ?? "", /only the signed-in owner/);
  }
  const stage = { p_story_id: "fx-story", p_stage: "rough-cut", p_decision: "approved", p_note: "", p_expected: [{ asset_id: "fx-story-copy", sha256: sha, revision: 1 }], p_reset_stages: [] };
  assert.match((await db.anon.rpc("gtm_decide_story_stage", stage)).error?.message ?? "", DENIED);
  for (const who of ["member", "impostor", "team"] as const) {
    assert.match((await db[who].rpc("gtm_decide_story_stage", stage)).error?.message ?? "", /only the signed-in owner can decide a stage/, who);
  }
  // A stale digest is refused promptly with the refresh message (PT409 -> HTTP 409; it was a retried
  // 40001 that hung for the 60 s gateway timeout before VIB-399) and never records an approval.
  const t0 = Date.now();
  const stale = await db.owner.rpc("gtm_decide_story_asset", { ...decide, p_expected_sha256: "b".repeat(64) }).abortSignal(AbortSignal.timeout(5000));
  assert.match(stale.error?.message ?? "", /Story asset changed; refresh and review the new version/);
  assert.equal(stale.error?.code, "PT409");
  assert.ok(Date.now() - t0 < 5000, "stale decision answered promptly");
  assert.equal((await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", "fx-story-copy").eq("channel", "linkedin").single()).data!.status, "pending");
  const ok = await db.owner.rpc("gtm_decide_story_asset", { ...decide, p_expected_sha256: sha });
  assert.equal(ok.error, null, String(ok.error?.message));
  const row = (await sr.from("gtm_story_asset_channels").select("*").eq("asset_id", "fx-story-copy").eq("channel", "linkedin").single()).data!;
  assert.deepEqual([row.status, row.approved_sha256, row.reviewed_by], ["approved", sha, fx.users.owner]);
  // The owner cannot forge an approval by writing the table directly.
  assert.match((await db.owner.from("gtm_story_asset_channels").update({ status: "approved", approved_sha256: "c".repeat(64) }).eq("channel", "linkedin").select()).error?.message ?? "", DENIED);
  // Service role cannot record an approval either: approvals need a signed-in user.
  assert.match((await sr.from("gtm_story_asset_channels").update({ status: "approved" }).eq("asset_id", "fx-story-link").select()).error?.message ?? "", /signed-in owner/);
});

test("owner comments while the round is open, submits once, then every role is locked out", async () => {
  const c = await db.owner.from("review_comments").insert({ id: randomUUID(), asset_id: fx.assets[0], t_ms: 1500, body: "db-layer note" }).select().single();
  assert.equal(c.error, null, String(c.error?.message));
  assert.equal(c.data!.batch_id, fx.openBatch, "batch derived from the asset");
  assert.equal(c.data!.author, fx.users.owner);
  const commentId: string = c.data!.id;
  const edited = await db.owner.from("review_comments").update({ body: "db-layer note, edited" }).eq("id", c.data!.id).select();
  assert.equal(edited.data?.length, 1);
  assert.match((await db.owner.from("review_batches").update({ title: "renamed" }).eq("id", fx.openBatch).select()).error?.message ?? "", DENIED);
  const skip = await db.owner.from("review_batches").update({ status: "actioned" }).eq("id", fx.openBatch).select();
  assert.ok(skip.error || skip.data?.length === 0, "owner cannot skip to actioned");

  const submitted = await db.owner.rpc("submit_review", { p_batch_id: fx.openBatch });
  assert.equal(submitted.error, null, String(submitted.error?.message));
  assert.equal((submitted.data as { status: string }).status, "submitted");
  assert.match((await db.owner.rpc("submit_review", { p_batch_id: fx.openBatch })).error?.message ?? "", /is not open/);
  for (const [who, client] of [["owner", db.owner], ["service_role", sr]] as [string, SupabaseClient][]) {
    const ins = await client.from("review_comments").insert({ asset_id: fx.assets[0], body: "late" }).select();
    assert.ok(ins.error, `${who} commented on a submitted round`);
    const up: { error: unknown; data: unknown[] | null } = await client.from("review_comments").update({ body: "late edit" }).eq("id", commentId).select();
    assert.ok(up.error || up.data?.length === 0, `${who} edited a locked comment`);
    const del: { error: unknown; data: unknown[] | null } = await client.from("review_comments").delete().eq("id", commentId).select();
    assert.ok(del.error || del.data?.length === 0, `${who} deleted a locked comment`);
  }
  assert.equal((await sr.from("review_comments").select("body").eq("id", c.data!.id).single()).data!.body, "db-layer note, edited");
  assert.match((await sr.from("review_batches").update({ status: "open" }).eq("id", fx.openBatch).select()).error?.message ?? "", /cannot move from submitted to open/);
});

test("content-review bucket: private; only the owner reads; only the secret key writes", async () => {
  const [key] = fx.keys;
  const bucket = (await sr.storage.getBucket("content-review")).data!;
  assert.equal(bucket.public, false);
  const pub = await fetch(`${local().url}/storage/v1/object/public/content-review/${key}`);
  assert.notEqual(pub.status, 200, "no public URL");
  await pub.body?.cancel();

  for (const who of ["anon", "member", "impostor"] as const) {
    const s = db[who].storage.from("content-review");
    assert.ok((await s.download(key)).error, `${who} downloaded`);
    assert.ok((await s.createSignedUrl(key, 60)).error, `${who} signed a URL`);
    const list = await s.list(key.split("/")[0], { limit: 100 });
    assert.deepEqual(list.data ?? [], [], `${who} listed`);
    assert.ok((await s.upload(`${key}.${who}`, Buffer.from("x"), { contentType: "image/png" })).error, `${who} uploaded`);
    await s.remove([key]);
  }
  const owner = db.owner.storage.from("content-review");
  const listed = await owner.list(key.split("/")[0], { limit: 100 });
  assert.equal(listed.error, null, String(listed.error?.message));
  assert.ok((listed.data ?? []).length > 0, "positive control: the owner can list what non-owners cannot");
  const dl = await owner.download(key);
  assert.equal(dl.error, null, String(dl.error?.message));
  assert.ok((await dl.data!.arrayBuffer()).byteLength > 1000);
  const signed = await owner.createSignedUrl(key, 60);
  assert.equal(signed.error, null);
  const got = await fetch(signed.data!.signedUrl);
  assert.equal(got.status, 200);
  await got.body?.cancel();
  assert.ok((await owner.upload(`${key}.owner`, Buffer.from("x"), { contentType: "image/png" })).error, "owner uploaded");
  const removed = await owner.remove([key]);
  assert.deepEqual(removed.data ?? [], [], "owner removed an object");
  assert.equal((await sr.storage.from("content-review").download(key)).error, null, "object survives every non-service delete");
  const up = await sr.storage.from("content-review").upload(`probe/${randomUUID()}.png`, Buffer.from("x"), { contentType: "image/png" });
  assert.equal(up.error, null, String(up.error?.message));
  const wrongType = await sr.storage.from("content-review").upload(`probe/${randomUUID()}.txt`, Buffer.from("x"), { contentType: "text/plain" });
  assert.ok(wrongType.error, "bucket only accepts review media types");
});

test("gtm_swap_slots is service_role only: anon, a member, the impostor and the owner cannot call it", async () => {
  for (const who of ["anon", "member", "impostor", "owner"] as const) {
    const { error } = await db[who].rpc("gtm_swap_slots", { p_a: "fx-upcoming-idea", p_b: "fx-later" });
    assert.match(error?.message ?? "", DENIED, who);
  }
});

test("Storyboard Studio RPCs are the owner's only: anon, a member, an impostor and a gtm_team member are refused", async () => {
  const calls = [
    ["gtm_add_storyboard_comment", { p_storyboard_id: "sb-fx-story-enhance-plan", p_version: 1, p_anchor: {}, p_kind: "note", p_body: "x" }],
    ["gtm_withdraw_storyboard_comment", { p_comment_id: randomUUID() }],
    ["gtm_decide_storyboard_scene", { p_storyboard_id: "sb-fx-story-enhance-plan", p_version: 1, p_scene_id: "sc-hook", p_expected_scene_sha: "1".repeat(64), p_decision: "approved", p_note: "" }],
    ["gtm_decide_storyboard", { p_storyboard_id: "sb-fx-story-enhance-plan", p_version: 1, p_doc_sha: "d".repeat(64), p_decision: "approved", p_note: "", p_approve_remaining: true }],
    ["gtm_reopen_storyboard", { p_storyboard_id: "sb-fx-story-enhance-plan", p_note: "x", p_reset_stages: [] }],
    ["gtm_update_storyboard_rule", { p_rule_id: randomUUID(), p_status: "retired" }],
  ] as const;
  const before = await snapshot();
  for (const [fn, args] of calls) {
    assert.match((await db.anon.rpc(fn, args)).error?.message ?? "no error", DENIED, `anon ${fn}`);
    for (const who of ["member", "impostor", "team"] as const) {
      assert.match((await db[who].rpc(fn, args)).error?.message ?? "no error", /only the signed-in owner/, `${who} ${fn}`);
    }
  }
  assert.deepEqual(await snapshot(), before, "no refused call changed any row");
});
