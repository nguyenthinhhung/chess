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

test('EXPLAIN_SCHEMA requires the opponentReply and principle fields', () => {
  assert.ok(EXPLAIN_SCHEMA.properties.opponentReply);
  assert.ok(EXPLAIN_SCHEMA.required.includes('opponentReply'));
  assert.ok(EXPLAIN_SCHEMA.properties.principle);
  assert.ok(EXPLAIN_SCHEMA.required.includes('principle'));
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

test('buildExplainPrompt live (no played move): opponentReply reads from the PV', () => {
  const { system, user } = buildExplainPrompt({ ...BASE });
  assert.match(system, /second move of the principal variation/);
  assert.doesNotMatch(system, /move actually played/);
  assert.doesNotMatch(user, /Move actually played/);
  // The opponent's reply (PV move 2) is spelled out to ground the field.
  assert.match(user, /Opponent's best reply: Nc3/);
});

test('buildExplainPrompt reframes when the opponent is to move', () => {
  // BASE fen has Black to move; coaching White → the analyzed position is the
  // opponent's move, so the engine's best move is the opponent's, not the user's,
  // and PV move 2 is the user's own reply. The framing must reflect that instead
  // of narrating the opponent's move as the user's (the "you vs opponent" mixup).
  const { system, user } = buildExplainPrompt({ ...BASE, userSide: 'w' });
  assert.match(system, /the engine's best move is THEIRS/);
  assert.match(system, /Never present the opponent's move as yours to play/);
  assert.match(system, /a concrete plan for YOU \(the coached side\) to meet what the opponent is doing/);
  // PV move 2 is the user's reply here — it must not be mislabeled as the opponent's.
  assert.match(user, /Your best reply: Nc3/);
  assert.doesNotMatch(user, /Opponent's best reply/);
});

test('buildExplainPrompt keeps the you-to-move framing when the coached side moves', () => {
  // Coaching Black with Black to move → the engine's best move IS the user's;
  // none of the opponent-to-move reframing should leak in.
  const { system, user } = buildExplainPrompt({ ...BASE, userSide: 'b' });
  assert.doesNotMatch(system, /the engine's best move is THEIRS/);
  assert.match(user, /Opponent's best reply: Nc3/);
});

test('buildExplainPrompt review (played move known): compares best vs played', () => {
  const { system, user } = buildExplainPrompt({
    ...BASE, playedMove: 'd5', playedDescription: 'Black pawn d7–d5'
  });
  assert.match(user, /Move actually played from this position: d5 \(Black pawn d7–d5\)/);
  assert.match(system, /how the move actually played compares/);
  assert.match(system, /how the opponent exploits the played move/);
  // The grounding guardrails must survive the review framing.
  assert.match(system, /do NOT invent a forced tactic/);
  assert.match(system, /re-derive a piece from the FEN/i);
});

test('buildExplainPrompt asks for a transferable principle', () => {
  const { system } = buildExplainPrompt({ ...BASE });
  assert.match(system, /"principle":/);
  assert.match(system, /transferable chess maxim/);
});

test('plan themes are filtered to what the Position facts support', () => {
  // IQP, neither side castled → offer the weakness + open-file ideas, not king attack.
  const iqp = buildExplainPrompt({
    fen: 'r1bqkb1r/pp3ppp/2n1pn2/8/3P4/2N2N2/PP3PPP/R1BQKB1R w KQkq - 0 1',
    bestMove: 'f1d3', bestSan: 'Bd3', eval: { type: 'cp', value: 20 }, depth: 16,
    pv: ['f1d3'], pvSan: ['Bd3'], topMoves: [{ move: 'f1d3', san: 'Bd3', eval: { type: 'cp', value: 20 } }]
  }).system;
  assert.match(iqp, /attack a structural weakness/);
  assert.match(iqp, /open or half-open file/);
  assert.doesNotMatch(iqp, /attack the king/);

  // Opposite-side castling → the king-attack idea is offered.
  const castled = buildExplainPrompt({
    fen: 'r1bq1rk1/ppp2ppp/2n5/8/8/2N5/PPP2PPP/2KR3R w - - 0 1',
    bestMove: 'd1e1', bestSan: 'Rde1', eval: { type: 'cp', value: -30 }, depth: 16,
    pv: ['d1e1'], pvSan: ['Rde1'], topMoves: [{ move: 'd1e1', san: 'Rde1', eval: { type: 'cp', value: -30 } }]
  }).system;
  assert.match(castled, /attack the king/);
});
