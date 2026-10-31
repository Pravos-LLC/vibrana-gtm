import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('the actual writing-desk browser harness bundles without server runtime data modules', async () => {
  const result = await build({
    entryPoints: ['test/support/desk-angle-harness.tsx'], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic', metafile: true, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { 'next/link': resolve('test/support/desk-link.tsx') },
  });
  assert.ok(result.outputFiles[0].text.length > 0);
  for (const path of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(path, /(?:runtime-config|content-overlay|release-context|offers-server)\.[mt]?[js]+$/);
  }
});
