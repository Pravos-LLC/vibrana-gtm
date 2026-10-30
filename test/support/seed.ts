// Deterministic fixtures for the database and e2e layers, written to the LOCAL stack only.
// Run directly (`node --import tsx test/support/seed.ts`) or import `seed()`.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { local } from "./local-supabase.ts";
import { digest } from "../../lib/story.ts";
import { contentHash } from "../../lib/calendar-db.ts";
import { weekOfDate } from "../../lib/calendar.ts";

export const PASSWORD = "gtm-test-password-1";
export const USERS = {
  owner: { email: "owner@gtm.test", app_metadata: { gtm_owner: true }, user_metadata: {} },
  member: { email: "member@gtm.test", app_metadata: {}, user_metadata: {} },
  // A Signal Desk team member (e.g. Abe): /signals only, never the rest of the cockpit or approvals.
  team: { email: "team@gtm.test", app_metadata: { gtm_team: true }, user_metadata: {} },
  // Claims ownership in user-editable metadata only: must be treated as a non-owner everywhere.
  impostor: { email: "impostor@gtm.test", app_metadata: { gtm_owner: false }, user_metadata: { gtm_owner: true } },
} as const;
export type Who = keyof typeof USERS;

const fixture = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)));
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

export const FIXTURE_REPORT = "00000000-0000-4000-8000-0000000000e1";

export const FIXTURE_CANDIDATE_CAROUSEL = "00000000-0000-4000-8000-0000000000c1";
export const FIXTURE_CANDIDATE_TEXT = "00000000-0000-4000-8000-0000000000c2";
const FIXTURE_DECK = { template: "listicle", slides: [
  { type: "cover", title: "Five agent patterns teams keep" },
  ...["Reflection", "Tool use", "Planning first", "Shared context", "People where the risk is"].map((title, i) => ({ type: "item", n: i + 1, title, body: "Why it holds up in daily work." })),
  { type: "cta", title: "Which one is your team missing?" },
] };
const CANDIDATE_CAROUSEL = (week: string) => ({
  id: FIXTURE_CANDIDATE_CAROUSEL, week_start: week, slug: "fixture-five-agent-patterns", position: 0, format: "carousel", lens: "thought_leadership", pillar: "lists",
  channels: ["linkedin", "instagram"], title: "Fixture five agent patterns", body: "Five patterns we keep seeing in teams that work with agents.\n\n[JOHN: which one did Orion adopt first?]", instagram: "Five agent patterns, one slide each.",
  slides: FIXTURE_DECK, sources: [{ title: "Fixture source", url: "https://example.com/signal-1", source: "Fixture Dynamics" }], rubric: { overall: "pass", rounds: 2 }, score: 84,
  agent_draft: { title: "Fixture five agent patterns", body: "Five patterns we keep seeing in teams that work with agents.\n\n[JOHN: which one did Orion adopt first?]", instagram: "Five agent patterns, one slide each.", slides: FIXTURE_DECK, video: null },
});
const CANDIDATE_TEXT = (week: string) => ({
  id: FIXTURE_CANDIDATE_TEXT, week_start: week, slug: "fixture-grid-strain", position: 1, format: "text", lens: "regenerative", pillar: "perspective",
  channels: ["linkedin"], title: "Fixture grid strain take", body: "The grid is the quiet constraint on every AI plan.", signal_id: "00000000-0000-4000-8000-0000000000f1",
  sources: [{ title: "Fixture data center power", url: "https://example.com/signal-1", source: "Fixture Dynamics" }], rubric: { overall: "pass", rounds: 1 }, score: 78,
  agent_draft: { title: "Fixture grid strain take", body: "The grid is the quiet constraint on every AI plan.", instagram: null, slides: null, video: null },
});

/** A generated-angles run the angle-edit probes in rls.test.ts point at (vendored 20261027010000). */
export const ANGLE_RUN_ID = "00000000-0000-4000-8000-0000000000e1";
export const OUTREACH_IDS = {
  old: "00000000-0000-4000-8000-0000000000c0", trialA: "00000000-0000-4000-8000-0000000000c1", trialB: "00000000-0000-4000-8000-0000000000c2",
  solo: "00000000-0000-4000-8000-0000000000c3", done: "00000000-0000-4000-8000-0000000000c4",
};
const outreach = (id: string, batch: string, domain: string, variant: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, batch, domain, variant, model: variant === "main" ? "fixture-model" : variant,
  prospect: { first_name: name, last_name: "Fixture", title: "Founder", company: `${name} Co`, email: `${name.toLowerCase()}@${domain}`, linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase()}-fixture`, country: "NL", lane: "founder", score: 80 },
  trigger: { what: `${name} Co opened a second office`, date: "2026-10-01", url: `https://${domain}/news` },
  strategy: { problem: "Two offices, one inbox", proof: "Fixture case study", why_now: "Hiring in the new office", door: "A 20 minute call", asset: "Readiness check" },
  subject: `Fixture subject for ${name} (${variant})`, body: `Fixture body for ${name} (${variant}).`,
  original_subject: `Fixture subject for ${name} (${variant})`, original_body: `Fixture body for ${name} (${variant}).`,
  linkedin_note: `Hi ${name}, fixture note.`,
  followups: [{ day: 3, subject: "", body: `Fixture follow-up for ${name}.`, topic: "nudge" }],
  claims: [{ claim: `${name} Co opened a second office`, source_url: `https://${domain}/news`, quote: "We opened our second office." }],
  findings: [{ level: "block", code: "fixture-block", detail: "Fixture blocking finding" }, { level: "advice", code: "fixture-advice", detail: "Fixture advice" }],
  ...extra,
});
export const OUTREACH_FIXTURE = [
  outreach(OUTREACH_IDS.old, "fx-batch-1", "old.example", "main", "Olda", { created_at: "2026-10-01T00:00:00Z", status: "accepted", decided_by: "owner@gtm.test", decided_at: "2026-10-02T00:00:00Z" }),
  outreach(OUTREACH_IDS.trialA, "fx-batch-2", "trial.example", "model-a", "Tria"),
  outreach(OUTREACH_IDS.trialB, "fx-batch-2", "trial.example", "model-b", "Tria"),
  outreach(OUTREACH_IDS.solo, "fx-batch-2", "solo.example", "main", "Sola"),
  outreach(OUTREACH_IDS.done, "fx-batch-2", "done.example", "main", "Dona", { status: "accepted", decided_by: "owner@gtm.test", decided_at: new Date().toISOString() }),
];

