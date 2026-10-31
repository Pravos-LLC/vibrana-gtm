import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadRuntimeConfig, readPrivateRuntimeConfig, validateRuntimeConfig } from '../lib/runtime-config.mjs';
import { PRODUCTION_IDENTITY, providerReleaseContext, validateReleaseStamp } from '../lib/release-context.mjs';
import { REQUIRED_CONTENT } from '../lib/content-overlay.mjs';
// JavaScript entry points are tested through dynamic imports to preserve their executable form.
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sample = () => JSON.parse(readFileSync('config/runtime.sample.json', 'utf8'));
function productionEnv() {
  return {
    CONTENT_MODE: 'private', VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github', NODE_ENV: 'production',
    VERCEL_PROJECT_ID: PRODUCTION_IDENTITY.projectId,
    VERCEL_GIT_REPO_OWNER: PRODUCTION_IDENTITY.repoOwner, VERCEL_GIT_REPO_SLUG: PRODUCTION_IDENTITY.repoSlug,
    VERCEL_GIT_REPO_ID: PRODUCTION_IDENTITY.repoId, VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), VERCEL_DEPLOYMENT_ID: 'dpl_synthetic',
    PRIVATE_CONTENT_REVISION: 'b'.repeat(40), PRIVATE_OVERLAY_REVISION: 'c'.repeat(40),
    PRIVATE_OVERLAY_DIGEST: 'd'.repeat(64), PRIVATE_RUNTIME_DIGEST: 'e'.repeat(64),
    PRIVATE_CONTENT_REPOSITORY: 'git@github.com:Pravos-LLC/vibrana-gtm-runtime-private.git',
    PRIVATE_CONTENT_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC FIXTURE ONLY\n-----END OPENSSH PRIVATE KEY-----',
    PATH: process.env.PATH,
  };
}
test('runtime schema accepts independent private identifiers and rejects unsafe or extra fields', () => {
  const value = sample();
  value.publications = { independent: { label: 'Fixture Publication', url: 'https://fixture.example.test' } };
  value.publicationChannels = { 'personal-substack': 'independent' };
  value.calendar.accounts.linkedin = 'independent-account';
  assert.equal(validateRuntimeConfig(value).calendar.accounts.linkedin, 'independent-account');
  assert.throws(() => validateRuntimeConfig({ ...value, executable: 'unreviewed.js' }));
  assert.throws(() => validateRuntimeConfig({ ...value, brand: { ...value.brand, websiteUrl: 'javascript:alert(1)' } }));
  assert.throws(() => validateRuntimeConfig({ ...value, publicationChannels: { invalid: 'missing' } }));
  assert.throws(() => validateRuntimeConfig({ ...value, mail: { ...value.mail, from: 'test@example.test\r\nBcc: other@example.test' } }));
  assert.throws(() => validateRuntimeConfig({ ...value, candidates: { ...value.candidates, script: true } }));
  for (const font of ['../private.json', '/etc/passwd', 'subdir/font.woff2', '..\\private.woff2', 'font.woff2\n']) {
    const invalid = structuredClone(value); const profile = Object.values(invalid.packaging.profiles)[0] as { fonts: string[] };
    profile.fonts[0] = font; assert.throws(() => validateRuntimeConfig(invalid));
  }
  const css = structuredClone(value); const profile = Object.values(css.packaging.profiles)[0] as { display: string };
  profile.display = 'Fixture";}body{background:red}'; assert.throws(() => validateRuntimeConfig(css));
});
test('sample, tests and previews cannot load a private runtime config', () => {
  assert.equal(loadRuntimeConfig({ CONTENT_MODE: 'private', NODE_ENV: 'test', PRIVATE_OVERLAY_ROOT: '/nonexistent' }).schemaVersion, 1);
  assert.throws(() => loadRuntimeConfig({ CONTENT_MODE: 'private', VERCEL_ENV: 'preview' }));
  assert.throws(() => loadRuntimeConfig(productionEnv()));
});
test('private runtime config is digest pinned and bounded before parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-pinned-'));
  try {
    const bytes = JSON.stringify(sample()); writeFileSync(join(root, 'runtime.json'), bytes);
    const env = { PRIVATE_RUNTIME_DIGEST: digest(bytes) };
    assert.equal(readPrivateRuntimeConfig(root, env).config.schemaVersion, 1);
    assert.throws(() => readPrivateRuntimeConfig(root, { PRIVATE_RUNTIME_DIGEST: '0'.repeat(64) }));
    writeFileSync(join(root, 'runtime.json'), bytes + ' ');
    assert.throws(() => readPrivateRuntimeConfig(root, env));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('release stamp binds actual provider deployment and independent immutable data pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-stamp-'));
  try {
    const env = productionEnv(); mkdirSync(join(root, '.content-runtime'));
    writeFileSync(join(root, '.content-runtime/release.json'), JSON.stringify(providerReleaseContext(env)));
    assert.equal(validateReleaseStamp(root, env).gitCommitSha, env.VERCEL_GIT_COMMIT_SHA);
    for (const key of ['VERCEL_GIT_PROVIDER', 'VERCEL_PROJECT_ID', 'VERCEL_GIT_REPO_ID', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_DEPLOYMENT_ID', 'PRIVATE_RUNTIME_DIGEST', 'PRIVATE_CONTENT_REVISION'] as const) {
      assert.throws(() => validateReleaseStamp(root, { ...env, [key]: 'wrong' }));
    }
    assert.throws(() => providerReleaseContext({ ...env, VERCEL_ENV: 'preview' }));
    assert.throws(() => providerReleaseContext({ ...env, PRIVATE_RELEASE_SHA: 'f'.repeat(40) }));
    const future = { ...env, VERCEL_GIT_COMMIT_SHA: 'f'.repeat(40), VERCEL_DEPLOYMENT_ID: 'dpl_future' };
    // A newly trusted protected-main deployment stamps its actual new SHA without changing data pins.
    writeFileSync(join(root, '.content-runtime/release.json'), JSON.stringify(providerReleaseContext(future)));
    assert.equal(validateReleaseStamp(root, future).privateRevision, env.PRIVATE_CONTENT_REVISION);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('dependency installation removes restored private caches and scrubs credentials before hooks', async () => {
  const entry = await import(pathToFileURL(join(process.cwd(), 'scripts/production-install.mjs')).href);
  const root = mkdtempSync(join(tmpdir(), 'install-scrub-')); let childHome = '';
  try {
    for (const name of ['.next', '.content-runtime', '.content-runtime-stale']) mkdirSync(join(root, name));
    entry.installProductionDependencies(root, { PATH: process.env.PATH, PRIVATE_CONTENT_SSH_KEY: 'fixture-secret', SUPABASE_SECRET_KEY: 'fixture-secret', NODE_OPTIONS: '--require=bad', HOME: '/private/home' }, (_bin: string, args: string[], options: { env: Record<string, string> }) => {
      assert.deepEqual(args, ['install', '--frozen-lockfile', '--prod=false', '--ignore-scripts']);
      for (const name of ['.next', '.content-runtime', '.content-runtime-stale']) assert.equal(existsSync(join(root, name)), false);
      assert.equal(options.env.PRIVATE_CONTENT_SSH_KEY, undefined); assert.equal(options.env.SUPABASE_SECRET_KEY, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
      childHome = options.env.HOME; assert.notEqual(childHome, '/private/home'); assert.equal(existsSync(childHome), true);
    });
    assert.equal(existsSync(childHome), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('production bootstrap validates immutable delivery and cleans fetching key before Next and all temp data after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'production-bootstrap-'));
  try {
    for (const dir of ['lib', 'scripts', 'config', 'content']) mkdirSync(join(root, dir));
    for (const name of ['content-overlay.mjs', 'release-context.mjs', 'runtime-config.mjs']) cpSync(join('lib', name), join(root, 'lib', name));
    for (const name of ['production-build.mjs', 'production-install.mjs']) cpSync(join('scripts', name), join(root, 'scripts', name));
    cpSync('config/runtime.sample.json', join(root, 'config/runtime.sample.json'));
    cpSync('content/sample', join(root, 'content/sample'), { recursive: true });
    const entry = await import(pathToFileURL(join(root, 'scripts/production-build.mjs')).href);
    const runtime = await import(pathToFileURL(join(root, 'lib/runtime-config.mjs')).href);
    const overlay = await import(pathToFileURL(join(root, 'lib/content-overlay.mjs')).href);
    const env = productionEnv(); const runtimeBytes = JSON.stringify(sample());
    env.PRIVATE_RUNTIME_DIGEST = digest(runtimeBytes);
    const files = Object.fromEntries(REQUIRED_CONTENT.map(name => [name, digest(readFileSync(join('content/sample', name)))]));
    const manifest = JSON.stringify({ schemaVersion: 1, revision: env.PRIVATE_OVERLAY_REVISION, files }); env.PRIVATE_OVERLAY_DIGEST = digest(manifest);
    let temporary = ''; let nextRan = false;
    const run = (bin: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      if (bin === 'pnpm') {
        assert.deepEqual(args, ['exec', 'next', 'build']); assert.equal(options.env.PRIVATE_CONTENT_SSH_KEY, undefined);
        assert.equal(existsSync(join(temporary, 'deploy-key')), false);
        assert.equal(runtime.loadRuntimeConfig(options.env).schemaVersion, 1); assert.equal(overlay.validateOverlay(options.env).mode, 'private');
        nextRan = true; return '';
      }
      temporary = dirname(options.cwd);
      assert.equal(options.env.PRIVATE_CONTENT_SSH_KEY, undefined); assert.equal(options.env.SUPABASE_SECRET_KEY, undefined);
      if (args[0] === 'rev-parse') return env.PRIVATE_CONTENT_REVISION + '\n';
      if (args[0] === 'ls-tree') return [...REQUIRED_CONTENT, 'manifest.json', 'runtime.json'].map(name => `100644 blob ${'f'.repeat(40)}\t${name}`).join('\n') + '\n';
      if (args.includes('checkout')) {
        for (const name of REQUIRED_CONTENT) { mkdirSync(dirname(join(options.cwd, name)), { recursive: true }); cpSync(join('content/sample', name), join(options.cwd, name)); }
        writeFileSync(join(options.cwd, 'manifest.json'), manifest); writeFileSync(join(options.cwd, 'runtime.json'), runtimeBytes);
      }
      return '';
    };
    entry.buildProduction(root, env, run);
    assert.equal(nextRan, true); assert.equal(existsSync(temporary), false);
    assert.equal(runtime.loadRuntimeConfig(env).schemaVersion, 1); assert.equal(overlay.validateOverlay(env).mode, 'private');
    assert.throws(() => entry.verifyDeliveryTree('120000 blob ' + 'f'.repeat(40) + '\toutside\n'));
    assert.throws(() => entry.buildProduction(root, { ...env, VERCEL_GIT_COMMIT_REF: 'feature' }, run));
    assert.throws(() => entry.buildProduction(root, env, () => { throw Error('fixture private command failure'); }), /^Error: Private production build failed$/);
    assert.equal(existsSync(join(root, '.content-runtime')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
