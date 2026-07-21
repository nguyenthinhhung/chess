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
//   whyBest       — a three-word read of who stands better, then what the best
//                   move does (or, in review, how the played move compares)
//   plan          — a concrete middlegame plan for the coached side over the
//                   next several moves, drawn from standard strategic themes and
//                   matched to the pawn structure on THIS board
//   opponentReply — the opponent's best reply (PV move 2) and the idea to watch
//   principle     — one short transferable maxim the student can reuse; this is
//                   what turns move commentary into teaching for a ~1200 player
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    whyBest: { type: 'string' },
    plan: { type: 'string' },
    opponentReply: { type: 'string' },
    principle: { type: 'string' }
  },
  required: ['whyBest', 'plan', 'opponentReply', 'principle']
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
// 3-field schema in v5, the computed position-facts block in v6, the
// PV-anchoring + principle field in v7), so stale explanations aren't served
// from chrome.storage.local after an update.
const EXPLAIN_CACHE_VERSION = 7;

// The strategic vocabulary the "plan" field draws from. Each theme carries a
// `when(facts)` predicate so we offer the model only the ideas THIS position
// actually supports — no IQP theme when there is no IQP, no king-attack theme
// before anyone has castled. This is relevance-filtering of the menu (grounding),
// NOT deciding the plan: the LLM still chooses among the offered themes and does
// all the strategic reasoning. It also trims tokens and kills "theme soup".
const _hasWeakPawn = (f) => ['white', 'black'].some((s) =>
  f.pawns[s].isolated.length || f.pawns[s].doubled.length || f.pawns[s].backward.length);
const _hasOutpost = (f) => f.outposts.white.length || f.outposts.black.length;
const _hasOpenFile = (f) => f.openFiles.length || f.halfOpen.white.length || f.halfOpen.black.length;
const _hasCastled = (f) => (f.kings.white && f.kings.white.side !== 'center') ||
  (f.kings.black && f.kings.black.side !== 'center');
const _materialGap = (f) => Math.abs(f.material.white - f.material.black) >= 1;

const STRATEGY_THEMES = [
  { text: 'improve your worst-placed piece (a passive knight or bishop → an active square or an outpost)', when: () => true },
  { text: 'put a rook on an open or half-open file, or reach the 7th rank', when: _hasOpenFile },
  { text: 'make a pawn break to open lines for your pieces or fix a target', when: (f) => f.phase !== 'endgame' },
  { text: 'attack a structural weakness — an isolated (IQP), backward or doubled pawn, or a weak square you can occupy', when: (f) => _hasWeakPawn(f) || _hasOutpost(f) },
  { text: 'attack the king — a pawn storm or piece attack on the wing it castled to (a minority attack when you have fewer pawns there)', when: _hasCastled },
  { text: 'trade your bad piece for the opponent\'s good one, or simplify into a better endgame', when: (f) => _materialGap(f) || f.phase === 'endgame' }
];