// The writing desk (/outreach/write): dossiers in the vibrana-crm desk shape, and John's profile. Synthetic people,
// .example domains. Tria and Trib work at trial.example, where the /outreach fixture has two AI drafts (no Twenty id,
// so they match by domain). Wara's client check did not pass; Skip is skipped.
export const DESK_IDS = { top: "fx-p-top", tria: "fx-p-tria", trib: "fx-p-trib", wara: "fx-p-wara", skip: "fx-p-skip" };
export const DESK_PROFILE = {
  name: "Jo Fixture", first_name: "Jo", title: "Founder", signature: "Jo Fixture\nFounder, Fixture Co\nfixture.example",
  positioning: "Fixture positioning line.", point_of_view: ["Fixture point of view."],
  facts: [{ id: "f1", text: "Fixture fact one.", source: "Jo, 2026-10-16" }],
  proof: [{ id: "pr1", text: "Fixture proof.", url: "https://fixture.example/proof", fits: ["ops"] }],
  assets: [{ id: "a1", name: "Fixture readiness check", url: "https://fixture.example/check", pitch: "A fixture asset.", fits: ["ops"] }],
  asks: ["A 20 minute call"], voice: ["Plain words."],
  gold_examples: [{ note: "Fixture gold example one.", subject: "Fixture gold subject", body: "Hey Gil,\n\nFixture gold body.\n\nJo" }, { note: "Fixture gold example two.", subject: "Second gold subject", body: "Hey Hal,\n\nSecond fixture gold body." }],
};
const deskDossier = (id: string, first: string, domain: string, score: number, extra: Record<string, unknown> = {}) => ({
  twenty_person_id: id, domain, built_at: "2026-10-16T08:00:00Z",
  prospect: { first_name: first, last_name: "Fixture", title: "COO", company: `${first} Co`, email: `${first.toLowerCase()}@${domain}`, linkedin_url: `https://www.linkedin.com/in/${first.toLowerCase()}-fixture`, country: "NL", city: "Utrecht", lane: "ops", score, industry: "Software", employees: 120 },
  company: { name: `${first} Co`, domain, industry: "Software", employees: 120, country: "NL", description: `${first} Co makes fixture software.`, ai_native: false, technologies: ["Fixture CRM"] },
  signal: { text: `${first} Co posted a Head of AI Operations role`, url: `https://${domain}/jobs/1`, date: "2026-10-10", type: "hiring" },
  triggers: [{ family: "hiring", subtype: "ai_lead", event_date: "2026-10-10", source_url: `https://${domain}/jobs/1`, summary: `${first} Co is hiring its first AI lead.` }],
  sources: [
    { id: "S1", url: `https://${domain}/jobs/1`, title: "Head of AI Operations", published: "2026-10-10", via: "careers page", text: `Fixture source text for ${first}: the role owns company-wide AI adoption.` },
    { id: "S2", url: `https://${domain}/blog/ai`, title: "Our AI plans", published: "2026-09-01", via: "blog", text: "Fixture blog text." },
  ],
  brief: { problem: "Fixture problem: AI pilots that never reach the team.", problem_quote: { text: "We need AI to reach every team, not just engineering.", source_id: "S1" }, why_now: "Fixture why now: the hire.",
    how_john_helps: [{ id: "pr1", text: "Fixture help line." }], door_questions: ["Where are you in this hire?"], asset: { id: "a1", url: "https://fixture.example/check", label: "Fixture readiness check" },
    recipient_note: "Fixture recipient note.", model: "fixture-model" },
  person: { headline: `COO at ${first} Co`, about: "Fixture about text.", recent_posts: [{ text: "Fixture post about AI rollout.", url: `https://www.linkedin.com/posts/${first.toLowerCase()}-1`, date: "2026-10-12" }] },
  colleagues: [{ name: "Cole Fixture", title: "CTO", email: `cole@${domain}`, linkedin_url: "https://www.linkedin.com/in/cole-fixture" }],
  history: [{ channel: "linkedin", date: "2026-09-01", summary: "Fixture: liked a post." }],
  client_check: { ok: true, reason: null, checked_at: "2026-10-16T08:00:00Z" },
  ...extra,
});
export const DOSSIER_FIXTURE = [
  deskDossier(DESK_IDS.top, "Topa", "top.example", 95),
  deskDossier(DESK_IDS.tria, "Tria", "trial.example", 80),
  deskDossier(DESK_IDS.trib, "Trib", "trial.example", 60),
  deskDossier(DESK_IDS.wara, "Wara", "warn.example", 50, { client_check: { ok: false, reason: "Fixture: a current client", checked_at: "2026-10-16T08:00:00Z" } }),
  deskDossier(DESK_IDS.skip, "Skip", "skip.example", 40),
];

