#!/usr/bin/env -S npx tsx
// gtm: agent-first CLI for the content calendar, Zernio publishing, and cockpit sync.
// Every command accepts --json for machine-readable output.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { findAgentNotes, findBritishSpellings } from "../lib/copy-guard";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Tests set GTM_SKIP_ENV_FILES=1 so a developer's real keys can never leak into a mocked run.
if (process.env.GTM_SKIP_ENV_FILES !== "1") {
  for (const f of [join(root, ".env.local"), join(homedir(), "Projects/john-workspace/.tools/wise-mcp/.env")]) {
    if (existsSync(f)) process.loadEnvFile(f);
  }
}

const { loadCalendar, calendarPath, updateItem, resolveAsset } = await import("../lib/calendar");
// The calendar lives in gtm_content_items. GTM_CALENDAR_SOURCE=file keeps the legacy YAML mode
// (used by the CLI contract tests); calendar.yaml is otherwise an import/export format.
const fromDb = (process.env.GTM_CALENDAR_SOURCE ?? "db") === "db";
async function calendar() {
  if (!fromDb) return loadCalendar();
  const { adminDb } = await import("../lib/db");
  const { loadCalendarDb } = await import("../lib/calendar-db");
  return loadCalendarDb(adminDb());
}
const { listAccounts } = await import("../lib/zernio");

const argv = process.argv.slice(2);
let json = argv.includes("--json");
const dry = argv.includes("--dry-run");
const draft = argv.includes("--draft");
const allowPast = argv.includes("--allow-past");
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").match(/^--(week|iso-week|track|season|days|since|only|round|series|title|description|starts|ends|pillars|batch|assets|asset|note|linkedin|instagram|youtube|kind|tags|tag|why|pillar|out|by|status|lane|limit|format|story|to|from|account|who|stage|changes|summary|effort|impact|source|owner|lens|slug|addresses|replies|motion-sha|motion-path|credits|balance-after|job|skill|from|category|rule|do-not-use|only|party|sha|render|keys|notes|eta|agent|storyboard|manifest|brand|theme|brief|prompt-file|reference|art-dir|shape|weeks|email|file|reason|url)$/));
const [cmd, ...rest] = positional;

