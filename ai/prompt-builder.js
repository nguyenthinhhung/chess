// ai/prompt-builder.js — turns a Stockfish analysis into a compact prompt for
// Gemini plus the JSON schema it must answer in. Pure: no DOM, no chrome, no
// network — so it runs both as a content/background script (globals) and
// under the Node test runner.
//
// Input shape (see plan.md Phase 1):
//   { fen, bestMove, playedMove?, eval, depth, pv, topMoves }
// eval / topMoves[].eval are Stockfish score objects: { type: 'cp'|'mate', value }.

const _pbIsNode = typeof module !== 'undefined' && module.exports;
const _pbI18n = _pbIsNode ? require('../i18n.js') : globalThis.ChessI18n;

const LANG_NAMES = { vi: 'Vietnamese' };

// Every field maps to something Stockfish actually returned (its score, its
// principal variation, its multipv candidates) or a plain board fact about the
// move — nothing the model has to invent. Deliberately dropped from the old
// schema: free-form "strategy"/"tactics", long-term "nextPlan", a guessed
// "commonMistake", and a 1–5 "difficulty" — all AI speculation the engine
// never gave us.
//   assessment   — what the evaluation number means (who's better, by how much)
//   whyBest      — what the best move concretely does and why the engine picks it
//   plan         — the idea/plan behind it, but ONLY as shown by the line (this
//                  absorbs the old strategy/tactics/nextPlan fields, kept useful
//                  but now anchored to the PV instead of free invention)
//   line         — the principal variation narrated move by move
//   alternatives — the other candidate moves and how much worse they are
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string' },
    whyBest: { type: 'string' },
    plan: { type: 'string' },
    line: { type: 'array', items: { type: 'string' } },
    alternatives: { type: 'string' }
  },
  required: ['assessment', 'whyBest', 'plan', 'line', 'alternatives']
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
  const lang = (data && data.lang) || 'en';
  if (!data || !data.bestMove) return { skip: true, reason: _pbI18n.t(lang, 'skipNoAnalysis') };
  if (typeof data.depth === 'number' && data.depth < 12) return { skip: true, reason: _pbI18n.t(lang, 'skipShallowDepth') };
  if (data.eval && data.eval.type === 'mate') return { skip: true, reason: _pbI18n.t(lang, 'skipForcedMate') };
  return { skip: false, reason: null };
}

// Bump when the prompt shape changes in a way that makes older cached answers
// wrong or worse (e.g. the SAN/piece-description grounding added in v2), so
// stale explanations aren't served from chrome.storage.local after an update.
const EXPLAIN_CACHE_VERSION = 3;

// A cheap, deterministic cache key (not a cryptographic hash) — unique enough
// to key chrome.storage.local cache entries by position + search depth. Language
// is included so a Vietnamese explanation never gets served for an English request.
function cacheKeyFor(data) {
  return `v${EXPLAIN_CACHE_VERSION}|${data.fen}|${data.bestMove}|${data.depth || 0}|${data.lang || 'en'}`;
}

// The FEN's active-color field, spelled out — handed to Gemini as an explicit
// fact rather than making it re-derive "whose move is it" from the raw FEN
// every time, which is an easy thing for a model to get backwards.
function sideToMoveName(fen) {
  const active = String(fen || '').split(' ')[1];
  return active === 'b' ? 'Black' : 'White';
}

function buildExplainPrompt(data) {
  const topMoves = (data.topMoves || [])
    .map((m, i) => `${i + 1}. ${m.san || m.move} (${fmtEval(m.eval)})`)
    .join('\n');
  const pv = (data.pvSan && data.pvSan.length ? data.pvSan : data.pv || []).join(' ');
  // The best move as SAN plus, when available, an explicit board-grounded
  // description of exactly which piece moves where.
  const bestLine = (data.bestSan || data.bestMove) + (data.moveDescription ? ` (${data.moveDescription})` : '');

  const langName = LANG_NAMES[data.lang];
  const system = [
    'You are a professional chess coach explaining one engine analysis to a 1200-Elo player.',
    'Ground every statement ONLY in the data given: the evaluation, the principal variation, the candidate moves, and the described best move.',
    'Do NOT invent threats, mating nets, plans, motifs, or piece activity that are not present in the given line — if the data does not show it, do not say it.',
    'The "Side to move" field is ground truth — never say the other color is moving.',
    'Moves are given in SAN; the best move also names exactly which piece moves and what it captures. Use those identities verbatim — never re-derive a piece from the FEN or rename one (e.g. knight vs bishop).',
    'Fill the fields exactly: ',
    '"assessment": who is better and by how much, read straight from the evaluation (e.g. a clear advantage, roughly equal, a forced mate) — no more than one sentence.',
    '"whyBest": what the best move concretely does (the piece, any capture or check) and why the engine prefers it, judged by its evaluation versus the alternatives.',
    '"plan": the idea or plan the move serves for the side to move, but ONLY as demonstrated by the principal variation (e.g. a trade the line carries out, a file it opens) — do not state a plan the line does not show.',
    '"line": one short entry per move of the principal variation, in order, each saying that single move\'s point — do not go beyond the moves listed.',
    '"alternatives": the other candidate moves with their evaluations and how much worse they are; if none are given, state that the best move is clearly ahead.',
    'Keep the whole thing under 160 words.',
    langName ? `Write every text field in ${langName}, including move descriptions.` : null,
    'Return JSON only, matching the given schema exactly.'
  ].filter(Boolean).join(' ');

  const user = [
    `Position (FEN): ${data.fen}`,
    `Side to move: ${sideToMoveName(data.fen)}`,
    `Best move: ${bestLine}`,
    data.playedMove ? `Move actually played: ${data.playedMove}` : null,
    `Evaluation: ${fmtEval(data.eval)}`,
    `Principal variation: ${pv}`,
    topMoves ? `Candidate moves (best first):\n${topMoves}` : null
  ].filter(Boolean).join('\n');

  return { system, user };
}

const _pbExports = { EXPLAIN_SCHEMA, buildExplainPrompt, shouldSkipExplain, cacheKeyFor, fmtEval };
if (_pbIsNode) {
  module.exports = _pbExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiPrompt = _pbExports;
}
