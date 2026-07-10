const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPosition, applySan, applyUci, toFen, fromFen, replay } = require('../chesscore.js');

test('applySan: Italian opening yields the right UCI + turn flips', () => {
  const pos = createPosition();
  assert.equal(applySan(pos, 'e4'), 'e2e4');
  assert.equal(pos.turn, 'b');
  assert.equal(applySan(pos, 'e5'), 'e7e5');
  assert.equal(applySan(pos, 'Nf3'), 'g1f3');
  assert.equal(applySan(pos, 'Nc6'), 'b8c6');
  assert.equal(applySan(pos, 'Bc4'), 'f1c4');
});

test('applySan: pawn double push sets the en-passant target', () => {
  const pos = createPosition();
  applySan(pos, 'e4');
  assert.equal(toFen(pos).split(' ')[3], 'e3');
  applySan(pos, 'c5');
  assert.equal(toFen(pos).split(' ')[3], 'c6');
  applySan(pos, 'Nf3');
  assert.equal(toFen(pos).split(' ')[3], '-');
});

test('applySan: castling moves the rook and drops the rights', () => {
  const pos = replay(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
  assert.equal(applySan(pos, 'O-O'), 'e1g1');
  const [board, , rights] = toFen(pos).split(' ');
  // Rank 1: queenside pieces untouched, king on g1, rook hopped to f1.
  assert.equal(board.split('/')[7], 'RNBQ1RK1');
  // White has castled, so only black rights remain.
  assert.equal(rights, 'kq');
});

test('applySan: knight disambiguation (Nbd2 vs Nfd2)', () => {
  // After 1.Nf3 d5 both the b1 and f3 knights can reach d2.
  const pos = replay(['Nf3', 'd5']);
  assert.equal(applySan(pos, 'Nbd2'), 'b1d2');
  const pos2 = replay(['Nf3', 'd5']);
  assert.equal(applySan(pos2, 'Nfd2'), 'f3d2');
});

test('applyUci: en passant capture removes the passed pawn', () => {
  const pos = replay(['e2e4', 'a7a6', 'e4e5', 'd7d5'], { uci: true });
  // e5xd6 e.p.
  assert.equal(applyUci(pos, 'e5d6'), 'exd6');
  // rank 6 = a6 pawn, then b6/c6 empty, white pawn on d6, then 4 empty.
  assert.equal(toFen(pos).split(' ')[0].split('/')[2], 'p2P4');
});

test('applyUci: promotion to queen', () => {
  const pos = createPosition();
  // Hand-build a simple promotion position.
  pos.board = require('../chesscore.js').startBoard().map(() => '.');
  pos.board[require('../chesscore.js').sqIndex('e7')] = 'P';
  pos.board[require('../chesscore.js').sqIndex('e1')] = 'K';
  pos.board[require('../chesscore.js').sqIndex('a8')] = 'k';
  pos.turn = 'w';
  assert.equal(applyUci(pos, 'e7e8q'), 'e8=Q');
});

test('replay: throws loudly on an illegal move', () => {
  assert.throws(() => replay(['e4', 'e4']), /Illegal move at ply 2/);
});

test('toFen: start position', () => {
  assert.equal(
    toFen(createPosition()),
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  );
});

test('applySan: undisambiguated SAN resolves away from the pinned piece', () => {
  // White: Ke1, Ng1 (pinned along rank 1 by the black rook on h1), Nd2.
  // Both knights geometrically reach f3, and g1 has the lower square index,
  // so geometry alone would pick the pinned knight; SAN says plain "Nf3"
  // because only the d2 knight can legally go there.
  const pos = fromFen('4k3/8/8/8/8/8/3N4/4K1Nr w - - 0 1');
  assert.equal(applySan(pos, 'Nf3'), 'd2f3');
});

test('applySan: pawn-capture SAN with no pawn on the from-square fails', () => {
  // "dxe5" from the start position: there is no white pawn on d4.
  const pos = createPosition();
  assert.equal(applySan(pos, 'dxe5'), null);
});

test('fromFen: round-trips toFen through a real game position', () => {
  const played = replay(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
  const fen = toFen(played);
  const parsed = fromFen(fen);
  assert.equal(toFen(parsed), fen);
  assert.equal(parsed.turn, 'w');
});

test('fromFen: reads turn, partial castling rights, and the ep square', () => {
  const pos = fromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR b Kq d6 0 2');
  assert.equal(pos.turn, 'b');
  assert.deepEqual(pos.castling, { K: true, Q: false, k: false, q: true });
  assert.equal(toFen(pos).split(' ')[3], 'd6');
});

test('fromFen: rejects malformed input', () => {
  assert.equal(fromFen(null), null);
  assert.equal(fromFen('not a fen'), null);
  assert.equal(fromFen('8/8/8 w - - 0 1'), null); // wrong row count
});