// The guest stream (VIB-463): podcast guests in the vibrana-crm guest contract. Made-up people, .example domains and the
// synthetic '<slug>.guest.invalid' domain a guest with no organization gets. Gia is reached by email, Lio by a LinkedIn
// note, Ina through an intermediary (and is not in Twenty), Eli by email too (the follow-up fixture).
export const GUEST_IDS = { email: "fx-g-gia", linkedin: "fx-g-lio", inter: "guest-md:ina-fixture", followup: "fx-g-eli" };
export const GUEST_PROFILE = {
  name: "Jo Fixture", first_name: "Jo", title: "Host", signature: "Jo Fixture\nHost of The Fixture Show\nfixture.example/show",
  positioning: "Fixture guest positioning.", voice: ["Plain words.", "No em dashes."],
  facts: [{ id: "gf1", text: "Fixture guest fact.", source: "Jo, 2026-10-19" }],
  assets: [{ id: "ga1", name: "Fixture show page", url: "https://fixture.example/show", pitch: "The show.", fits: ["guest"] }],
  gold_examples: [{ note: "Fixture guest gold.", subject: "Fixture guest subject", body: "Hey Gil,\n\nFixture guest gold body.\n\nJo" }],
  templates: {
    "01": "Subject: Leading the transition at {{company}}\n\nHey {{first_name}},\n\n{{trigger: one dated, specific thing}}\n\nWould you join the show?\n\nJo Fixture\nHost of The Fixture Show",
    "04": "Subject: A conversation\n\nHey {{first_name}},\n\n{{why you reached out}}\n\nJo Fixture",
  },
};
const guestDossier = (id: string, first: string, domain: string, score: number, route: "email" | "linkedin" | "intermediary", extra: Record<string, unknown> = {}, guest: Record<string, unknown> = {}) => ({
  twenty_person_id: id, domain, built_at: new Date().toISOString(), track: "guest", score, route, not_in_twenty: id.startsWith("guest-md:"),
  prospect: { first_name: first, last_name: "Fixture", title: "Founder", company: `${first} Org`, email: route === "email" ? `${first.toLowerCase()}@${domain}` : "", linkedin_url: `https://www.linkedin.com/in/${first.toLowerCase()}-fixture`, country: "NL", city: "Utrecht", lane: "operator" },
  signal: { text: `${first} gave a fixture talk`, url: `https://${domain}/talk`, date: "2026-10-12", type: "guest_trigger" },
  client_check: { ok: true, reason: null, checked_at: "2026-10-19T08:00:00Z" },
  guest: { season: "2", lane: "operator", tier: "A", pillar: "Fixture pillar", template: "01", trigger: `${first} gave a fixture talk`, trigger_url: `https://${domain}/talk`, backup_trigger: "Fixture backup trigger",
    wisdom_angle: "Fixture wisdom angle.", central_question: "Fixture central question?", prompts: ["Fixture prompt one", "Fixture prompt two", "Fixture prompt three"], warm_path: "Fixture warm path.",
    representation: "Fixture representation note.", approach_note: "", protocol_note: "", channel: route, contact_line: "", website: `https://${domain}`, ...guest },
  ...extra,
});
export const GUEST_FIXTURE = [
  guestDossier(GUEST_IDS.email, "Gia", "gia.example", 90, "email"),
  guestDossier(GUEST_IDS.linkedin, "Lio", "lio.example", 80, "linkedin"),
  guestDossier(GUEST_IDS.inter, "Ina", "ina-fixture.guest.invalid", 70, "intermediary", {}, { template: "04", approach_note: "Fixture approach note: go through the council.", protocol_note: "Fixture protocol note: final cut stays with the community.", contact_line: "Fixture council office, fixture-council.example/contact" }),
  guestDossier(GUEST_IDS.followup, "Eli", "eli.example", 60, "email"),
];
export const dossierRow = (d: (typeof DOSSIER_FIXTURE)[number] | (typeof GUEST_FIXTURE)[number]) => ({
  twenty_person_id: d.twenty_person_id, track: "track" in d ? d.track : "client", domain: d.domain, name: `${d.prospect.first_name} ${d.prospect.last_name}`, company: d.prospect.company, title: d.prospect.title,
  score: "track" in d ? d.score : d.prospect.score, built_at: d.built_at, dossier: d,
});
/** The two tracks (target, sender, profile), as seed() leaves them. `target` is the client's; the guest's is 2. */
export async function seedDesk(target = 5) {
  const at = new Date().toISOString();
  must(await admin().from("gtm_outreach_tracks").upsert([
    { track: "client", daily_target: target, from_address: "user-045d73df3c9a@example.com", profile: DESK_PROFILE, profile_imported_at: at },
    { track: "guest", daily_target: 2, from_address: "user-8dd8662c2f5a@example.com", profile: GUEST_PROFILE, profile_imported_at: at },
  ], { onConflict: "track" }), "desk tracks");
  // The old single desk row stays (the client track's fallback until a later cleanup).
  must(await admin().from("gtm_outreach_desk").upsert({ id: true, daily_target: target, profile: DESK_PROFILE, profile_imported_at: at }, { onConflict: "id" }), "desk");
}

export const TABLES = [
  "gtm_content_items", "gtm_post_metrics", "gtm_channel_daily", "gtm_crm_snapshots", "gtm_enrichment_runs", "gtm_spend",
  "gtm_zernio_events", "gtm_seasons", "gtm_stories", "gtm_story_assets", "gtm_story_asset_channels", "gtm_story_feedback", "gtm_story_asset_versions", "gtm_story_stages", "gtm_story_stage_decisions", "gtm_inspiration",
  "gtm_signal_stories", "gtm_signal_items", "gtm_signal_feedback", "gtm_signal_runs",
  "gtm_manual_metrics", "gtm_content_reports", "gtm_report_actions", "gtm_sync_state",
  "gtm_comments", "gtm_comment_runs", "gtm_red_flag_alerts", "gtm_engage_lessons", "gtm_content_candidates", "gtm_ideas",
  "gtm_storyboards", "gtm_storyboard_versions", "gtm_storyboard_rules", "gtm_storyboard_comments", "gtm_storyboard_scene_decisions",
  "gtm_storyboard_spend", "gtm_broll_shots", "gtm_reviewer_invites", "gtm_reviewer_invite_accounts", "gtm_reviewer_asset_decisions", "gtm_work_items", "gtm_people",
  "gtm_outreach_drafts", "gtm_outreach_draft_versions", "gtm_outreach_dossiers", "gtm_outreach_desk", "gtm_outreach_tracks",
  "gtm_outreach_angle_runs", "gtm_outreach_angle_edits", "gtm_outreach_lessons", "gtm_outreach_learn_runs",
  "gtm_red_flag_resolutions", "client_feedback",
  "review_batches", "review_assets", "review_comments", "review_publications", "review_publication_cancellations",
] as const;

/**
 * The shared piece review and delivery ledger (vendored 20261017020000 and 20261017030000). Every write goes through a
 * checked RPC; the browser gets owner-only reads and the secret key reads too, so these are tested apart from TABLES
 * (test/db/rls.test.ts). Truncated with the rest on every seed.
 */
