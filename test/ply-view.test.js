const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sliceToViewedPly } = require('../ply-view.js');

test('sliceToViewedPly: full list when not navigating (undefined/null ply)', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
  assert.deepEqual(sliceToViewedPly(sans, undefined), sans);
  assert.deepEqual(sliceToViewedPly(sans, null), sans);
});

test('sliceToViewedPly: slices to the viewed ply mid-scrub', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
  assert.deepEqual(sliceToViewedPly(sans, 1), ['e4']);
  assert.deepEqual(sliceToViewedPly(sans, 3), ['e4', 'e5', 'Nf3']);
});

test('sliceToViewedPly: ply 0 (starting position) yields an empty list', () => {
  assert.deepEqual(sliceToViewedPly(['e4', 'e5'], 0), []);
});

test('sliceToViewedPly: out-of-range ply falls back to the full list', () => {
  const sans = ['e4', 'e5'];
  assert.deepEqual(sliceToViewedPly(sans, 5), sans);
  assert.deepEqual(sliceToViewedPly(sans, -1), sans);
});

test('sliceToViewedPly: non-array input treated as empty', () => {
  assert.deepEqual(sliceToViewedPly(null, 2), []);
  assert.deepEqual(sliceToViewedPly(undefined, undefined), []);
});
