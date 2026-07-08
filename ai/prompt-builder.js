// ai/prompt-builder.js — turns a Stockfish analysis into a compact prompt for
// Gemini plus the JSON schema it must answer in. Pure: no DOM, no chrome, no
// network — so it runs both as a content/background script (globals) and
// under the Node test runner.
//
// Input shape (see plan.md Phase 1):
//   { fen, bestMove, playedMove?, eval, depth, pv, topMoves }
// eval / topMoves[].eval are Stockfish score objects: { type: 'cp'|'mate', value }.

const _pbIsNode = typeof module !== 'undefined' && module.exports;

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    whyBest: { type: 'string' },
    strategy: { type: 'string' },
    tactics: { type: 'string' },
    nextPlan: { type: 'array', items: { type: 'string' } },
    commonMistake: { type: 'string' },
    difficulty: { type: 'integer' }
  },
  required: ['summary', 'whyBest', 'strategy', 'tactics', 'nextPlan', 'commonMistake', 'difficulty']
};

function fmtEval(score) {
  if (!score) return 'unclear';
  if (score.type === 'mate') return (score.value >= 0 ? 'Mate in ' : 'Mated in ') + Math.abs(score.value);
  const cp = score.value / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(2);
}

// Cost control (plan.md Phase 7): skip calling Gemini when the analysis is too
// shallow to trust, or the position is already decided (mate found) — the
// engine's own numbers say everything needed, an LLM gloss adds nothing.
function shouldSkipExplain(data) {
  if (!data || !data.bestMove) return { skip: true, reason: 'no analysis yet' };
  if (typeof data.depth === 'number' && data.depth < 12) return { skip: true, reason: 'depth too shallow' };
  if (data.eval && data.eval.type === 'mate') return { skip: true, reason: 'forced mate — nothing to explain' };
  return { skip: false, reason: null };
}

// A cheap, deterministic cache key (not a cryptographic hash) — unique enough
// to key chrome.storage.local cache entries by position + search depth.
function cacheKeyFor(data) {
  return `${data.fen}|${data.bestMove}|${data.depth || 0}`;
}

function buildExplainPrompt(data) {
  const topMoves = (data.topMoves || [])
    .map((m, i) => `${i + 1}. ${m.move} (${fmtEval(m.eval)})`)
    .join('\n');

  const system = [
    'You are a professional chess coach.',
    'Do NOT invent variations. Only explain using the supplied Stockfish analysis.',
    'Keep the explanation under 180 words total across all fields.',
    'Audience: a 1200 Elo player.',
    'Return JSON only, matching the given schema exactly.'
  ].join(' ');

  const user = [
    `Position (FEN): ${data.fen}`,
    `Best move: ${data.bestMove}`,
    data.playedMove ? `Move actually played: ${data.playedMove}` : null,
    `Evaluation: ${fmtEval(data.eval)}`,
    `Principal variation: ${(data.pv || []).join(' ')}`,
    topMoves ? `Top moves:\n${topMoves}` : null
  ].filter(Boolean).join('\n');

  return { system, user };
}

const _pbExports = { EXPLAIN_SCHEMA, buildExplainPrompt, shouldSkipExplain, cacheKeyFor, fmtEval };
if (_pbIsNode) {
  module.exports = _pbExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiPrompt = _pbExports;
}
