// explain.js — turns a Stockfish evaluation into a short, human-readable reason,
// using only concrete board facts (what moved, what it captured, whether it
// gives check) plus the engine's centipawn delta. No language model, no
// network: the explanation is GROUNDED in the engine score and the position, so
// it is terse but never makes things up.
//
// Pure: no DOM, no chrome, no Worker. It only needs chesscore for square names
// and to derive the SAN of a UCI move. Runs both as a content script (globals)
// and under the Node test runner.

const _eIsNode = typeof module !== 'undefined' && module.exports;
const _ecc = _eIsNode ? require('./chesscore.js') : globalThis;
const _eI18n = _eIsNode ? require('./i18n.js') : globalThis.ChessI18n;

const PIECE_KEYS = { p: 'pieceP', n: 'pieceN', b: 'pieceB', r: 'pieceR', q: 'pieceQ', k: 'pieceK' };
// Rough value, only used to decide whether a capture/hang is worth mentioning.
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function pieceName(ch, lang = 'en') {
  const key = ch ? PIECE_KEYS[ch.toLowerCase()] : null;
  return _eI18n.t(lang, key || 'pieceGeneric');
}

// A score is { type: 'cp' | 'mate', value } as reported by the engine, relative
// to the side to move. flip negates it so the caller can show it from a fixed
// point of view (e.g. always the user's side).
function formatScore(score, flip) {
  if (!score) return '';
  const sign = flip ? -1 : 1;
  if (score.type === 'mate') {
    const m = score.value * sign;
    return m >= 0 ? `M${Math.abs(m)}` : `−M${Math.abs(m)}`;
  }
  const cp = score.value * sign;
  return (cp >= 0 ? '+' : '−') + (Math.abs(cp) / 100).toFixed(2);
}

// Collapse a score onto a single comparable centipawn axis (mate counted as a
// large value, longer mates slightly smaller) so two scores from the same
// position can be subtracted to get a centipawn loss.
function scoreToCp(score) {
  if (!score) return 0;
  if (score.type === 'mate') {
    const big = 100000 - Math.min(Math.abs(score.value), 999);
    return score.value >= 0 ? big : -big;
  }
  return score.value;
}

// Classify the move that was actually played by how much evaluation it gave up
// versus the engine's best move (both from the mover's point of view).
function classify(cpLoss, lang = 'en') {
  if (cpLoss <= 20) return { key: 'best', label: _eI18n.t(lang, 'labelBest') };
  if (cpLoss <= 50) return { key: 'good', label: _eI18n.t(lang, 'labelGood') };
  if (cpLoss <= 90) return { key: 'inaccuracy', label: _eI18n.t(lang, 'labelInaccuracy') };
  if (cpLoss <= 200) return { key: 'mistake', label: _eI18n.t(lang, 'labelMistake') };
  return { key: 'blunder', label: _eI18n.t(lang, 'labelBlunder') };
}

// Attack geometry and check detection live in chesscore.js now (applySan
// needs them to disambiguate SAN by legality); re-exported here so existing
// callers and tests keep working. The local names are underscored because in
// the content-script world all these files share one global scope — chesscore
// already declared global functions named attacks/kingInCheck, and a top-level
// `const attacks` here would be a redeclaration SyntaxError that kills this
// whole file (see test/content-script-world.test.js).
const _attacks = _ecc.attacks;
const _kingInCheck = _ecc.kingInCheck;

function clonePos(p) {
  return { board: p.board.slice(), turn: p.turn, castling: { ...p.castling }, ep: p.ep };
}

