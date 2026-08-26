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

// Ray directions per sliding piece, for pin geometry (mirrors chesscore's
// SLIDERS, which it doesn't export).
const _RAY = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
};
const _mFileOf = (i) => i % 8;
const _mRankOf = (i) => (i / 8) | 0;
const _mIsEnemy = (p, moverWhite) => p !== '.' && (p === p.toUpperCase()) !== moverWhite;

// Is `sq` defended by any piece of `defenderWhite`'s colour on this board?
function _defendedBy(board, sq, defenderWhite) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === '.' || i === sq) continue;
    if ((p === p.toUpperCase()) !== defenderWhite) continue;
    if (_attacks(board, i, sq)) return true;
  }
  return false;
}

// Name the tactical motif(s) a move CREATES, read from concrete geometry on the
// board AFTER it is played — never a guess. Deliberately conservative: a wrong
// label teaches the wrong thing, so it fires only on high-confidence patterns
// and prefers silence otherwise. Crucially this is meant to run on the ENGINE'S
// BEST move (which the search has already vetted as sound), so a "fork" can't be
// a hung-piece false positive the way it could on an arbitrary move.
//   Motifs: fork, absolute pin (against the king), discovered check, double check.
// Returns i18n keys in priority order, at most two.
function detectMotifs(pos, uci) {
  if (!pos || typeof uci !== 'string' || uci.length < 4) return [];
  const clone = clonePos(pos);
  if (!_ecc.applyUci(clone, uci)) return [];
  const board = clone.board;
  const moverWhite = pos.turn === 'w';
  const enemyColor = moverWhite ? 'b' : 'w';
  const to = _ecc.sqIndex(uci.slice(2, 4));
  const moved = board[to];
  if (!moved || moved === '.') return [];       // e.g. castling — no single landing piece to reason about
  const movedType = moved.toLowerCase();
  const movedVal = PIECE_VALUE[movedType] || 0;
  const motifs = [];

  // Discovered / double check: the enemy king is in check after the move. Any
  // checker is either the moved piece or one it un-blocked (before the move the
  // enemy king could not have been in check). If the moved piece is NOT among
  // the checkers, the check was discovered; if it is AND another piece also
  // checks, it's a double check.
  if (_kingInCheck(board, enemyColor)) {
    const kingSq = board.indexOf(enemyColor === 'w' ? 'K' : 'k');
    let movedChecks = false, otherChecks = false;
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (p === '.' || (p === p.toUpperCase()) !== moverWhite) continue;
      if (!_attacks(board, i, kingSq)) continue;
      if (i === to) movedChecks = true; else otherChecks = true;
    }
    if (movedChecks && otherChecks) motifs.push('motifDoubleCheck');
    else if (!movedChecks && otherChecks) motifs.push('motifDiscoveredCheck');
  }

  // Fork: the moved piece attacks two or more winnable enemy targets — the king
  // (a check leg), or a minor-or-better piece that is either worth more than the
  // forker or undefended. Pawns are ignored so a routine pawn push isn't a "fork".
  let forkTargets = 0;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!_mIsEnemy(p, moverWhite) || !_attacks(board, to, i)) continue;
    const t = p.toLowerCase();
    if (t === 'k') { forkTargets++; continue; }
    const val = PIECE_VALUE[t] || 0;
    if (val < 3) continue;
    if (val > movedVal || !_defendedBy(board, i, !moverWhite)) forkTargets++;
  }
  if (forkTargets >= 2) motifs.push('motifFork');

  // Absolute pin: from the moved slider, along one of its ray directions, the
  // first piece is an enemy non-king and the next piece on that ray is the enemy
  // king — so the shield cannot move without exposing its king.
  if (_RAY[movedType]) {
    const kingChar = enemyColor === 'w' ? 'K' : 'k';
    for (const [ox, oy] of _RAY[movedType]) {
      let f = _mFileOf(to) + ox, r = _mRankOf(to) + oy, shield = -1;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const i = r * 8 + f;
        const p = board[i];
        if (p !== '.') {
          if (shield < 0) {
            if (!_mIsEnemy(p, moverWhite) || p.toLowerCase() === 'k') break;
            shield = i;
          } else {
            if (p === kingChar) motifs.push('motifPin');
            break;
          }
        }
        f += ox; r += oy;
      }
      if (motifs.includes('motifPin')) break;
    }
  }

  return [...new Set(motifs)].slice(0, 2);
}

