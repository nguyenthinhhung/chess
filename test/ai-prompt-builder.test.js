const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildExplainPrompt, shouldSkipExplain, cacheKeyFor, fmtEval } = require('../ai/prompt-builder.js');

test('fmtEval formats centipawns and mate', () => {
  assert.equal(fmtEval({ type: 'cp', value: 82 }), '+0.82');
  assert.equal(fmtEval({ type: 'cp', value: -55 }), '-0.55');
  assert.equal(fmtEval({ type: 'mate', value: 3 }), 'Mate in 3');
  assert.equal(fmtEval({ type: 'mate', value: -2 }), 'Mated in 2');
  assert.equal(fmtEval(null), 'unclear');
});

test('shouldSkipExplain: skips shallow depth', () => {
  const r = shouldSkipExplain({ bestMove: 'e2e4', depth: 8, eval: { type: 'cp', value: 20 } });
  assert.equal(r.skip, true);
});

test('shouldSkipExplain: skips forced mate', () => {
  const r = shouldSkipExplain({ bestMove: 'd8h4', depth: 20, eval: { type: 'mate', value: 1 } });
  assert.equal(r.skip, true);
});

test('shouldSkipExplain: allows a solid, deep, non-mate position', () => {
  const r = shouldSkipExplain({ bestMove: 'g1f3', depth: 16, eval: { type: 'cp', value: 30 } });
  assert.equal(r.skip, false);
});

test('shouldSkipExplain: skips when there is no analysis', () => {
  assert.equal(shouldSkipExplain(null).skip, true);
  assert.equal(shouldSkipExplain({}).skip, true);
});

test('cacheKeyFor is stable for the same fen/move/depth', () => {
  const data = { fen: 'startfen', bestMove: 'e2e4', depth: 14 };
  assert.equal(cacheKeyFor(data), cacheKeyFor({ ...data }));
});

test('buildExplainPrompt embeds FEN, best move, and top moves', () => {
  const { system, user } = buildExplainPrompt({
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    bestMove: 'g8f6',
    eval: { type: 'cp', value: 30 },
    depth: 16,
    pv: ['g8f6', 'b1c3'],
    topMoves: [{ move: 'g8f6', eval: { type: 'cp', value: 30 } }]
  });
  assert.match(system, /Do NOT invent variations/);
  assert.match(user, /g8f6/);
  assert.match(user, /Top moves/);
});