// Pick the themes the Position facts support: keep it a genuine menu (never fewer
// than 3, so the model still has room to reason) but focused (at most 4). Falls
// back to the full list when facts are unavailable.
function selectThemes(facts) {
  if (!facts) return STRATEGY_THEMES.map((t) => t.text);
  const picked = STRATEGY_THEMES.filter((t) => t.when(facts)).map((t) => t.text);
  for (const t of STRATEGY_THEMES) {
    if (picked.length >= 3) break;
    if (!picked.includes(t.text)) picked.push(t.text);
  }
  return picked.slice(0, 4);
}

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
  const pvArr = (data.pvSan && data.pvSan.length ? data.pvSan : data.pv || []);
  const pv = pvArr.join(' ');
  const replySan = pvArr[1] || null; // the opponent's reply = 2nd move of the PV
  // The best move as SAN plus, when available, an explicit board-grounded
  // description of exactly which piece moves where.
  const bestLine = (data.bestSan || data.bestMove) + (data.moveDescription ? ` (${data.moveDescription})` : '');
  // Same treatment for the move actually played (present only when the user is
  // reviewing history — see buildExplainInput in chess-coach.js).
  const playedLine = data.playedMove
    ? data.playedMove + (data.playedDescription ? ` (${data.playedDescription})` : '')
    : null;
  const hasPlayed = !!playedLine;

  // Structural facts computed from the board (material, king safety, files, weak
  // pawns, outposts) — the grounding the "plan" field leans on, and the basis
  // for offering only the strategic themes this position actually supports.
  const facts = _pbFacts ? _pbFacts.describePosition(data.fen) : null;
  const factsText = facts && facts.lines && facts.lines.length ? facts.lines.join('\n') : null;

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
    'The evaluation, the candidate moves with their scores, and the principal variation are ALREADY shown to the player as numbers. Do NOT restate them. Your job is the human plan behind the position — the ideas the numbers do not spell out.',
    'Write for that level: plain sentences, and when you use a chess term (outpost, minority attack, IQP…) add in a few words what it means on THIS board. Name concrete squares and pieces.',
    'Stay anchored: keep consistent with the evaluation and treat the engine\'s best move as correct; explain the pawn structure and plans, but do NOT invent a forced tactic, mating net, or winning line the principal variation does not show.',
    'The principal variation is evidence: the engine\'s own next moves reveal the plan\'s direction and the opponent\'s best reply — do not propose a plan or threat that contradicts it.',
    'The "Side to move" field is ground truth — never say the other color is moving.',
    'Moves are given in SAN; the best move also names exactly which piece moves and what it captures. Use those identities verbatim — never re-derive a piece from the FEN or rename one (e.g. knight vs bishop).',
    'A "Position facts" block, computed directly from the board, gives the material, game phase, where each king castled, the open/half-open files, the weak pawns, and the outpost squares. Treat it as ground truth: build your plan on those facts and do NOT contradict them or re-read the structure from the FEN yourself. If it lists no weakness of some kind, do not claim one.',
    'Fill the four fields exactly:',
    hasPlayed
      ? '"whyBest": open with a three-word read of who stands better ("You are winning/better/slightly better", "Roughly equal", "You are worse"), then in one sentence what the engine\'s best move does and how the move actually played compares (better/worse and why); if the played move falls outside the candidate list, say so rather than inventing a number.'
      : '"whyBest": open with a three-word read of who stands better ("You are winning/better/slightly better", "Roughly equal", "You are worse"), then in one sentence what the best move concretely does (the piece, any capture or check) and the idea behind it.',
    '"plan": a concrete plan for the coached side over the next 5–8 moves, chosen to fit the Position facts. Pick the one or two most relevant of these ideas (offered because the position supports them) and make them specific to this board (which piece, which file, which break, which square):\n- ' + selectThemes(facts).join('\n- ') + '\nName the plan in terms of this position, not as a generic list. Give the moves as a short idea (e.g. "reroute the knight Nc2–e3–d5") rather than a long forced line.',
    hasPlayed
      ? '"opponentReply": how the opponent exploits the played move, using ONLY the evaluation gap and the principal variation; if nothing concrete is shown, say the punishment is positional rather than a forced line.'
      : '"opponentReply": the opponent\'s best reply (the second move of the principal variation) and the one idea behind it the coached player must watch; if the position is quiet, say so rather than inventing counterplay.',
    '"principle": one short, transferable chess maxim a 1200 player can reuse in other games (e.g. "rooks belong on open files"), tied in a few words to why it applies here.',
    'Keep all four fields together under ~150 words total.',
    langName ? `Write every text field in ${langName}, including chess terms where a natural translation exists.` : null,
    'Output only the JSON object matching the schema — no markdown, no text outside it.'
  ].filter(Boolean).join('\n');

  const user = [
    `Position (FEN): ${data.fen}`,
    `Side to move: ${sideToMoveName(data.fen)}`,
    data.userSide ? `Coached player: ${sideName(data.userSide)}` : null,
    factsText ? `Position facts (computed from the board — ground truth):\n${factsText}` : null,
    `Best move: ${bestLine}`,
    playedLine ? `Move actually played from this position: ${playedLine}` : null,
    `Evaluation: ${fmtEval(data.eval)}`,
    `Principal variation: ${pv}`,
    // Spell out the opponent's reply (PV move 2) so the model grounds
    // "opponentReply" on it instead of guessing — weaker models mis-count PV
    // tokens. Only meaningful live (in review, the played move has its own line).
    !hasPlayed && (replySan) ? `Opponent's best reply: ${replySan}` : null,
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
