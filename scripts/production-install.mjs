// Vercel install entry point: remove restored private caches before running dependency scripts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function cleanBuildPayload(root) {
  for (const name of readdirSync(root)) {
    if (name === '.next' || name === '.content-runtime' || name.startsWith('.content-runtime-')) {
      rmSync(resolve(root, name), { recursive: true, force: true });
    }
  }
}
export function dependencyEnvironment(env, home) {
  return Object.fromEntries(Object.entries({
    PATH: env.PATH, HOME: home, TMPDIR: env.TMPDIR, TMP: env.TMP, TEMP: env.TEMP,
    CI: '1', NODE_ENV: 'production', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_update_notifier: 'false',
  }).filter(([, value]) => value !== undefined));
}
export function installProductionDependencies(root = process.cwd(), env = process.env, run = execFileSync) {
  cleanBuildPayload(root);
  const home = mkdtempSync(resolve(tmpdir(), 'public-dependency-home-'));
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--prod=false', '--ignore-scripts'], {
      cwd: root, env: dependencyEnvironment(env, home), stdio: 'inherit', timeout: 600000,
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installProductionDependencies(); } catch { console.error('Dependency installation failed'); process.exitCode = 1; }
}
