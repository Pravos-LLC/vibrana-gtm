// The note dispatcher's shell pieces (ops/work-dispatch-lib.sh): finding the hub, killing a run's whole tree at the
// limit, and the denylist. Bash and real processes, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LIB = resolve("ops/work-dispatch-lib.sh");
const sh = (script: string, timeout = 30_000) => spawnSync("bash", ["-c", `. "${LIB}"; ${script}`], { encoding: "utf8", timeout });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return ok(); };

test("the hub is the nearest directory with vibrana.json, found from a worktree too; none found fails", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-"));
  try {
    const worktree = join(root, "vibrana-gtm-worktrees", "fix-x");
    mkdirSync(worktree, { recursive: true });
    assert.equal(sh(`dispatch_hub "${worktree}"`).status, 1, "no vibrana.json anywhere above");
    writeFileSync(join(root, "vibrana.json"), "{}");
    const r = sh(`dispatch_hub "${worktree}"`);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), spawnSync("bash", ["-c", `cd "${root}" && pwd -P`], { encoding: "utf8" }).stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Kills every pid and every group in a list, for test cleanup; quiet about what is already gone. */
const reap = (pids: number[]) => { for (const p of pids) for (const target of [-p, p]) { try { process.kill(target, "SIGKILL"); } catch { /* gone */ } } };
const pidsOf = (entries: string) => entries.split("\n").filter(Boolean).map((e) => Number(e.split("|")[0]));

test("the tree records each process with its start time, and every recorded process stops, also in its own group", async () => {
  // A stand-in run: one child in the run's group, and one detached into its own group the way Claude Code starts its
  // Bash tool shells, which itself starts a grandchild.
  const run = spawn("bash", ["-c", `sleep 300 & perl -e 'setpgrp(0,0); exec "bash", "-c", "sleep 300 & wait"' & wait`], { detached: true, stdio: "ignore" });
  const pid = run.pid!;
  let entries: string[] = [];
  try {
    assert.ok(await until(() => { entries = sh(`dispatch_tree ${pid}`).stdout.split("\n").filter(Boolean); return entries.length >= 3; }), `tree under ${pid}: ${entries}`);
    assert.ok(entries.every((e) => /^\d+\|\S+_\d{4}$/.test(e)), `pid|start time, one word: ${entries}`);
    const tree = pidsOf(entries.join("\n"));
    const groups = new Set(tree.map((p) => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(p)], { encoding: "utf8" }).stdout.trim())));
    assert.ok(groups.size >= 2, "the stand-in has a detached group, like a Bash tool shell");
    const quoted = entries.map((e) => `'${e}'`).join(" ");
    sh(`dispatch_signal TERM ${pid} ${quoted}`);
    sh(`dispatch_signal KILL ${pid} ${quoted}`);
    assert.ok(await until(() => tree.every((p) => !alive(p))), `still alive: ${tree.filter(alive)}`);
  } finally {
    reap([pid, ...pidsOf(entries.join("\n"))]);
  }
});

test("a recorded pid that now belongs to another process is not signalled", async () => {
  const other = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    // Same pid, different start time: what a reused pid looks like.
    const stale = `${other.pid}|Thu_Jan_1_00:00:00_1970`;
    assert.equal(sh(`dispatch_live '${stale}'`).stdout.trim(), "", "a changed start time is not the recorded process");
    const real = sh(`echo "${other.pid}|$(dispatch_started ${other.pid})"`).stdout.trim();
    assert.equal(sh(`dispatch_live '${real}'`).stdout.trim(), String(other.pid));
    sh(`dispatch_signal KILL 999999 '${stale}'`);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(other.pid!), "the other process is untouched");
  } finally { reap([other.pid!]); }
});

test("the limit holds even when the run ignores TERM: the watcher sends KILL after the grace period", () => {
  const mark = join(mkdtempSync(join(tmpdir(), "limit-")), "timed-out");
  // The run and its detached child both ignore TERM, like a CLI stuck in a graceful shutdown.
  const standIn = `trap "" TERM; perl -e '$SIG{TERM}="IGNORE"; setpgrp(0,0); exec "sleep", "300"' & sleep 300 & while :; do sleep 1; done`;
  const started = Date.now();
  // The stand-in's output goes to /dev/null, so a survivor cannot hold this test's pipe open; the timeout fails a
  // regression instead of hanging the suite.
  const r = sh(`dispatch_run 2 3 "${mark}" bash -c '${standIn.replaceAll("'", "'\\''")}' >/dev/null 2>&1; echo "code=$?"`, 20_000);
  const took = (Date.now() - started) / 1000;
  const recorded = spawnSync("cat", [mark], { encoding: "utf8" }).stdout;
  const pids = pidsOf(recorded);
  try {
    assert.match(r.stdout, /code=137/, `killed, not exited: ${r.stdout} ${r.stderr}`);
    assert.ok(took < 2 + 3 + 4, `ended within limit + grace (took ${took}s)`);
    assert.ok(pids.length >= 2, `the watcher recorded the tree: ${recorded}`);
    assert.ok(pids.every((p) => !alive(p)), `still alive: ${pids.filter(alive)}`);
  } finally { reap(pids); }
});

test("a run that ends inside the limit returns its own code and leaves no limit mark", () => {
  const mark = join(mkdtempSync(join(tmpdir(), "limit-")), "timed-out");
  const started = Date.now();
  const r = sh(`dispatch_run 30 3 "${mark}" bash -c 'exit 7'; echo "code=$?"`);
  assert.match(r.stdout, /code=7/);
  assert.ok((Date.now() - started) / 1000 < 5, "the watcher is not waited for");
  assert.equal(spawnSync("test", ["-e", mark]).status, 1, "no limit mark");
});

