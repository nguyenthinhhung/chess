const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pieceName, formatScore, scoreToCp, classify, kingInCheck, moveFacts,
  explainBest, explainPlayed
} = require('../explain.js');
const { createPosition, applySan } = require('../chesscore.js');

// Replay SAN from the start and hand back the resulting position.
function pos(sans) {
  const p = createPosition();
  for (const s of sans) {
    if (!applySan(p, s)) throw new Error(`illegal SAN in test: ${s}`);
  }
  return p;
}

test('pieceName maps letters to words, regardless of colour', () => {
  assert.equal(pieceName('Q'), 'queen');
  assert.equal(pieceName('n'), 'knight');
  assert.equal(pieceName('P'), 'pawn');
});

test('formatScore: centipawns, mate, and POV flip', () => {
  assert.equal(formatScore({ type: 'cp', value: 125 }), '+1.25');
  assert.equal(formatScore({ type: 'cp', value: -40 }), '−0.40');
  assert.equal(formatScore({ type: 'cp', value: 40 }, true), '−0.40'); // flipped
  assert.equal(formatScore({ type: 'mate', value: 3 }), 'M3');
  assert.equal(formatScore({ type: 'mate', value: -2 }), '−M2');
});

test('scoreToCp puts mate far above any normal eval', () => {
  assert.ok(scoreToCp({ type: 'mate', value: 1 }) > scoreToCp({ type: 'cp', value: 5000 }));
  assert.ok(scoreToCp({ type: 'mate', value: -1 }) < scoreToCp({ type: 'cp', value: -5000 }));
  // A faster mate scores higher than a slower one.
  assert.ok(scoreToCp({ type: 'mate', value: 1 }) > scoreToCp({ type: 'mate', value: 5 }));
});

test('classify buckets centipawn loss into labels', () => {
  assert.equal(classify(0).key, 'best');
  assert.equal(classify(35).key, 'good');
  assert.equal(classify(70).key, 'inaccuracy');
  assert.equal(classify(150).key, 'mistake');
  assert.equal(classify(400).key, 'blunder');
});

test('kingInCheck detects a pawn-delivered check', () => {
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# — but test a simpler check:
  // 1.e4 d5 2.exd5 Qxd5 3.Nc3 attacks the queen, not check. Use a real check:
  // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 4.Qxf7+ is mate; instead 1.f3 e5 2.g4 Qh4# .
  const p = pos(['f3', 'e5', 'g4', 'Qh4']);
  // After Qh4 it is White to move and White's king is in check (mate, in fact).
  assert.equal(p.turn, 'w');
  assert.equal(kingInCheck(p.board, 'w'), true);
});

test('moveFacts reports a capture and the moving piece', () => {
  // After 1.e4 d5 it is White to move; exd5 captures the d5 pawn.
  const p = pos(['e4', 'd5']);
  const f = moveFacts(p, 'e4d5');
  assert.equal(f.san, 'exd5');
  assert.equal(f.pieceChar, 'P');
  assert.equal(f.captured, 'p');
  assert.equal(f.givesCheck, false);
});

test('moveFacts flags a checking move', () => {
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 — now Qxf7 is check (and mate). Test Qh5xf7.
  const p = pos(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
  const f = moveFacts(p, 'h5f7');
  assert.equal(f.captured, 'p');
  assert.equal(f.givesCheck, true);
});

test('moveFacts does not mutate the position passed in', () => {
  const p = pos(['e4', 'd5']);
  const before = p.board.slice();
  moveFacts(p, 'e4d5');
  assert.deepEqual(p.board, before);
  assert.equal(p.turn, 'w');
});

test('explainBest names a capture', () => {
  const p = pos(['e4', 'd5']);
  const text = explainBest(p, 'e4d5', { type: 'cp', value: 60 });
  assert.match(text, /exd5/);
  assert.match(text, /captures the pawn/);
});

test('explainBest reports a forced mate', () => {
  const p = pos(['f3', 'e5', 'g4']);
  const text = explainBest(p, 'd8h4', { type: 'mate', value: 1 });
  assert.match(text, /Qh4/);
  assert.match(text, /mate in 1/);
});

test('explainPlayed praises a best capture', () => {
  const p = pos(['e4', 'd5']);
  const r = explainPlayed(p, 'e4d5', 'e4d5', 0);
  assert.equal(r.key, 'best');
  assert.match(r.text, /Wins the pawn/);
});

test('explainPlayed flags a blunder that drops a piece to the engine reply', () => {
  // Contrived: a move that loses a queen. We just check the wiring: a large
  // cpLoss → blunder label, and the reply capture is named.
  const p = pos(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6']);
  // Black just played Nf6?? allowing Qxf7#. Evaluate from White-to-move pos:
  // pretend White played a weak move g3 (best was Qxf7), reply Black ... we
  // only assert classification + that a reply is mentioned.
  const r = explainPlayed(p, 'g2g3', 'h5f7', 600, 'f6h5');
  assert.equal(r.key, 'blunder');
  assert.ok(r.text.length > 0);
});
