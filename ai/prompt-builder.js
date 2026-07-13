// ai/prompt-builder.js — turns a Stockfish analysis into a compact prompt for
// Gemini plus the JSON schema it must answer in. Pure: no DOM, no chrome, no
// network — so it runs both as a content/background script (globals) and
// under the Node test runner.
//
// Input shape (see plan.md Phase 1):
//   { fen, bestMove, playedMove?, playedDescription?, userSide?, eval, depth, pv, topMoves }
// eval / topMoves[].eval are Stockfish score objects: { type: 'cp'|'mate', value }.
// userSide is 'w'|'b' — the coached player. playedMove is the SAN of the move
// actually played from this position (only known when reviewing history).

const _pbIsNode = typeof module !== 'undefined' && module.exports;
const _pbI18n = _pbIsNode ? require('../i18n.js') : globalThis.ChessI18n;

const LANG_NAMES = { vi: 'Vietnamese' };

// Every field maps to something Stockfish actually returned (its score, its
// principal variation, its multipv candidates) or a plain board fact about the
// move — nothing the model has to invent. Deliberately dropped from the old
// schema: free-form "strategy"/"tactics", long-term "nextPlan", a guessed
// "commonMistake", and a 1–5 "difficulty" — all AI speculation the engine
// never gave us.
//   assessment    — what the evaluation number means (who's better, by how much)
//   whyBest       — what the best move concretely does and why the engine picks it
//                   (or, when reviewing a played move, how it compares to it)
//   opponentReply — the expected answer to the best move (PV move 2), or how the
//                   opponent punishes a weak played move — still PV-grounded
//   plan          — the idea/plan behind it, but ONLY as shown by the line (this
//                   absorbs the old strategy/tactics/nextPlan fields, kept useful
//                   but now anchored to the PV instead of free invention)
//   line          — the principal variation narrated move by move
//   alternatives  — the other candidate moves and how much worse they are
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string' },
    whyBest: { type: 'string' },
    opponentReply: { type: 'string' },
    plan: { type: 'string' },
    line: { type: 'array', items: { type: 'string' } },
    alternatives: { type: 'string' }
  },
  required: ['assessment', 'whyBest', 'opponentReply', 'plan', 'line', 'alternatives']
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
// wrong or worse (e.g. the SAN/piece-description grounding added in v2, the
// coached-side perspective + opponentReply field added in v4), so stale
// explanations aren't served from chrome.storage.local after an update.
const EXPLAIN_CACHE_VERSION = 4;

// A cheap, deterministic cache key (not a cryptographic hash) — unique enough
// to key chrome.storage.local cache entries by position + search depth. Language
// is included so a Vietnamese explanation never gets served for an English
// request; the coached side and the played move likewise change the answer's
// framing (the same position can be seen live with no played move and later in
// review with one), so they key separately too.
function cacheKeyFor(data) {
  return `v${EXPLAIN_CACHE_VERSION}|${data.fen}|${data.bestMove}|${data.depth || 0}|${data.lang || 'en'}` +
    `|${data.userSide || ''}|${data.playedMove || ''}`;
}

// The FEN's active-color field, spelled out — handed to Gemini as an explicit
// fact rather than making it re-derive "whose move is it" from the raw FEN
// every time, which is an easy thing for a model to get backwards.
function sideToMoveName(fen) {
  const active = String(fen || '').split(' ')[1];
  return active === 'b' ? 'Black' : 'White';
}

const sideName = (s) => (s === 'b' ? 'Black' : 'White');

