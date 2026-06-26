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

const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
// Rough value, only used to decide whether a capture/hang is worth mentioning.
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function pieceName(ch) {
  return ch ? (PIECE_NAMES[ch.toLowerCase()] || 'piece') : 'piece';
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
function classify(cpLoss) {
  if (cpLoss <= 20) return { key: 'best', label: 'Best move' };
  if (cpLoss <= 50) return { key: 'good', label: 'Good move' };
  if (cpLoss <= 90) return { key: 'inaccuracy', label: 'Inaccuracy' };
  if (cpLoss <= 200) return { key: 'mistake', label: 'Mistake' };
  return { key: 'blunder', label: 'Blunder' };
}

// Does a piece on `from` attack `to`? Pieces use chesscore's geometry; pawns
// are handled here because chesscore only resolves pawn pushes, not attacks.
function attacks(board, from, to) {
  const p = board[from];
  if (p === '.' || from === to) return false;
  if (p.toLowerCase() === 'p') {
    const white = p === 'P';
    const ff = from % 8, fr = (from / 8) | 0;
    const tf = to % 8, tr = (to / 8) | 0;
    return Math.abs(tf - ff) === 1 && tr - fr === (white ? 1 : -1);
  }
  return _ecc.pieceReaches(board, from, to);
}

// Is `color` ('w'|'b') to-move king currently attacked on this board?
function kingInCheck(board, color) {
  const king = color === 'w' ? 'K' : 'k';
  const kingSq = board.indexOf(king);
  if (kingSq < 0) return false;
  const enemyIsWhite = color === 'b';
  for (let i = 0; i < 64; i++) {
    const pc = board[i];
    if (pc === '.') continue;
    if ((pc === pc.toUpperCase()) !== enemyIsWhite) continue;
    if (attacks(board, i, kingSq)) return true;
  }
  return false;
}

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
  const givesCheck = kingInCheck(clone.board, clone.turn);

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
function explainBest(pos, bestUci, score, replyUci) {
  const f = moveFacts(pos, bestUci);
  if (!f) return '';
  const bits = [];
  if (score && score.type === 'mate') {
    bits.push(`forces mate in ${Math.abs(score.value)}`);
  } else if (f.captured) {
    bits.push(`captures the ${pieceName(f.captured)}`);
  } else if (f.isCastle) {
    bits.push('castles the king to safety');
  } else if (f.promo) {
    bits.push(`promotes to a ${pieceName(f.promo)}`);
  } else if (f.givesCheck) {
    bits.push('gives check and keeps the initiative');
  } else {
    bits.push('keeps the strongest position here');
  }
  if (f.givesCheck && bits.length && !/check/.test(bits[0])) bits.push('with check');

  let text = `${f.san} — ${bits.join(', ')}.`;
  if (replyUci) {
    const reply = moveFacts(pos2After(pos, bestUci), replyUci);
    if (reply) text += ` Expect ${reply.san} in reply.`;
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
function explainPlayed(pos, playedUci, bestUci, cpLoss, replyUci) {
  const cls = classify(cpLoss);
  const f = moveFacts(pos, playedUci);
  if (!f) return { ...cls, text: '' };

  let text;
  if (cls.key === 'best' || cls.key === 'good') {
    if (f.captured) text = `Wins the ${pieceName(f.captured)}.`;
    else if (f.givesCheck) text = 'A strong move with check.';
    else text = 'Solid — right in line with the engine.';
  } else {
    // A weak move: name what it costs, and what the opponent can punish with.
    const reply = replyUci ? moveFacts(pos2After(pos, playedUci), replyUci) : null;
    if (reply && reply.captured && PIECE_VALUE[reply.captured.toLowerCase()] >= 3) {
      text = `Drops the ${pieceName(reply.captured)} — the opponent can answer ${reply.san}.`;
    } else if (reply) {
      text = `The engine prefers ${sanOf(pos, bestUci)}; ${reply.san} is the tougher reply.`;
    } else {
      text = `The engine prefers ${sanOf(pos, bestUci)}.`;
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
  attacks, kingInCheck, moveFacts, explainBest, explainPlayed, sanOf
};
if (_eIsNode) {
  module.exports = _eExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessExplain = _eExports;
}
