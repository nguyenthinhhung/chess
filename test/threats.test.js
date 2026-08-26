// The pure half of the "Threats only" display level: handing the move over
// (nullPosition) and deciding which of the opponent's replies are actually
// worth an alarm (describeThreats). The engine call between them lives in
// chess-coach.js; everything decided ABOUT its output is tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromFen, toFen } = require('../chesscore.js');
const { nullPosition, describeThreats } = require('../explain.js');

const cp = (v) => ({ type: 'cp', value: v });
const mate = (v) => ({ type: 'mate', value: v });

test('nullPosition hands the move to the other side and drops en passant', () => {
  const pos = fromFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const np = nullPosition(pos);
  assert.equal(np.turn, 'b');
  assert.equal(np.ep, -1);
  // Castling rights and the board itself are untouched.
  assert.deepEqual(np.castling, pos.castling);
  assert.equal(toFen(np).split(' ')[0], toFen(pos).split(' ')[0]);
  assert.equal(pos.turn, 'w', 'the source position must not be mutated');
});

test('nullPosition refuses when the side to move is in check', () => {
  // Black queen on h4 checks the white king through the opened f2 diagonal.
  const pos = fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 0 3');
  assert.equal(nullPosition(pos), null);
});

test('describeThreats keeps only swings past the alarm bar', () => {
  const pos = fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const lines = [
    { move: 'e7e5', score: cp(300) },  // costs us 3.20 from a +0.20 baseline → a threat
    { move: 'd7d5', score: cp(-10) }   // costs us 0.10 → tempo noise, not a threat
  ];
  const out = describeThreats(pos, lines, 20, { minCp: 150 });
  assert.equal(out.length, 1);
  assert.equal(out[0].san, 'e5');
  assert.equal(out[0].lossCp, 320);
});

test('describeThreats always reports mate, however small the nominal swing', () => {
  // Scholar's mate is on the board for Black: Qxf7#.
  const pos = fromFen('rnb1kbnr/pppp1ppp/8/4p3/2B1P2q/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1');
  const out = describeThreats(pos, [{ move: 'h4f2', score: mate(1) }], 0, { minCp: 150 });
  assert.equal(out.length, 1);
  assert.equal(out[0].mateIn, 1);
  assert.match(out[0].text, /mate in 1/);
});

test('describeThreats names the piece a threat takes, and the check it comes with', () => {
  // Black queen on h4 can take the f2 pawn, landing next to the white king.
  const pos = fromFen('rnb1kbnr/pppp1ppp/8/4p3/2B1P2q/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1');
  const out = describeThreats(pos, [{ move: 'h4f2', score: cp(400) }], 0, { minCp: 150 });
  assert.equal(out[0].san, 'Qxf2+');
  assert.match(out[0].text, /captures the pawn/);
  assert.match(out[0].text, /with check/);
});

test('describeThreats ranks mate above material and respects max', () => {
  const pos = fromFen('rnb1kbnr/pppp1ppp/8/4p3/2B1P2q/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1');
  const out = describeThreats(pos, [
    { move: 'h4e4', score: cp(500) },
    { move: 'h4f2', score: mate(1) },
    { move: 'h4h2', score: cp(400) }
  ], 0, { minCp: 150, max: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].mateIn, 1);
  assert.equal(out[1].san, 'Qxe4+');
});

test('describeThreats speaks the coach language', () => {
  const pos = fromFen('rnbqkb1r/pppp1ppp/8/4p3/6n1/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const out = describeThreats(pos, [{ move: 'g4f2', score: cp(400) }], 0, { minCp: 150, lang: 'vi' });
  assert.match(out[0].text, /ăn tốt/);
});

test('describeThreats survives unplayable or scoreless lines', () => {
  const pos = fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const out = describeThreats(pos, [
    { move: 'a3a4', score: cp(900) },  // no piece on a3 — cannot be replayed
    { move: 'e7e5' },                   // no score
    null
  ], 0, { minCp: 150 });
  assert.deepEqual(out, []);
});
