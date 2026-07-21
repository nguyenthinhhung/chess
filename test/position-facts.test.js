const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describePosition, parseBoard } = require('../ai/position-facts.js');

test('parseBoard maps FEN squares correctly (a1, e1, a8)', () => {
  const b = parseBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(b[0], 'R');   // a1
  assert.equal(b[4], 'K');   // e1
  assert.equal(b[56], 'r');  // a8
  assert.equal(b[60], 'k');  // e8
});

test('start position: equal, opening, kings in the center, no weaknesses', () => {
  const f = describePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(f.material.white, f.material.black);
  assert.equal(f.phase, 'opening');
  assert.equal(f.kings.white.side, 'center');
  assert.equal(f.kings.black.side, 'center');
  assert.deepEqual(f.openFiles, []);
  assert.deepEqual(f.pawns.white.isolated, []);
  assert.deepEqual(f.pawns.white.passed, []);
  assert.deepEqual(f.outposts.white, []);
});

test('detects an isolated queen pawn and the open c-file', () => {
  const f = describePosition('r1bqkb1r/pp3ppp/2n1pn2/8/3P4/2N2N2/PP3PPP/R1BQKB1R w KQkq - 0 1');
  assert.ok(f.pawns.white.isolated.includes('d4'));
  assert.ok(f.openFiles.includes('c'));
  assert.ok(f.halfOpen.white.includes('e')); // Black pawn on e6, none for White
  assert.ok(f.lines.some((l) => /isolated/.test(l)));
});

test('detects a passed pawn in an endgame', () => {
  const f = describePosition('k7/8/P7/8/8/8/8/K7 w - - 0 1');
  assert.equal(f.phase, 'endgame');
  assert.equal(f.material.white - f.material.black, 1);
  assert.ok(f.pawns.white.passed.includes('a6'));
});

test('reads opposite-side castling from the kings\' files', () => {
  const f = describePosition('r1bq1rk1/ppp2ppp/2n5/8/8/2N5/PPP2PPP/2KR3R w - - 0 1');
  assert.equal(f.kings.white.side, 'queenside'); // Kc1
  assert.equal(f.kings.black.side, 'kingside');  // Kg8
});

test('detects a pawn-protected outpost square', () => {
  const f = describePosition('4k3/8/8/4n3/3P1P2/8/8/4K3 w - - 0 1');
  assert.ok(f.outposts.white.includes('e5')); // defended by d4/f4, no Black c/e/g pawns to evict it
});

test('describePosition never throws on a sparse or odd FEN', () => {
  assert.doesNotThrow(() => describePosition('8/8/8/8/8/8/8/8 w - - 0 1'));
  assert.doesNotThrow(() => describePosition('just-garbage'));
  const f = describePosition('8/8/8/8/8/8/8/8 w - - 0 1');
  assert.equal(f.kings.white, null);
});
