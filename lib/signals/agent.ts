// Installs the hourly launchd job that runs `gtm signals collect-x` on John's Mac.
// launchd has no direnv, so a small script loads the env files the way direnv does (hub
// scripts/env-to-shell.mjs: decrypt, nothing expanded) before running the CLI: the Tessera root .env when
// the hub sits under one (John's Mac: TINY_FISH_API_KEY for the Reddit fallback), then the hub and
// repo .env.team, most specific last. The job always
// runs from the primary checkout, never a worktree, because worktrees are pruned after merge.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LABEL = "ai.vibrana.signals-x";

/** The primary checkout of the repo `root` belongs to (a worktree's common git dir is the primary's .git). */
export function primaryCheckout(root: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  return dirname(resolve(common));
}

export function agentScript(primary: string, hub: string, nodeBin: string, tessera?: string): string {
  const root = tessera ? `cd "${tessera}" && eval "$(node "${hub}/scripts/env-to-shell.mjs" .env .env.keys)"\n` : "";
  return `#!/bin/zsh
# Written by \`gtm signals install-agent\`. Runs the Signal Desk X collector (launchd ${LABEL}).
set -eu
export PATH="${nodeBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
${root}cd "${hub}" && eval "$(node scripts/env-to-shell.mjs .env.team .env.keys)"
cd "${primary}" && eval "$(node "${hub}/scripts/env-to-shell.mjs" .env.team .env.keys)"
echo "--- $(date -u +%FT%TZ)"
exec ./bin/gtm signals collect-x
`;
}

export function agentPlist(script: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${script}</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logDir}/collect-x.log</string>
  <key>StandardErrorPath</key><string>${logDir}/collect-x.err.log</string>
</dict>
</plist>
`;
}

export function installAgent(root: string, opts: { dryRun?: boolean } = {}) {
  const primary = primaryCheckout(root);
  const hub = dirname(primary);
  if (!existsSync(join(hub, "scripts/env-to-shell.mjs"))) throw new Error(`no hub env loader at ${hub}/scripts/env-to-shell.mjs`);
  const dir = join(homedir(), ".vibrana", "signals");
  const script = join(dir, "collect-x.sh");
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const plist = agentPlist(script, dir);
  const parent = dirname(hub);
  const tessera = existsSync(join(parent, ".env")) && existsSync(join(parent, ".env.keys")) ? parent : undefined;
  const body = agentScript(primary, hub, dirname(process.execPath), tessera);
  if (opts.dryRun) return { label: LABEL, plist, script: body, logDir: dir };
  mkdirSync(dir, { recursive: true });
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  writeFileSync(plistPath, plist);
  const domain = `gui/${process.getuid?.()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
  execFileSync("launchctl", ["bootstrap", domain, plistPath]);
  return { label: LABEL, plist: plistPath, script, logDir: dir };
}