// ---- threats (the "Threats only" display level) ------------------------------
// The same position with the move handed to the other side — a null move, as if
// you had passed. Castling rights survive; en passant does not (it expires the
// moment it isn't taken). Returns null when the side to move is IN CHECK: then
// passing isn't even a legal construct to reason about, and the check itself is
// the only threat worth naming.
function nullPosition(pos) {
  if (!pos || _kingInCheck(pos.board, pos.turn)) return null;
  const p = clonePos(pos);
  p.turn = pos.turn === 'w' ? 'b' : 'w';
  p.ep = -1;
  return p;
}

// Which of the opponent's moves are worth WARNING about, from a search on the
// null position above. Because that search starts from the board as it stands,
// its lines are the opponent's plans against your CURRENT setup — not replies to
// a move you haven't chosen yet, which is what "danger" means before you move.
//
//   pos         the null position (opponent to move); not mutated
//   lines       that search's MultiPV lines, scores from the OPPONENT's POV
//   baselineCp  the real eval with YOU to move, from YOUR point of view
//
// A line only counts as a threat when allowing it would cost you at least
// `minCp` against that baseline: handing over the move is worth a tempo or two
// by itself, so a small drop means nothing and warning about it is pure noise.
// Returns [{ move, san, lossCp, mateIn, text, motifs }], worst first.
function describeThreats(pos, lines, baselineCp, opts = {}) {
  const { minCp = 150, max = 3, lang = 'en' } = opts;
  const t = (key, ...args) => _eI18n.t(lang, key, ...args);
  const out = [];
  for (const ln of lines || []) {
    if (!ln || !ln.move || !ln.score) continue;
    const mateIn = ln.score.type === 'mate' && ln.score.value > 0 ? ln.score.value : null;
    // scoreToCp(ln.score) is the opponent's POV; negate to get yours. Clamped
    // because either side of that subtraction may be a mate score, which
    // scoreToCp deliberately collapses onto a huge number — past ~20 pawns the
    // figure has stopped meaning anything except "catastrophic", and printing
    // "−1004.98" would just look broken.
    const lossCp = Math.min(baselineCp - (-scoreToCp(ln.score)), 2000);
    if (!mateIn && lossCp < minCp) continue;
    const f = moveFacts(pos, ln.move);
    if (!f) continue;
    // Why it hurts, in that order of alarm: mate, then material, then "this
    // just wins" for a positional crush the board facts can't name.
    const bits = [];
    if (mateIn) bits.push(t('forcesMateIn', mateIn));
    else if (f.captured) bits.push(t('capturesThe', pieceName(f.captured, lang)));
    else bits.push(t('threatWinsAdvantage'));
    if (f.givesCheck && !mateIn) bits.push(t('withCheck'));
    out.push({
      move: ln.move,
      san: f.san + (f.givesCheck ? '+' : ''),
      lossCp, mateIn,
      text: bits.join(' '),
      motifs: detectMotifs(pos, ln.move)
    });
  }
  // Mate outranks any centipawn swing; otherwise the biggest loss first.
  const rank = (x) => (x.mateIn ? 1e9 - x.mateIn : x.lossCp);
  out.sort((a, b) => rank(b) - rank(a));
  return out.slice(0, max);
}

const _eExports = {
  pieceName, formatScore, scoreToCp, classify,
  attacks: _attacks, kingInCheck: _kingInCheck,
  moveFacts, explainBest, explainPlayed, sanOf, detectMotifs,
  nullPosition, describeThreats
};
if (_eIsNode) {
  module.exports = _eExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessExplain = _eExports;
}
