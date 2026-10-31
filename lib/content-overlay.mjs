// Server/CLI content boundary. Never import this module from a client component.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, existsSync, lstatSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProduction, providerReleaseContext, validateReleaseStamp } from './release-context.mjs';

const REPO = process.env.NEXT_RUNTIME ? process.cwd() : resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_CONTENT = Object.freeze([
  'guide/assets.json', 'guide/audience-calibration.json', 'guide/channels.json',
  'guide/inspiration.json', 'guide/media.json', 'guide/personal.json', 'guide/phase.json',
  'guide/pillars.json', 'guide/pipeline.json', 'guide/playbook-taxonomy.json',
  'guide/redflags.json', 'guide/regenera.json', 'guide/signals.json', 'guide/stories.json',
  'guide/voice.json', 'guide/why.json', 'engage/reply-voice.json',
  'config/season1.json', 'config/piece-traits.json',
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
function fail() { throw new Error('Content overlay validation failed; verify mode, root, revision, manifest and required files'); }
export function contentMode(env = process.env) {
  const requested = env.CONTENT_MODE ?? 'sample';
  if (!['sample', 'private'].includes(requested)) fail();
  if (canonicalProduction(env)) {
    try { providerReleaseContext(env); } catch { fail(); }
    return 'private';
  }
  if (env.VERCEL_ENV && requested === 'private') fail();
  // Tests and demos cannot read private data even when a snapshot is linked locally.
  if (env.NODE_TEST_CONTEXT || env.NODE_ENV === 'test' || env.DEMO_MODE === '1') return 'sample';
  return requested;
}

function shape(value, sample) {
  if (sample === null) return;
  if (Array.isArray(sample)) {
    if (!Array.isArray(value)) fail();
    if (!sample.length) return;
    const kinds = new Set(sample.map(x => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x));
    for (const item of value) {
      const kind = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
      if (!kinds.has(kind)) fail();
      if (kind === 'object') {
        const examples = sample.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x));
        if (!examples.some(example => { try { shape(item, example); return true; } catch { return false; } })) fail();
      }
    }
    return;
  }
  if (typeof value !== typeof sample || value === null) fail();
  if (typeof sample === 'object') {
    for (const [key, item] of Object.entries(sample)) {
      if (!(key in value)) fail();
      shape(value[key], item);
    }
  }
}
function readOverlay(env = process.env, preparing = false) {
  if (contentMode(env) === 'sample') return { mode: 'sample', root: resolve(REPO, 'content/sample'), revision: 'sample-v1' };
  try {
    if (canonicalProduction(env) && !preparing) validateReleaseStamp(REPO, env);
    const supplied = env.PRIVATE_OVERLAY_ROOT;
    const runtime = resolve(REPO, '.content-runtime');
    const materialized = !supplied || !existsSync(supplied);
    if (!materialized && !isAbsolute(supplied)) fail();
    const root = realpathSync(materialized ? runtime : supplied);
    if (within(realpathSync(REPO), root) && (!materialized || root !== runtime)) fail();
    const bytes = readFileSync(resolve(root, 'manifest.json'));
    if (!/^[a-f0-9]{64}$/.test(env.PRIVATE_OVERLAY_DIGEST ?? '') || sha(bytes) !== env.PRIVATE_OVERLAY_DIGEST) fail();
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.revision ?? '') || manifest.revision !== env.PRIVATE_OVERLAY_REVISION || !manifest.files || typeof manifest.files !== 'object') fail();
    for (const key of Object.keys(manifest.files)) {
      if (!REQUIRED_CONTENT.includes(key)) fail();
    }
    // Check the entire immutable snapshot before serving any one member. No mutable cache.
    const content = {};
    const raw = {};
    for (const name of REQUIRED_CONTENT) {
      const path = realpathSync(resolve(root, name));
      if (!within(root, path) || !statSync(path).isFile() || !/^[a-f0-9]{64}$/.test(manifest.files[name] ?? '')) fail();
      if (statSync(path).size > 5 * 1024 * 1024) fail();
      const data = readFileSync(path);
      if (sha(data) !== manifest.files[name]) fail();
      const parsed = JSON.parse(data.toString('utf8'));
      if (name === 'config/piece-traits.json') {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.pieces || typeof parsed.pieces !== 'object' || Array.isArray(parsed.pieces)) fail();
        if (Object.keys(parsed).some(key => !['$comment', 'pieces'].includes(key))) fail();
        if ('$comment' in parsed && typeof parsed.$comment !== 'string') fail();
        for (const [id, trait] of Object.entries(parsed.pieces)) {
          if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) || !trait || typeof trait !== 'object' || Array.isArray(trait)) fail();
          if (('topic' in trait && (typeof trait.topic !== 'string' || !trait.topic)) || !Object.keys(trait).length || Object.keys(trait).some(key => !['look', 'topic', 'lanes'].includes(key))) fail();
          if ('look' in trait && !['prism', 'voiceover', 'talking-head', 'footage', 'text'].includes(trait.look)) fail();
          if ('lanes' in trait && (!Array.isArray(trait.lanes) || trait.lanes.some(lane => typeof lane !== 'string'))) fail();
        }
      } else shape(parsed, JSON.parse(readFileSync(resolve(REPO, 'content/sample', name), 'utf8')));
      content[name] = parsed;
      raw[name] = data;
    }
    return { mode: 'private', root, revision: manifest.revision, content, raw, manifestBytes: bytes };
  } catch { fail(); }
}
export function validateOverlay(env = process.env) { return readOverlay(env); }
export function loadContent(name) {
  if (typeof window !== 'undefined' || !REQUIRED_CONTENT.includes(name)) fail();
  const overlay = validateOverlay();
  return overlay.mode === 'private' ? overlay.content[name] : JSON.parse(readFileSync(resolve(overlay.root, name), 'utf8'));
}
// Writers receive an explicit output location; immutable overlay snapshots are never mutated.
export function contentWritePath(name) {
  if (!REQUIRED_CONTENT.includes(name) || !process.env.CONTENT_WRITE_ROOT || !isAbsolute(process.env.CONTENT_WRITE_ROOT)) fail();
  const out = realpathSync(process.env.CONTENT_WRITE_ROOT);
  if (within(realpathSync(REPO), out) || out === validateOverlay().root) fail();
  if (process.env.PRIVATE_OVERLAY_ROOT) {
    const immutable = realpathSync(process.env.PRIVATE_OVERLAY_ROOT);
    if (within(immutable, out) || within(out, immutable)) fail();
  }
  const target = resolve(out, name);
  if (!within(out, realpathSync(dirname(target)))) fail();
  let targetStat;
  try { targetStat = lstatSync(target); } catch (error) { if (error.code !== "ENOENT") fail(); }
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile() || !within(out, realpathSync(target)))) fail();
  return target;
}

