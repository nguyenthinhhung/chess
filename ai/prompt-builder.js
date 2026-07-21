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
const _pbFacts = _pbIsNode ? require('./position-facts.js') : globalThis.ChessPositionFacts;

const LANG_NAMES = { vi: 'Vietnamese' };

// The division of labour: Stockfish's own numbers (evaluation, candidate moves
// with their scores, the principal variation) are shown directly as chips in
// the panel, so the model must NOT just re-narrate them. Its job is the layer
// the numbers don't give — the human strategic plan. So the schema keeps only
// the three fields that add that: what the best move does, the middlegame plan
// behind it, and what the opponent is trying to do. Deliberately dropped: the
// old "assessment" (= the eval chip), "line" (= the PV arrows), and
// "alternatives" (= the candidate chips) — all duplicated Stockfish output.
//   whyBest       — what the best move concretely does and the idea behind it
//                   (or, when reviewing a played move, how it compares to it)
//   plan          — a concrete middlegame plan for the coached side over the
//                   next several moves, drawn from standard strategic themes and
//                   matched to the pawn structure on THIS board
//   opponentReply — what the opponent is trying to achieve and what the coached
//                   player should watch for / prepare against
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    whyBest: { type: 'string' },
    plan: { type: 'string' },
    opponentReply: { type: 'string' }
  },
  required: ['whyBest', 'plan', 'opponentReply']
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
// coached-side perspective + opponentReply field added in v4, the strategy-first
// 3-field schema in v5, the computed position-facts block in v6), so stale
// explanations aren't served from chrome.storage.local after an update.
const EXPLAIN_CACHE_VERSION = 6;

// The strategic vocabulary the "plan" field draws from — a menu the model picks
// from to match THIS position's pawn structure, not a checklist to recite. Kept
// broad on purpose (the user asked for more than the original six themes) but
// phrased for a ~1200-Elo student. The model is told to name concrete squares
// and pieces, and to choose only the ideas the position actually supports.
const STRATEGY_THEMES = [
  'improve your worst-placed piece (a passive knight or bishop → an active square or an outpost)',
  'fight for an open or half-open file with a rook, double rooks, or reach the 7th rank',
  'make a pawn break to open lines for your pieces or fix a target',
  'attack a structural weakness — an isolated (IQP), backward, doubled, or hanging pawn, or a weak square/hole; attack a pawn chain at its base',
  'exchange your bad piece for the opponent\'s good one, relieve a cramped position, or simplify into a better endgame',
  'a wing attack or a minority attack, matched to which side each king castled',
  'push for or use a space advantage without over-extending, and restrain the opponent (prophylaxis)',
  'attack the king: open lines toward it, or exploit a weakened castled position',
  'use the bishop pair, a strong knight outpost, control of a key diagonal, or a good-vs-bad bishop imbalance',
  'create or blockade a passed pawn; in the endgame, activate the king and use a pawn majority',
  'the principle of two weaknesses — open a second front so the defender is stretched'
];

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
  // Stockfish's raw numbers (eval, candidate moves + scores, the PV) are already
  // shown to the player as chips, so this prompt is NOT for re-narrating them —
  // it is for the strategic layer the numbers don't give. The model may reason
  // about the pawn structure and plans (that is the point), but stays anchored:
  // the engine's move/eval are the ceiling, and it must not fabricate forced
  // tactics the search didn't show.
  const system = [
    'You are a professional chess coach turning one engine analysis into a strategic lesson for a ~1200-Elo player.',
    data.userSide
      ? `You are coaching the ${sideName(data.userSide)} player — "you" always means that player. When it is the opponent to move, explain what the opponent is trying to do and how the coached player should prepare; never advise the opponent.`
      : null,
    'The evaluation, the candidate moves with their scores, and the principal variation are ALREADY shown to the player as numbers. Do NOT just restate them. Your job is the human plan behind the position — the ideas the numbers do not spell out.',
    'Write for that level: plain sentences, and when you use a chess term (outpost, minority attack, IQP…) add in a few words what it means on THIS board. Name concrete squares and pieces.',
    'Stay anchored: keep consistent with the evaluation and treat the engine\'s best move as correct; you may explain the pawn structure and plans, but do NOT claim a winning tactic, mating net, or forced win the analysis does not support.',
    'The "Side to move" field is ground truth — never say the other color is moving.',
    'Moves are given in SAN; the best move also names exactly which piece moves and what it captures. Use those identities verbatim — never re-derive a piece from the FEN or rename one (e.g. knight vs bishop).',
    'A "Position facts" block, computed directly from the board, gives the material, game phase, where each king castled, the open/half-open files, the weak pawns, and the outpost squares. Treat it as ground truth: build your plan on those facts and do NOT contradict them or re-read the structure from the FEN yourself. If it lists no weakness of some kind, do not claim one.',
    'Fill the three fields exactly:',
    hasPlayed
      ? '"whyBest": in one or two sentences, what the engine\'s best move does and the idea behind it, and how the move actually played compares (better/worse and why); if the played move falls outside the candidate list, say so rather than inventing a number.'
      : '"whyBest": in one or two sentences, what the best move concretely does (the piece, any capture or check) and the idea behind it — not its number.',
    '"plan": a concrete plan for the coached side over the next 5–8 moves, chosen to fit the pawn structure. Pick the one or two most relevant of these standard ideas and make them specific to this board (which piece, which file, which break, which square):\n- ' + STRATEGY_THEMES.join('\n- ') + '\nName the plan in terms of this position, not as a generic list. Give the moves as a short idea (e.g. "reroute the knight Nc2–e3–d5") rather than a long forced line.',
    hasPlayed
      ? '"opponentReply": what the opponent is trying to achieve in return and the one thing the coached player should watch for or prevent.'
      : '"opponentReply": what the opponent intends after the best move (their own plan or counterplay) and the one thing the coached player should watch for.',
    'Keep the whole thing under 150 words.',
    langName ? `Write every text field in ${langName}, including chess terms where a natural translation exists.` : null,
    'Return JSON only, matching the given schema exactly.'
  ].filter(Boolean).join(' ');

  // Structural facts computed from the board (material, king safety, files,
  // weak pawns, outposts) — the grounding the strategic "plan" field leans on
  // so the model doesn't have to (mis)read them out of the FEN itself.
  const facts = _pbFacts ? _pbFacts.describePosition(data.fen) : null;
  const factsText = facts && facts.lines && facts.lines.length ? facts.lines.join('\n') : null;

  const user = [
    `Position (FEN): ${data.fen}`,
    `Side to move: ${sideToMoveName(data.fen)}`,
    data.userSide ? `Coached player: ${sideName(data.userSide)}` : null,
    factsText ? `Position facts (computed from the board — ground truth):\n${factsText}` : null,
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
