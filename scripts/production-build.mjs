// Private data is fetched only after the separately scrubbed dependency installation completes.
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareContentBuild, REQUIRED_CONTENT } from '../lib/content-overlay.mjs';
import { providerReleaseContext } from '../lib/release-context.mjs';
import { readPrivateRuntimeConfig } from '../lib/runtime-config.mjs';
import { cleanBuildPayload } from './production-install.mjs';

export const PRIVATE_CONTENT_REPOSITORY = 'git@github.com:Pravos-LLC/vibrana-gtm-runtime-private.git';
// GitHub's published Ed25519 host key, pinned from https://api.github.com/meta.
export const GITHUB_KNOWN_HOST = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
const FILES = [...REQUIRED_CONTENT, 'manifest.json', 'runtime.json'].sort();
function fail() { throw new Error('Private production build failed'); }
function gitEnvironment(env, home, sshCommand) {
  return {
    PATH: env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand, LC_ALL: 'C',
  };
}
export function verifyDeliveryTree(tree) {
  const entries = tree.trimEnd().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^100644 blob [a-f0-9]{40}\t(.+)$/);
    if (!match) fail();
    return match[1];
  }).sort();
  if (entries.length !== FILES.length || entries.some((name, index) => name !== FILES[index])) fail();
}
export function productionBuildEnvironment(env, root) {
  const child = { ...env, PRIVATE_OVERLAY_ROOT: root };
  delete child.PRIVATE_CONTENT_SSH_KEY;
  delete child.SSH_AUTH_SOCK;
  delete child.GIT_SSH;
  delete child.GIT_SSH_COMMAND;
  return child;
}
export function buildProduction(root = process.cwd(), env = process.env, run = execFileSync) {
  const stamp = providerReleaseContext(env);
  if (env.PRIVATE_CONTENT_REPOSITORY !== PRIVATE_CONTENT_REPOSITORY ||
    typeof env.PRIVATE_CONTENT_SSH_KEY !== 'string' ||
    !env.PRIVATE_CONTENT_SSH_KEY.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) fail();
  cleanBuildPayload(root);
  const temporary = mkdtempSync(resolve(tmpdir(), 'private-production-content-'));
  chmodSync(temporary, 0o700);
  const repo = resolve(temporary, 'data');
  const key = resolve(temporary, 'deploy-key');
  const hosts = resolve(temporary, 'known_hosts');
  let complete = false;
  try {
    writeFileSync(key, env.PRIVATE_CONTENT_SSH_KEY.trim() + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(hosts, GITHUB_KNOWN_HOST, { mode: 0o600, flag: 'wx' });
    mkdirSync(repo, { mode: 0o700 });
    const ssh = `ssh -F /dev/null -i '${key}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${hosts}' -o HostKeyAlgorithms=ssh-ed25519 -o LogLevel=ERROR`;
    const gitOptions = { cwd: repo, env: gitEnvironment(env, temporary, ssh), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000, maxBuffer: 1024 * 1024 };
    run('git', ['init', '--quiet'], gitOptions);
    run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', PRIVATE_CONTENT_REPOSITORY, stamp.privateRevision], gitOptions);
    const actual = run('git', ['rev-parse', 'FETCH_HEAD'], gitOptions).trim();
    if (actual !== stamp.privateRevision) fail();
    verifyDeliveryTree(run('git', ['ls-tree', '-r', 'FETCH_HEAD'], gitOptions));
    run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], gitOptions);
    const buildEnv = productionBuildEnvironment(env, repo);
    const runtime = readPrivateRuntimeConfig(repo, buildEnv);
    prepareContentBuild(buildEnv);
    const materialized = resolve(root, '.content-runtime');
    if (!lstatSync(materialized).isDirectory()) fail();
    writeFileSync(resolve(materialized, 'runtime.json'), runtime.bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(resolve(materialized, 'release.json'), JSON.stringify(stamp) + '\n', { mode: 0o400, flag: 'wx' });
    // Remove the fetching key before running any public build hooks. The validated payload stays pinned.
    rmSync(key, { force: true });
    // prebuild performs a fresh materialization for ordinary sample/local builds. This entry point
    // already performed it and bound release.json, so invoke Next directly instead of wiping it.
    run('pnpm', ['exec', 'next', 'build'], { cwd: root, env: buildEnv, stdio: 'inherit', timeout: 600000 });
    complete = true;
    return stamp;
  } catch { fail(); }
  finally {
    rmSync(temporary, { recursive: true, force: true });
    if (!complete) cleanBuildPayload(root);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildProduction(); console.log('Production content and release binding validated'); }
  catch { console.error('Private production build failed'); process.exitCode = 1; }
}