/** Build-only materialization; copies the bytes already validated, never a second mutable read. */
export function prepareContentBuild(env = process.env) {
  const mode = contentMode(env);
  const destination = resolve(REPO, '.content-runtime');
  // Every build starts without prior content artifacts or cache from another trust mode.
  rmSync(destination, { recursive: true, force: true });
  rmSync(resolve(REPO, '.next'), { recursive: true, force: true });
  if (mode === 'sample') return { mode };
  // A build must start from an explicit external snapshot; runtime fallback cannot prepare itself.
  if (!env.PRIVATE_OVERLAY_ROOT || !isAbsolute(env.PRIVATE_OVERLAY_ROOT) || !existsSync(env.PRIVATE_OVERLAY_ROOT)) fail();
  const snapshot = readOverlay(env, true);
  const temporary = mkdtempSync(resolve(REPO, '.content-runtime-'));
  try {
    for (const [name, bytes] of Object.entries(snapshot.raw)) {
      mkdirSync(dirname(resolve(temporary, name)), { recursive: true, mode: 0o700 });
      writeFileSync(resolve(temporary, name), bytes, { mode: 0o600 });
    }
    writeFileSync(resolve(temporary, 'manifest.json'), snapshot.manifestBytes, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return { mode, revision: snapshot.revision };
}

/** Atomic replacement never follows a destination symlink, including one raced after validation. */
export function writeContent(name, data) {
  const destination = contentWritePath(name);
  const parent = dirname(destination);
  const temp = mkdtempSync(resolve(parent, '.content-write-'));
  try {
    const file = resolve(temp, 'data.json');
    writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
    renameSync(file, destination);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
