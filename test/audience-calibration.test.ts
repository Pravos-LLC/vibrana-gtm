// Public tests validate synthetic calibration, never a person's historical replies or backtests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../lib/content-overlay.mjs';
import { audienceRubric } from '../lib/signals/audience';
test('sample calibration has valid scoring fields and no private source paths', () => {
 const cal=loadContent('guide/audience-calibration.json');
 const result=audienceRubric();
 assert.ok(result.reader && result.question && result.rubric);
 assert.ok(result.min_audience_fit !== null && result.min_audience_fit > 0 && result.min_audience_fit < 1);
 for (const e of cal.examples) {
  assert.ok(typeof e.text === 'string' && e.text.length > 0);
  assert.ok(e.audience_fit >= 0 && e.audience_fit <= 1);
 }
 assert.equal(result.examples.length,Math.min(12,cal.examples.length));
});
