const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, REPERTOIRE } = require('../coach.js');
const { createPosition, applySan } = require('../chesscore.js');

// Turn a SAN line into the UCI list analyze() expects.
function uci(sans) {
  const pos = createPosition();
  return sans.map((s) => {
    const u = applySan(pos, s);
    if (!u) throw new Error(`test wrote an illegal SAN: ${s}`);
    return u;
  });
}

test('repertoire integrity: every authored line is a legal sequence', () => {
  const walk = (nodes, pos, path) => {
    for (const node of nodes) {
      const clone = { board: pos.board.slice(), turn: pos.turn, castling: { ...pos.castling }, ep: pos.ep };
      const u = applySan(clone, node.m);
      assert.ok(u, `illegal move "${node.m}" after ${path.join(' ') || '(start)'}`);
      if (node.children) walk(node.children, clone, [...path, node.m]);
    }
  };
  for (const opening of REPERTOIRE) {
    walk(opening.tree, createPosition(), []);
  }
});

test('Italian: recommends c3 in the Giuoco Piano with White to move', () => {
  const r = analyze(uci(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']), { side: 'w' });
  assert.equal(r.openingId, 'italian');
  assert.equal(r.status, 'on-book');
  assert.equal(r.userToMove, true);
  assert.equal(r.recommended.san, 'c3');
});

test('Caro-Kann: recommends Bf5 after 4.Nxe4 with Black to move', () => {
  const r = analyze(uci(['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4']), { side: 'b' });
  assert.equal(r.openingId, 'caro-kann');
  assert.equal(r.status, 'on-book');
  assert.equal(r.userToMove, true);
  assert.equal(r.recommended.san, 'Bf5');
});

test('Caro-Kann: 2.Nc3 d5 3.d4 transposes into the shared Classical subtree', () => {
  const r = analyze(uci(['e4', 'c6', 'Nc3', 'd5', 'd4', 'dxe4', 'Nxe4']), { side: 'b' });
  assert.equal(r.openingId, 'caro-kann');
  assert.equal(r.recommended.san, 'Bf5');
});

test('flags the opponent leaving book', () => {
  // 3...a6 is not in our Italian tree.
  const r = analyze(uci(['e4', 'e5', 'Nf3', 'a6']), { side: 'w' });
  assert.equal(r.status, 'opp-left-book');
  assert.equal(r.off.side, 'b');
  const sans = r.bookMoves.map((m) => m.san);
  assert.deepEqual(sans, ['Nc6', 'Nf6', 'd6']);
});

test('flags the user leaving book and names the correct move', () => {
  // After 3...Bc5 the book move is 4.c3; play 4.d4 instead.
  const r = analyze(uci(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd4']), { side: 'w' });
  assert.equal(r.status, 'user-left-book');
  assert.equal(r.off.side, 'w');
  assert.deepEqual(r.bookMoves.map((m) => m.san), ['c3']);
});

test('empty game: coaches the very first move for the chosen side', () => {
  const w = analyze([], { side: 'w' });
  assert.equal(w.openingId, 'italian');
  assert.equal(w.recommended.san, 'e4');

  const b = analyze([], { side: 'b' });
  assert.equal(b.openingId, 'caro-kann');
  // Black is not to move yet on an empty board, so no single recommendation.
  assert.equal(b.userToMove, false);
});

test('openingId pins the trained opening regardless of the moves', () => {
  // Empty game, forced to Caro-Kann → Black side, waiting for White.
  const empty = analyze([], { openingId: 'caro-kann' });
  assert.equal(empty.openingId, 'caro-kann');
  assert.equal(empty.userSide, 'b');

  // Even on 1.e4 e5 (which matches the Italian deeper), pinning Caro keeps it.
  const r = analyze(uci(['e4', 'e5']), { openingId: 'caro-kann' });
  assert.equal(r.openingId, 'caro-kann');
});

test('recommended move carries a concrete UCI for board arrows', () => {
  const r = analyze(uci(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']), { side: 'w' });
  assert.equal(r.recommended.uci, 'c2c3');
});
