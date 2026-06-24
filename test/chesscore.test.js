const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPosition, applySan, applyUci, toFen, replay } = require('../chesscore.js');

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