function buildExplainPrompt(data) {
  const topMoves = (data.topMoves || [])
    .map((m, i) => `${i + 1}. ${m.san || m.move} (${fmtEval(m.eval)})`)
    .join('\n');
  const pv = (data.pvSan && data.pvSan.length ? data.pvSan : data.pv || []).join(' ');
  // The best move as SAN plus, when available, an explicit board-grounded
  // description of exactly which piece moves where.
  const bestLine = (data.bestSan || data.bestMove) + (data.moveDescription ? ` (${data.moveDescription})` : '');
  // Same treatment for the move actually played (present only when the user is
  // reviewing history — see buildExplainInput in chess-coach.js).
  const playedLine = data.playedMove
    ? data.playedMove + (data.playedDescription ? ` (${data.playedDescription})` : '')
    : null;
  const hasPlayed = !!playedLine;

  const langName = LANG_NAMES[data.lang];
  const system = [
    'You are a professional chess coach explaining one engine analysis to a 1200-Elo player.',
    data.userSide
      ? `You are coaching the ${sideName(data.userSide)} player — "you" in your text always means that player. When the side to move is the opponent, explain what the opponent's best move threatens and how the coached player should prepare; never write as if you were advising the opponent.`
      : null,
    'Write for that level: plain sentences, translate evaluations into words (e.g. "+1.02" means ahead by about a pawn), and when you use a chess term, add in a few words what it concretely means here.',
    'Ground every statement ONLY in the data given: the evaluation, the principal variation, the candidate moves, and the described best move.',
    'Do NOT invent threats, mating nets, plans, motifs, or piece activity that are not present in the given line — if the data does not show it, do not say it.',
    'The "Side to move" field is ground truth — never say the other color is moving.',
    'Moves are given in SAN; the best move also names exactly which piece moves and what it captures. Use those identities verbatim — never re-derive a piece from the FEN or rename one (e.g. knight vs bishop).',
    'Fill the fields exactly: ',
    '"assessment": who is better and by how much, read straight from the evaluation (e.g. a clear advantage, roughly equal, a forced mate) — no more than one sentence.',
    hasPlayed
      ? '"whyBest": what the best move would have achieved compared to the move actually played, judged only by their evaluations in the candidate list; if the played move is not among the candidates, say it falls outside the engine\'s top choices rather than guessing a number; if it IS the best move, say so and praise it.'
      : '"whyBest": what the best move concretely does (the piece, any capture or check) and why the engine prefers it, judged by its evaluation versus the alternatives.',
    hasPlayed
      ? '"opponentReply": how the opponent can exploit the move actually played, using only the evaluation gap and the principal variation; if the played move was the best move, describe the opponent\'s expected answer from the principal variation instead.'
      : '"opponentReply": the expected answer to the best move — the second move of the principal variation — and what that answer is trying to achieve (defend, trade, counter-attack), stated only from what the line shows.',
    '"plan": the idea or plan the move serves for the side to move, but ONLY as demonstrated by the principal variation (e.g. a trade the line carries out, a file it opens) — do not state a plan the line does not show.',
    '"line": one short entry per move of the principal variation, in order, each saying that single move\'s point — do not go beyond the moves listed.',
    '"alternatives": the other candidate moves with their evaluations and how much worse they are; if none are given, state that the best move is clearly ahead.',
    'Keep the whole thing under 180 words.',
    langName ? `Write every text field in ${langName}, including move descriptions.` : null,
    'Return JSON only, matching the given schema exactly.'
  ].filter(Boolean).join(' ');

  const user = [
    `Position (FEN): ${data.fen}`,
    `Side to move: ${sideToMoveName(data.fen)}`,
    data.userSide ? `Coached player: ${sideName(data.userSide)}` : null,
    `Best move: ${bestLine}`,
    playedLine ? `Move actually played from this position: ${playedLine}` : null,
    `Evaluation: ${fmtEval(data.eval)}`,
    `Principal variation: ${pv}`,
    topMoves ? `Candidate moves (best first):\n${topMoves}` : null
  ].filter(Boolean).join('\n');

  return { system, user };
}

const _pbExports = { EXPLAIN_SCHEMA, EXPLAIN_CACHE_VERSION, buildExplainPrompt, shouldSkipExplain, cacheKeyFor, fmtEval };
if (_pbIsNode) {
  module.exports = _pbExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiPrompt = _pbExports;
}