// Concrete facts about playing `uci` from position `pos` (pos is not mutated).
//   { san, pieceChar, captured (char|null), promo (char|null), isCastle, givesCheck }
// Returns null if the move cannot be replayed.
function moveFacts(pos, uci) {
  if (!pos || typeof uci !== 'string' || uci.length < 4) return null;
  const from = _ecc.sqIndex(uci.slice(0, 2));
  const to = _ecc.sqIndex(uci.slice(2, 4));
  const pieceChar = pos.board[from];
  if (!pieceChar || pieceChar === '.') return null;
  const isPawn = pieceChar.toLowerCase() === 'p';
  // En passant: a pawn changing file onto an empty square still captures.
  const epCapture = isPawn && (from % 8) !== (to % 8) && pos.board[to] === '.';
  const captured = pos.board[to] !== '.' ? pos.board[to] : (epCapture ? (pieceChar === 'P' ? 'p' : 'P') : null);
  const isCastle = pieceChar.toLowerCase() === 'k' && Math.abs((to % 8) - (from % 8)) === 2;

  const clone = clonePos(pos);
  const san = _ecc.applyUci(clone, uci); // mutates clone, leaves pos intact
  if (!san) return null;
  const givesCheck = _kingInCheck(clone.board, clone.turn);

  return {
    san,
    pieceChar,
    captured: captured || null,
    promo: uci.length > 4 ? uci[4].toLowerCase() : null,
    isCastle,
    givesCheck
  };
}

// Explain why the engine likes `bestUci` from `pos`. `score` is the eval after
// it, from the side-to-move's perspective. `replyUci` is the opponent's best
// reply (PV second move), used only to name the expected response.
function explainBest(pos, bestUci, score, replyUci, lang = 'en') {
  const f = moveFacts(pos, bestUci);
  if (!f) return '';
  const t = (key, ...args) => _eI18n.t(lang, key, ...args);
  const bits = [];
  if (score && score.type === 'mate') {
    bits.push(t('forcesMateIn', Math.abs(score.value)));
  } else if (f.captured) {
    bits.push(t('capturesThe', pieceName(f.captured, lang)));
  } else if (f.isCastle) {
    bits.push(t('castlesToSafety'));
  } else if (f.promo) {
    bits.push(t('promotesToA', pieceName(f.promo, lang)));
  } else if (f.givesCheck) {
    bits.push(t('givesCheckInitiative'));
  } else {
    bits.push(t('keepsStrongest'));
  }
  if (f.givesCheck && bits.length && bits[0] !== t('givesCheckInitiative')) bits.push(t('withCheck'));

  let text = `${f.san} — ${bits.join(', ')}.`;
  if (replyUci) {
    const reply = moveFacts(pos2After(pos, bestUci), replyUci);
    if (reply) text += ` ${t('expectInReply', reply.san)}`;
  }
  return text;
}

// Position after playing `uci` (for naming the opponent's reply).
function pos2After(pos, uci) {
  const clone = clonePos(pos);
  return _ecc.applyUci(clone, uci) ? clone : pos;
}

// Explain the move that was actually played from `pos`. `bestUci` is the
// engine's preferred move, `cpLoss` the centipawn loss vs. it (mover's POV).
// `replyUci` is the opponent's strongest answer to the played move.
function explainPlayed(pos, playedUci, bestUci, cpLoss, replyUci, lang = 'en') {
  const cls = classify(cpLoss, lang);
  const f = moveFacts(pos, playedUci);
  if (!f) return { ...cls, text: '' };
  const t = (key, ...args) => _eI18n.t(lang, key, ...args);

  let text;
  if (cls.key === 'best' || cls.key === 'good') {
    if (f.captured) text = t('winsThe', pieceName(f.captured, lang));
    else if (f.givesCheck) text = t('strongWithCheck');
    else text = t('solidInLine');
  } else {
    // A weak move: name what it costs, and what the opponent can punish with.
    const reply = replyUci ? moveFacts(pos2After(pos, playedUci), replyUci) : null;
    if (reply && reply.captured && PIECE_VALUE[reply.captured.toLowerCase()] >= 3) {
      text = t('dropsThe', pieceName(reply.captured, lang), reply.san);
    } else if (reply) {
      text = t('enginePrefersTougher', sanOf(pos, bestUci), reply.san);
    } else {
      text = t('enginePrefers', sanOf(pos, bestUci));
    }
  }
  return { ...cls, text };
}

// SAN of a UCI move from a position, without mutating it ('' if unplayable).
function sanOf(pos, uci) {
  const clone = clonePos(pos);
  return _ecc.applyUci(clone, uci) || uci || '';
}

const _eExports = {
  pieceName, formatScore, scoreToCp, classify,
  attacks: _attacks, kingInCheck: _kingInCheck,
  moveFacts, explainBest, explainPlayed, sanOf
};
if (_eIsNode) {
  module.exports = _eExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessExplain = _eExports;
}