// In `gtm sync`, commands hand their result to a sink instead of printing.
let sink: ((data: unknown) => void) | null = null;
function out(data: unknown, human?: () => void) {
  if (sink) return sink(data);
  if (json || !human) console.log(JSON.stringify(data, null, 2));
  else human();
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Moves the work board along after a stage, push or resolve (lib/work/store.ts). Never fails the command it follows:
 * the restage or the answer already happened; a board that could not update says so instead.
 */
async function advanceWork(run: (db: import("@supabase/supabase-js").SupabaseClient, store: typeof import("../lib/work/store")) => Promise<import("../lib/work/store").Advanced[]>) {
  try {
    const { adminDb } = await import("../lib/db");
    const work = await run(adminDb(), await import("../lib/work/store"));
    return work.length ? { work } : {};
  } catch (e) {
    return { work_error: `the work board was not updated: ${(e as Error).message}` };
  }
}
function printWork(r: { work?: Array<{ id: string; title: string; to: string; note: string }>; work_error?: string }) {
  for (const w of r.work ?? []) console.log(`  work ${w.id.slice(0, 8)} "${w.title}" -> ${w.to}: ${w.note}`);
  if (r.work_error) console.log(`  WARNING ${r.work_error}`);
}

/** Width, height and duration of a local video via ffprobe; null when the file or ffprobe is missing. */
function probeVideo(file: string | null) {
  if (!file || !existsSync(file)) return null;
  try {
    const { execFileSync } = process.getBuiltinModule("node:child_process");
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const v = j.streams?.[0];
    return v?.width && v?.height ? { width: Number(v.width), height: Number(v.height), duration: Number(j.format?.duration) || null } : null;
  } catch {
    return null;
  }
}

function printRun(label: string, r: { collected: { fetched: Record<string, number>; inserted: number; errors: { source: string; error: string }[] }; processed: { classified: number; classify_errors: number; relevant: number; new_stories: number; joined: number; scored: number } | null }) {
  const c = r.collected, p = r.processed;
  console.log(`${label}: ${Object.values(c.fetched).reduce((a, b) => a + b, 0)} fetched from ${Object.keys(c.fetched).length} sources, ${c.inserted} new`);
  for (const [source, n] of Object.entries(c.fetched)) console.log(`  ${String(n).padStart(4)}  ${source}`);
  for (const e of c.errors) console.log(`  ERROR ${e.source}: ${e.error}`);
  if (!p) return console.log("collected only: the next Vercel run (every 2 h) or `gtm signals process` classifies and ranks these");
  console.log(`classified ${p.classified} (${p.classify_errors} failed), relevant ${p.relevant}, ${p.new_stories} new stories, ${p.joined} joined existing, ${(p as { judged?: number }).judged ?? 0} judged by Clef, ${p.scored} rescored${(p as { deferred_classify?: number }).deferred_classify || (p as { deferred_cluster?: number }).deferred_cluster ? `; left for next run: ${(p as { deferred_classify?: number }).deferred_classify ?? 0} to classify, ${(p as { deferred_cluster?: number }).deferred_cluster ?? 0} to cluster` : ""}`);
}

/**
 * `--week N`: week N of the season (`--season <id>`, or the current one), counted exactly as `gtm season` counts
 * them. `--iso-week N` (or YYYY-Www): the calendar week. Neither: null. Both read the item's date, never a stored week.
 */
async function weekSelector() {
  const { parseIsoWeekArg, seasonWeekSelector } = await import("../lib/week");
  const week = flag("--week");
  const iso = flag("--iso-week");
  const seasonId = flag("--season");
  if (week !== undefined && iso !== undefined) throw new Error("give --week (season week) or --iso-week (calendar week), not both");
  if (iso !== undefined) {
    if (seasonId !== undefined) throw new Error("--season goes with --week; --iso-week is a calendar week");
    return { kind: "iso" as const, ...parseIsoWeekArg(iso) };
  }
  if (week === undefined) {
    if (seasonId !== undefined) throw new Error("--season goes with --week N");
    return null;
  }
  const { adminDb } = await import("../lib/db");
  const { resolveSeason } = await import("../lib/seasons");
  return seasonWeekSelector(await resolveSeason(adminDb(), seasonId, today()), week);
}

const commands: Record<string, () => Promise<void>> = {
  async packaging() {
    const [sub, id] = rest;
    const ops = await import("../lib/packaging/ops");
    if (sub === "catalog") return out(await import("../lib/packaging/catalog"));
    if (sub === "plate") {
      if (!flag("--prompt-file") || !flag("--out")) throw new Error("usage: gtm packaging plate --prompt-file path --out plate.png [--reference source.png]");
      return out(await (await import("../lib/packaging/plate")).generatePlate(readFileSync(flag("--prompt-file")!, "utf8"), flag("--reference"), flag("--out")!));
    }
    if (!id) throw new Error("usage: gtm packaging brief|render|check|revise|gallery|motion|stage-review <story-id> [--manifest path] [--brand sample-author|vibrana|aios] [--theme light|dark] [--brief path] [--notes ids]");
    if (sub === "brief") return out(ops.deriveBrief(id, { manifest: flag("--manifest"), brand: flag("--brand") as import("../lib/packaging/catalog").Brand | undefined, theme: flag("--theme") as import("../lib/packaging/catalog").Theme | undefined, out: flag("--out") }));
    if (sub === "stage-review") {
      if (!flag("--manifest")) throw new Error("stage-review needs --manifest <gallery/index.json>");
      const { adminDb } = await import("../lib/db");
      return out(await (await import("../lib/packaging/review")).stageReviewGallery(adminDb(), id, flag("--manifest")!, dry));
    }
    const bp = flag("--brief") ?? ops.briefPathFor(id, flag("--manifest"));
    const raw = JSON.parse(readFileSync(bp, "utf8"));
    if (raw.story !== id) throw new Error("--brief belongs to another Story");
    if (sub === "motion") {
      if (!flag("--out")) throw new Error("motion needs --out title.mp4|title.webm");
      const shape = flag("--shape") ?? "landscape";
      if (!["landscape","portrait","square","feed"].includes(shape)) throw new Error("Invalid motion shape");
      const rendered = await (await import("../lib/packaging/render")).renderPackage(bp);
      return out(await (await import("../lib/packaging/motion-export")).exportMotion(rendered.manifest,flag("--out")!,shape as import("../lib/packaging/catalog").Shape));
    }
    if (sub === "render") return out(await (await import("../lib/packaging/render")).renderPackage(bp));
    if (sub === "gallery") {
      if (!flag("--out")) throw new Error("gallery needs --out <directory>");
      return out(await (await import("../lib/packaging/gallery")).renderGallery(bp, flag("--out")!, { styles: argv.includes("--styles"), artDir: flag("--art-dir") }));
    }
    if (sub === "check") {
      const result = ops.checkStoryPackage(bp); out(result);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    if (sub === "revise") {
      const ids = flag("--notes")?.split(",").filter(Boolean);
      if (!ids?.length) throw new Error("revise needs --notes <feedback-id,...>");
      const { adminDb } = await import("../lib/db");
      const notes = await (await import("../lib/packaging/review")).revisionFeedback(adminDb(),id,ids);
      return out(ops.reviseBrief(bp,notes));
    }
    throw new Error("unknown packaging command");
  },
  async piece() {
    const { adminDb }=await import("../lib/db"),db=adminDb(),ops=await import("../lib/piece-review");
    // gtm piece kill <story-id>: John's "kill it" (lib/kill-piece.ts). Every row skipped, unsent Zernio posts deleted,
    // open notes resolved, the kill recorded. --dry-run lists the rows it would take off.
    if(rest[0]==="kill"){
      if(!rest[1])throw new Error("usage: gtm piece kill <story-id> [--dry-run] [--reason text]");
    if (dry) {
      const { data } = await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("story_id", rest[1]);
      return out({ story: rest[1], dryRun: true, rows: data ?? [] }, () => {
        console.log(`DRY RUN. ${rest[1]}: ${(data ?? []).length} rows`);
        for (const r of (data ?? []) as Array<{ id: string; status: string; zernio_post_id: string | null }>) console.log(`  ${r.id}  ${r.status}${r.zernio_post_id ? `  zernio ${r.zernio_post_id}` : ""}${["published", "skipped"].includes(r.status) ? "  (left as is)" : "  -> skipped"}`);
      });
    }
    const { killPiece } = await import("../lib/kill-piece");
    const r = await killPiece(db, rest[1], flag("--reason") ? { reason: flag("--reason")! } : {});
    return out(r, () => console.log(`killed ${r.story}: ${r.skipped.length} rows skipped, ${Object.keys(r.deleted).length} Zernio posts deleted, ${r.notesResolved} notes resolved${r.published.length ? `; already out, left alone: ${r.published.join(", ")}` : ""}`));
    }
    if(rest[0]==="status")return out(await ops.loadPieceReview(db,rest[1]));
    if(rest[0]==="complete-fix") {
      const fingerprint=flag("--fingerprint"),revision=Number(flag("--revision")),actor=flag("--actor"),verification=flag("--verification");
      if(!rest[1]||!fingerprint||!Number.isSafeInteger(revision)||revision<1||!actor||!verification||!argv.includes("--only-authorised-changes"))throw new Error("usage: gtm piece complete-fix <fix-id> --fingerprint <verified-version> --revision <n> --actor <worker> --verification <evidence> --only-authorised-changes");
      const snapshot=await ops.completePieceFix(db,{fixId:rest[1],fingerprint,revision,actor,verification,onlyAuthorisedChanges:true});
      // What scheduling did is part of the answer (review #147 N4): a refusal is printed, never dropped.
      const delivery=await ops.sharedDeliveryInstalled(db);
      // A refused schedule is not success: the exit code says so as well as schedule.refused (review #147 F5).
      if(!snapshot.ready||!delivery.ok){process.exitCode=1;return out({...snapshot,schedule:snapshot.ready?{refused:`not scheduled: ${!delivery.ok?delivery.reason:""}`}:{refused:`not scheduled: ${snapshot.blockers.join("; ")}`}});}
      const r=await (await import("../lib/auto-schedule")).autoSchedule(db,{storyId:snapshot.storyId});
      if(r.failed.length)process.exitCode=1;
      return out({...snapshot,schedule:{scheduled:r.scheduled,skipped:r.skipped,failed:r.failed}},()=>{console.log(`fix recorded for ${snapshot.storyId}`);for(const f of r.failed)console.error(`NOT SCHEDULED ${f.id}: ${f.error}`);for(const k of r.skipped)console.log(`skipped ${k.id}: ${k.reason}`);});
    }
    // Operator paths for one channel delivery (review #151 B1): never a dead end, never a second post.
    if(["recover","release","retry","replace"].includes(rest[0])&&rest[1]){
      const pd=await import("../lib/piece-delivery");
      if(rest[0]==="replace"){
        const d=(await pd.loadPieceDeliveries(db)).find(x=>x.id===rest[1]);
        const r=await pd.retireDeadDelivery(db,rest[1]);
        const sched=d?await (await import("../lib/piece-schedule")).scheduleSharedPieces(db,{storyId:d.story_id}):null;
        if(sched?.failed.length)process.exitCode=1;
        return out({...r,schedule:sched},()=>{console.log(r.detail);for(const f of sched?.failed??[])console.error(`NOT SCHEDULED ${f.id}: ${f.error}`);for(const k of sched?.skipped??[])console.log(`skipped ${k.id}: ${k.reason}`);});
      }
      if(rest[0]==="recover"){const r=await pd.recoverUncertainDelivery(db,rest[1],await (await import("../lib/calendar-db")).loadCalendarDb(db));return out(r,()=>console.log(`${r.action}: ${r.detail}`));}
      if(rest[0]==="release"){const r=await pd.releaseUnsentDelivery(db,rest[1]);return out(r,()=>console.log(r.detail));}
      const d=await (await import("../lib/piece-schedule")).retryPieceDelivery(db,rest[1]);
      if(!d||!["scheduled","published"].includes(d.state))process.exitCode=1;
      return out(d,()=>console.log(d?`${d.channel}: ${d.state}${d.error?` (${d.error})`:""}`:"not claimed: another worker holds this delivery"));
    }
    throw new Error("usage: gtm piece status <story-id> | complete-fix <fix-id> <verification flags> | recover|release|retry|replace <delivery-id> | kill <story-id> [--dry-run] [--reason text]");
  },
  async pipeline() {
    // gtm pipeline [short|carousel|text|episode|video] [--json]: the per-format pipelines (lib/pipelines.ts)
    const { PIPELINES, isFormat } = await import("../lib/pipelines");
    const arg = rest[0];
    const format = arg && isFormat(arg) ? arg : undefined;
    if (arg && !format) throw new Error(`unknown pipeline "${arg}"; one of ${Object.keys(PIPELINES).join(", ")}`);
    const data = format ? PIPELINES[format] : PIPELINES;
    out(data, () => {
      for (const p of format ? [PIPELINES[format]] : Object.values(PIPELINES)) {
        console.log(`${p.format}: ${p.label}`);
        for (const st of p.stages) console.log(`  ${st.key.padEnd(13)} ${st.gate === "john" ? "John (/content)" : "agent"}`.padEnd(34) + ` ${st.owner}${st.spends ? `; approving authorizes ${st.spends}` : ""}${st.final ? "; the only stage that schedules" : ""}\n                ${st.does}`);
      }
    });
  },
  async media() {
    // gtm media audit: probe every stored and scheduled video and image from its headers (lib/media-audit.ts).
    // --since 48h limits storage to recent changes (the daily cron's window); --fix replaces each bad file in place
    // (lib/media-fix.ts); --no-zernio skips Zernio; --dry-run writes nothing (no findings, no fixes).
    if (rest[0] !== "audit") throw new Error("usage: gtm media audit [--since 48h|ISO] [--fix] [--no-zernio] [--dry-run] [--json]");
    const { loadUnplayable, recordAudit, runAudit } = await import("../lib/media-audit");
    const { adminDb } = await import("../lib/db");
    const db = adminDb();
    const since = flag("--since");
    const sinceIso = since ? (/^\d+h$/.test(since) ? new Date(Date.now() - Number(since.slice(0, -1)) * 3_600_000).toISOString() : new Date(since).toISOString()) : undefined;
    const started = Date.now();
    const keys = flag("--keys")?.split(",").map((k) => k.trim()).filter(Boolean);
    const audit = await runAudit(db, { since: sinceIso, keys, zernio: !keys && !argv.includes("--no-zernio") });
    const recorded = dry ? null : await recordAudit(db, audit);
    let fixes: unknown[] = [];
    if (argv.includes("--fix")) {
      const { fixProblem } = await import("../lib/media-fix");
      const { ownerClient } = await import("../lib/story-ops");
      let owner: Awaited<ReturnType<typeof ownerClient>> | undefined;
      const ownerOnce = async () => (owner ??= await ownerClient(db));
      // Audit findings plus anything a browser reported that the header probe could not see.
      const todo = [...audit.bad];
      for (const f of await loadUnplayable(db)) if (!todo.some((t) => t.key === f.key)) todo.push(f);
      fixes = [];
      for (const p of todo) fixes.push(await fixProblem(db, p, { dryRun: dry, owner: ownerOnce }));
    }
    // Re-probe what was bad (storage keys, and Zernio when it was in scope) to prove the fix; nothing else is cleared.
    const after = argv.includes("--fix") && !dry ? await runAudit(db, { keys: audit.bad.filter((b) => b.where === "storage").map((b) => b.key), zernio: !keys && !argv.includes("--no-zernio") }) : null;
    if (after) await recordAudit(db, after);
    const result = {
      ran_at: audit.ran_at, scope: audit.scope, seconds: Math.round((Date.now() - started) / 1000),
      probed: audit.probedKeys.length, skipped: audit.skipped, videos: audit.videos, images: audit.images, storage: audit.storage, zernio: audit.zernio,
      bad_before: audit.bad.length, bad: audit.bad.map((b) => ({ key: b.key, kind: b.kind ?? "video", problems: b.problems, story: b.story_id, refs: b.refs.map((r) => `${r.kind}:${r.id}`) })),
      unreadable: audit.unreadable, ...(recorded ? { recorded } : {}), ...(argv.includes("--fix") ? { fixes } : {}),
      ...(after ? { bad_after: after.bad.length, still_bad: after.bad.map((b) => ({ key: b.key, problems: b.problems })) } : {}),
    };
    return out(result, () => {
      console.log(`probed ${result.probed} (${result.videos} videos, ${result.images} images; ${result.storage} in storage, ${result.zernio} on Zernio) in ${result.seconds}s: ${result.bad_before} bad`);
      for (const b of result.bad) console.log(`  BAD ${b.kind} ${b.key}: ${b.problems.join("; ")}${b.refs.length ? ` [${b.refs.join(", ")}]` : ""}`);
      for (const u of result.unreadable) console.log(`  UNREADABLE ${u.key}: ${u.error}`);
      for (const f of fixes as { key: string; ok: boolean; action: string; error?: string }[]) console.log(`  ${f.ok ? "FIXED" : "FAILED"} ${f.key}: ${f.ok ? f.action : f.error}`);
      if (after) console.log(`after: ${after.bad.length} bad`);
    });
  },
  async people() {
    // gtm people list|add|import|resolve: who "@Name" tags (lib/people.ts, lib/mentions.ts).
    const sub = rest[0];
    const { adminDb } = await import("../lib/db");
    const people = await import("../lib/people");
    const db = adminDb();
    const line = (p: { name: string; linkedin_url: string | null; linkedin_urn: string | null; linkedin_error?: string | null; instagram_handle: string | null; auto_tag?: boolean | null }) =>
      `${p.name.padEnd(28)} LinkedIn ${p.linkedin_urn ? "tags" : p.linkedin_url ? `NO (${p.linkedin_error || "not resolved"})` : "-"}   Instagram ${p.instagram_handle ? `@${p.instagram_handle}` : "-"}${p.auto_tag ? "   plain name tags" : ""}`;
    if (sub === "list" || !sub) {
      const rows = (await people.loadPeople(db)).filter((p) => (!argv.includes("--unresolved") || (p.linkedin_url && !p.linkedin_urn)) && (!argv.includes("--auto-tag") || p.auto_tag));
      return out(rows, () => { for (const p of rows) console.log(line(p)); console.log(`${rows.length} people`); });
    }
    if (sub === "add") {
      const r = await people.upsertPerson(db, { name: flag("--name"), rename: flag("--name") !== undefined, linkedin: flag("--linkedin"), linkedinName: flag("--linkedin-name"), instagram: flag("--instagram"), source: flag("--source") ?? "gtm people add", ...(argv.includes("--auto-tag") ? { autoTag: true } : argv.includes("--no-auto-tag") ? { autoTag: false } : {}) });
      if (!r.ok) throw new Error(r.error);
      return out(r, () => console.log(line(r.person) + (r.linkedin && !r.linkedin.ok ? `\n  LinkedIn could not resolve it: ${r.linkedin.error}` : "")));
    }
    if (sub === "import") {
      const file = rest[1];
      if (!file) throw new Error("usage: gtm people import <file.json> [--dry-run]");
      const { readFileSync } = await import("node:fs");
      const rows = JSON.parse(readFileSync(file, "utf8")) as import("../lib/people").NewPerson[];
      if (argv.includes("--dry-run")) return out({ rows: rows.length }, () => console.log(`${rows.length} people would be imported`));
      const done: string[] = []; const failed: Array<{ row: unknown; error: string }> = []; const untagged: string[] = [];
      for (const row of rows) {
        const r = await people.upsertPerson(db, row);
        if (!r.ok) { failed.push({ row, error: r.error }); continue; }
        done.push(r.person.name);
        if (r.linkedin && !r.linkedin.ok) untagged.push(`${r.person.name}: ${r.linkedin.error}`);
      }
      return out({ imported: done.length, failed, untagged }, () => {
        console.log(`imported ${done.length}, failed ${failed.length}, LinkedIn not resolvable ${untagged.length}`);
        for (const f of failed) console.log(`  FAILED ${JSON.stringify(f.row)}: ${f.error}`);
        for (const u of untagged) console.log(`  NO TAG ${u}`);
      });
    }
    if (sub === "resolve") {
      const rows = (await people.loadPeople(db)).filter((p) => p.linkedin_url && (argv.includes("--all") || !p.linkedin_urn));
      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      for (const p of rows) { const r = await people.refreshLinkedIn(db, p); results.push({ name: p.name, ok: r.ok, ...(r.ok ? {} : { error: r.error }) }); }
      return out(results, () => { for (const r of results) console.log(`${r.ok ? "tags" : "NO  "} ${r.name}${r.error ? `: ${r.error}` : ""}`); console.log(`${results.filter((r) => r.ok).length}/${results.length} resolved`); });
    }
    if (sub === "auto-tag") {
      // Tag someone on LinkedIn whenever John writes their name, no "@" (lib/mentions.ts); --off stops it.
      const who = rest.slice(1).join(" ").trim();
      if (!who) throw new Error('usage: gtm people auto-tag "<name>" [--off]');
      // Exact name, matched here (an ilike pattern would let "*" turn it on for everyone).
      const match = (await people.loadPeople(db)).filter((p) => p.name.toLowerCase() === who.toLowerCase());
      if (!match.length) throw new Error(`nobody called ${who}`);
      const { data, error } = await db.from("gtm_people").update({ auto_tag: !argv.includes("--off") }).in("id", match.map((p) => p.id)).select("name,linkedin_url,linkedin_urn,linkedin_error,instagram_handle,auto_tag");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`nobody called ${who}`);
      return out(data, () => { for (const p of data) console.log(line(p)); });
    }
    if (sub === "remove") {
      const who = rest.slice(1).join(" ").trim();
      if (!who) throw new Error('usage: gtm people remove "<name>"');
      const match = (await people.loadPeople(db)).filter((p) => p.name.toLowerCase() === who.toLowerCase());
      if (!match.length) throw new Error(`nobody called ${who}`);
      const { data, error } = await db.from("gtm_people").delete().in("id", match.map((p) => p.id)).select("name");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`nobody called ${who}`);
      return out(data, () => console.log(`removed ${data.map((d) => d.name).join(", ")}`));
    }
    throw new Error("usage: gtm people list [--unresolved] [--auto-tag] | remove \"<name>\" | auto-tag \"<name>\" [--off] | add --linkedin <url> [--name n] [--linkedin-name n] [--instagram h] [--auto-tag|--no-auto-tag] | import <file.json> | resolve [--all]");
  },
  async work() {
    // gtm work add|update|done|list: the work board (/work), what happens to John's notes. lib/work/store.ts
    const sub = rest[0];
    const { adminDb } = await import("../lib/db");
    const store = await import("../lib/work/store");
    const { STATUS_LABEL, agoLabel, etaLabel, buildBoard } = await import("../lib/work/model");
    const short = (id: string) => id.slice(0, 8);
    const ids = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    for (const f of ["--story", "--notes", "--title", "--eta", "--agent", "--asset", "--status", "--note", "--state", "--ended"]) if (argv.includes(f) && flag(f) === undefined) throw new Error(`${f} needs a value`);
    if (sub === "add") {
      const r = await store.addWork(adminDb(), { story: flag("--story"), notes: ids(flag("--notes")), title: flag("--title"), eta: flag("--eta"), agent: flag("--agent"), asset: flag("--asset"), status: flag("--status"), note: flag("--note") });
      return out(r, () => {
        console.log(`${short(r.item.id)}  ${r.item.title}  ${STATUS_LABEL[r.item.status]}${r.item.eta_at ? `, ETA ${etaLabel(r.item.eta_at, r.item.status)}` : ""}  (John sees it at /work)`);
        for (const o of r.alsoCoveredBy) console.log(`  note: ${short(o.id)} "${o.title}" already covers some of these notes`);
      });
    }
    if (sub === "update") {
      if (!rest[1]) throw new Error('usage: gtm work update <id> [--status queued|working|rendering|checking|staged|done|blocked] [--note "one plain line"] [--eta 30m] [--notes id,id] [--title t] [--agent a]');
      const w = await store.updateWork(adminDb(), rest[1], { status: flag("--status"), note: flag("--note"), eta: flag("--eta"), title: flag("--title"), agent: flag("--agent"), addNotes: flag("--notes") ? ids(flag("--notes")) : undefined });
      return out(w, () => console.log(`${short(w.id)}  ${w.title}  ${STATUS_LABEL[w.status]}${w.status === "blocked" ? `: ${w.blocked_reason}` : w.last_update ? `: ${w.last_update}` : ""}  ETA ${etaLabel(w.eta_at, w.status)}`));
    }
    if (sub === "done") {
      if (!rest[1]) throw new Error('usage: gtm work done <id> [--note "what was done"]');
      const r = await store.doneWork(adminDb(), rest[1], flag("--note"));
      return out(r, () => {
        console.log(`${short(r.item.id)}  ${r.item.title}  Done`);
        if (r.unanswered.length) console.log(`  ${r.unanswered.length} of its notes are still unanswered (${r.unanswered.map(short).join(", ")}): resolve them, or John will not see a reply`);
      });
    }
    if (sub === "next") {
      // The note dispatcher's pick (ops/work-dispatch.sh): the oldest piece with John's notes no job covers, with its
      // prompt. --state <file> remembers attempts, so a run that never claims its piece is not restarted every few
      // minutes. --mark records the attempt and first tidies up: dispatcher jobs left running past the run limit, and
      // notes tried MAX_ATTEMPTS times, become blocked jobs on /work with the reason. --ended <piece> --note <why>
      // blocks the jobs a run left open on its piece when it crashed or timed out.
      const d = await import("../lib/work/dispatch");
      const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
      const { calendarConfig } = await import("../lib/calendar-db");
      const db = adminDb();
      const LOG = "~/Library/Logs/vibrana/work-dispatch.log";
      const ended = flag("--ended");
      if (argv.includes("--ended") && !ended) throw new Error("--ended needs a piece id");
      if (ended) {
        const reason = flag("--note") ?? "the run ended before finishing";
        const r = await store.listWork(db);
        const blocked: string[] = [];
        for (const w of d.leftOpen(r.items, ended)) blocked.push((await store.updateWork(db, w.id, { status: "blocked", note: `dispatcher: ${reason}; see ${LOG}` })).id);
        return out({ piece: ended, blocked }, () => console.log(`${ended}: ${blocked.length} job${blocked.length === 1 ? "" : "s"} marked blocked`));
      }
      const stateFile = flag("--state");
      const mark = argv.includes("--mark");
      if (mark && !stateFile) throw new Error("--mark needs --state <file>");
      let state: import("../lib/work/dispatch").DispatchState = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
      const tz = calendarConfig().timezone;
      let r = await store.listWork(db);
      let board = buildBoard(r.items, r.waiting, new Date(), tz);
      if (mark) {
        let changed = false;
        for (const w of d.staleDispatcherJobs(r.items)) {
          await store.updateWork(db, w.id, { status: "blocked", note: `dispatcher: no update for over ${d.STALE_AFTER_MINUTES} minutes, so its run is gone; see ${LOG}` });
          changed = true;
        }
        for (const g of d.exhausted(board, state)) {
          const piece = { story: g.storyId ?? undefined };
          await store.addWork(db, { ...piece, notes: g.notes.map((n) => n.note_id), agent: d.DISPATCH_AGENT, status: "blocked",
            note: `dispatcher gave up after ${d.MAX_ATTEMPTS} runs that never picked these notes up; see ${LOG}` });
          changed = true;
        }
        if (changed) { r = await store.listWork(db); board = buildBoard(r.items, r.waiting, new Date(), tz); }
      }
      const row = d.nextDispatch(board, r.items, state);
      if (row && mark) {
        state = d.markAttempt(state, row, d.johnsGroups(board).map(d.attemptKey));
        writeFileSync(stateFile!, JSON.stringify(state, null, 2));
      }
      const pick = row ? { piece: row.storyId, source: row.source, notes: row.notes.map((n) => n.note_id), prompt: d.dispatchPrompt(row) } : null;
      if (argv.includes("--prompt")) return void (pick && process.stdout.write(pick.prompt));
      return out(pick, () => console.log(pick ? `${pick.piece} (${pick.source}): ${pick.notes.length} note${pick.notes.length === 1 ? "" : "s"}` : "nothing to dispatch"));
    }
    if (sub === "list" || !sub) {
      const r = await store.listWork(adminDb(), { all: argv.includes("--all") });
      const { calendarConfig } = await import("../lib/calendar-db");
      const tz = calendarConfig().timezone;
      return out(r, () => {
        const b = buildBoard(r.items, r.waiting, new Date(), tz);
        const line = (w: (typeof r.items)[number]) => `  ${short(w.id)}  ${STATUS_LABEL[w.status].padEnd(9)} ${w.title}  (${w.agent}, updated ${agoLabel(w.updated_at)}, ETA ${etaLabel(w.eta_at, w.status)})${w.status === "blocked" ? `\n            blocked: ${w.blocked_reason}` : w.last_update ? `\n            ${w.last_update}` : ""}`;
        console.log(`Waiting for an agent (${b.waiting.length})`);
        for (const g of b.waiting) if (g.kind === "waiting") console.log(`  ${g.storyId}: ${g.notes.length} note${g.notes.length === 1 ? "" : "s"} since ${agoLabel(g.since)}  ${g.notes.map((n) => short(n.note_id)).join(", ")}  ->  gtm work add --notes ${g.notes.map((n) => n.note_id).join(",")}`);
        for (const [label, rows] of [["In progress", b.inProgress], ["Ready for your review", b.review], ["Done today", b.doneToday]] as const) {
          console.log(`${label} (${rows.length})`);
          for (const x of rows) if (x.kind === "item") console.log(line(x.item));
        }
      });
    }
    throw new Error("usage: gtm work add --notes <ids> [--story id] [--title t] [--eta 45m] | update <id> --status s [--note n] [--eta 30m] | done <id> | list [--all] [--json] | next [--state file] [--mark] [--json|--prompt] | next --ended <piece> --note why");
  },
  async guide() {
    // The Content Guide (content/guide/*.json) for agents: the whole thing, one section, or one item in it.
    const { guide } = await import("../lib/guide/content");
    const all = guide() as Record<string, unknown>;
    const [section, item] = rest;
    if (!section) {
      return out(all, () => {
        console.log("Content Guide sections (gtm guide <section> [item] --json):");
        for (const k of Object.keys(all).filter((k) => k !== "version")) console.log(`  ${k}`);
        console.log("Live calendar: gtm plan --week N. Web: /guide");
      });
    }
    if (!(section in all)) throw new Error(`unknown section "${section}"; one of ${Object.keys(all).filter((k) => k !== "version").join(", ")}`);
    let data = all[section];
    if (item) {
      const list = Array.isArray(data) ? data : Object.values(data as object).find(Array.isArray) as unknown[] | undefined;
      data = list?.find((x) => (x as { slug?: string }).slug === item);
      if (!data) throw new Error(`no "${item}" in ${section}`);
    }
    out(data);
  },
  async season() {
    // gtm season [id] [--json]: the overview and analysis. gtm season set <id> --title ... updates the record.
    const { adminDb } = await import("../lib/db");
    const seasons = await import("../lib/seasons");
    const db = adminDb();
    if (rest[0] === "set") {
      const id = rest[1];
      if (!id) throw new Error("usage: gtm season set <id> [--title T] [--description D] [--starts YYYY-MM-DD] [--ends YYYY-MM-DD] [--pillars proof,perspective,build,lists]");
      const { data: current, error } = await db.from("gtm_seasons").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!current) throw new Error(`no season "${id}"`);
      const given = { title: flag("--title"), description: flag("--description"), starts: flag("--starts"), ends: flag("--ends"), pillars: flag("--pillars") };
      if (Object.values(given).every((v) => v === undefined)) throw new Error("nothing to change: give at least one of --title, --description, --starts, --ends, --pillars");
      const next = {
        title: given.title ?? current.title, description: given.description ?? current.description,
        starts_on: given.starts ?? current.starts_on, ends_on: given.ends ?? current.ends_on,
        pillars: given.pillars === undefined ? current.pillars : seasons.parsePillars(given.pillars),
      };
      const errors = seasons.validateSeasonFields(next);
      if (errors.length) throw new Error(errors.join(" "));
      next.title = next.title.trim();
      const updated = await db.from("gtm_seasons").update({ ...next, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
      if (updated.error) throw new Error(updated.error.message);
      return out(updated.data, () => console.log(`updated ${id}: ${next.title} | ${next.starts_on} to ${next.ends_on} | ${next.pillars.join(", ") || "no pillars"}`));
    }
    const id = rest[0] ?? (await seasons.resolveSeason(db, undefined, today())).id;
    const { input, analysis } = await seasons.loadSeason(db, id, today());
    out(analysis, () => console.log(seasons.formatSeasonReport(input, analysis)));
  },
  async story() {
    const { adminDb } = await import("../lib/db");
    const { stageStory, syncStoryCopy } = await import("../lib/story");
    const ops = await import("../lib/story-ops");
    const sub = rest[0];
    if (sub === "pull" && rest[1]) return out({ written: await syncStoryCopy(adminDb(), loadCalendar(), rest[1]) });
    if (sub === "status" && rest[1]) {
      const st = await ops.storyState(adminDb(), rest[1]);
      return out(st, () => {
        for (const a of st.assets) console.log(`${a.id.padEnd(40)} ${a.kind.padEnd(6)} rev ${a.revision}  ${a.channels.map((c) => `${c.channel}:${c.status}${c.current ? "" : "(stale)"}`).join(" ")}${a.stage ? `  stage ${a.stage}` : ""}`);
        for (const a of st.assets) for (const c of a.channels) if (c.note) console.log(`FEEDBACK ${a.id} (${c.channel}): ${c.note}`);
        const early = st.assets.filter((a) => a.stage && a.stage !== "final");
        if (early.length) console.log(`NOT FINAL: ${early.map((a) => `${a.id} is at stage ${a.stage}`).join(", ")}; approvals here mean "the edit is good" and nothing is scheduled until the final cut`);
        console.log(st.allApproved ? "ALL APPROVED" : "NOT all approved");
      });
    }
    if (sub === "feedback" && rest[1]) {
      const db = adminDb();
      const assets = (await db.from("gtm_story_assets").select("id").eq("story_id", rest[1])).data ?? [];
      const rows = (await db.from("gtm_story_feedback").select("*").in("asset_id", assets.map((a: { id: string }) => a.id)).order("created_at")).data ?? [];
      const shown = argv.includes("--all") ? rows : rows.filter((r: { resolved_at: string | null }) => !r.resolved_at);
      // An approve-with-note is flagged: John approved it; apply the note, restage, then `gtm story resolve <id>` schedules it.
      const { parseFixNote, noteAssets, noteText } = await import("../lib/approve-note");
      // A note for all formats of a video is stored once and names every format it covers (`covers`): fix them all, then
      // resolve it once.
      const flagged = shown.map((r: { id: string; asset_id: string; channel: string | null; body: string; resolved_at: string | null; resolution: string; stage?: string | null }) => { const fix = parseFixNote(r.body); const covers = noteAssets(r); return { ...r, note: noteText(r.body).text, covers, approved_with_note: !!fix, ...(fix ? { fix_before_scheduling: { part: fix.part, channels: fix.channels, assets: fix.assets, note: fix.note } } : {}) }; });
      return out(flagged, () => flagged.forEach((r: { id: string; asset_id: string; channel: string | null; note: string; covers: string[]; resolved_at: string | null; resolution: string; stage?: string | null; approved_with_note: boolean; fix_before_scheduling?: { part: string; channels: string[]; note: string } }) => console.log(`${r.id}  ${r.covers.length > 1 ? `ALL FORMATS: ${r.covers.join(", ")}` : r.asset_id} (${r.channel ?? "all"})${r.stage ? ` at ${r.stage}` : ""}${r.resolved_at ? " RESOLVED" : ""}${r.fix_before_scheduling && !r.resolved_at ? `  APPROVED WITH NOTE (${r.fix_before_scheduling.part}, ${r.fix_before_scheduling.channels.join("+")}): fix it, restage, then gtm story resolve ${r.id} "<reply>"; it schedules itself, no second review` : ""}\n  ${r.note.replaceAll("\n", "\n  ")}${r.resolution ? `\n  -> ${r.resolution}` : ""}\n`)));
    }
    if (sub === "resolve" && rest[1]) {
      const reply = rest.slice(2).join(" ").trim();
      const db = adminDb();
      // An approve-with-note: refused until the fix is restaged; then John's approval moves to the fixed bytes and it schedules.
      const { parseFixNote } = await import("../lib/approve-note");
      const { data: head,error:headError } = await db.from("gtm_story_feedback").select("body,asset_id").eq("id", rest[1]).maybeSingle();
      if(headError)throw new Error(headError.message);
      if(head) {
        await (await import("../lib/piece-review")).assertNotSharedFix(db, rest[1]);
        const asset=(await db.from("gtm_story_assets").select("metadata").eq("id",head.asset_id).single());
        if(asset.error)throw new Error(asset.error.message);
        // Only an accepted-with-note fix needs the scoped completion; a plain "Request changes" note on a shared piece
        // is resolved like any other note (review #147 N2).
        if(asset.data.metadata?.shared_review===true&&parseFixNote(head.body))throw new Error("Shared review fixes use explicit gtm piece complete-fix authorisation; legacy resolve cannot release them");
      }
      if (head && parseFixNote(head.body)) {
        const { resolveFixNote } = await import("../lib/approve-note-db");
        const r = { ...(await resolveFixNote(db, rest[1], reply)), ...(await advanceWork((d, w) => w.advanceOnResolve(d, [rest[1]]))) };
        out(r, () => {
          console.log(`resolved ${r.resolved} on ${r.story}; John's approval recorded on the fixed version for ${r.reapproved.length ? r.reapproved.join(", ") : "(already current)"}`);
          for (const id of r.scheduled) console.log(`  scheduled ${id}`);
          for (const k of r.skipped) console.log(`  skipped ${k.id}: ${k.reason}`);
          for (const f of r.failed) console.log(`  FAILED ${f.id}: ${f.error}`);
          printWork(r);
        });
        if (r.failed.length) process.exitCode = 1;
        return;
      }
      const { data: fb, error } = await db.from("gtm_story_feedback").update({ resolved_at: new Date().toISOString(), resolution: reply }).eq("id", rest[1]).is("resolved_at", null).select("asset_id, channel, body").maybeSingle();
      if (error) throw new Error(error.message);
      // Once nothing is left open for that platform, "needs changes" goes back to "needs approval".
      let reopened = 0;
      const { noteAssets, noteCovers } = await import("../lib/approve-note");
      const covers = fb ? noteAssets(fb) : [];
      if (fb && covers.length > 1) {
        // A note for all formats: each format it covers goes back to "needs approval" once no other open note is on it.
        const { data: asset } = await db.from("gtm_story_assets").select("story_id").eq("id", fb.asset_id).maybeSingle();
        const ids = asset ? ((await db.from("gtm_story_assets").select("id").eq("story_id", asset.story_id)).data ?? []).map((a: { id: string }) => a.id) : [];
        const open = ids.length ? ((await db.from("gtm_story_feedback").select("asset_id,channel,body").in("asset_id", ids).is("resolved_at", null)).data ?? []) as Array<{ asset_id: string; channel: string | null; body: string }> : [];
        for (const id of covers) {
          const rows = ((await db.from("gtm_story_asset_channels").select("channel").eq("asset_id", id).eq("status", "rejected")).data ?? []) as Array<{ channel: string }>;
          const free = rows.map((r) => r.channel).filter((ch) => !open.some((n) => noteCovers(n, id) && (n.channel === null || n.channel === ch)));
          if (!free.length) continue;
          const back = await db.from("gtm_story_asset_channels").update({ status: "pending", note: "" }).eq("asset_id", id).in("channel", free).eq("status", "rejected").select("asset_id");
          reopened += back.data?.length ?? 0;
        }
      } else if (fb?.channel) {
        const { data: asset } = await db.from("gtm_story_assets").select("story_id").eq("id", fb.asset_id).maybeSingle();
        if (asset) {
          const ids = ((await db.from("gtm_story_assets").select("id").eq("story_id", asset.story_id)).data ?? []).map((a: { id: string }) => a.id);
          const open = (await db.from("gtm_story_feedback").select("id").in("asset_id", ids).eq("channel", fb.channel).is("resolved_at", null)).data ?? [];
          if (!open.length) {
            const back = await db.from("gtm_story_asset_channels").update({ status: "pending", note: "" }).in("asset_id", ids).eq("channel", fb.channel).eq("status", "rejected").select("asset_id");
            reopened = back.data?.length ?? 0;
          }
        }
      }
      return out({ resolved: rest[1], reply, backToNeedsApproval: reopened, ...(fb ? await advanceWork((d, w) => w.advanceOnResolve(d, [rest[1]])) : {}) });
    }
    if (sub === "rework") {
      const db = adminDb();
      const { noteCovers } = await import("../lib/approve-note");
      const storyFilter = rest[1];
      const stories = ((await db.from("gtm_stories").select("id,title").order("id")).data ?? []).filter((s: { id: string }) => (storyFilter ? s.id === storyFilter : s.id.startsWith("s1-")));
      const report: Array<{ story: string; asset: string; channel: string; revision: number; note: string; open_feedback: string[] }> = [];
      for (const s of stories as Array<{ id: string }>) {
        const assets = (await db.from("gtm_story_assets").select("id,revision").eq("story_id", s.id)).data ?? [];
        const ids = assets.map((a: { id: string }) => a.id);
        if (!ids.length) continue;
        const rows = (await db.from("gtm_story_asset_channels").select("asset_id,channel,status,note").in("asset_id", ids).eq("status", "rejected")).data ?? [];
        const open = (await db.from("gtm_story_feedback").select("asset_id,channel,body,id,stage").in("asset_id", ids).is("resolved_at", null)).data ?? [];
        // A stage John sent back in /content ("changes" on a rough cut or a plan): one entry per stage, with its notes.
        const stagesBack = (await db.from("gtm_story_stages").select("stage,note").eq("story_id", s.id).eq("status", "changes")).data ?? [];
        for (const r of stagesBack as Array<{ stage: string; note: string }>) {
          report.push({ story: s.id, asset: `stage ${r.stage}`, channel: "all", revision: 0, note: r.note,
            open_feedback: (open as Array<{ id: string; body: string; stage: string | null }>).filter((f) => f.stage === r.stage).map((f) => `${f.id}: ${f.body}`) });
        }
        for (const r of rows as Array<{ asset_id: string; channel: string; note: string }>) {
          report.push({ story: s.id, asset: r.asset_id, channel: r.channel, revision: assets.find((a: { id: string }) => a.id === r.asset_id)?.revision ?? 0, note: r.note,
            open_feedback: (open as Array<{ id: string; asset_id: string; channel: string | null; body: string }>).filter((f) => f.channel === r.channel || (f.channel === null && noteCovers(f, r.asset_id))).map((f) => `${f.id}: ${f.body}`) });
        }
      }
      // Approve with note: John approved it; the fix is made, restaged and resolved, then it schedules itself.
      const { loadFixNotes } = await import("../lib/approve-note-db");
      for (const n of (await loadFixNotes(db, storyFilter)).filter((x) => storyFilter || x.storyId.startsWith("s1-"))) {
        report.push({ story: n.storyId, asset: n.assets.join(","), channel: n.channels.join("+"), revision: 0, note: `APPROVED WITH NOTE (fix before scheduling): ${n.note}`,
          open_feedback: [`${n.id}: restage the fix, then gtm story resolve ${n.id} "<reply>"; it schedules itself, no second review`] });
      }
      // Series notes ("Note for all 5"): one entry per batch, listing every piece it is on, so the fix is made once.
      const storyIds = (stories as Array<{ id: string }>).map((s) => s.id);
      const assetRows = storyIds.length ? ((await db.from("gtm_story_assets").select("id,story_id").in("story_id", storyIds)).data ?? []) as Array<{ id: string; story_id: string }> : [];
      const batchRows = assetRows.length ? ((await db.from("gtm_story_feedback").select("id,asset_id,body,batch_id").in("asset_id", assetRows.map((a) => a.id)).not("batch_id", "is", null).is("resolved_at", null)).data ?? []) as Array<{ id: string; asset_id: string; body: string; batch_id: string }> : [];
      for (const batch of [...new Set(batchRows.map((r) => r.batch_id))]) {
        const rows = batchRows.filter((r) => r.batch_id === batch);
        report.push({ story: "series", asset: `note ${batch.slice(0, 8)}`, channel: "all", revision: 0, note: rows[0].body,
          open_feedback: rows.map((r) => `${r.id}: on ${assetRows.find((a) => a.id === r.asset_id)?.story_id} (resolve each with gtm story resolve)`) });
      }
      return out(report, () => { if (!report.length) console.log("nothing needs changes"); for (const r of report) console.log(`${r.story}  ${r.asset} (${r.channel}, rev ${r.revision})\n  ${r.note.replaceAll("\n", "\n  ")}\n${r.open_feedback.map((f) => `  open ${f}`).join("\n")}\n`); });
    }
    if (sub === "approve" && rest[1]) {
      const approved = await ops.approveStory(adminDb(), rest[1], { only: flag("--asset"), note: flag("--note") ?? "approved from the gtm CLI at the owner's direction" });
      return out({ approved, state: (await ops.storyState(adminDb(), rest[1])).allApproved ? "ALL APPROVED" : "NOT all approved" });
    }
    if (sub === "schedule" && rest[1]) {
      const cal = await calendar();
      const slots = ops.defaultSlots(cal, rest[1]);
      for (const item of cal.items.filter((i) => i.story_id === rest[1])) {
        const at = flag(`--${item.channels[0]}`); // e.g. --linkedin "2026-10-06 08:30"
        if (at) { const [date, time] = at.split(/[ T]/); slots[item.id] = { date, time: time.slice(0, 5) }; }
      }
      const lines = await ops.scheduleStoryItems(adminDb(), rest[1], slots, { dryRun: dry });
      return out({ lines }, () => lines.forEach((l) => console.log(l)));
    }
    if (sub === "publish-media" && rest[1]) {
      const { publishStoryMedia } = await import("../lib/public-media");
      const assetIds = flag("--assets")?.split(",").map((id) => id.trim()).filter(Boolean);
      const r = await publishStoryMedia(adminDb(), rest[1], { assetIds, dryRun: dry });
      return out(r, () => {
        for (const image of r.images) console.log("url" in image ? `${image.id}  ${image.url}` : `${image.id}  -> ${image.key}${image.already ? "  (already public)" : ""}`);
      });
    }
    if (sub === "mark-published") {
      // gtm story mark-published <story-id> <copy-asset-id> --url <https://...substack.com/p/...> [--force] [--dry-run]
      // The essay is live on Substack: record where, and its card leaves /content (lib/mark-published.ts). The Mark
      // published button on the card does the same.
      const { markEssayPublished } = await import("../lib/mark-published");
      const url = flag("--url");
      if (!rest[1] || !rest[2] || !url) throw new Error("usage: gtm story mark-published <story-id> <copy-asset-id> --url https://<publication>.substack.com/p/<slug> [--force] [--dry-run]");
      const r = await markEssayPublished(adminDb(), rest[1], rest[2], url, { force: argv.includes("--force"), dryRun: dry });
      return out({ ...r, dryRun: dry }, () => console.log(`${dry ? "DRY RUN: would mark" : "marked"} ${r.asset} published at ${r.url}; its Substack card leaves /content`));
    }
    if (sub === "withdraw" || (sub === "progress" && rest[1] && rest[2] === "final" && rest[3] === "working")) {
      // Take a staged final off /content until a new final is staged (it was made before John's latest direction, or
      // is being redone). Hides it and holds it from scheduling; changes no asset, approval or note.
      const { withdrawFinal } = await import("../lib/content-visibility-db");
      if (!rest[1]) throw new Error('usage: gtm story withdraw <story-id> --note "why" [--dry-run]');
      const r = await withdrawFinal(adminDb(), rest[1], flag("--note") ?? "", { dryRun: dry });
      const h = r.visibility.hidden.find((x) => x.storyId === rest[1]);
      return out(r, () => console.log(`${dry ? "DRY RUN: would withdraw" : "withdrew"} the final of ${r.story} from /content: ${r.note}${h ? `\n  hidden: ${h.detail}` : r.visibility.listed.length ? "\n  still shown (dry run)" : "\n  not listed in /content"}`));
    }
    if (sub === "hidden") {
      // What /content leaves out right now, and why (lib/content-visibility.ts).
      const { contentVisibility } = await import("../lib/content-visibility-db");
      const r = await contentVisibility(adminDb(), rest[1]);
      return out(r, () => {
        console.log(`${r.shown.length} of ${r.listed.length} season pieces shown in /content (${r.cards.shown} of ${r.cards.listed} platform cards); ${r.hidden.length} hidden`);
        for (const h of r.hidden) console.log(`  ${h.storyId}  ${h.reason}: ${h.detail}`);
        for (const c of r.cards.sentBack) console.log(`  ${c.storyId} ${c.channel} card  changes: you asked for changes; it comes back when the new version is staged`);
      });
    }
    if (sub === "progress") {
      // gtm story progress <story-id | --series S> <stage> <status> [--note N]
      const { recordProgress, formatStages } = await import("../lib/stage-progress");
      const series = flag("--series");
      const args = series ? rest.slice(1) : rest.slice(2);
      const [stageKey, status] = args;
      if ((!series && !rest[1]) || !stageKey || !status) throw new Error("usage: gtm story progress <story-id | --series S> <stage> <todo|working|review|changes|approved|done|skipped|blocked> [--note N]");
      const db = adminDb();
      const ids = series ? (((await db.from("gtm_stories").select("id").eq("series", series).order("id")).data ?? []) as { id: string }[]).map((r) => r.id) : [rest[1]];
      if (!ids.length) throw new Error(`no Stories in series ${series}`);
      const results: Array<{ story: string; current: string | null }> = [];
      for (const id of ids) {
        const view = await recordProgress(db, id, stageKey, status, flag("--note") ?? "", "agent");
        results.push({ story: id, current: view.current?.stage.key ?? null });
        if (!json) console.log(`${id}\n${formatStages(view).replace(/^/gm, "  ")}`);
      }
      return json ? out(results) : undefined;
    }
    if (sub === "remove-asset" && rest[1]) {
      // A production asset staged into /content by mistake (a storyboard on a "plan" channel): remove it and only it.
      const r = await ops.removeStoryAsset(adminDb(), rest[1], { dryRun: dry });
      return out(r, () => console.log(`${dry ? "DRY RUN: would remove" : "removed"} ${r.removed} (${r.title}) from ${r.story}${r.channels.length ? `, with its ${r.channels.join(", ")} rows` : ""}. Remove it from the Story manifest too.`));
    }
    if (sub === "drop-channel" && rest[1] && rest[2]) {
      // Take a whole Story off one platform; its other platforms keep every row and approval.
      const r = await ops.dropStoryChannel(adminDb(), rest[1], rest[2], { dryRun: dry });
      return out(r, () => console.log(`${dry ? "DRY RUN: would drop" : "dropped"} ${r.channel} from ${r.rows.length} asset(s) of ${r.story}${r.removedAssets.length ? `; removed ${r.removedAssets.join(", ")} (bound to no other platform)` : ""}. Remove ${r.channel} from the Story manifest too.`));
    }
    if (sub === "stages" && rest[1]) {
      const { loadPipeline, formatStages } = await import("../lib/stage-progress");
      const p = await loadPipeline(adminDb(), rest[1]);
      const data = {
        story: p.story.id, pipeline: p.story.pipeline, series: p.story.series, third_party: p.story.third_party_who,
        current: p.view.current?.stage.key ?? null,
        stages: p.view.stages.map((s) => ({ stage: s.stage.key, label: s.stage.label, status: s.status, implicit: s.implicit, staged: s.staged, gate: s.stage.gate, review: s.stage.review, note: s.note, actor: s.actor })),
        decisions: p.decisions,
      };
      return out(data, () => {
        console.log(`${p.story.id}  ${p.pipeline.label || "no pipeline (one final stage)"}${p.story.series ? `  series ${p.story.series}` : ""}${p.story.third_party_who ? `  third party ${p.story.third_party_who}` : ""}`);
        console.log(formatStages(p.view).replace(/^/gm, "  "));
        for (const d of p.decisions) console.log(`  ${d.decided_at.slice(0, 16)} ${d.party === "john" ? "John" : d.who ?? "third party"} ${d.decision} ${d.stage}${d.note ? `: ${d.note}` : ""}`);
      });
    }
    if (sub !== "stage" || !rest[1]) throw new Error("usage: gtm story stage <story.yaml> [--stage rough-cut|final] [--dry-run] [--no-heal] | status <id> | approve <id> [--asset a] [--note n] | schedule <id> [--linkedin 'YYYY-MM-DD HH:MM'] [--instagram '...'] [--dry-run] | pull <id> | publish-media <story-id> [--assets a,b] [--dry-run] | mark-published <story-id> <copy-asset-id> --url U [--force] [--dry-run] | drop-channel <story-id> <channel> [--dry-run] | feedback <id> | resolve <note-id> 'reply' | withdraw <id> --note N | hidden [id]");
    if (argv.includes("--stage") && !flag("--stage")) throw new Error("--stage needs a stage key, e.g. --stage rough-cut or --stage final");
    if (argv.includes("--changes") && !flag("--changes")) throw new Error('--changes needs a sentence, e.g. --changes "Raw-track audio, new end card"');
    // A configured dry run may read legacy asset provenance but never writes. Offline dry runs
    // still validate complete new packages; they cannot attest to a DB-only legacy exemption.
    const stageDb = dry && (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) ? null : adminDb();
    const staged = await stageStory(stageDb, rest[1], loadCalendar(), dry, argv.includes("--force"), flag("--stage"), { changes: flag("--changes"), reopen: argv.includes("--reopen"), heal: !argv.includes("--no-heal"), shared: argv.includes("--shared") });
    // The piece's open jobs on the work board move to staged (or done, when every note is already answered).
    out(dry || "dryRun" in staged ? staged : { ...staged, ...(await advanceWork((db, w) => w.advanceOnStage(db, staged.id))) });
  },
  async review() {
    // The round-based review suite (/review, review_* tables) was retired for Content review v3.
    throw new Error("gtm review was retired: John reviews content at /content. Agents read his notes with `gtm story status`, `gtm story feedback <id>` and `gtm story pull <id>`, and stage new work with `gtm story stage <story.yaml>`.");
  },

  async accounts() {
    const r = await listAccounts();
    out(r, () => {
      console.log(`analytics access: ${r.hasAnalyticsAccess}`);
      for (const a of r.accounts) console.log(`${a.platform.padEnd(10)} ${String(a.username ?? a.displayName).padEnd(20)} ${a.followersCount ?? "-"} followers  ${a._id}${a.needsReconnection ? "  NEEDS RECONNECT" : ""}`);
    });
  },

  async plan() {
    const cal = await calendar();
    const sel = await weekSelector();
    const { inWeek, mondayOf, seasonWeek } = await import("../lib/week");
    const items = cal.items.filter((i) => (sel ? inWeek(sel, i.date) : true));
    const overdue = items.filter((i) => i.date < today() && !["published", "skipped"].includes(i.status));
    out({ timezone: cal.timezone, ...(sel ? { week: sel } : {}), items, overdue: overdue.map((i) => i.id) }, () => {
      let w = "";
      for (const i of items) {
        if (mondayOf(i.date) !== w) {
          w = mondayOf(i.date);
          const label = sel?.kind === "season" ? `${sel.season.id} week ${seasonWeek(sel.season.starts_on, i.date)}, ` : "";
          console.log(`\nWeek of ${w} (${label}ISO week ${i.week})`);
        }
        const late = overdue.includes(i) ? "  OVERDUE" : "";
        console.log(`  ${i.date} ${i.time ?? "     "} ${i.status.padEnd(9)} ${i.channels.join(",").padEnd(26)} ${i.id}  ${i.title}${late}`);
      }
    });
  },

  async check() {
    const { validate, parseCopy } = await import("../lib/calendar");
    const { checkChannelLinks, shapeFromName } = await import("../lib/channel-rules");
    const { deckCopyProblems, deckDigest, findDeck } = await import("../lib/deck");
    const file = argv.includes("--file");
    const warnings: string[] = [];
    // Channel link rules: errors fail the check (and the scheduler); warnings are advice only.
    const linkRules = (cal: { manual: string[] }, i: { id: string; channels: string[]; status: string; media?: string[] }, text: string, localVideo?: (m: string) => string | null) => {
      if (["published", "skipped"].includes(i.status)) return [];
      const video = (i.media ?? []).find((m) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(m));
      const probed = video && localVideo ? probeVideo(localVideo(video)) : null;
      const r = checkChannelLinks(i.id, i.channels.filter((ch) => !cal.manual.includes(ch)), parseCopy(text), probed ?? (video ? shapeFromName(video) : null));
      warnings.push(...r.warnings);
      return r.errors;
    };
    if (fromDb && !file) {
      const { validateRow, contentHash } = await import("../lib/calendar-db");
      const cal = await calendar();
      const problems: string[] = [];
      // Post text follows the asset: list carousels are checked against the slides.json they were rendered from.
      // Story copy lives in gtm_story_assets; the deck is found beside the local slide files when this machine has them.
      const storyIds = [...new Set(cal.items.map((i) => i.story_id).filter((s): s is string => !!s))];
      if (storyIds.length) {
        const { adminDb, must } = await import("../lib/db");
        const { dirname, resolve } = await import("node:path");
        const base = dirname(calendarPath());
        const rows = must(await adminDb().from("gtm_story_assets").select("id,story_id,kind,source,body").in("story_id", storyIds), "story assets") as { id: string; story_id: string; kind: string; source: string; body: string | null }[];
        let unchecked = 0;
        for (const i of cal.items) {
          if (!i.story_id || ["published", "skipped"].includes(i.status) || !["carousel", "document"].includes(i.format)) continue;
          const bound = rows.filter((r) => r.story_id === i.story_id && i.story_assets?.includes(r.id));
          const images = bound.filter((r) => r.kind === "image").map((r) => resolve(base, r.source));
          const copy = bound.find((r) => r.kind === "copy");
          if (!images.length || !copy?.body) continue;
          const deck = findDeck(images);
          if (!deck) {
            if (!images.some((f) => existsSync(f))) unchecked++;
            else if (i.pillar === "lists") warnings.push(`${i.id}: list carousel has no slides.json beside its slides, so its text is not checked against them; re-export the deck`);
            continue;
          }
          for (const p of deckCopyProblems(copy.body, deck.deck, deckDigest(deck.raw))) problems.push(`${i.id}: ${p}`);
        }
        if (unchecked) warnings.push(`${unchecked} carousel items not checked against their slides: the slide files are not on this machine`);
      }
      for (const i of cal.items) {
        if (i.body) problems.push(...linkRules(cal, i, i.body));
        problems.push(...validateRow({ ...i, time: i.time ?? null } as never));
        for (const ch of i.channels) if (!cal.accounts[ch] && !cal.manual.includes(ch)) problems.push(`${i.id}: no account for ${ch}`);
        if (!i.story_id && !i.body?.trim() && i.status !== "idea" && i.format !== "ig_story") problems.push(`${i.id}: no body`);
        if (i.body?.includes("\u2014")) problems.push(`${i.id}: em dash in copy`);
        if (i.body) for (const n of findAgentNotes(i.body)) problems.push(`${i.id}: unresolved note in copy: ${n.slice(0, 60)}`);
        if (i.body) { const b = findBritishSpellings(i.body); if (b.length) warnings.push(`${i.id}: British spelling (John is American): ${b.join(", ")}`); }
        if (i.status === "approved" && !i.story_id && i.approved_hash !== contentHash({ body: i.body, media: i.media })) problems.push(`${i.id}: approved, but the content changed after approval`);
      }
      out({ source: "db", items: cal.items.length, problems, warnings }, () => {
        console.log(`${cal.items.length} items, ${problems.length} problems${warnings.length ? `, ${warnings.length} warnings` : ""}`);
        problems.forEach((p) => console.log(`  - ${p}`));
        warnings.forEach((w) => console.log(`  ! ${w}`));
      });
      if (problems.length) process.exitCode = 1;
      return;
    }
    const cal = loadCalendar(undefined, { validate: false });
    const problems: string[] = validate(cal.items);
    for (const i of cal.items) {
      if (i.copy && !existsSync(resolveAsset(cal, i.copy))) problems.push(`${i.id}: copy missing ${i.copy}`);
      for (const m of i.media ?? []) if (!/^https?:/.test(m) && !existsSync(resolveAsset(cal, m))) problems.push(`${i.id}: media missing ${m}`);
      for (const ch of i.channels) if (!cal.accounts[ch] && !cal.manual.includes(ch)) problems.push(`${i.id}: no account for ${ch}`);
      if (i.copy && existsSync(resolveAsset(cal, i.copy)) && readFileSync(resolveAsset(cal, i.copy), "utf8").includes("\u2014")) problems.push(`${i.id}: em dash in copy`);
      if (i.copy && existsSync(resolveAsset(cal, i.copy))) {
        const text = readFileSync(resolveAsset(cal, i.copy), "utf8");
        for (const n of findAgentNotes(text)) problems.push(`${i.id}: unresolved note in copy: ${n.slice(0, 60)}`);
        const british = findBritishSpellings(text);
        if (british.length) warnings.push(`${i.id}: British spelling (John is American): ${british.join(", ")}`);
        const deck = findDeck((i.media ?? []).filter((m) => !/^https?:/.test(m)).map((m) => resolveAsset(cal, m)));
        if (deck) for (const p of deckCopyProblems(text, deck.deck, deckDigest(deck.raw))) problems.push(`${i.id}: ${p}`);
        else if (i.pillar === "lists" && ["carousel", "document"].includes(i.format) && (i.media ?? []).some((m) => /\.(png|jpe?g|webp)$/i.test(m))) warnings.push(`${i.id}: list carousel has no slides.json beside its slides, so its text is not checked against them; re-export the deck`);
        problems.push(...linkRules(cal, i, readFileSync(resolveAsset(cal, i.copy), "utf8"), (m) => /^https?:/.test(m) ? null : resolveAsset(cal, m)));
      }
    }
    out({ items: cal.items.length, problems, warnings }, () => {
      console.log(`${cal.items.length} items, ${problems.length} problems${warnings.length ? `, ${warnings.length} warnings` : ""}`);
      problems.forEach((p) => console.log(`  - ${p}`));
      warnings.forEach((w) => console.log(`  ! ${w}`));
    });
    if (problems.length) process.exitCode = 1;
  },

  async schedule() {
    const cal = await calendar();
    const sel = rest.length ? null : await weekSelector();
    const { inWeek } = await import("../lib/week");
    const ids = rest.length ? rest : cal.items.filter((i) => sel && inWeek(sel, i.date) && i.status === "approved").map((i) => i.id);
    if (!ids.length) throw new Error("nothing to schedule: pass ids, --week N (season week) or --iso-week N (only status: approved items are scheduled)");
    const { sendCalendarItem } = await import("../lib/publish-item");
    const mode = argv.includes("--now") ? "now" as const : "schedule" as const;
    const results = [];
    for (const id of ids) results.push(await sendCalendarItem(cal, id, { mode, dry, draft, allowPast }));
    out(results);
  },

  async autoschedule() {
    // Approval schedules (John, 2026-10-11): every approved, unscheduled item goes to its best open slot.
    const { adminDb } = await import("../lib/db");
    const { autoSchedule, holdReason } = await import("../lib/auto-schedule");
    const db = adminDb();
    const r = await autoSchedule(db, { storyId: flag("--story"), dryRun: dry });
    // A real pass refreshes what /content shows as approved but not scheduled (a dry run records nothing).
    const { recordScheduleReport } = await import("../lib/schedule-report");
    await recordScheduleReport(db, r, flag("--story")).catch((e) => console.error(`schedule report: ${(e as Error).message}`));
    out(r, () => {
      console.log(`${r.dryRun ? "DRY RUN (nothing sent). " : ""}${r.scheduled.length} scheduled, ${r.failed.length} failed, ${r.skipped.length} skipped`);
      for (const s of r.scheduled) console.log(`  ${s.date} ${s.time} ${s.channel.padEnd(9)} ${s.id}${s.moved ? `  (moved from ${s.from.date})` : ""}${s.zernioPostId ? `  Zernio ${s.zernioPostId}` : ""}`);
      for (const f of r.failed) console.log(`  FAILED ${f.id}: ${f.error}`);
      for (const k of r.skipped) console.log(`  skipped ${k.id}: ${k.reason}`);
      for (const h of r.held) console.log(`  on hold ${h.storyId}: ${holdReason(h)}`);
      for (const n of r.notFinal) console.log(`  not final ${n.storyId}: ${n.assets.map((a) => `${a.title} is at stage ${a.stage}`).join(", ")} (never scheduled until the final cut)`);
    });
    if (r.failed.length) process.exitCode = 1;
  },

  async hold() {
    // Pending third-party approval: a held Story is never auto-scheduled, even when John has approved it.
    const { adminDb } = await import("../lib/db");
    const { loadHolds, holdReason } = await import("../lib/auto-schedule");
    const { setStoryHold } = await import("../lib/story-ops");
    const db = adminDb();
    const id = rest[0];
    if (id) {
      await setStoryHold(db, id, { who: flag("--who"), note: flag("--note") });
      const [hold] = await loadHolds(db, id);
      return out({ held: hold }, () => console.log(`held ${id}: ${holdReason(hold)}. Release it with gtm release ${id} (or "Third party approved" in /content).`));
    }
    const holds = await loadHolds(db);
    out(holds, () => { if (!holds.length) console.log("nothing is on hold"); for (const h of holds) console.log(`${h.storyId}  ${h.heldAt ? `since ${h.heldAt.slice(0, 10)}` : "third party"}  ${holdReason(h)}`); });
  },

  async release() {
    // "Third party approved": clears the hold, then approval schedules as usual (no second approval).
    const { adminDb } = await import("../lib/db");
    const { autoSchedule } = await import("../lib/auto-schedule");
    const { setStoryHold } = await import("../lib/story-ops");
    const id = rest[0];
    if (!id) throw new Error("usage: gtm release <story-id> [--note \"how they approved\"] [--dry-run]");
    const db = adminDb();
    if (!dry) await setStoryHold(db, id, null, { note: flag("--note") });
    const r = await autoSchedule(db, { storyId: id, dryRun: dry, ...(dry ? { holds: [] } : {}) });
    out({ released: id, ...r }, () => {
      console.log(`${dry ? "DRY RUN: would release" : "released"} ${id}. ${r.scheduled.length} scheduled, ${r.failed.length} failed, ${r.skipped.length} skipped`);
      for (const s of r.scheduled) console.log(`  ${s.date} ${s.time} ${s.channel.padEnd(9)} ${s.id}${s.zernioPostId ? `  Zernio ${s.zernioPostId}` : ""}`);
      for (const f of r.failed) console.log(`  FAILED ${f.id}: ${f.error}`);
      for (const k of r.skipped) console.log(`  skipped ${k.id}: ${k.reason}`);
      if (!r.scheduled.length && !r.failed.length) console.log("  nothing approved to schedule yet; approval in /content schedules it");
    });
    if (r.failed.length) process.exitCode = 1;
  },

  async reviewer() {
    // Third-party review links (README "Review links"): a private link for example_approver / Example Series to see their finals at
    // /shared, comment, approve or ask for changes. The URL is printed once; only its hash is stored.
    const { adminDb } = await import("../lib/db");
    const { createInvite, inviteState, knownParties, listInvites, revokeInvite } = await import("../lib/reviewer/invites");
    const db = adminDb();
    const sub = rest[0];
    if (sub === "invite") {
      const party = flag("--party");
      if (!party) throw new Error(`usage: gtm reviewer invite --party "<who>" [--days N] [--accounts 1-5, default 2] [--note text]. Parties: ${(await knownParties(db)).join(", ") || "none"}`);
      const { invite, url } = await createInvite(db, { party, days: flag("--days") ? Number(flag("--days")) : undefined, accounts: flag("--accounts") ? Number(flag("--accounts")) : undefined, note: flag("--note"), by: "cli" });
      return out({ id: invite.id, party: invite.party, expires_at: invite.expires_at, max_accounts: invite.max_accounts, url }, () => {
        console.log(`review link for ${invite.party} (makes up to ${invite.max_accounts} logins; open until ${invite.expires_at.slice(0, 10)}):\n${url}\nSend it to them privately. Opening it again is harmless: only creating a login uses one, and they return with their email and password. It is not shown again; revoke with gtm reviewer revoke ${invite.id}`);
      });
    }
    if (sub === "revoke") {
      if (!rest[1]) throw new Error("usage: gtm reviewer revoke <invite-id>");
      const row = await revokeInvite(db, rest[1]);
      return out(row, () => console.log(`revoked ${row.id} (${row.party}${row.claimed_email ? `, ${row.claimed_email}` : ""}): access ends now`));
    }
    if (sub === "list" || !sub) {
      const rows = (await listInvites(db)).map((r) => ({ ...r, state: inviteState(r) }));
      return out(rows, () => {
        if (!rows.length) console.log("no review links yet: gtm reviewer invite --party \"<who>\"");
        for (const r of rows) console.log(`${r.id}  ${r.state.padEnd(7)}  ${r.party}  ${r.accounts}/${r.max_accounts} logins${r.emails.length ? ` (${r.emails.join(", ")})` : ""}  made ${r.created_at.slice(0, 10)}${r.state === "open" ? `, open until ${r.expires_at.slice(0, 10)}` : ""}`);
      });
    }
    if (sub === "notes") {
      // A third party's approvals, change requests and notes, per asset. They never enter the agent work queue: read them here
      // (or in the email John gets) and decide what to do.
      const story = rest[1];
      let q = db.from("gtm_reviewer_asset_decisions").select("id,story_id,asset_id,revision,party,decision,note,decided_by_email,decided_at").order("decided_at", { ascending: true });
      if (story) q = q.eq("story_id", story);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      return out(rows, () => {
        if (!rows.length) console.log("no third-party decisions yet");
        for (const r of rows) console.log(`${r.decided_at.slice(0, 16).replace("T", " ")}  ${r.story_id}  ${r.asset_id} v${r.revision}  ${r.decision.toUpperCase()}${r.decided_by_email ? `  (${r.decided_by_email})` : ""}${r.note ? `\n    ${String(r.note).replaceAll("\n", "\n    ")}` : ""}`);
      });
    }
    throw new Error("usage: gtm reviewer invite|list|revoke|notes [story-id]");
  },

  async push() {
    if (fromDb) {
      // Legacy name: the YAML is now imported, never mirrored (a mirror would wipe dashboard rows).
      const { adminDb } = await import("../lib/db");
      const { importCalendar } = await import("../lib/calendar-db");
      return out(await importCalendar(adminDb(), calendarPath(), { dryRun: dry }));
    }
    const { pushItems } = await import("../lib/sync");
    out(await pushItems(loadCalendar().items));
  },

  async status() {
    const { pushItems, syncStatus } = await import("../lib/sync");
    if (fromDb) return out({ updated: await syncStatus() });
    if (!existsSync(calendarPath())) return out({ skipped: `no calendar at ${calendarPath()}` });
    const cal = loadCalendar();
    await pushItems(cal.items);
    const patches = await syncStatus();
    for (const p of patches) updateItem(cal.path, p.id, p as any);
    out({ updated: patches });
  },

  async calendar() {
    const { adminDb } = await import("../lib/db");
    const { importCalendar, exportCalendar } = await import("../lib/calendar-db");
    if (rest[0] === "import") {
      const path = rest[1] ?? calendarPath();
      const r = await importCalendar(adminDb(), path, { dryRun: dry, force: argv.includes("--force") });
      return out(r, () => {
        console.log(`${r.dryRun ? "dry run: " : ""}${r.items} items from ${r.source}: ${r.inserted.length} new, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.uploads.length} media uploads`);
        if (r.conflicts.length) console.log(`kept dashboard edits (pass --force to overwrite): ${r.conflicts.join(", ")}`);
      });
    }
    if (rest[0] === "export") {
      const { writeFileSync } = await import("node:fs");
      const yaml = await exportCalendar(adminDb());
      const target = flag("--out");
      if (target) { writeFileSync(target, yaml); return out({ written: target }, () => console.log(`wrote ${target}`)); }
      return void process.stdout.write(yaml);
    }
    if (rest[0] === "weeks") {
      const { repairWeeks } = await import("../lib/calendar-db");
      const r = await repairWeeks(adminDb(), { dryRun: dry });
      return out(r, () => {
        console.log(`${r.dryRun ? "dry run: " : ""}${r.changes.length} of ${r.checked} rows have a week that does not match their date${r.dryRun || !r.changes.length ? "" : " (fixed)"}`);
        for (const c of r.changes) console.log(`  ${c.id.padEnd(46)} ${c.date}  week ${c.old} -> ${c.new}`);
      });
    }
    if (rest[0] === "reconcile") {
      // The calendar is the plan, Zernio is what publishes. Move Zernio to the calendar's slot, write back what went out,
      // and list what failed (give those a new slot with `gtm calendar move`).
      const { reconcileCalendar } = await import("../lib/reschedule");
      const r = await reconcileCalendar(adminDb(), { fix: !dry });
      return out(r, () => {
        console.log(`${dry ? "DRY RUN (nothing changed). " : ""}${r.checked} linked items checked against Zernio`);
        for (const d of r.drift) console.log(`  drift ${d.id}: calendar ${d.calendar}, Zernio ${d.zernio}${d.fixed ? "  -> Zernio moved" : d.error ? `  NOT FIXED: ${d.error}` : ""}`);
        for (const p of r.published) console.log(`  went out ${p.id} on ${p.date}${dry ? "" : "  -> calendar updated"}`);
        for (const f of r.failed) console.log(`  FAILED ${f.id} (${f.zernioPostId}): ${f.error}`);
      });
    }
    if (rest[0] === "lint") {
      // The weekly rhythm (John, 2026-10-17): each week against the house rules, plus the weekdays still empty.
      const { lintCalendar, gapsFor, dayLabels, isRealDate, parseWeeks, WEEKDAYS } = await import("../lib/rhythm");
      const { loadLintPosts } = await import("../lib/rhythm-db");
      const { addDays, mondayOf } = await import("../lib/week");
      const { todayIn } = await import("../lib/posts-db");
      const { planSlots } = await import("../lib/auto-schedule");
      const { loadCalendarDb } = await import("../lib/calendar-db");
      const weeks = parseWeeks(flag("--weeks"));
      const from = flag("--from");
      if (from !== undefined && !isRealDate(from)) throw new Error(`--from must be a real date, YYYY-MM-DD (got ${JSON.stringify(from)})`);
      const db = adminDb();
      const monday = mondayOf(from ?? todayIn());
      const end = addDays(monday, weeks * 7 - 1);
      const posts = await loadLintPosts(db, addDays(monday, -14), addDays(end, 7));
      const reports = lintCalendar(posts, monday, weeks);
      const gaps = gapsFor(posts, monday, end).filter((g) => g.date >= todayIn());
      // What auto-schedule would do with every piece not on Zernio yet if it were approved now: the ones with no open
      // day before the season ends are listed, so John can place them by hand.
      const cal = await loadCalendarDb(db);
      const { data: seasons } = await db.from("gtm_seasons").select("id,starts_on,ends_on");
      const unsent = cal.items.filter((i) => !i.zernio_post_id && (i.status === "drafted" || i.status === "approved"));
      const doesNotFit = planSlots({ items: cal.items, ready: unsent, now: new Date(), timeZone: cal.timezone, seasons: seasons ?? [], manual: cal.manual })
        .skipped.filter((x) => x.reason.startsWith("doesn't fit this season"));
      return out({ weeks: reports, gaps, doesNotFit }, () => {
        console.log(`Weekly rhythm: ${WEEKDAYS.map((d) => `${d} ${dayLabels(d).primary}`).join(" · ")}`);
        for (const w of reports) {
          const errors = w.issues.filter((i) => i.severity === "error").length;
          console.log(`\nWeek of ${w.monday}: ${w.pieces} pieces · ${w.counts.talkingHeads} talking heads · ${w.counts.voiceoverReels} voiceover reels · ${w.counts.prism} Prism Light · ${w.issues.length ? `${w.issues.length} issues (${errors} errors)` : "clean"}`);
          for (const i of w.issues) console.log(`  ${i.severity === "error" ? "ERROR" : "warn "} ${i.rule.padEnd(13)} ${i.message}`);
          for (const g of gaps.filter((x) => x.date >= w.monday && x.date <= addDays(w.monday, 6))) console.log(`  gap   ${g.day} ${g.date}: wants ${g.wants}`);
        }
        if (doesNotFit.length) {
          console.log("\nDoesn't fit this season (auto-schedule leaves these where they are; place them by hand):");
          for (const x of doesNotFit) console.log(`  ${x.id}: ${x.reason}`);
        }
      });
    }
    if (rest[0] === "move") {
      const { moveCalendarItem } = await import("../lib/reschedule");
      const id = rest[1]; const date = rest[2];
      if (!id || !date) throw new Error("usage: gtm calendar move <item-id> <YYYY-MM-DD> [--time HH:MM]");
      const r = await moveCalendarItem(adminDb(), id, { date, ...(flag("--time") ? { time: flag("--time") } : {}) });
      return out(r, () => console.log(`${r.id}: ${r.from.date} ${r.from.time ?? ""} -> ${r.to.date} ${r.to.time ?? ""}${r.zernio === "moved" ? " (Zernio moved too)" : ""}`));
    }
    if (rest[0] === "retry") {
      // A failed post, sent again from its current approved text at its calendar slot (lib/retry-item.ts).
      const id = rest[1];
      if (!id) throw new Error("usage: gtm calendar retry <item-id>");
      const { failureReason, retryCalendarItem } = await import("../lib/retry-item");
      if (dry) {
        const reason = await failureReason(adminDb(), id);
        return out({ id, reason, dryRun: true }, () => console.log(`DRY RUN. ${id} failed: ${reason ?? "(no reason on Zernio)"}`));
      }
      const r = await retryCalendarItem(adminDb(), id);
      return out(r, () => console.log(`${r.id}: sent again as ${r.zernioPostId} (${r.status})${r.deleted ? `; failed post ${r.deleted} deleted` : ""}`));
    }
    throw new Error("usage: gtm calendar import [calendar.yaml] [--dry-run] [--force] | export [--out file] | weeks [--dry-run] | reconcile [--dry-run] | move <item-id> <YYYY-MM-DD> [--time HH:MM] | retry <item-id> [--dry-run] | lint [--weeks N] [--from YYYY-MM-DD] [--json]");
  },

  async inspo() {
    const { adminDb } = await import("../lib/db");
    const lib = await import("../lib/inspiration");
    if (rest[0] === "add" && rest[1]) {
      const kind = flag("--kind") as never;
      const r = await lib.addInspiration(adminDb(), {
        url: rest[1], kind, tags: flag("--tags")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [],
        why_we_like: flag("--why") ?? "", pillar: flag("--pillar") ?? null, title: flag("--title") ?? undefined, added_by: flag("--by") ?? "cli",
      });
      return out(r, () => console.log(`saved ${r.kind}: ${r.title || r.url} (${r.id})`));
    }
    if (rest[0] === "list") {
      const r = await lib.listInspiration(adminDb(), { kind: flag("--kind"), tag: flag("--tag"), pillar: flag("--pillar") });
      return out(r, () => { for (const i of r) console.log(`${i.kind.padEnd(10)} ${(i.pillar ?? "-").padEnd(11)} ${i.title || i.url}  [${i.tags.join(", ")}]  ${i.url}`); });
    }
    if (rest[0] === "import" && rest[1]) return out(await lib.importInspiration(dry ? null : adminDb(), rest[1], { dryRun: dry }));
    throw new Error("usage: gtm inspo add <url> --kind video|carousel|newsletter|post [--tags a,b] [--why text] [--pillar p] [--title t] | list [--kind k] [--tag t] [--pillar p] | import <seed.json> [--dry-run]");
  },

  async outreach() {
    // Personalized cold outreach (gtm_outreach_drafts): the vibrana-crm pipeline imports drafts, John reviews them in
    // /outreach, his notes go back to the pipeline, and accepted drafts are queued and marked as they are sent.
    const [sub, arg] = rest;
    const { adminDb } = await import("../lib/db");
    const store = await import("../lib/outreach/store");
    const { prospectName } = await import("../lib/outreach/model");
    const batch = flag("--batch");
    if (sub === "import-dossiers" || sub === "import-profile") {
      // The writing desk (/outreach/write): vibrana-crm's dossiers (one per Twenty person) and John's profile, per stream:
      // --track client (the default) for cold prospects, --track guest for podcast guests.
      const file = flag("--file") ?? arg;
      const track = flag("--track") ?? "client";
      // A profile replaces the stream's stored one and the old text is not kept, so a forgotten flag must not default to clients.
      if (sub === "import-profile" && !flag("--track")) throw new Error("import-profile needs --track client|guest: it replaces that stream's profile");
      if (track !== "client" && track !== "guest") throw new Error(`--track is client or guest, not "${track}"`);
      if (!file) throw new Error(`usage: gtm outreach ${sub} --file <path.json> [--track client|guest] [--dry-run]`);
      const desk = await import("../lib/outreach/desk-store");
      const canWrite = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
      const db = dry && !canWrite ? null : adminDb();
      if (sub === "import-profile") {
        const r = await desk.importProfile(db, readFileSync(file, "utf8"), { dryRun: dry, track });
        return out({ track, ...r }, () => console.log(`${r.dryRun ? `dry run: ${track} profile checked, nothing written` : `${track} profile imported`}: ${r.facts} facts, ${r.proof} proof, ${r.assets} assets, ${r.gold_examples} gold examples, ${r.templates} templates`));
      }
      const r = await desk.importDossiers(db, readFileSync(file, "utf8"), { dryRun: dry, track });
      return out({ track, ...r }, () => console.log(`${r.dryRun ? "dry run: would insert" : "inserted"} ${r.inserted.length}, ${r.dryRun ? "would update" : "updated"} ${r.updated.length} of ${r.total} ${track} dossiers${r.dryRun ? " (nothing written)" : ""}. Skips and John's drafts are kept.`));
    }
    if (sub === "learn") {
      // The angle learning loop: read John's edits to generated angles since the last run, write observations and update the lessons.
      const { learnFromEdits, learningScore } = await import("../lib/outreach/learn");
      const r = await learnFromEdits(adminDb(), { dryRun: dry, force: process.argv.includes("--all"), actor: "cli" });
      const score = await learningScore(adminDb());
      return out({ ...r, observations: [...r.observations], score }, () => {
        if (r.skipped) console.log("no new edits since the last learning run (--all re-reads the latest)");
        else {
          console.log(`${dry ? "dry run: " : ""}read ${r.edits} edits: ${r.added.length} new lessons, ${r.kept} kept, ${r.retired.length} retired${r.held.length ? `, ${r.held.length} kept anyway (a run retires at most half)` : ""}`);
          for (const [id, notes] of r.observations) console.log(`  ${id.slice(0, 8)}: ${notes.join("; ")}`);
          for (const l of r.added) console.log(`  + (${l.kind}) ${l.lesson}`);
        }
        for (const s of score) console.log(`set ${s.lesson_set ?? "baseline"}: ${s.sent} sent, ${s.unedited} unchanged, ${Math.round(100 * s.similarity)}% close to sent`);
      });
    }
    if (sub === "import" && arg) {
      // A dry run still reads the existing rows (read-only) when the database is configured, so it says what would happen.
      const canRead = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
      const r = await store.importDrafts(dry && !canRead ? null : adminDb(), readFileSync(arg, "utf8"), { dryRun: dry });
      return out(r, () => {
        console.log(`${dry ? "dry run: would insert" : "inserted"} ${r.inserted.length}, ${dry ? "would regenerate" : "regenerated"} ${r.regenerated.length} (version + 1, back to pending), ${dry ? "would refresh" : "refreshed"} ${r.refreshed.length} untouched pending`);
        for (const k of r.kept) console.log(`  kept ${k.key}: ${k.reason}`);
        for (const k of r.raced) console.log(`  skipped ${k}: John decided on it during the import`);
        if (dry) console.log(canRead ? "dry run: nothing written" : "dry run: file checked, nothing written (no database configured, so every draft counts as new)");
      });
    }
    if (sub === "notes") {
      const rows = await store.regenerateNotes(adminDb(), batch);
      const file = flag("--out");
      if (file) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, JSON.stringify(rows, null, 2) + "\n");
      }
      return out(file ? { out: file, count: rows.length, ids: rows.map((r) => r.id) } : rows, () => {
        console.log(`${rows.length} draft${rows.length === 1 ? "" : "s"} sent back${file ? ` -> ${file}` : ""}`);
        if (!file) for (const r of rows) console.log(`  ${r.batch}/${r.domain}/${r.variant} v${r.version}${r.edited ? " (John edited it)" : ""}: ${r.note}`);
      });
    }
    if (sub === "queue" && (arg === "linkedin" || arg === "email")) {
      const rows = await store.actionQueue(adminDb(), arg, batch);
      return out(rows, () => {
        for (const r of rows) console.log(`${r.id}  ${r.batch}/${r.domain}/${r.variant}  ${r.name || "-"}, ${r.company ?? "-"}  ${"linkedin_url" in r ? r.linkedin_url : r.email}`);
        if (!rows.length) console.log(`nothing accepted waiting for ${arg}`);
      });
    }
    if (sub === "mark" && arg) {
      const r = await store.markDraft(adminDb(), arg, { linkedin: flag("--linkedin"), email: flag("--email") });
      return out(r, () => console.log(`${r.batch}/${r.domain}/${r.variant}: linkedin ${r.linkedin_status}, email ${r.email_status}`));
    }
    if (sub === "list") {
      const rows = await store.listDrafts(adminDb(), { batch, status: flag("--status") });
      return out(rows, () => {
        for (const d of rows) console.log(`${d.id}  ${d.status.padEnd(10)} ${d.batch}/${d.domain}/${d.variant} v${d.version}  ${prospectName(d.prospect) || "-"}  li:${d.linkedin_status} email:${d.email_status}\n    ${d.subject}`);
        if (!rows.length) console.log("no outreach drafts");
      });
    }
    throw new Error("usage: gtm outreach import <file.json> [--dry-run] | import-dossiers --file <path> [--track client|guest] [--dry-run] | import-profile --file <path> --track client|guest [--dry-run] | notes [--batch B] [--out file.json] | queue linkedin|email [--batch B] | mark <id> --linkedin queued|sent|connected|skipped | --email queued|sent|replied | list [--batch B] [--status pending|accepted|rejected|regenerate]");
  },

  async idea() {
    // Brainstorming Backlog (gtm_ideas): capture and triage ideas; promote a content idea into the Sunday candidates.
    const [sub, ref] = rest;
    const { adminDb } = await import("../lib/db");
    const store = await import("../lib/ideas/store");
    const fields = () => {
      const impact = flag("--impact");
      const raw: Record<string, unknown> = {
        title: flag("--title"), summary: flag("--summary"), kind: flag("--kind"), pillar: flag("--pillar"), format: flag("--format"),
        effort: flag("--effort"), impact: impact === undefined ? undefined : impact === "" ? null : Number(impact), status: flag("--status"),
        source_url: flag("--source"), owner: flag("--owner"), tags: flag("--tags"),
      };
      return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    };
    const line = (i: import("../lib/ideas/model").Idea) => `${i.status.padEnd(13)} ${i.kind.padEnd(11)} ${(i.pillar ?? "-").padEnd(11)} ${(i.effort ?? "-")} ${i.impact ?? "-"}  ${i.title}${i.promoted_candidate_id ? "  (promoted)" : ""}\n              ${i.slug}${i.tags.length ? `  [${i.tags.join(", ")}]` : ""}`;
    if (sub === "add" && ref) {
      const r = await store.addIdea(adminDb(), { ...fields(), title: ref, slug: flag("--slug"), created_by: flag("--by") ?? "cli" } as import("../lib/ideas/model").NewIdea);
      return out(r, () => console.log(`added ${r.slug} (${r.status}, ${r.kind})`));
    }
    if (sub === "list") {
      const rows = await store.listIdeas(adminDb(), { status: flag("--status"), kind: flag("--kind"), pillar: flag("--pillar"), tag: flag("--tag") });
      return out(rows, () => { for (const i of rows) console.log(line(i)); if (!rows.length) console.log("no ideas"); });
    }
    if (sub === "show" && ref) {
      const i = await store.getIdea(adminDb(), ref);
      return out(i, () => { console.log(line(i)); if (i.summary) console.log(`\n${i.summary}`); if (i.source_url) console.log(`\nsource: ${i.source_url}`); });
    }
    if (sub === "update" && ref) {
      const r = await store.updateIdea(adminDb(), ref, fields());
      return out(r, () => console.log(`updated ${r.slug}: ${line(r)}`));
    }
    if (sub === "promote" && ref) {
      const sel = await import("../lib/candidates/select");
      const db = adminDb();
      const week = await sel.resolveCandidateWeek(db, flag("--week"));
      const r = await store.promoteIdea(db, ref, { week_start: week, lens: flag("--lens") as never, pillar: flag("--pillar") as never, source_url: flag("--source") });
      return out(r, () => {
        console.log(`promoted ${r.idea.slug} -> candidate ${r.candidate.slug} for the week of ${r.candidate.week_start} (${r.candidate.id}); the idea is now in_production`);
        console.log("John writes it up or rejects it in /signals?view=candidates; nothing is approved or scheduled");
        for (const w of r.warnings) console.log(`warn  ${w}`);
      });
    }
    if (sub === "seed" && ref) {
      const r = await store.seedIdeas(dry ? null : adminDb(), ref, { dryRun: dry });
      return out(r, () => console.log(dry ? `dry run: ${r.would_add.length} ideas checked (${r.would_add.join(", ")})` : `added ${r.added.length}${r.added.length ? ` (${r.added.join(", ")})` : ""}; kept ${r.kept.length} that already exist`));
    }
    throw new Error("usage: gtm idea add <title> [--summary s] [--kind content|engagement|lead_magnet|tool|other] [--pillar p] [--format f] [--effort s|m|l] [--impact 1-5] [--status s] [--source url] [--owner name] [--tags a,b] [--slug s] | list [--status s] [--kind k] [--pillar p] [--tag t] | show <id|slug> | update <id|slug> [--title t] [--status s] [...same fields] | promote <id|slug> [--week N|YYYY-MM-DD] [--lens transformation|thought_leadership|regenerative] [--pillar p] [--source url] | seed <file.json> [--dry-run]");
  },

  async signals() {
    // Signal Desk: timely AI stories from the open web and John's X, classified by Clef, ranked for /signals.
    const { adminDb } = await import("../lib/db");
    const [sub, id, action] = rest;
    if (sub === "check") {
      const { signalsConfig, validateConfig } = await import("../lib/signals/config");
      const problems = validateConfig(signalsConfig());
      if (problems.length) process.exitCode = 1;
      return out({ ok: !problems.length, problems }, () => console.log(problems.length ? problems.join("\n") : "signals.json ok"));
    }
    if (sub === "run") {
      const { runWeb } = await import("../lib/signals/run");
      const r = await runWeb(adminDb());
      return out(r, () => printRun("web", r));
    }
    if (sub === "collect-x") {
      const { runX } = await import("../lib/signals/run");
      const r = await runX(adminDb());
      return out(r, () => printRun("x", r));
    }
    if (sub === "process") {
      const { processSignals } = await import("../lib/signals/pipeline");
      const { aiRunner } = await import("../lib/signals/cloudflare");
      const { signalsConfig } = await import("../lib/signals/config");
      return out(await processSignals(adminDb(), aiRunner(), signalsConfig()));
    }
    if (sub === "list") {
      const { listStories } = await import("../lib/signals/pipeline");
      const limit = Number(flag("--limit") ?? 20);
      const r = await listStories(adminDb(), { status: flag("--status"), lane: flag("--lane"), limit }) as { id: string; title: string; lanes: string[]; score: number; source_count: number; status: string; requested_format: string | null; brief: { headline: string } | null }[];
      return out(r, () => {
        for (const s of r) console.log(`${String(s.score).padStart(5)}  ${s.status.padEnd(9)} ${(s.requested_format ?? "").padEnd(6)} ${s.source_count}src  [${s.lanes.join(",")}]  ${s.brief?.headline ?? s.title}\n       ${s.id}`);
      });
    }
    if (sub === "show" && id) {
      const { storyItems } = await import("../lib/signals/pipeline");
      const db = adminDb();
      const { must } = await import("../lib/db");
      const story = must(await db.from("gtm_signal_stories").select("id,title,lanes,score,velocity,source_count,item_count,first_seen,last_seen,brief,status,requested_format,gtm_story_id,acted_by,acted_at").eq("id", id).maybeSingle(), "story");
      if (!story) throw new Error(`no signal story ${id}`);
      return out({ ...story, items: await storyItems(db, [id]) });
    }
    if (sub === "act" && id && action) {
      const { actOnStory } = await import("../lib/signals/actions");
      const r = await actOnStory(adminDb(), { id, action: action as never, actor: flag("--by") ?? "cli", format: (flag("--format") ?? null) as never, gtmStoryId: flag("--story") ?? null });
      return out(r, () => console.log(`${r.status}${r.requested_format ? ` (${r.requested_format})` : ""}: ${r.title}`));
    }
    if (sub === "digest") {
      const { runDigest } = await import("../lib/signals/run");
      const r = await runDigest(adminDb(), { dryRun: dry, to: flag("--to") });
      if (dry && !json) {
        const { digestText } = await import("../lib/signals/digest");
        const { signalsConfig } = await import("../lib/signals/config");
        console.log(`briefed ${r.briefs.briefed}${r.briefs.errors.length ? `, ${r.briefs.errors.length} errors` : ""}\n`);
        return console.log(digestText(signalsConfig(), r.stories as never, process.env.GTM_COCKPIT_URL ?? "http://localhost:3000", "dry run"));
      }
      return out(r);
    }
    if (sub === "runs") {
      const { must } = await import("../lib/db");
      const r = must(await adminDb().from("gtm_signal_runs").select("kind,started_at,finished_at,stats,errors").order("started_at", { ascending: false }).limit(Number(flag("--limit") ?? 10)), "runs") as { kind: string; started_at: string; finished_at: string | null; stats: Record<string, unknown>; errors: unknown[] }[];
      return out(r, () => { for (const x of r) console.log(`${x.started_at.slice(0, 16)} ${x.kind.padEnd(9)} ${x.finished_at ? "done" : "RUNNING/DIED"}  inserted=${x.stats.inserted ?? "-"} errors=${x.errors.length}`); });
    }
    if (sub === "install-agent") {
      const { installAgent } = await import("../lib/signals/agent");
      const r = installAgent(root, { dryRun: dry });
      return out(r, () => console.log(dry ? r.plist : `loaded ${r.label}: hourly, logs in ${r.logDir}`));
    }
    throw new Error("usage: gtm signals check | run | collect-x | process | list [--status S] [--lane L] [--limit N] | show <id> | act <id> save|queue|dismiss|restore|drafted [--format story|repost|video] [--story gtm-story-id] [--by name] | digest [--dry-run] [--to email] | runs [--limit N] | install-agent [--dry-run]");
  },
  async engage() {
    // Engage queue (VIB-423): comments and DMs from other people, drafted replies, John approves in /engage.
    const [sub] = rest;
    if (sub === "intake-linkedin") {
      // Runs where gog is authenticated (the Hermes box, or the Mac). Needs only GTM_COCKPIT_URL and CRON_SECRET.
      const { readLinkedInEmails, postIntake } = await import("../lib/engage/linkedin-email");
      const r = readLinkedInEmails({ days: Number(flag("--days") ?? 3), account: flag("--account") });
      if (dry) return out({ emails: r.emails, not_comment_emails: r.skipped, comments: r.comments }, () => {
        console.log(`${r.emails} emails, ${r.comments.length} comment notifications (${r.skipped} other)`);
        for (const c of r.comments) console.log(`- ${c.received_at?.slice(0, 16) ?? "?"} ${c.author_name} ${c.kind}: ${c.text ? c.text.slice(0, 80) : "(no text in the email)"} ${c.comment_url ?? ""}`);
      });
      const posted = r.comments.length ? await postIntake(r.comments) : { inserted: 0, duplicates: 0 };
      return out({ emails: r.emails, comments: r.comments.length, ...posted }, () => console.log(`${r.emails} emails, ${r.comments.length} comments, ${posted.inserted ?? 0} new in the queue`));
    }
    const { adminDb, must } = await import("../lib/db");
    if (sub === "run") {
      const { runEngage } = await import("../lib/engage/run");
      const r = await runEngage(adminDb(), { dryRun: dry, to: flag("--to") });
      return out(r, () => { console.log(JSON.stringify(r.stats)); for (const e of r.errors) console.log(`error ${e.source}: ${e.error}`); });
    }
    if (sub === "draft") {
      const { draftNew } = await import("../lib/engage/run");
      const r = await draftNew(adminDb(), { dryRun: dry, limit: Number(flag("--limit") ?? 80) });
      return out(r, () => { for (const d of r.drafts) console.log(`${d.id.slice(0, 8)} ${d.classification.padEnd(10)} ${d.reply || "-"}\n           why: ${d.reason}`); for (const e of r.errors) console.log(`error ${e.source}: ${e.error}`); });
    }
    if (sub === "list") {
      const { COMMENT_COLUMNS } = await import("../lib/engage/store");
      let q = adminDb().from("gtm_comments").select(COMMENT_COLUMNS).eq("is_own", false).order("commented_at", { ascending: false }).limit(Number(flag("--limit") ?? 30));
      if (flag("--status")) q = q.eq("status", flag("--status")!);
      const r = must(await q, "comments") as { id: string; platform: string; status: string; classification: string | null; author_name: string | null; text: string; draft: string | null }[];
      return out(r, () => { for (const c of r) console.log(`${c.id.slice(0, 8)} ${c.platform.padEnd(9)} ${c.status.padEnd(8)} ${(c.classification ?? "-").padEnd(10)} ${c.author_name ?? "?"}: ${c.text.slice(0, 70)}`); });
    }
    if (sub === "flags") {
      // Red flags (VIB-424) on posts commented on in the last N days: healthy debate, not landing, backlash.
      const { redFlags } = await import("../lib/engage/redflags");
      const { flagLines } = await import("../lib/engage/alerts");
      const days = Number(flag("--days") ?? 7);
      const r = await redFlags(adminDb(), new Date(Date.now() - days * 86400_000), new Date(Date.now() + 60_000));
      return out(r, () => { if (!r.length) console.log("no red flags"); for (const f of r) console.log(flagLines(f).join("\n") + "\n"); });
    }
    if (sub === "classify") {
      // Read-only: classify stance on recent comments and compute the flags, writing nothing. Needs --dry-run.
      if (!dry) throw new Error("gtm engage classify only runs as --dry-run (the daily run stores stances)");
      const { classifyDryRun } = await import("../lib/engage/run");
      const r = await classifyDryRun(adminDb(), { days: Number(flag("--days") ?? 14) });
      return out(r, () => {
        const by: Record<string, number> = {};
        for (const d of r.drafts) by[d.stance ?? "unclassified"] = (by[d.stance ?? "unclassified"] ?? 0) + 1;
        console.log(`${r.comments} comments, stances ${JSON.stringify(by)}, ${r.flags.length} flags, ${r.errors.length} errors`);
      });
    }
    if (sub === "learn") {
      // VIB-428: lessons from John's sends, edits, skips and relabels since the last run (--all: every decision).
      const { learnFromDecisions, learningScore } = await import("../lib/engage/learn");
      const r = await learnFromDecisions(adminDb(), { dryRun: dry, force: process.argv.includes("--all"), actor: "cli" });
      const score = await learningScore(adminDb());
      return out({ ...r, score }, () => {
        if (r.skipped) console.log("no new decisions since the last learning run (--all re-reads every one)");
        else console.log(`${r.signals} decisions read: ${r.added.length} new, ${r.kept} kept, ${r.retired.length} retired${r.held.length ? `, ${r.held.length} held (a run retires at most half; --all forces)` : ""}${r.more ? ", more waiting" : ""}${dry ? " (dry run, nothing written)" : ""}`);
        for (const l of r.added) console.log(`+ (${l.kind}) ${l.lesson}  [${l.evidence.length} evidence]`);
        for (const l of r.retired) console.log(`- (${l.kind}) ${l.lesson}`);
        for (const s of score) console.log(`set ${s.lesson_set ?? "baseline"}: ${s.sent} sent, ${s.unedited} as drafted, ${Math.round(100 * s.similarity)}% close, ${s.skipped} skipped, ${s.corrected} relabeled`);
      });
    }
    if (sub === "profiles") {
      // VIB-428: photo, followers, headline, website for queued commenters (LinkedIn, Instagram) via Apify.
      const { enrichAuthors } = await import("../lib/engage/profile");
      if (dry) {
        const rows = must(await adminDb().from("gtm_comments").select("platform,author_username").is("author_enriched_at", null).eq("is_own", false).in("status", ["new", "drafted", "failed"]), "unenriched") as { platform: string; author_username: string | null }[];
        return out({ unenriched: rows.length }, () => console.log(`${rows.length} queued comments without a profile`));
      }
      const r = await enrichAuthors(adminDb());
      return out(r, () => { console.log(`${r.rows} comments: ${r.read} read, ${r.reused} reused, ${r.missing} not found`); for (const e of r.errors) console.log(`error ${e.source}: ${e.error}`); });
    }
    if (sub === "voice") {
      // VIB-428: re-measure John's own replies against content/engage/reply-voice.json (read only).
      const { measureVoice, ownReplies } = await import("../lib/engage/voice");
      const { REPLY_VOICE } = await import("../lib/engage/draft");
      const now = measureVoice(await ownReplies());
      return out({ now, recorded: REPLY_VOICE.measured }, () => {
        console.log(`${now.replies} of John's replies read (the file records ${REPLY_VOICE.measured.replies})`);
        for (const [k, v] of Object.entries(now)) if (k !== "never_used_now_used" && k !== "replies") console.log(`  ${k}: ${v}${REPLY_VOICE.measured[k] !== undefined && String(REPLY_VOICE.measured[k]) !== String(v) ? `  (file: ${REPLY_VOICE.measured[k]})` : ""}`);
        for (const n of now.never_used_now_used) console.log(`! John now uses "${n.phrase}" (${n.uses}x): take it off never_used`);
      });
    }
    if (sub === "counts") {
      const { conversationCounts } = await import("../lib/engage/store");
      const to = flag("--to") ?? today();
      const from = flag("--from") ?? new Date(Date.parse(to) - 7 * 86400_000).toISOString().slice(0, 10);
      return out(await conversationCounts(adminDb(), from, to));
    }
    if (sub === "health") {
      // Read-only: connected accounts, their health, and whether the webhook carries comment events.
      const { accountHealth, listWebhooks, ENGAGE_EVENTS } = await import("../lib/zernio-inbox");
      const accounts = (await listAccounts()).accounts;
      const health = await Promise.all(accounts.map(async (a) => {
        const h = await accountHealth(a._id).catch((e: Error) => ({ status: `error: ${e.message.slice(0, 80)}` }) as { status: string; tokenStatus?: { expiresIn?: string } });
        return { id: a._id, platform: a.platform, username: a.username, active: a.isActive, needsReconnection: a.needsReconnection ?? false, status: h.status, token: h.tokenStatus?.expiresIn ?? null };
      }));
      const hooks = (await listWebhooks()).map((w) => ({ id: w._id, url: w.url, active: w.isActive, missing: ENGAGE_EVENTS.filter((e) => !w.events.includes(e)) }));
      return out({ accounts: health, webhooks: hooks }, () => {
        for (const h of health) console.log(`${h.platform.padEnd(10)} ${String(h.username).padEnd(18)} ${h.status}${h.needsReconnection ? " NEEDS RECONNECTION" : ""} token ${h.token ?? "-"}`);
        for (const w of hooks) console.log(`webhook ${w.url} ${w.active ? "active" : "INACTIVE"}${w.missing.length ? `, missing ${w.missing.join(", ")} (gtm engage subscribe)` : ", engage events subscribed"}`);
      });
    }
    if (sub === "subscribe") {
      // Adds comment.received and message.received to the cockpit webhook. Run after the route is deployed.
      const { listWebhooks, subscribeEngageEvents, ENGAGE_EVENTS } = await import("../lib/zernio-inbox");
      const hook = (await listWebhooks()).find((w) => w.url.includes("/api/webhooks/zernio"));
      if (!hook) throw new Error("no Zernio webhook points at /api/webhooks/zernio");
      const missing = ENGAGE_EVENTS.filter((e) => !hook.events.includes(e));
      if (dry || !missing.length) return out({ webhook: hook._id, missing, applied: false });
      await subscribeEngageEvents(hook);
      return out({ webhook: hook._id, added: missing, applied: true });
    }
    throw new Error("usage: gtm engage run [--dry-run] [--to email] | draft [--dry-run] [--limit N] | list [--status S] [--limit N] | counts [--from YYYY-MM-DD] [--to YYYY-MM-DD] | intake-linkedin [--days N] [--account email] [--dry-run] | health | subscribe [--dry-run] | flags [--days N] | classify --dry-run [--days N] | learn [--dry-run] [--all] | profiles [--dry-run]");
  },

  async stats() {
    const { syncStats, syncChannels } = await import("../lib/sync");
    const { adminDb } = await import("../lib/db");
    if (argv.includes("--delta")) {
      // Only the posts whose metrics changed since the stored cursor (what the analytics.synced webhook runs).
      const { syncDelta } = await import("../lib/analytics/delta");
      return out({ delta: await syncDelta(adminDb()) });
    }
    const { syncChannelReach } = await import("../lib/analytics/channels");
    out({ channels: await syncChannels(), reach: await syncChannelReach(adminDb()), posts: await syncStats(Number(flag("--days") ?? 90)) });
  },

  async candidates() {
    // Sunday candidates (VIB-420): the routine selects, drafts with the writers room, then puts the drafts here.
    const [sub, path] = rest;
    const { adminDb } = await import("../lib/db");
    const sel = await import("../lib/candidates/select");
    if (sub === "select") {
      // Read-only: which stories to draft for the week, balanced across lenses, pillars and formats.
      const db = adminDb();
      const week = await sel.resolveCandidateWeek(db, flag("--week"));
      let input = await sel.loadSelectInput(db, week);
      // Briefs written before VIB-420 lack audience fit: score them in one batched call (read-only, nothing stored).
      if (!argv.includes("--no-score")) {
        const { openRouterFitScorer, scoreFits } = await import("../lib/candidates/fit");
        input = await scoreFits(input, openRouterFitScorer());
      }
      // A calibrated rubric (content/guide/audience-calibration.json) may carry its own floor.
      const { audienceRubric } = await import("../lib/signals/audience");
      const floor = audienceRubric().min_audience_fit;
      const r = sel.selectCandidates(input, floor == null ? sel.candidatesConfig() : { ...sel.candidatesConfig(), min_audience_fit: floor });
      return out(r, () => {
        console.log(`Candidates for the week of ${r.week_start}: ${r.candidates.length} (pool: ${r.pool.queued} queued, ${r.pool.report} report stories, ${r.pool.briefed} briefed; ${r.pool.excluded} already used)`);
        for (const c of r.candidates) console.log(`${String(c.position + 1).padStart(2)}. ${c.format.padEnd(8)} ${c.pillar.padEnd(11)} ${c.lens.padEnd(18)} fit ${c.audience_fit ?? "-"}  ${c.title}\n    ${c.audience_reason ?? ""}\n    ${c.slug}  ${c.signal_id ?? c.report_action_id ?? ""}  (${c.why})`);
        if (r.gated.length) console.log(`gated (${r.gated.length}): ${r.gated.slice(0, 8).map((g) => `${g.title} [${g.why}]`).join("; ")}`);
        console.log(`lens ${JSON.stringify(r.balance.lens)}  format ${JSON.stringify(r.balance.format)}`);
        for (const w of r.warnings) console.log(`WARN ${w}`);
      });
    }
    if (sub === "put") {
      if (!path) throw new Error("usage: gtm candidates put <dir|file.json> [--week N|YYYY-MM-DD] [--dry-run] [--force] [--no-email] [--to email]");
      const { readPutInput } = await import("../lib/candidates/read");
      const { putCandidates, listCandidates } = await import("../lib/candidates/store");
      const input = readPutInput(path);
      const db = dry ? null : adminDb();
      const week = flag("--week") ? await sel.resolveCandidateWeek(db ?? adminDb(), flag("--week")) : input.week_start ?? sel.defaultWeekStart();
      const r: Record<string, unknown> & Awaited<ReturnType<typeof putCandidates>> = await putCandidates(db, week, input.candidates, { dryRun: dry, force: argv.includes("--force") });
      if (r.problems.errors.length) process.exitCode = 1;
      else if (!dry && r.written.length && !argv.includes("--no-email") && !/^https:\/\//.test(process.env.GTM_COCKPIT_URL ?? "")) {
        // A localhost link in John's inbox is worse than no email: say so and fail the run.
        r.email_error = "GTM_COCKPIT_URL is not an https URL, so the email would link to nowhere; set it to the deployed cockpit (the candidates are written)";
        process.exitCode = 1;
      } else if (!dry && r.written.length && !argv.includes("--no-email")) {
        const { sendCandidatesEmail } = await import("../lib/candidates/email");
        const { findAgentNotes } = await import("../lib/copy-guard");
        const waiting = await listCandidates(db!, { week_start: week, status: "candidate" });
        try {
          r.email_id = (await sendCandidatesEmail(waiting.map((c) => ({ ...c, john_slots: findAgentNotes([c.title, c.body, c.instagram ?? "", JSON.stringify(c.slides ?? ""), JSON.stringify(c.video ?? "")].join("\n")).filter((n) => /^\[JOHN/i.test(n)).length })), week,
            { to: flag("--to") ?? process.env.CANDIDATES_EMAIL_TO ?? process.env.SIGNALS_DIGEST_TO ?? "user-f538cb95fc21@example.com", cockpitUrl: process.env.GTM_COCKPIT_URL ?? "http://localhost:3000" })).id;
        } catch (e) {
          r.email_error = (e as Error).message;
          process.exitCode = 1;
        }
      }
      return out(r, () => {
        console.log(`${dry ? "DRY RUN " : ""}week of ${r.week_start}: ${input.candidates.length} candidate${input.candidates.length === 1 ? "" : "s"}, ${r.problems.errors.length} errors, ${r.problems.warnings.length} warnings, ${r.problems.john_slots} [JOHN: ...] slots`);
        for (const e of r.problems.errors) console.log(`ERROR ${e}`);
        for (const w of r.problems.warnings) console.log(`warn  ${w}`);
        if (r.written.length) console.log(`written: ${r.written.join(", ")}`);
        for (const k of r.kept) console.log(`kept ${k.slug} (${k.why})`);
        if (r.email_id) console.log(`emailed (${r.email_id})`);
        if (r.email_error) console.log(`EMAIL FAILED ${r.email_error}`);
      });
    }
    if (sub === "list") {
      const { listCandidates, editDiff } = await import("../lib/candidates/store");
      const week = flag("--week") ? await sel.resolveCandidateWeek(adminDb(), flag("--week")) : undefined;
      const rows = await listCandidates(adminDb(), { week_start: week, status: flag("--status"), limit: Number(flag("--limit") ?? 50) });
      return out(rows.map((c) => ({ ...c, john_edits: editDiff(c) })), () => {
        for (const c of rows) console.log(`${c.week_start} ${c.status.padEnd(9)} ${c.format.padEnd(8)} ${c.pillar.padEnd(11)} ${c.title}${c.score != null ? ` (rubric ${Math.round(c.score)})` : ""}${c.reject_reason ? `  rejected: ${c.reject_reason}${c.reject_note ? `, ${c.reject_note}` : ""}` : ""}${c.gtm_story_id ? `  -> ${c.gtm_story_id}` : ""}${c.edits.length ? `  ${c.edits.length} edits by John` : ""}\n           ${c.id}`);
        if (!rows.length) console.log("no candidates");
      });
    }
    throw new Error("usage: gtm candidates select [--week N|YYYY-MM-DD] [--no-score] | put <dir|file.json> [--week ...] [--dry-run] [--force] [--no-email] [--to email] | list [--week ...] [--status candidate|accepted|rejected] [--limit N]");
  },
  async report() {
    // The weekly content report (VIB-418) and the baseline. Dry runs read and call the model, write nothing.
    const { adminDb } = await import("../lib/db");
    const sub = rest[0];
    const weekArg = flag("--week");
    const week = weekArg === undefined ? undefined : Number(weekArg);
    if (week !== undefined && !(Number.isInteger(week) && week >= 1)) throw new Error(`--week takes a season week number (got ${JSON.stringify(weekArg)})`);
    if (sub === "weekly" || sub === "pack") {
      const { resolveReportWeek } = await import("../lib/reports/week");
      if (sub === "pack") {
        const { buildPack, loadPackInputs } = await import("../lib/reports/pack");
        const wk = await resolveReportWeek(adminDb(), { week, seasonId: flag("--season") });
        return out(buildPack(await loadPackInputs(adminDb(), wk), wk, new Date()));
      }
      const { runWeeklyReport } = await import("../lib/reports/run");
      const r = await runWeeklyReport(adminDb(), { week, seasonId: flag("--season"), dryRun: dry, force: argv.includes("--force"), to: flag("--to") });
      const { reportText } = await import("../lib/reports/email");
      return out(r, () => {
        if (r.skipped) return console.log(`skipped: ${r.skipped}`);
        console.log(`${dry ? "DRY RUN (nothing written or sent). " : ""}Week ${r.week.number}, ${r.week.from} to ${r.week.to}, model ${r.model}`);
        if (r.pack) console.log(`pack: ${r.pack.posts.length} posts (${r.pack.posts.filter((p) => p.window === "this_week").length} this week), ${Object.keys(r.pack.facts).length} facts, ${r.pack.upcoming.length} upcoming slots, ${r.pack.signals.length} signals`);
        if (r.pack) for (const g of r.pack.gaps) console.log(`  gap: ${g}`);
        console.log(`guard: ${r.guard?.dropped.length ?? 0} dropped, ${r.guard?.cleaned.length ?? 0} words struck${r.guard?.warnings.length ? `, ${r.guard.warnings.join("; ")}` : ""}`);
        for (const d of r.guard?.dropped ?? []) console.log(`  DROPPED ${d.section}[${d.index}]: ${d.reason}\n    "${d.text}"`);
        console.log("");
        if (r.pack && r.report) console.log(reportText(r.pack, r.report, process.env.GTM_COCKPIT_URL ?? "http://localhost:3000"));
        for (const a of r.report?.actions ?? []) console.log(`ACTION ${a.type}${a.item_id ? ` ${a.item_id}` : ""}${a.other_item_id ? ` <-> ${a.other_item_id}` : ""}${a.new_date ? ` -> ${a.new_date}` : ""}${a.new_format ? ` as ${a.new_format}` : ""}\n  ${a.proposal}\n  why: ${a.rationale}\n  evidence: ${a.evidence.map((e) => `${e.fact}=${e.value}`).join(", ")}`);
        if (!dry) console.log(`\nsaved ${r.id}; ${r.actions} changes to decide; email ${r.email_id ?? "not sent"}`);
      });
    }
    if (sub === "baseline") {
      const { recordBaseline } = await import("../lib/reports/run");
      const r = await recordBaseline(adminDb(), { dryRun: dry });
      return out(r, () => {
        console.log(`${dry ? "DRY RUN (not saved). " : ""}Baseline ${r.period_start} to ${r.period_end}`);
        for (const c of r.report.channels) {
          console.log(`  ${c.platform.padEnd(10)} followers ${c.followers ?? "-"}  28d: impressions ${c.impressions ?? "-"}, reach ${c.reach ?? "-"}, views ${c.views ?? "-"}, engagements ${c.engagements ?? "-"} (comments ${c.comments ?? "-"}, saves ${c.saves ?? "-"}, shares ${c.shares ?? "-"})${c.note ? `  [${c.note}]` : ""}`);
          if (c.linkedin) console.log(`             LinkedIn via Zernio: impressions ${c.linkedin.impressions}, reach ${c.linkedin.reach}, reactions ${c.linkedin.reactions}, comments ${c.linkedin.comments}, saves ${c.linkedin.saves}, sends ${c.linkedin.sends}`);
        }
      });
    }
    if (sub === "list") {
      const { must } = await import("../lib/db");
      const rows = must(await adminDb().from("gtm_content_reports").select("id,kind,week,period_start,period_end,status,headline,finished_at").order("period_start", { ascending: false }).limit(Number(flag("--limit") ?? 12)), "reports") as { id: string; kind: string; week: number | null; period_start: string; status: string; headline: string | null }[];
      return out(rows, () => { for (const x of rows) console.log(`${x.period_start} ${x.kind.padEnd(8)} ${x.week ? `W${x.week}`.padEnd(4) : "    "} ${x.status.padEnd(7)} ${x.headline ?? ""}`); });
    }
    throw new Error("usage: gtm report weekly [--week N] [--season id] [--dry-run] [--force] [--to email] | pack [--week N] | baseline [--dry-run] | list [--limit N]");
  },

  async playbook() {
    // Playbook tags (VIB-421): one hook, storyline and CTA per approved, scheduled or published item, from the
    // content canon's taxonomy. --dry-run calls the model and writes nothing. The daily Vercel sync runs this too.
    const sub = rest[0];
    if (sub === "tag") {
      const { adminDb } = await import("../lib/db");
      const { tagPlaybook, tagNames } = await import("../lib/playbook/tag");
      const limitArg = flag("--limit");
      const limit = limitArg === undefined ? undefined : Number(limitArg);
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) throw new Error(`--limit takes a positive whole number (got ${JSON.stringify(limitArg)})`);
      const r = await tagPlaybook(adminDb(), { all: argv.includes("--all"), dryRun: dry, limit });
      out(r, () => {
        console.log(`${dry ? "DRY RUN (nothing written). " : ""}${r.considered} approved, scheduled or published items; ${r.selected} to tag${r.all ? " (--all)" : " (untagged or copy changed)"}`);
        if (r.skipped) console.log(`  note: ${r.skipped}`);
        for (const t of r.tagged) {
          const n = tagNames(t.tags);
          console.log(`  ${t.id} [${t.status}] ${t.title}\n    hook ${t.tags.hook} (${n.hook}) · story ${t.tags.storyline} (${n.storyline}) · cta ${t.tags.cta} (${n.cta}, ${t.tags.cta_awareness}) · ${t.tags.confidence}\n    ${t.tags.rationale}`);
        }
        for (const x of r.rejected) console.log(`  REJECTED ${x.id} ${x.title}: ${x.reason}`);
        for (const e of r.errors) console.log(`  ERROR ${e.id}: ${e.error}`);
        if (r.deferred.length) console.log(`  deferred to the next run (time budget): ${r.deferred.join(", ")}`);
        console.log(`${r.tagged.length} tagged${dry ? " (not saved)" : ""}, ${r.rejected.length} rejected by the guard, ${r.errors.length} errors`);
      });
      // A skip that left due rows untagged (no key, no column) is a failure on the command line.
      if (r.errors.length || r.rejected.length || (r.skipped && r.selected > 0 && r.tagged.length === 0)) process.exitCode = 1;
      return;
    }
    throw new Error("usage: gtm playbook tag [--all] [--dry-run] [--limit N]");
  },

  async "front-doors"() {
    // The weekly funnel for the AI Readiness, EU AI Act and Build Sprint front doors (the /front-doors page): assessment
    // completions, ROI leads, sprint requests and call clicks per front door, unsubscribes and report quality.
    const { adminDb } = await import("../lib/db");
    const { loadFrontDoors, DOOR_LABELS } = await import("../lib/front-doors");
    const weeksArg = flag("--weeks");
    if (argv.includes("--weeks") && (weeksArg === undefined || weeksArg.startsWith("--"))) throw new Error("--weeks needs a number, e.g. --weeks 8");
    const weeks = weeksArg === undefined ? 8 : Number(weeksArg);
    if (!(Number.isInteger(weeks) && weeks >= 1 && weeks <= 52)) throw new Error(`--weeks takes a whole number from 1 to 52 (got ${JSON.stringify(weeksArg)})`);
    const r = await loadFrontDoors(adminDb(), { today: new Date().toISOString().slice(0, 10), weeks });
    out(r, () => {
      for (const e of r.errors) console.log(`WARNING: could not read ${e.table}: ${e.error} (its counts show as 0)`);
      console.log("week      assess  eu-act  roi  sprint  calls  unsub  stored  failed  judge");
      for (const w of r.weeks) {
        const q = w.quality;
        console.log(`${w.week}  ${String(w.total.completions).padStart(6)}  ${String(w.total.euAssessments).padStart(6)}  ${String(w.total.roiLeads).padStart(3)}  ${String(w.total.sprintInquiries).padStart(6)}  ${String(w.total.callClicks).padStart(5)}  ${String(w.unsubscribes).padStart(5)}  ${String(q.stored).padStart(6)}  ${String(q.failed).padStart(6)}  ${q.meanJudge == null ? "  none" : q.meanJudge.toFixed(2).padStart(6)}`);
        for (const d of r.active) {
          const c = w.doors[d];
          if (c.completions + c.euAssessments + c.roiLeads + c.sprintInquiries + c.callClicks === 0) continue;
          console.log(`  ${DOOR_LABELS[d].padEnd(16)} assessments ${c.completions}, eu ai act ${c.euAssessments}, roi leads ${c.roiLeads}, sprint requests ${c.sprintInquiries}, call clicks ${c.callClicks}`);
        }
      }
      for (const n of r.notes) console.log(`note: ${n}`);
    });
    if (r.errors.length) process.exitCode = 1;
  },

  async crm() {
    const { syncCrm } = await import("../lib/sync");
    const snap = await syncCrm();
    out(snap, () => {
      for (const [k, v] of Object.entries(snap.metrics)) console.log(`${k.padEnd(24)} ${v}`);
      console.log("opportunities", snap.opportunities);
      const mc = snap.meeting_capture;
      if (!mc.installed) console.log(`meeting capture         not installed (${mc.missing?.join(", ")})`);
      else for (const [o, v] of Object.entries(mc.owners)) {
        console.log(`meeting capture ${o.padEnd(8)} ${v.run ? `${v.run.mode ?? "?"}, day ${v.run.day}, seen ${v.run.notesSeen ?? 0}, captured ${v.run.captured ?? 0}` : "not onboarded"}, pending ${v.pending ?? "-"}`);
      }
      if (mc.missingFields?.length) console.log(`meeting capture fields  missing ${mc.missingFields.join(", ")}`);
      if (mc.error) console.log(`meeting capture error   ${mc.error}`);
    });
  },

  async enrichment() {
    const { pushEnrichment } = await import("../lib/sync");
    const dir = process.env.GTM_ENRICHMENT_DIR ?? join(homedir(), ".local/share/vibrana-qualification");
    const runs = [];
    for (const d of existsSync(dir) ? readdirSync(dir) : []) {
      const f = join(dir, d, "progress.json");
      if (!existsSync(f)) continue;
      const p = JSON.parse(readFileSync(f, "utf8"));
      runs.push({
        run: d, status: p.status, selected: p.selected, submitted: p.submitted, returned: p.returned, no_result: p.noResult,
        saved: p.saved, conflicted: p.conflicted, failed: p.failed, credits: p.creditsConsumed, cap_usd: p.capUsd ?? null, at: p.at,
      });
    }
    out(await pushEnrichment(runs));
  },

  async costs() {
    const { statement } = await import("../lib/wise");
    const { spendRows, pushSpend } = await import("../lib/costs");
    const since = flag("--since") ?? new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
    const rows = await spendRows(await statement(since, today()));
    if (dry) return out(rows);
    out(await pushSpend(rows));
  },

  async sync() {
    json = true;
    const results: Record<string, unknown> = {};
    const PARTS = ["status", "stats", "crm", "enrichment", "costs"];
    const only = flag("--only")?.split(",");
    for (const c of only ?? PARTS) if (!PARTS.includes(c)) throw new Error(`unknown sync part ${c} (allowed: ${PARTS.join(", ")})`);
    for (const c of only ?? PARTS) {
      sink = (d) => (results[c] = d);
      try {
        await commands[c]();
      } catch (e) {
        results[c] = { error: (e as Error).message };
      } finally {
        sink = null;
      }
    }
    console.log(JSON.stringify(results, null, 2));
    if (Object.values(results).some((r) => r && typeof r === "object" && "error" in r)) process.exitCode = 1;
  },
};

