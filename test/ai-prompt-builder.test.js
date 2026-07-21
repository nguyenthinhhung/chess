const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildExplainPrompt, shouldSkipExplain, cacheKeyFor, fmtEval, EXPLAIN_SCHEMA, EXPLAIN_CACHE_VERSION } = require('../ai/prompt-builder.js');

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

test('cacheKeyFor starts with the exported cache version — the stale-cache purge in background.js keys off this', () => {
  const key = cacheKeyFor({ fen: 'startfen', bestMove: 'e2e4', depth: 14 });
  assert.ok(key.startsWith(`v${EXPLAIN_CACHE_VERSION}|`));
});

test('cacheKeyFor separates review (played move known) from live, and by coached side', () => {
  const data = { fen: 'startfen', bestMove: 'e2e4', depth: 14 };
  assert.notEqual(cacheKeyFor(data), cacheKeyFor({ ...data, playedMove: 'd4' }));
  assert.notEqual(cacheKeyFor({ ...data, userSide: 'w' }), cacheKeyFor({ ...data, userSide: 'b' }));
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
  assert.match(system, /Stay anchored/);
  assert.match(user, /g8f6/);
  assert.match(user, /Candidate moves/);
});

test('buildExplainPrompt prefers SAN + piece description over raw UCI', () => {
  const { system, user } = buildExplainPrompt({
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    bestMove: 'g8f6',
    bestSan: 'Nf6',
    moveDescription: 'Black knight g8–f6',
    eval: { type: 'cp', value: 30 },
    depth: 16,
    pv: ['g8f6', 'b1c3'],
    pvSan: ['Nf6', 'Nc3'],
    topMoves: [{ move: 'g8f6', san: 'Nf6', eval: { type: 'cp', value: 30 } }]
  });
  // The best move surfaces as SAN + the board-grounded piece description...
  assert.match(user, /Best move: Nf6 \(Black knight g8–f6\)/);
  // ...the PV and top moves are SAN, not raw coordinates...
  assert.match(user, /Nf6 Nc3/);
  assert.doesNotMatch(user, /b1c3/);
  // ...and the model is told not to re-derive pieces from the FEN.
  assert.match(system, /re-derive a piece from the FEN/i);
});

test('buildExplainPrompt injects a computed Position facts block and points the model at it', () => {
  const { system, user } = buildExplainPrompt({
    fen: 'r1bqkb1r/pp3ppp/2n1pn2/8/3P4/2N2N2/PP3PPP/R1BQKB1R w KQkq - 0 1',
    bestMove: 'd4d5', bestSan: 'd5',
    eval: { type: 'cp', value: 35 }, depth: 16, pv: ['d4d5'], pvSan: ['d5'],
    topMoves: [{ move: 'd4d5', san: 'd5', eval: { type: 'cp', value: 35 } }]
  });
  assert.match(user, /Position facts \(computed from the board/);
  assert.match(user, /isolated pawn\(s\) on d4/);   // the IQP is spelled out for the model
  assert.match(user, /Open files: c/);
  assert.match(system, /"Position facts" block/);    // and the model is told to trust it
});

test('EXPLAIN_SCHEMA requires the opponentReply field', () => {
  assert.ok(EXPLAIN_SCHEMA.properties.opponentReply);
  assert.ok(EXPLAIN_SCHEMA.required.includes('opponentReply'));
});

const BASE = {
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  bestMove: 'g8f6',
  bestSan: 'Nf6',
  eval: { type: 'cp', value: 30 },
  depth: 16,
  pv: ['g8f6', 'b1c3'],
  pvSan: ['Nf6', 'Nc3'],
  topMoves: [{ move: 'g8f6', san: 'Nf6', eval: { type: 'cp', value: 30 } }]
};

test('buildExplainPrompt frames everything for the coached side', () => {
  const { system, user } = buildExplainPrompt({ ...BASE, userSide: 'b' });
  assert.match(system, /coaching the Black player/);
  assert.match(system, /never advise the opponent/);
  assert.match(user, /Coached player: Black/);
});

test('buildExplainPrompt live (no played move): opponentReply reads the opponent intent', () => {
  const { system, user } = buildExplainPrompt({ ...BASE });
  assert.match(system, /what the opponent intends after the best move/);
  assert.doesNotMatch(system, /move actually played/);
  assert.doesNotMatch(user, /Move actually played/);
});

test('buildExplainPrompt review (played move known): compares best vs played', () => {
  const { system, user } = buildExplainPrompt({
    ...BASE, playedMove: 'd5', playedDescription: 'Black pawn d7–d5'
  });
  assert.match(user, /Move actually played from this position: d5 \(Black pawn d7–d5\)/);
  assert.match(system, /how the move actually played compares/);
  assert.match(system, /what the opponent is trying to achieve in return/);
  // The grounding guardrails must survive the review framing.
  assert.match(system, /do NOT claim a winning tactic/);
  assert.match(system, /re-derive a piece from the FEN/i);
});
