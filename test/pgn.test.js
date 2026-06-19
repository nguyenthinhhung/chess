const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeTcn, uciListToSan, buildPgn } = require('../pgn.js');

const emptyBoard = () => Array(64).fill('.');
const sq = (file, rank) => (rank - 1) * 8 + (file.charCodeAt(0) - 97);

test('decodeTcn: plain moves', () => {
  assert.deepEqual(decodeTcn('mC'), ['e2e4']);
  assert.deepEqual(decodeTcn('gv'), ['g1f3']);
  assert.deepEqual(decodeTcn('mC0K'), ['e2e4', 'e7e5']);
});

test('decodeTcn: queen promotion (straight push)', () => {
  // e7 = '0', to-index 65 ('~') => promote to queen pushing straight to e8.
  assert.deepEqual(decodeTcn('0~'), ['e7e8q']);
});

test('decodeTcn: rejects malformed input', () => {
  assert.equal(decodeTcn(''), null);
  assert.equal(decodeTcn(null), null);
});

test('uciListToSan: Ruy Lopez opening from start', () => {
  const san = uciListToSan(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']);
  assert.deepEqual(san, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
});

test('uciListToSan: kingside castling', () => {
  const san = uciListToSan(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']);
  assert.deepEqual(san, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']);
});

test('uciListToSan: queenside castling', () => {
  const board = emptyBoard();
  board[sq('e', 1)] = 'K';
  board[sq('a', 1)] = 'R';
  board[sq('e', 8)] = 'k';
  assert.deepEqual(uciListToSan(['e1c1'], board), ['O-O-O']);
});

test('uciListToSan: pawn promotion', () => {
  const board = emptyBoard();
  board[sq('a', 7)] = 'P';
  board[sq('e', 1)] = 'K';
  board[sq('e', 8)] = 'k';
  assert.deepEqual(uciListToSan(['a7a8q'], board), ['a8=Q']);
});

test('uciListToSan: en passant capture', () => {
  const board = emptyBoard();
  board[sq('e', 5)] = 'P';
  board[sq('d', 5)] = 'p'; // black pawn that just advanced two squares
  const san = uciListToSan(['e5d6'], board);
  assert.deepEqual(san, ['exd6']);
  assert.equal(board[sq('d', 5)], '.'); // captured pawn removed
});

test('uciListToSan: knight disambiguation by file', () => {
  const board = emptyBoard();
  board[sq('b', 1)] = 'N';
  board[sq('f', 3)] = 'N'; // both knights can reach d2
  board[sq('e', 1)] = 'K';
  board[sq('e', 8)] = 'k';
  assert.deepEqual(uciListToSan(['b1d2'], board), ['Nbd2']);
});

test('uciListToSan: returns null when a from-square is empty', () => {
  assert.equal(uciListToSan(['e3e4']), null);
});

test('buildPgn: assembles headers, moves and result', () => {
  const pgn = buildPgn({
    pgnHeaders: { Event: 'Test', Result: '1-0' },
    moveList: 'mC0K'
  });
  assert.equal(pgn, '[Event "Test"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n');
});

test('buildPgn: null without headers or moves', () => {
  assert.equal(buildPgn({ moveList: 'mC' }), null);
  assert.equal(buildPgn({ pgnHeaders: { Result: '*' }, moveList: '' }), null);
});