const help = `gtm <command> [--json]
  guide [section] [slug]   the Content Guide as JSON: phase, why, pillars, stories, voice, regenera, personal, assets, signals,
                           channels, inspiration, pipeline (e.g. gtm guide pillars proof)
  accounts                 connected Zernio accounts + followers
  plan [--week N [--season id] | --iso-week N]   calendar view (flags overdue). --week N is week N of the season
                           (the current one, or --season id), counted as gtm season counts them: weeks run Monday to
                           Sunday and week 1 holds the season's first day. --iso-week N (or YYYY-Www) is the calendar week.
                           Both go by each item's date.
  check [--file]           validate the calendar (database, or calendar.yaml with --file): ids, dates, HH:MM times,
                           pillars, bodies/copy files, accounts mapped, no em dashes, approvals still match content,
                           channel link rules (no URL in Instagram captions or LinkedIn bodies; YouTube Short warnings)
  schedule <id...> | --week N [--season id] | --iso-week N [--dry-run|--draft|--now]   create Zernio posts for approved
                           items (--week and --iso-week pick weeks exactly as plan does)
                           (--now: publish immediately; --dry-run: print payloads, no API; --draft: Zernio draft to preview, calendar untouched;
                            refuses past/imminent times unless --allow-past; the Zernio idempotency key is
                            gtm-<id> for 24h, so to re-post a deleted item within 24h give it a new id)
  autoschedule [--story id] [--dry-run]   schedule every approved, unscheduled item into its best open slot (approval
                           in /content does this by itself; no second approval). Keeps a planned slot that is still ahead
                           and free on its channel, else its weekly-rhythm day (then a fallback day, then the earliest
                           open day) inside the season at the guide time ("doesn't fit this season" otherwise);
                           skips held pieces (pending third-party approval, listed as "on hold") and reserve-bank items
                           dated after the last season
  hold [<story-id> [--who name] [--note text]]   pending third-party approval: hold a Story so approval never schedules
                           it (the cockpit's "Pending third-party approval" button); no id lists every hold
  release <story-id> [--dry-run]   "Third party approved": clear the hold, then schedule whatever John already approved
                           into its best open slot
  calendar reconcile [--dry-run]   compare every linked item with its Zernio post: move Zernio to the calendar's slot, write
                           back what went out (real date and links), list what failed. calendar move <id> <date> [--time]
                           moves one item (and its Zernio post); drag and drop in /calendar moves the whole piece.
                           calendar retry <id> [--dry-run]   a failed post: show Zernio's reason, delete the failed post and
                           send it again from the current approved text at its slot
  piece kill <story-id> [--dry-run] [--reason text]   John's "kill it": every calendar row of the piece skipped (off the
                           calendar and /content), unsent Zernio posts deleted, open notes resolved
  calendar lint [--weeks 4] [--from date] [--json]   the weekly rhythm (Mon Perspective, Tue Proof, Wed Build, Thu
                           Voices, Fri Lists, Sat IG+YT reels, Sun off) against the house rules: one piece a day,
                           channels on one day, 2 talking heads, at most 1 voiceover reel, no look twice in a row,
                           topic spacing, LinkedIn caption length; plus the weekdays still empty. Run it before
                           planning a week
  reviewer invite --party "<who>" [--days N] [--accounts 1-5] [--note text]   a private review link for a third party (example_approver / Example Series):
                           makes up to two logins (the reviewer and a cofounder; opening it again changes nothing, they
                           return with their email and password); they see only their pieces' finals at /shared and
                           approve, ask for changes on, or note EACH asset (the video, each platform's listing). Their
                           decisions never queue agent work; the last approval is their sign-off (it releases the hold and
                           schedules what John approved). The URL is printed once. reviewer list | reviewer revoke
                           <invite-id> (access ends at once) | reviewer notes [story-id] (their decisions and notes)
  calendar import [calendar.yaml] [--dry-run] [--force]   idempotent upsert of the YAML into the database (by id);
                           keeps dashboard body edits unless --force
  calendar export [--out file]   YAML snapshot of the database calendar (times quoted, so any YAML reader keeps them as text)
  calendar weeks [--dry-run]     set each row's stored week column to the ISO week of its date (only that column)
  push                     legacy alias of calendar import (GTM_CALENDAR)
  status                   reconcile post status from Zernio into the database
  inspo add <url> --kind K [--tags a,b] [--why text] [--pillar p]   save an inspiration (title/thumbnail fetched)
  inspo list [--kind K] [--tag T] [--pillar P]   list inspirations
  inspo import <seed.json> [--dry-run]           load a seed file (entries marked pending are skipped)
  outreach import <file.json> [--dry-run]   load the vibrana-crm pipeline's drafts into /outreach (key: batch, domain,
                           variant). A draft John sent back is replaced (version + 1, pending again, his note kept in the
                           history); an untouched pending one is refreshed; accepted, rejected or edited drafts are never
                           overwritten
  outreach notes [--batch B] [--out file.json]   the drafts John sent back: domain, variant, his note, the current subject
                           and body, and his edit when he made one, for the pipeline to regenerate
  outreach queue linkedin|email [--batch B]   accepted drafts not yet acted on, with the LinkedIn URL and note, or the
                           email address, subject, body and follow-ups
  outreach mark <id> --linkedin queued|sent|connected|skipped | --email queued|sent|replied   record what was done
  outreach list [--batch B] [--status pending|accepted|rejected|regenerate]   the drafts (all batches unless --batch)
  outreach import-dossiers --file <path> [--track client|guest] [--dry-run]   load vibrana-crm's dossiers into the writing
                           desk (/outreach/write), one per Twenty person; the file must hold rows of that track (client by
                           default); a re-import refreshes each dossier and keeps John's skips and drafts
  outreach import-profile --file <path> --track client|guest [--dry-run]   load John's profile for a stream
                           (qualification/outreach_profile*.json): facts, proof, assets, signature, gold examples and, for
                           guests, the 01 to 04 templates, shown beside the composer
  idea add <title> [--summary s] [--kind K] [--pillar P] [--format F] [--effort s|m|l] [--impact 1-5] [--status S]
                           [--source url] [--owner name] [--tags a,b] [--slug s]   capture an idea in the Brainstorming Backlog
                           (/ideas). Kinds: content, engagement, lead_magnet, tool, other. Statuses: idea, shortlisted,
                           in_production, shipped, parked
  idea list [--status S] [--kind K] [--pillar P] [--tag T]   the backlog, newest change first
  idea show <id|slug>      one idea with its summary
  idea update <id|slug> [--status S] [--title t] [...the add fields]   change an idea ("" clears an optional field)
  idea promote <id|slug> [--week N|YYYY-MM-DD] [--lens L] [--pillar P] [--source url]   put a content idea in the Sunday
                           candidates (next week unless --week) as a text brief with a [JOHN: ...] slot, link it and move
                           the idea to in_production. Needs a pillar and a source link; lead magnets and tools are built,
                           never promoted. Nothing is approved or scheduled
  idea seed <file.json> [--dry-run]   load ideas from a JSON array (config/ideas-seed.json); existing slugs are kept as they are
  signals run              Signal Desk: collect the open web (RSS, HN, GitHub, arXiv, HF papers, Google News, Reddit, Bluesky),
                           classify with Clef, cluster into stories and score (the Vercel cron does this every 2h)
  signals collect-x        the same for John's X (bookmarks, likes, X news, searches, voices) via bird; hourly on the Mac
  signals list [--status new|saved|queued|drafted|dismissed] [--lane L] [--limit N]   ranked stories (agents: --json)
  signals show <id>        a story with its brief and every source
  signals act <id> save|queue|dismiss|restore|drafted [--format story|repost|video] [--story gtm-story-id] [--by name]
                           what the writers-room does after drafting a queued story: act <id> drafted --story <id>
  signals digest [--dry-run] [--to email]   brief the top stories and email them (cron: daily, 08:00 Bali time)
  signals runs | check | install-agent [--dry-run]   run log with counts | validate signals.json | load the hourly X job
  stats [--days 90] [--delta]   snapshot post metrics (one row per post, platform and day), followers and account reach;
                           --delta reads only the posts that changed since the stored cursor (the analytics webhook does this)
  report weekly [--week N] [--dry-run] [--force] [--to email]   the weekly content report: what went out, what did well,
                           what didn't, pillars against their awareness job, and calendar changes to accept or dismiss in
                           /performance/report/N (cron: Sundays 08:00 Bali). --dry-run calls the model, writes and sends nothing
  report pack [--week N]   the report's input pack (deterministic JSON; every citable number is in .facts)
  report baseline [--dry-run]   record absolute counts per channel (followers, last 28 days of reach and engagements)
  report list              recent reports and baselines
  candidates select [--week N|YYYY-MM-DD] [--no-score]   the Sunday candidates for next week (read-only): queued signals
                           and the report's new_story actions first, then briefed stories that clear the audience-fit and score
                           floors, balanced across lenses and pillars (Perspective capped), at least one carousel and one video
                           script, 5 to 7 at most (fewer when the pool is thin). Briefs without audience fit are scored in one
                           OpenRouter call; --no-score skips it and gates them out
  candidates put <dir|file.json> [--dry-run] [--force] [--no-email]   validate the drafted candidates (voice guard, slides.json,
                           sources), upsert them for the week and email "N candidates waiting"; all or nothing
  candidates list [--week ...] [--status S]   the candidates and what John did with them (edits, rejections, staged Stories)
  playbook tag [--all] [--dry-run] [--limit N]   tag approved, scheduled and published items with one hook, storyline
                           and CTA from the content canon's taxonomy (content/guide/playbook-taxonomy.json); only untagged
                           items or ones whose copy changed, unless --all. The weekly report grades against these (cron: daily sync)
  engage run [--dry-run] [--to email]   poll Zernio for comments the webhook missed, draft replies, email "N replies to
                           approve" (cron: daily, 07:00 Bali time). Replies are approved and sent in /engage only
  engage draft [--dry-run] [--limit N]   draft replies for new comments now (--dry-run prints them, writes nothing)
  engage list [--status new|drafted|sent|skipped|hidden|failed] [--limit N]   the queue
  engage counts [--from D] [--to D]   conversations per platform (comments by others + DMs) in [from, to)
  engage intake-linkedin [--days 3] [--account email] [--dry-run]   read LinkedIn comment notification emails with gog
                           and post them to the cockpit (Hermes or the Mac; needs GTM_COCKPIT_URL and CRON_SECRET)
  engage health | subscribe [--dry-run]   accounts, health and webhook events | add the comment/DM events to the webhook
  engage flags [--days 7]  red flags per post: healthy debate, not landing, backlash, with the recommended action
  engage classify --dry-run [--days 14]   read-only: stance of recent comments and the flags they would raise
  outreach learn [--dry-run] [--all]   observations on John's edits to generated angles, updated lessons, and the score
  engage learn [--dry-run] [--all]   lessons from John's sends, edits, skips and relabels since the last run, and the score
  engage profiles [--dry-run]   photo, followers, headline and website for queued commenters (Apify; APIFY_TOKEN)
  engage voice                  re-measure John's own replies against content/engage/reply-voice.json (read only)
  front-doors [--weeks 8] [--json]   the weekly funnel per front door (readiness page, ROI calculator, sprint page, email,
                           simulator, direct): assessment completions, ROI leads, sprint requests, call clicks (clicks, not
                           bookings: Google Calendar reports nothing back), unsubscribes and report quality (analyses stored
                           or failed, mean judge score). Same numbers as /front-doors; read-only
  crm                      snapshot the Twenty funnel
  enrichment               push local enrichment run progress
  costs [--since DATE] [--dry-run]   classify Wise card spend into subscriptions
  sync [--only a,b]        status + stats + crm + enrichment + costs (or a subset)
  season [id] [--json]     a Season's overview and analysis: dates, pipeline (approvals and versions per piece and platform),
                           cadence against 3 a week, pillar mix against the guide, format-mix and guardrail checks
  season set <id> [--title T] [--description D] [--starts YYYY-MM-DD] [--ends YYYY-MM-DD] [--pillars a,b]
                           edit a Season's metadata (dates and pillar slugs are validated)
  story stage <story.yaml> [--stage key] [--dry-run]
                           snapshot a Story's assets into the cockpit for approval; --stage marks the media's pipeline
                           stage (a rough-cut can be approved but is never scheduled or published; --stage final lifts that)
                           --changes "..." says what changed (shown to John); --reopen restages a stage the piece is past
                           a video over 50 MiB (an episode final, up to 5 GiB) uploads resumably with a 720p review proxy
                           (needs ffmpeg; README "Large video")
  story progress <id | --series S> <stage> <status> [--note N]   report an agent stage (working, done, skipped, blocked),
                           or record a decision John gave outside the cockpit: progress <id> rough-cut approved --note
                           "John approved in the terminal". Gates (rough cut, review copy, final) are decided in /content
  story stages <id>        the piece's pipeline in the terminal, with every decision
  story withdraw <id> --note "why" [--dry-run]   take a staged final off /content (and off the schedule) until a new
                           final is staged; changes no asset, approval or note (also: story progress <id> final working)
  story hidden [id]        what /content leaves out and why: John asked for changes and nothing newer is staged, the final
                           predates his latest rough-cut approval, or an agent withdrew it
  story remove-asset <asset-id> [--dry-run]   remove a production asset staged into /content by mistake (its rows go
                           with it; nothing else changes); refused for an approved post or one a calendar item posts
  media audit [--since 48h] [--fix] [--no-zernio] [--dry-run]   probe every stored and scheduled video and image from its
                           headers (H.264 High/Main/Baseline 4:2:0, AAC, faststart; sRGB JPEG/PNG/WebP under 5 MB); BLOCK
                           findings in /content; --fix re-encodes or re-uploads each bad file in place, approvals carried
  people list [--unresolved]   the people list behind @mentions (gtm_people): what John types, LinkedIn tag, Instagram handle
  people add --linkedin <url> [--name "what John types"] [--linkedin-name "exact LinkedIn name"] [--instagram handle]
                           add or update someone; the LinkedIn tag is resolved through Zernio at once. In a post, "@Name"
                           becomes a LinkedIn tag and the Instagram @handle at publish; /content shows which will tag
  people import <file.json> [--dry-run]   [{name?, linkedin, linkedinName?, instagram?, source?}, ...]
  people resolve [--all]   resolve LinkedIn tags still missing (--all: every profile again)
  people auto-tag "<name>" [--off]   tag them on LinkedIn whenever their plain name is written, no @ (the team)
  people remove "<name>"   take someone off the list (add with --name renames; --linkedin changes the profile)
  work add --notes <id,id> [--story id] [--title "Meridian Short B: 5 notes"] [--eta 45m] [--agent name] [--status working]
                           the work board (/work): record a job on John's notes the moment an agent picks them up, so he
                           sees it. The piece comes from the notes when --story is left out; the title defaults to
                           "<piece>: N notes". A John note no job covers shows as "Waiting for an agent" after 5 minutes
  work update <id> --status queued|working|rendering|checking|staged|done|blocked [--note "one plain line"] [--eta 30m]
                           [--notes id,id] [--title t]   progress John reads at /work (blocked needs --note "why")
  work done <id> [--note "what was done"]   finished (warns when any of its notes is still unanswered)
  work list [--all] [--json]   waiting notes (with the add command for each piece), in progress, ready for review, done today
  work next [--state f] [--mark] [--json|--prompt]   the note dispatcher's pick: the oldest piece with John's notes no job
                           covers (--mark records it and blocks left-over dispatcher jobs and notes tried 3 times)
  work next --ended <piece> --note why   block the jobs a dispatched run left open when it crashed or timed out
                           Automatic: story stage moves the piece's open jobs to staged; story resolve marks a job done once all its notes are answered
  pipeline [format]        the per-format pipelines: stages, who decides each gate, what approval authorizes
  story mark-published <story-id> <copy-asset-id> --url U [--force] [--dry-run]
                           the Substack essay is live: record its URL; its card leaves /content (--force replaces a
                           different URL). The Mark published button on the card in /content does the same
  story publish-media <story-id> [--assets a,b] [--dry-run]
                           copy the Story's newsletter images to the public bucket (permanent URLs for Substack)
  story status|feedback|pull <id>   John's approvals and notes from /content (Content review); pull syncs approved copy.
                           A note on one format of a video (4:5, 9:16, 9:16-youtube) covers every format unless John
                           ticked "Only this format": feedback prints it once as ALL FORMATS: <ids>; fix each, resolve once
  story resolve <feedback-id> <reply>   answer one of John's notes. "story feedback" flags an "Approve with note" as
                           APPROVED WITH NOTE: John approved it and it is held from scheduling until the fix lands. Apply
                           the fix and restage first (resolve is refused until a newer version of that part is staged);
                           resolving then records his approval on the fixed version and auto-schedules it. No second review.
                           (gtm review publish|pull|status was retired with the old /review screen: review happens in /content)
`;

if (!cmd || !commands[cmd]) {
  console.log(help);
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(`gtm ${cmd}: ${(e as Error).message}`);
  process.exit(1);
}
