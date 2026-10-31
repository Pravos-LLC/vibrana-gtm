import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { contentMode, REQUIRED_CONTENT, validateOverlay, contentWritePath, writeContent } from '../lib/content-overlay.mjs';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'overlay-test-'));
 const files: Record<string,string> = {};
 for (const name of REQUIRED_CONTENT) {
  const b = readFileSync(join(process.cwd(), 'content/sample', name));
  mkdirSync(join(root, name.split('/')[0]), { recursive: true });
  writeFileSync(join(root, name), b); files[name] = hash(b);
 }
 const manifest = JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(40), files });
 writeFileSync(join(root,'manifest.json'),manifest);
 return { root, env: { CONTENT_MODE: 'private', PRIVATE_OVERLAY_ROOT: root, PRIVATE_OVERLAY_REVISION: 'a'.repeat(40), PRIVATE_OVERLAY_DIGEST: hash(manifest) } };
}
test('private mode requires complete pinned immutable snapshot; tampering fails before reads', () => {
 const f = fixture();
 try {
  assert.equal(validateOverlay(f.env).mode,'private');
  writeFileSync(join(f.root, REQUIRED_CONTENT[0]), '{}');
  assert.throws(() => validateOverlay(f.env), /validation failed/);
 } finally { rmSync(f.root, {recursive:true,force:true}); }
});
test('sample mode ignores linked private data and tests always force samples', () => {
 assert.equal(contentMode({ CONTENT_MODE:'private', NODE_TEST_CONTEXT:'child-v8' }),'sample');
 assert.equal(contentMode({ CONTENT_MODE:'private', DEMO_MODE:'1' }),'sample');
 assert.equal(validateOverlay({}).mode,'sample');
 assert.throws(() => contentMode({CONTENT_MODE:'private', VERCEL_ENV:'preview'}));
});
test('production is bound to canonical repository and exact protected release revision', () => {
 assert.throws(() => contentMode({VERCEL_ENV:'production',VERCEL_GIT_REPO_OWNER:'Pravos-LLC',VERCEL_GIT_REPO_SLUG:'vibrana-gtm'}));
 assert.equal(contentMode({VERCEL_ENV:'production'}),'sample');
 assert.throws(() => contentMode({VERCEL_ENV:'production',CONTENT_MODE:'private',VERCEL_GIT_REPO_OWNER:'fork'}));
});
test('schema and revision and manifest digest are validated', () => {
 const f=fixture();
 try {
  assert.throws(() => validateOverlay({...f.env,PRIVATE_OVERLAY_DIGEST:'b'.repeat(64)}));
  assert.throws(() => validateOverlay({...f.env,PRIVATE_OVERLAY_REVISION:'b'.repeat(40)}));
  rmSync(join(f.root,REQUIRED_CONTENT[1]));
  assert.throws(() => validateOverlay(f.env));
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('overlay files cannot escape through symlinks, and incomplete JSON shape fails', () => {
 const f=fixture();
 const outside=mkdtempSync(join(tmpdir(),'overlay-outside-'));
 try {
  const name=REQUIRED_CONTENT[0];
  const original=readFileSync(join(f.root,name));
  writeFileSync(join(outside,'data.json'),original);
  rmSync(join(f.root,name));
  symlinkSync(join(outside,'data.json'),join(f.root,name));
  assert.throws(() => validateOverlay(f.env));
  rmSync(join(f.root,name)); writeFileSync(join(f.root,name),'{}');
  const manifest=JSON.parse(readFileSync(join(f.root,'manifest.json'),'utf8'));
  manifest.files[name]=hash('{}');
  const bytes=JSON.stringify(manifest);writeFileSync(join(f.root,'manifest.json'),bytes);
  assert.throws(() => validateOverlay({...f.env,PRIVATE_OVERLAY_DIGEST:hash(bytes)}));
 } finally {rmSync(f.root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('build materialization survives an absent external root and sample builds remove prior payload/cache', async () => {
 const snapshot=fixture();
 const repo=mkdtempSync(join(tmpdir(),'overlay-build-repo-'));
 try {
  mkdirSync(join(repo,'lib'));mkdirSync(join(repo,'content'));
  cpSync(join(process.cwd(),'lib/content-overlay.mjs'),join(repo,'lib/content-overlay.mjs'));
  cpSync(join(process.cwd(),'lib/release-context.mjs'),join(repo,'lib/release-context.mjs'));
  cpSync(join(process.cwd(),'content/sample'),join(repo,'content/sample'),{recursive:true});
  const loader=await import(pathToFileURL(join(repo,'lib/content-overlay.mjs')).href);
  loader.prepareContentBuild(snapshot.env);
  assert.ok(readFileSync(join(repo,'.content-runtime/manifest.json')));
  rmSync(snapshot.root,{recursive:true,force:true});
  assert.equal(loader.validateOverlay(snapshot.env).mode,'private');
  mkdirSync(join(repo,'.next'),{recursive:true});writeFileSync(join(repo,'.next','stale'),'private');
  loader.prepareContentBuild({CONTENT_MODE:'sample'});
  assert.throws(() => readFileSync(join(repo,'.content-runtime/manifest.json')));
  assert.throws(() => readFileSync(join(repo,'.next/stale')));
 } finally {rmSync(snapshot.root,{recursive:true,force:true});rmSync(repo,{recursive:true,force:true});}
});
test('canonical production refuses test/demo bypasses even with an otherwise pinned release', () => {
 const env={CONTENT_MODE:'private',VERCEL_ENV:'production',VERCEL_GIT_PROVIDER:'github',VERCEL_PROJECT_ID:'prj_7pEB6cPxDSB77W1UF2sFcl2EmCRt',VERCEL_GIT_REPO_OWNER:'Pravos-LLC',VERCEL_GIT_REPO_SLUG:'vibrana-gtm',VERCEL_GIT_REPO_ID:'1440425392',VERCEL_GIT_COMMIT_REF:'main',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),VERCEL_DEPLOYMENT_ID:'dpl_example',PRIVATE_CONTENT_REVISION:'b'.repeat(40),PRIVATE_OVERLAY_DIGEST:'c'.repeat(64),PRIVATE_RUNTIME_DIGEST:'d'.repeat(64)};
 assert.equal(contentMode(env),'private');
 assert.throws(() => contentMode({...env,DEMO_MODE:'1'}));
 assert.throws(() => contentMode({...env,NODE_ENV:'test'}));
 assert.throws(() => contentMode({...env,NODE_TEST_CONTEXT:'child-v8'}));
});

test('private writers reject target symlinks and atomically replace regular output files', () => {
 const out=mkdtempSync(join(tmpdir(),'overlay-write-'));
 const external=mkdtempSync(join(tmpdir(),'overlay-immutable-'));
 const prior=process.env.CONTENT_WRITE_ROOT;
 try {
  process.env.CONTENT_WRITE_ROOT=out;
  mkdirSync(join(out,'guide'));
  const target=join(external,'protected.json');writeFileSync(target,'original');
  symlinkSync(target,join(out,'guide/media.json'));
  assert.throws(() => contentWritePath('guide/media.json'));
  assert.throws(() => writeContent('guide/media.json','changed'));
  assert.equal(readFileSync(target,'utf8'),'original');
  rmSync(join(out,'guide/media.json'));
  writeContent('guide/media.json','synthetic output');
  assert.equal(readFileSync(join(out,'guide/media.json'),'utf8'),'synthetic output');
 } finally {
  if(prior===undefined)delete process.env.CONTENT_WRITE_ROOT;else process.env.CONTENT_WRITE_ROOT=prior;
  rmSync(out,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});
 }
});

test('trait records accept independent private IDs and reject malformed values', () => {
 const f=fixture();
 const update=(pieces: unknown) => {
  const name='config/piece-traits.json';
  const data=JSON.stringify({pieces});writeFileSync(join(f.root,name),data);
  const manifest=JSON.parse(readFileSync(join(f.root,'manifest.json'),'utf8'));manifest.files[name]=hash(data);
  const bytes=JSON.stringify(manifest);writeFileSync(join(f.root,'manifest.json'),bytes);
  return {...f.env,PRIVATE_OVERLAY_DIGEST:hash(bytes)};
 };
 try {
  assert.equal(validateOverlay(update({'independent-private-record':{look:'voiceover',topic:'independent-topic'}})).mode,'private');
  assert.throws(()=>validateOverlay(update({'independent-private-record':{look:42}})));
  assert.throws(()=>validateOverlay(update({'independent-private-record':{topic:['invalid']}})));
  assert.throws(()=>validateOverlay(update({'independent-private-record':{look:'unknown'}})));
  assert.throws(()=>validateOverlay(update({'independent-private-record':{lanes:'invalid'}})));
  assert.throws(()=>validateOverlay(update({'../escaped':{topic:'example'}})));
 } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('all bundled campaign identifiers are synthetic', () => {
 const traits=JSON.parse(readFileSync('content/sample/config/piece-traits.json','utf8'));
 for(const key of Object.keys(traits.pieces))assert.match(key,/^(s1-\d{2}-sample-piece-\d{2}(?:-document)?|sample-extra-\d+)$/);
 const season=JSON.parse(readFileSync('content/sample/config/season1.json','utf8'));
 for(const [index,piece] of season.pieces.entries()) {
  assert.equal(piece.slug,`sample-piece-${String(index+1).padStart(2,'0')}`);
  assert.equal(piece.n,index+1);
 }
});