test("the denylist covers every spelling that reaches a publishing gtm command, and git push or merge", () => {
  const deny = sh("dispatch_deny").stdout.split("\n").filter(Boolean);
  for (const cmd of ["schedule", "autoschedule", "release", "hold", "reviewer", "engage", "outreach", "calendar", "candidates", "signals digest", "report weekly"]) {
    for (const via of ["gtm", "./bin/gtm", "bin/gtm", "pnpm gtm", "pnpm run gtm", "pnpm tsx cli/gtm.ts", "npx tsx cli/gtm.ts", "node cli/gtm.ts", "node vibrana-gtm/cli/gtm.ts"]) {
      assert.ok(deny.includes(`Bash(${via} ${cmd}:*)`), `${via} ${cmd}`);
    }
  }
  for (const p of ["Bash(git push:*)", "Bash(git merge:*)", "Bash(git -C:*)", "Bash(git -c:*)", "Bash(git --no-pager:*)", "Bash(git -P:*)", "Bash(git -p:*)", "Bash(pnpm run:*)", "Bash(pnpm tsx:*)", "Bash(pnpm exec:*)", "Bash(pnpm dlx:*)", "Bash(pnpm -C:*)", "Bash(npx:*)", "Bash(gh:*)"]) {
    assert.ok(deny.includes(p), p);
  }
  // The commands a run needs stay allowed: staging, notes, the work board and killing a piece.
  for (const keep of ["story", "storyboard", "work", "piece", "media"]) assert.ok(!deny.some((d) => d === `Bash(gtm ${keep}:*)`), `gtm ${keep} stays allowed`);
});

test("the dispatcher script refuses to start outside the hub, and says so in its log", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  try {
    mkdirSync(join(repo, "ops"), { recursive: true });
    for (const f of ["work-dispatch.sh", "work-dispatch-lib.sh"]) writeFileSync(join(repo, "ops", f), spawnSync("cat", [resolve("ops", f)], { encoding: "utf8" }).stdout);
    const r = spawnSync("bash", [join(repo, "ops", "work-dispatch.sh")], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    assert.equal(r.status, 1);
    const log = spawnSync("cat", [join(home, "Library/Logs/vibrana/work-dispatch.log")], { encoding: "utf8" }).stdout;
    assert.match(log, /not under the Vibrana hub/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("the dispatcher script stops a run that ignores TERM at the limit and marks its job blocked", () => {
  // A throwaway hub: vibrana.json, the real ops scripts, a stub gtm that hands out one piece and records --ended, and
  // a stand-in claude that is signed in to the subscription and ignores TERM (and starts a detached child that does too).
  const hub = mkdtempSync(join(tmpdir(), "hub-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const repo = join(hub, "vibrana-gtm");
  const calls = join(hub, "gtm-calls.log");
  const write = (path: string, body: string) => { writeFileSync(path, body); spawnSync("chmod", ["+x", path]); };
  try {
    writeFileSync(join(hub, "vibrana.json"), "{}");
    mkdirSync(join(repo, "ops"), { recursive: true });
    mkdirSync(join(repo, "bin"), { recursive: true });
    for (const f of ["work-dispatch.sh", "work-dispatch-lib.sh"]) writeFileSync(join(repo, "ops", f), spawnSync("cat", [resolve("ops", f)], { encoding: "utf8" }).stdout);
    write(join(repo, "bin", "gtm"), `#!/bin/bash
echo "$*" >> "${calls}"
case "$*" in
  *--ended*) echo '{"blocked":["w1"]}' ;;
  "work next"*) echo '{"piece":"s1-99-fixture","source":"content","notes":["n1"],"prompt":"fix it"}' ;;
esac
`);
    const claude = join(hub, "claude");
    write(claude, `#!/bin/bash
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0; fi
trap "" TERM
perl -e '$SIG{TERM}="IGNORE"; setpgrp(0,0); exec "sleep", "300"' &
while :; do sleep 1; done
`);
    const started = Date.now();
    const r = spawnSync("/bin/bash", [join(repo, "ops", "work-dispatch.sh")], {
      encoding: "utf8", timeout: 30_000,
      env: { HOME: home, USER: process.env.USER ?? "test", PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_BIN: claude, WORK_DISPATCH_LIMIT: "2", WORK_DISPATCH_GRACE: "2" } as unknown as NodeJS.ProcessEnv,
    });
    const took = (Date.now() - started) / 1000;
    const log = spawnSync("cat", [join(home, "Library/Logs/vibrana/work-dispatch.log")], { encoding: "utf8" }).stdout;
    assert.equal(r.status, 0, `${r.stderr}\n${log}`);
    assert.ok(took < 2 + 2 + 5, `stopped within limit + grace (took ${took}s)`);
    assert.match(log, /start s1-99-fixture \(max\) limit 2s/);
    assert.match(log, /end s1-99-fixture: stopped at the 2s limit before finishing/);
    assert.match(spawnSync("cat", [calls], { encoding: "utf8" }).stdout, /work next --ended s1-99-fixture --note stopped at the 2s limit/);
    assert.equal(spawnSync("pgrep", ["-f", `${claude}`]).status, 1, "the stand-in claude is gone");
    assert.equal(spawnSync("test", ["-L", join(home, "Library/Logs/vibrana/work-dispatch.lock")]).status, 1, "the lock is released");
  } finally {
    spawnSync("pkill", ["-9", "-f", join(hub, "claude")]);
    rmSync(hub, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});