export const PIECE_LEDGER = ["gtm_piece_reviews", "gtm_piece_part_decisions", "gtm_piece_fixes", "gtm_piece_deliveries", "gtm_piece_delivery_attempts", "gtm_piece_decision_events"] as const;

export function admin(): SupabaseClient {
  const l = local();
  return createClient(l.url, l.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function signedIn(who: Who): Promise<SupabaseClient> {
  const l = local();
  const db = createClient(l.url, l.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email: USERS[who].email, password: PASSWORD });
  if (error) throw new Error(`sign in ${who}: ${error.message}`);
  return db;
}

export function anon(): SupabaseClient {
  const l = local();
  return createClient(l.url, l.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Superuser SQL on the local database (reset only: bypasses the review lock triggers). */
export function sql(statement: string) {
  return execFileSync("psql", [local().dbUrl, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", statement], { encoding: "utf8" });
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

/** The INSERT of John's standing rules from the vendored gtm_storyboards migration (the migration stays the source). */
export function standingRules(): string {
  const dir = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
  const file = readdirSync(dir).find((f) => f.endsWith("_gtm_storyboards.sql"));
  if (!file) return "select 1";
  const text = readFileSync(join(dir, file), "utf8");
  const at = text.lastIndexOf("insert into public.gtm_storyboard_rules (format");
  return at < 0 ? "select 1" : text.slice(at, text.indexOf(";\n", at) + 1);
}

export async function seed() {
  const db = admin();
  sql(`set session_replication_role = replica;
    truncate ${[...TABLES, ...PIECE_LEDGER].map((t) => `public.${t}`).join(", ")} cascade;
    delete from storage.objects where bucket_id = 'content-review';
    set session_replication_role = origin;
    delete from auth.identities where identity_data ->> 'email' like '%@gtm.test';
    delete from auth.users where email like '%@gtm.test';`);
  // John's standing storyboard rules are seeded by their migration; put them back exactly as a fresh database has them.
  sql(standingRules());
  const ids: Record<Who, string> = {} as Record<Who, string>;
  for (const [who, u] of Object.entries(USERS) as [Who, (typeof USERS)[Who]][]) {
    const r = await db.auth.admin.createUser({ email: u.email, password: PASSWORD, email_confirm: true, app_metadata: u.app_metadata, user_metadata: u.user_metadata });
    if (r.error) throw new Error(`create ${who}: ${r.error.message}`);
    ids[who] = r.data.user.id;
  }

  // Pipeline: 2 upcoming (1 needs approval), 1 overdue, 1 published in the last 14 days, 1 later.
  const items = [
    { id: "fx-upcoming-approved", week: weekOfDate(day(3)), date: day(3), time: "08:30", pillar: "proof", title: "Fixture upcoming approved", format: "text", channels: ["linkedin"], status: "approved", body: "Fixture approved body.", media: [], approved_hash: contentHash({ body: "Fixture approved body.", media: [] }) },
    { id: "fx-upcoming-idea", week: weekOfDate(day(5)), date: day(5), time: "09:00", pillar: "build", title: "Fixture needs approval", format: "video", channels: ["youtube"], status: "idea" },
    { id: "fx-overdue", week: weekOfDate(day(-2)), date: day(-2), time: "08:30", pillar: "proof", title: "Fixture overdue drafted", format: "text", channels: ["linkedin"], status: "drafted" },
    { id: "fx-published", week: weekOfDate(day(-4)), date: day(-4), time: "08:30", pillar: "proof", title: "Fixture published", format: "text", channels: ["linkedin"], status: "published", zernio_post_id: "zp-1", urls: { linkedin: "https://www.linkedin.com/feed/update/fixture" } },
    { id: "fx-later", week: weekOfDate(day(40)), date: day(40), time: "08:30", pillar: "build", title: "Fixture later", format: "text", channels: ["instagram"], status: "idea" },
  ];
  must(await db.from("gtm_content_items").insert(items, { defaultToNull: false }), "items");

  must(await db.from("gtm_inspiration").insert([
    { kind: "video", url: "https://www.youtube.com/watch?v=fixture1", title: "Fixture motion graphics", platform: "youtube", tags: ["motion-graphics"], why_we_like: "Kinetic type.", pillar: "perspective" },
    { kind: "newsletter", url: "https://example.substack.com/p/fixture", title: "Fixture newsletter reference", platform: "substack", tags: ["header-image"], why_we_like: "Header art.", pillar: "proof" },
  ]), "inspiration");

  // Signal Desk: one ranked story with two sightings, a feedback label and a finished run.
  must(await db.from("gtm_signal_stories").insert({ id: "00000000-0000-4000-8000-0000000000f1", title: "Fixture grid strain story", lanes: ["power", "datacenters"], score: 72.5, source_count: 2, item_count: 2 }), "signal story");
  must(await db.from("gtm_signal_items").insert([
    { url: "https://example.com/signal-1", source: "Fixture Dynamics", source_kind: "rss", title: "Fixture data center power", story_id: "00000000-0000-4000-8000-0000000000f1", relevant: true },
    { url: "https://x.com/fixture/status/1", source: "John's X bookmarks", source_kind: "x_bookmark", title: "Fixture grid tweet", story_id: "00000000-0000-4000-8000-0000000000f1", relevant: true },
  ]), "signal items");
  must(await db.from("gtm_signal_feedback").insert({ story_id: "00000000-0000-4000-8000-0000000000f1", actor: "owner@gtm.test", action: "save" }), "signal feedback");
  must(await db.from("gtm_signal_runs").insert({ kind: "collect", finished_at: new Date().toISOString(), stats: { inserted: 2 } }), "signal run");
  // Engage queue: one drafted comment awaiting approval, one needing John, one already sent.
  must(await db.from("gtm_comments").insert([
    { id: "00000000-0000-4000-8000-0000000000e1", source: "webhook", platform: "instagram", account_id: "acc-ig", platform_post_id: "ig-post-1", external_id: "ig-c-1", author_username: "fixture.reader", author_name: "Fixture Reader", text: "How did you measure adoption in week one?", post_preview: "Fixture post about week one", permalink: "https://example.com/p/1", commented_at: new Date(Date.now() - 3600_000).toISOString(), status: "drafted", classification: "reply", draft: "We counted who finished the first assessment. What would you measure?" },
    { id: "00000000-0000-4000-8000-0000000000e2", source: "email", platform: "linkedin", external_id: "urn:li:comment:(activity:1,2)", author_name: "Fixture Colleague", text: "Which team went first?", comment_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/", commented_at: new Date(Date.now() - 7200_000).toISOString(), status: "drafted", classification: "needs_john", draft: "[JOHN: which team went first?] They set the pace for the rest." },
    { id: "00000000-0000-4000-8000-0000000000e4", source: "poll", platform: "linkedin", account_id: "acc-li", platform_post_id: "urn:li:ugcPost:fixture", external_id: "urn:li:comment:(ugcPost:fixture,4)", author_username: "fixture-partner", author_name: "Fixture Partner", author_headline: "Founder, Example Network", author_company: "Example Network", author_website: "https://example.com/network", author_followers: 10366, author_profile_url: "https://www.linkedin.com/in/fixture-partner/", author_enriched_at: new Date().toISOString(), text: "Love this perspective. We wrote about it here: https://example.com/network/essay. Would love to explore a partnership with you.", linked: [{ url: "https://example.com/network/essay", title: "Low tech and high tech", summary: "Argues that soil and servers sit on one spectrum of technology." }], permalink: "https://www.linkedin.com/feed/update/urn:li:ugcPost:fixture", commented_at: new Date(Date.now() - 5400_000).toISOString(), status: "drafted", classification: "spam", stance: "spam", draft_reason: "Solicits a partnership" },
    { id: "00000000-0000-4000-8000-0000000000e3", source: "poll", platform: "youtube", account_id: "acc-yt", platform_post_id: "yt-1", external_id: "yt-c-1", author_name: "Fixture Viewer", text: "Great video", commented_at: new Date(Date.now() - 86400_000).toISOString(), status: "sent", sent_at: new Date().toISOString(), drafted_at: new Date(Date.now() - 3600_000).toISOString(), classification: "reply", draft: "Thanks for watching.", final_text: "Thanks for watching!" },
  ]), "comments");
  must(await db.from("gtm_comment_runs").insert({ kind: "daily", finished_at: new Date().toISOString(), stats: { polled: 3, drafted: 2 } }), "comment run");
  // Red flags (VIB-424): a fast pile-on of two bad-faith comments on the Instagram fixture post (already skipped by John).
  must(await db.from("gtm_comments").insert([1, 2].map((i) => ({
    source: "webhook", platform: "instagram", account_id: "acc-ig", platform_post_id: "ig-post-1", external_id: `ig-troll-${i}`,
    author_name: `Fixture Troll ${i}`, text: "Fixture bad-faith comment", post_preview: "Fixture post about week one", permalink: "https://example.com/p/1",
    commented_at: new Date(Date.now() - (30 + i * 20) * 60_000).toISOString(), status: "skipped", classification: "needs_john",
    stance: "troll_or_bad_faith", objection: "fixture objection about AI hype",
  }))), "red flag comments");
  // An alert sent yesterday for another post (the cooldown is per post).
  must(await db.from("gtm_red_flag_alerts").insert({ post_key: "linkedin|urn:li:activity:fixture", flag: "backlash", sent_at: new Date(Date.now() - 30 * 3600_000).toISOString(), stats: { via: "webhook" } }), "red flag alert");
  must(await db.from("gtm_engage_lessons").insert({ kind: "voice", lesson: "Fixture lesson: react to their specific point first", source: "john" }), "engage lesson");
  must(await db.from("gtm_outreach_angle_runs").insert({ id: ANGLE_RUN_ID, person: "fx-angle-person", angles: [] }), "outreach angle run");
  must(await db.from("gtm_outreach_lessons").insert({ kind: "opening", lesson: "Fixture lesson: open on their own work", source: "john" }), "outreach lesson");
  must(await db.from("gtm_outreach_learn_runs").insert({ stats: {} }), "outreach learn run");
  must(await db.from("client_feedback").insert({ slug: "fixture", answers: {} }), "client feedback");
  must(await db.from("gtm_red_flag_resolutions").insert({ post_key: "instagram|fixture-resolved", flag: "healthy_debate" }), "red flag resolution");

  // Content analytics (VIB-417/418): a manual week, a finished weekly report with one proposed change, the delta cursor.
  const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  must(await db.from("gtm_manual_metrics").insert({ week_start: monday, channel: "substack_regenera", metrics: { subscribers: 812 } }), "manual metrics");
  must(await db.from("gtm_content_reports").insert({ id: FIXTURE_REPORT, kind: "weekly", week: 1, period_start: monday, period_end: day(6), status: "done", headline: "Fixture report", report: {} }), "report");
  must(await db.from("gtm_report_actions").insert({ report_id: FIXTURE_REPORT, type: "move", item_id: "fx-upcoming-idea", change: { date: day(6) }, proposal: "Fixture move" }), "report action");
  must(await db.from("gtm_sync_state").insert({ key: "fixture.cursor", value: { cursor: "c0" } }), "sync state");

  // Sunday candidates (VIB-420): next week's two drafts waiting for John, a carousel and a text post on the fixture signal.
  const nextMonday = day(7 - ((new Date().getUTCDay() + 6) % 7));
  must(await db.from("gtm_content_candidates").insert([CANDIDATE_CAROUSEL(nextMonday), CANDIDATE_TEXT(nextMonday)]), "candidates");

  // Brainstorming Backlog: a promotable content idea on the shortlist, an engagement idea, a parked tool.
  must(await db.from("gtm_ideas").insert([
    { slug: "fixture-inbox-short", title: "Fixture inbox short", summary: "Split screen of one inquiry.", kind: "content", status: "shortlisted", pillar: "proof", format: "video", effort: "m", impact: 4, source_url: "https://example.com/case", tags: ["fixture"] },
    { slug: "fixture-comment-experiment", title: "Fixture comment experiment", kind: "engagement", status: "idea", effort: "s", tags: ["fixture"] },
    { slug: "fixture-parked-tool", title: "Fixture parked tool", kind: "tool", status: "parked", effort: "l" },
  ], { defaultToNull: false }), "ideas");

  const captured = new Date().toISOString();
  must(await db.from("gtm_post_metrics").insert([
    { zernio_post_id: "zp-1", platform: "linkedin", captured_at: new Date(Date.now() - 86400_000).toISOString(), content_item_id: "fx-published", published_at: `${day(-4)}T06:30:00Z`, content_preview: "Fixture post stale snapshot", impressions: 1, likes: 0 },
    { zernio_post_id: "zp-1", platform: "linkedin", captured_at: captured, content_item_id: "fx-published", published_at: `${day(-4)}T06:30:00Z`, content_preview: "Fixture published post", impressions: 1200, likes: 30, comments: 5, shares: 3, saves: 2 },
    { zernio_post_id: "zp-ext", platform: "instagram", captured_at: captured, is_external: true, published_at: `${day(-6)}T10:00:00Z`, content_preview: "Fixture external post", views: 800, likes: 10 },
  ], { defaultToNull: false }), "metrics");
  must(await db.from("gtm_channel_daily").insert([
    { account_id: "acc-li", platform: "linkedin", username: "fixture-li", date: day(-7), followers: 100, active: true },
    { account_id: "acc-li", platform: "linkedin", username: "fixture-li", date: day(0), followers: 123, active: true },
  ]), "channels");
  must(await db.from("gtm_crm_snapshots").insert([
    { date: day(-10), captured_at: `${day(-10)}T06:00:00Z`, metrics: { people: 400, enrichment_attempted: 200, researched: 150, enriched: 100, identity_verified: 60, eligible: 50, offer_fit: 30, contacted: 20, warm: 4, companies: 50, email_messages_synced: 0 }, opportunities: {} },
    { date: day(0), captured_at: captured, metrics: { people: 512, enrichment_attempted: 321, researched: 240, enriched: 173, identity_verified: 91, eligible: 84, offer_fit: 42, contacted: 27, warm: 9, companies: 61, email_messages_synced: 0, meeting_capture: {
      installed: true, notes7d: 4, owners: {
        JOHN: { pending: 3, oldestPendingDays: 2, run: {
          day: day(0), mode: "shadow", notesSeen: 6, captured: 4, proposalsCreated: 5, proposalsApplied: 1, pendingOldestDays: 2, llmCalls: 4,
          usd: 0.12, monthUsd: 1.5, monthCapUsd: 20, staleOpen: 1, states: { DONE: 4, INTERNAL: 1, NO_MATCH: 1 }, errors: {},
          lastSuccessAt: captured, updatedAt: captured } },
        ABE: { pending: 0, oldestPendingDays: null, run: null },
      } } }, opportunities: { SIGNED: 2, PROPOSAL: 3 } },
  ]), "crm");
  must(await db.from("gtm_enrichment_runs").insert([
    { run: "fx-run-1", status: "complete", selected: 250, submitted: 240, returned: 200, no_result: 40, saved: 190, conflicted: 5, failed: 5, credits: 777, cap_usd: 50, at: `${day(-1)}T12:00:00Z` },
  ]), "enrichment");
  must(await db.from("gtm_spend").insert([
    { id: "CARD-FX-1:EUR", date: day(-3), currency: "EUR", amount: 20, amount_eur: 20, merchant: "Cursor Usage", vendor: "Cursor", category: "dev-tools", gtm: false },
    { id: "CARD-FX-2:USD", date: day(-5), currency: "USD", amount: 58, amount_eur: 49, merchant: "Zernio", vendor: "Zernio", category: "content-production", gtm: true },
    { id: "CARD-FX-3:EUR", date: day(-8), currency: "EUR", amount: 5, amount_eur: 5, merchant: "Mystery Fixture SaaS", vendor: null, category: "unclassified", gtm: false },
    { id: "CARD-FX-4:EUR", date: day(-120), currency: "EUR", amount: 99, amount_eur: 99, merchant: "Old Tool", vendor: "Old Fixture Tool", category: "productivity", gtm: false },
  ]), "spend");
  must(await db.from("gtm_zernio_events").insert([{ event_id: "fx-evt-1", event: "post.published", payload: { fixture: true } }]), "events");

  // Story: copy + live link, pending for LinkedIn.
  const copy = "Fixture story copy.";
  must(await db.from("gtm_seasons").insert({ id: "fx-season", title: "Fixture Season", description: "Fixture season for tests.", starts_on: "2026-01-05", ends_on: "2026-03-13", pillars: ["build", "proof"] }), "season");
  must(await db.from("gtm_stories").insert({ id: "fx-story", title: "Fixture Story", link_url: "https://example.com/fixture-story", season_id: "fx-season" }), "story");
  must(await db.from("gtm_story_assets").insert([
    { id: "fx-story-copy", story_id: "fx-story", title: "Fixture copy", kind: "copy", source: "copy.md", sha256: digest(copy), body: copy },
    { id: "fx-story-link", story_id: "fx-story", title: "Fixture link", kind: "link", source: "https://example.com/fixture-story", sha256: digest("https://example.com/fixture-story"), url: "https://example.com/fixture-story" },
  ]), "story assets");
  must(await db.from("gtm_story_asset_channels").insert([
    { asset_id: "fx-story-copy", channel: "linkedin" }, { asset_id: "fx-story-link", channel: "linkedin" },
  ]), "story channels");
  // Stage progress and one decision, so the owner-read and denied-write checks cover the stage tables.
  must(await db.from("gtm_story_stages").insert({ story_id: "fx-story", stage: "draft", status: "done", actor: "seed" }), "story stage");
  must(await db.from("gtm_story_stage_decisions").insert({ story_id: "fx-story", stage: "draft", party: "john", decision: "approved", note: "seeded" }), "stage decision");

  // Storyboard Studio: one storyboard at v1 with a note, a scene approval, an authorization and one catalog shot.
  const sha = (c: string) => c.repeat(64);
  must(await db.from("gtm_storyboards").insert({ id: "sb-fx-story-enhance-plan", story_id: "fx-story", stage: "enhance-plan", format: "short", title: "Fixture storyboard", current_version: 1, status: "review" }), "storyboard");
  must(await db.from("gtm_storyboard_versions").insert({ storyboard_id: "sb-fx-story-enhance-plan", version: 1, doc: { schema: "vibrana.storyboard/1" }, doc_sha: sha("d"), schema: "vibrana.storyboard/1", scene_shas: { "sc-hook": sha("1") }, produced_by: "seed", motion_path: "motion.so", credit_cap: 200 }), "storyboard version");
  must(await db.from("gtm_storyboard_comments").insert({ storyboard_id: "sb-fx-story-enhance-plan", version: 1, anchor: { scene_id: "sc-hook" }, kind: "note", body: "Fixture note" }), "storyboard comment");
  must(await db.from("gtm_storyboard_scene_decisions").insert({ storyboard_id: "sb-fx-story-enhance-plan", version: 1, scene_id: "sc-hook", scene_sha: sha("1"), decision: "approved" }), "scene decision");
  must(await db.from("gtm_storyboard_spend").insert({ storyboard_id: "sb-fx-story-enhance-plan", version: 1, kind: "authorized", credits: 0 }), "storyboard spend");
  must(await db.from("gtm_broll_shots").insert({ id: "fx-shot-01", file: "media/fixture.mp4", src_in: 0, src_out: 4, description: "Fixture shot" }), "broll shot");

  // Newsletter Story: a Substack draft whose header image already has a permanent public URL.
  const poster = fixture("poster.jpg");
  const posterPath = `stories/fx-newsletter/fx-news-header-${digest(poster).slice(0, 16)}.jpg`;
  must(await db.storage.from("content-review").upload(posterPath, poster, { contentType: "image/jpeg" }), "upload newsletter header");
  const newsletter = "---\ntitle: \"Fixture newsletter title\"\nchannel: \"regenera-substack\"\npreviewText: \"Fixture subtitle\"\n---\n\n# Fixture newsletter title\n\nOpening paragraph.\n\n![Header alt](assets/header.jpg)\n\n## A section\n\nClosing line.\n\n*Fixture disclosure footer.*\n";
  must(await db.from("gtm_stories").insert({ id: "fx-newsletter", title: "Fixture Newsletter", link_url: "https://example.com/fixture-newsletter" }), "newsletter story");
  must(await db.from("gtm_story_assets").insert([
    { id: "fx-news-copy", story_id: "fx-newsletter", title: "Fixture Substack draft", kind: "copy", source: "drafts/regenera.md", sha256: digest(newsletter), body: newsletter, storage_path: null, metadata: {} },
    { id: "fx-news-header", story_id: "fx-newsletter", title: "Fixture header", kind: "image", source: "drafts/assets/header.jpg", sha256: digest(poster), storage_path: posterPath,
      metadata: { public_url: "https://pub.example.test/fx/header.jpg", public_sha256: digest(poster) } },
  ]), "newsletter assets");
  must(await db.from("gtm_story_asset_channels").insert([
    { asset_id: "fx-news-copy", channel: "newsletter" }, { asset_id: "fx-news-header", channel: "newsletter" },
  ]), "newsletter channels");
  const newsNote = must(await db.from("gtm_story_feedback").insert({ asset_id: "fx-news-copy", channel: "newsletter", body: "Fixture feedback" }).select("id").single(), "story feedback") as { id: string };

  // Third-party review links (/shared): a partner's final short, their rough cut, and John's own note they must not see.
  const clip = fixture("clip.mp4");
  const clipPath = `stories/s1-90-fx-partner-final/fx-partner-video-${digest(clip).slice(0, 16)}.mp4`;
  must(await db.storage.from("content-review").upload(clipPath, clip, { contentType: "video/mp4" }), "upload partner final");
  const caption = "Fixture partner caption about the river.";
  must(await db.from("gtm_stories").insert([
    { id: "s1-90-fx-partner-final", title: "S1-90 | Fixture partner final", link_url: "https://example.com/partner", pipeline: "short", third_party_who: "Fixture Partner", held_at: new Date().toISOString(), hold_who: "Fixture Partner" },
    { id: "s1-91-fx-partner-rough", title: "S1-91 | Fixture partner rough", link_url: "https://example.com/partner-rough", pipeline: "short", third_party_who: "Fixture Partner" },
  ]), "partner stories");
  must(await db.from("gtm_story_assets").insert([
    { id: "fx-partner-video", story_id: "s1-90-fx-partner-final", title: "Partner final", kind: "video", source: "final.mp4", sha256: digest(clip), storage_path: clipPath, stage: "final", metadata: { label: "v4" } },
    { id: "fx-partner-copy", story_id: "s1-90-fx-partner-final", title: "Partner caption", kind: "copy", source: "ig.md", sha256: digest(caption), body: caption, metadata: {} },
    { id: "fx-partner-rough-video", story_id: "s1-91-fx-partner-rough", title: "Partner rough", kind: "video", source: "rough.mp4", sha256: digest("rough"), storage_path: clipPath, stage: "rough-cut", metadata: {} },
  ]), "partner assets");
  must(await db.from("gtm_story_asset_channels").insert([
    { asset_id: "fx-partner-video", channel: "youtube" }, { asset_id: "fx-partner-copy", channel: "instagram" }, { asset_id: "fx-partner-rough-video", channel: "instagram" },
  ]), "partner channels");
  // John approved the short's YouTube cut on these bytes (only an owner session can approve, so the fixture writes it as superuser).
  sql(`set session_replication_role = replica; update public.gtm_story_asset_channels set status = 'approved', approved_sha256 = '${digest(clip)}', reviewed_at = now() where asset_id = 'fx-partner-video' and channel = 'youtube'`);
  must(await db.from("gtm_story_feedback").insert({ asset_id: "fx-partner-video", body: "Fixture John private note" }), "partner john note");

  // The people list behind @mentions (lib/mentions.ts).
  must(await db.from("gtm_people").insert({ name: "Fixture Person", linkedin_url: "https://www.linkedin.com/in/fixture-person", linkedin_name: "Fixture Person", linkedin_urn: "urn:li:person:fixture", instagram_handle: "fixture.person" }), "people");

  // The work board (/work): an agent working the newsletter note, and a staged partner final waiting on John.
  must(await db.from("gtm_work_items").insert([
    { story_id: "fx-newsletter", asset_id: "fx-news-copy", source_note_ids: [newsNote.id], title: "Fixture Newsletter: 1 note", status: "working", agent: "seed",
      eta_at: new Date(Date.now() + 30 * 60_000).toISOString(), last_update: "Rewriting the intro" },
    { story_id: "s1-90-fx-partner-final", asset_id: null, source_note_ids: [], title: "Fixture partner final: 1 note", status: "staged", agent: "seed", eta_at: null, last_update: "New version staged in /content" },
  ]), "work items");

  // Cold outreach (/outreach): an older batch, and the latest with a two-model trial, a single draft and an accepted one.
  // Synthetic people and .example domains only. The solo draft carries one edit, so its history has a row.
  must(await db.from("gtm_outreach_drafts").insert(OUTREACH_FIXTURE, { defaultToNull: false }), "outreach drafts");
  must(await db.from("gtm_outreach_drafts").update({ body: "Fixture solo body, edited.", edited_by: "owner@gtm.test", edited_at: new Date().toISOString() }).eq("id", OUTREACH_IDS.solo), "outreach edit");
  must(await db.from("gtm_outreach_angle_edits").insert({ run_id: ANGLE_RUN_ID, draft_id: OUTREACH_IDS.solo, person: "fx-angle-person", channel: "email", angle_key: "direct_fit", generated: {}, final: {} }), "outreach angle edit");
  // The writing desk: its queue, and the desk row (profile, target).
  must(await db.from("gtm_outreach_dossiers").insert([...DOSSIER_FIXTURE, ...GUEST_FIXTURE].map(dossierRow)), "dossiers");
  must(await db.from("gtm_outreach_dossiers").update({ skipped_at: new Date().toISOString(), skip_reason: "Fixture skip", skipped_by: "owner@gtm.test" }).eq("twenty_person_id", DESK_IDS.skip), "skip");
  await seedDesk();

  // A used and revoked review link (a live one is made by the e2e spec): the owner reads the table, the partner cannot.
  must(await db.from("gtm_reviewer_invites").insert({ id: "00000000-0000-4000-8000-0000000000a1", token_sha256: "0".repeat(64), party: "Fixture Partner", expires_at: new Date(Date.now() - 86400_000).toISOString(),
    claimed_by: randomUUID(), claimed_email: "old-partner@gtm.test", claimed_at: new Date(Date.now() - 2 * 86400_000).toISOString(), revoked_at: new Date(Date.now() - 86400_000).toISOString() }), "revoked invite");
  must(await db.from("gtm_reviewer_invite_accounts").insert({ invite_id: "00000000-0000-4000-8000-0000000000a1", user_id: randomUUID(), email: "old-partner@gtm.test" }), "invite account");
  must(await db.from("gtm_reviewer_asset_decisions").insert({ story_id: "fx-story", asset_id: "fx-story-copy", asset_sha256: "a".repeat(64), revision: 1, party: "Fixture Partner", decision: "note", note: "Seed decision" }), "asset decision");

  // Review: a submitted past round, then the open round (video + image), through the publication RPCs.
  // The /review screen and `gtm review` are retired; these rows stay so the RLS suite covers the kept tables.
  const past = await publishRound(db, "fx-old-series", 1, [{ slug: "old", title: "Old clip", kind: "image", file: "card.png", type: "image/png" }]);
  must(await db.from("review_comments").insert({ asset_id: past.assets[0], t_ms: null, body: "Fixture past note" }), "past comment");
  must(await db.from("review_batches").update({ status: "submitted" }).eq("id", past.batch), "submit past");
  const open = await publishRound(db, "fx-series", 1, [
    { slug: "clip", title: "Fixture clip", kind: "video", file: "clip.mp4", type: "video/mp4", poster: true, duration: 3 },
    { slug: "card", title: "Fixture card", kind: "image", file: "card.png", type: "image/png" },
  ]);
  return { users: ids, pastBatch: past.batch, openBatch: open.batch, assets: open.assets, keys: open.keys };
}

type Asset = { slug: string; title: string; kind: "video" | "image"; file: string; type: string; poster?: boolean; duration?: number };
async function publishRound(db: SupabaseClient, series: string, round: number, assets: Asset[]) {
  const id = randomUUID();
  must(await db.rpc("reserve_review_publication", { p_id: id, p_series: series, p_round: round, p_title: `${series} round ${round}`, p_workspace_dir: `2-work/${series}` }), "reserve");
  const rows = [];
  const keys: string[] = [];
  for (const [i, a] of assets.entries()) {
    const key = `${id}/${series}/r${round}/${i + 1}-${a.slug}${a.file.slice(a.file.lastIndexOf("."))}`;
    must(await db.storage.from("content-review").upload(key, fixture(a.file), { contentType: a.type }), `upload ${key}`);
    keys.push(key);
    let poster = key;
    if (a.poster) {
      poster = `${id}/${series}/r${round}/${i + 1}-${a.slug}-poster.jpg`;
      must(await db.storage.from("content-review").upload(poster, fixture("poster.jpg"), { contentType: "image/jpeg" }), "upload poster");
      keys.push(poster);
    }
    rows.push({ position: i + 1, slug: a.slug, title: a.title, kind: a.kind, storage_path: key, poster_path: poster, duration_s: a.duration ?? null, meta: { fps: 30 } });
  }
  const r = must(await db.rpc("finalize_review_publication", { p_id: id, p_assets: rows }), "finalize") as { batch: string };
  const created = must(await db.from("review_assets").select("id,position").eq("batch_id", r.batch).order("position"), "assets") as { id: string }[];
  return { batch: r.batch, assets: created.map((a) => a.id), keys };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await seed();
  console.log(JSON.stringify(r, null, 2));
}
