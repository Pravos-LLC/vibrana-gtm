// Private data is fetched only after the separately scrubbed dependency installation completes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prepareContentBuild, REQUIRED_CONTENT } from '../lib/content-overlay.mjs';
import { providerReleaseContext } from '../lib/release-context.mjs';
import { readPrivateRuntimeConfig } from '../lib/runtime-config.mjs';
import { cleanBuildPayload } from './production-install.mjs';

export const PRIVATE_CONTENT_REPOSITORY = 'git@github.com:Pravos-LLC/vibrana-gtm-runtime-private.git';
// GitHub's published Ed25519 host key, pinned from https://api.github.com/meta.
export const GITHUB_KNOWN_HOST = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
const FILES = [...REQUIRED_CONTENT, 'manifest.json', 'runtime.json'].sort();
const MAX_COMPRESSED = 8 * 1024 * 1024, MAX_EXPANDED = 32 * 1024 * 1024, MAX_FILE = 5 * 1024 * 1024;
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
  delete child.PRIVATE_CONTENT_READ_TOKEN;
  delete child.SSH_AUTH_SOCK;
  delete child.GIT_SSH;
  delete child.GIT_SSH_COMMAND;
  return child;
}
export function artifactLocation(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
      !/^vibrana-gtm-runtime-private-[a-z0-9]{9}-johnellisons-projects\.vercel\.app$/.test(url.hostname) ||
      url.pathname !== '/bundle.json.gz' || url.href !== value) fail();
    return url.href;
  } catch { fail(); }
}
export function decodeContentArtifact(bytes, env) {
  if (!/^[a-f0-9]{64}$/.test(env.PRIVATE_CONTENT_BUNDLE_DIGEST ?? '') || bytes.length > MAX_COMPRESSED ||
    createHash('sha256').update(bytes).digest('hex') !== env.PRIVATE_CONTENT_BUNDLE_DIGEST) fail();
  try {
    const expanded = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
    const bundle = JSON.parse(expanded.toString('utf8'));
    if (!bundle || Array.isArray(bundle) || Object.keys(bundle).length !== 3 ||
      bundle.schemaVersion !== 1 || bundle.revision !== env.PRIVATE_CONTENT_REVISION ||
      !/^[a-f0-9]{40}$/.test(bundle.revision) || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) fail();
    const names = Object.keys(bundle.files).sort();
    if (names.length !== FILES.length || names.some((name, index) => name !== FILES[index])) fail();
    const files = {};
    for (const name of names) {
      const encoded = bundle.files[name];
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_FILE / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail();
      const data = Buffer.from(encoded, 'base64');
      if (!data.length || data.length > MAX_FILE || data.toString('base64') !== encoded) fail();
      JSON.parse(data.toString('utf8'));
      files[name] = data;
    }
    return files;
  } catch { fail(); }
}
export async function fetchContentArtifact(env, destination, fetcher = fetch) {
  const location = artifactLocation(env.PRIVATE_CONTENT_URL);
  if (typeof env.PRIVATE_CONTENT_READ_TOKEN !== 'string' || env.PRIVATE_CONTENT_READ_TOKEN.length < 16 ||
    env.PRIVATE_CONTENT_READ_TOKEN.length > 4096 || /[\r\n]/.test(env.PRIVATE_CONTENT_READ_TOKEN)) fail();
  const response = await fetcher(location, {
    redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { 'x-vercel-protection-bypass': env.PRIVATE_CONTENT_READ_TOKEN },
  });
  if (response.status !== 200 || !response.body || response.redirected) fail();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_COMPRESSED)) fail();
  const chunks = []; let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_COMPRESSED) fail();
      chunks.push(Buffer.from(chunk));
    }
  } catch { fail(); }
  const files = decodeContentArtifact(Buffer.concat(chunks, total), env);
  for (const [name, data] of Object.entries(files)) {
    const target = resolve(destination, name);
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
  }
}
export async function buildProduction(root = process.cwd(), env = process.env, run = execFileSync, fetcher = fetch) {
  const stamp = providerReleaseContext(env);
  const artifact = Boolean(env.PRIVATE_CONTENT_URL);
  if (!artifact && (env.PRIVATE_CONTENT_REPOSITORY !== PRIVATE_CONTENT_REPOSITORY ||
    typeof env.PRIVATE_CONTENT_SSH_KEY !== 'string' ||
    !env.PRIVATE_CONTENT_SSH_KEY.includes('-----BEGIN OPENSSH PRIVATE KEY-----'))) fail();
  cleanBuildPayload(root);
  const temporary = mkdtempSync(resolve(tmpdir(), 'private-production-content-'));
  chmodSync(temporary, 0o700);
  const repo = resolve(temporary, 'data');
  const key = resolve(temporary, 'deploy-key');
  const hosts = resolve(temporary, 'known_hosts');
  let complete = false;
  try {
    mkdirSync(repo, { mode: 0o700 });
    if (artifact) await fetchContentArtifact(env, repo, fetcher);
    else {
    writeFileSync(key, env.PRIVATE_CONTENT_SSH_KEY.trim() + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(hosts, GITHUB_KNOWN_HOST, { mode: 0o600, flag: 'wx' });
    const ssh = `ssh -F /dev/null -i '${key}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${hosts}' -o HostKeyAlgorithms=ssh-ed25519 -o LogLevel=ERROR`;
    const gitOptions = { cwd: repo, env: gitEnvironment(env, temporary, ssh), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000, maxBuffer: 1024 * 1024 };
    run('git', ['init', '--quiet'], gitOptions);
    run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', PRIVATE_CONTENT_REPOSITORY, stamp.privateRevision], gitOptions);
    const actual = run('git', ['rev-parse', 'FETCH_HEAD'], gitOptions).trim();
    if (actual !== stamp.privateRevision) fail();
    verifyDeliveryTree(run('git', ['ls-tree', '-r', 'FETCH_HEAD'], gitOptions));
    run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], gitOptions);
    }
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
  try { await buildProduction(); console.log('Production content and release binding validated'); }
  catch { console.error('Private production build failed'); process.exitCode = 1; }
}
