// coach.js — the opening coach engine. Given the moves played so far (as a list
// of UCI strings) and which side the user is, it walks the repertoire and
// reports: which opening/line we are in, whether everyone is still "in book",
// what the user should play next, and who (if anyone) left preparation.
//
// Pure: no DOM, no chrome. Matching is done by UCI (re-derived from the board)
// so the SAN written in repertoire.js never has to match exactly.

const _isNode = typeof module !== 'undefined' && module.exports;
const _cc = _isNode ? require('./chesscore.js') : globalThis;
const _createPosition = _cc.createPosition;
const _applySan = _cc.applySan;
const _applyUci = _cc.applyUci;
const _toFen = _cc.toFen;
const _REPERTOIRE = _isNode ? require('./repertoire.js').REPERTOIRE : globalThis.REPERTOIRE;

function clonePosition(p) {
  return { board: p.board.slice(), turn: p.turn, castling: { ...p.castling }, ep: p.ep };
}

// What UCI does this SAN node produce from `pos`? Null if it can't be played.
function childUci(pos, node) {
  return _applySan(clonePosition(pos), node.m);
}

// Resolve a book node for display: SAN as authored + its concrete UCI + hints.
function describeMove(pos, node) {
  return { san: node.m, uci: childUci(pos, node), name: node.name || null, note: node.note || null };
}

// Walk one opening's tree against the played UCI list.
function matchLine(opening, playedUci) {
  const pos = _createPosition();
  let siblings = opening.tree;
  let matched = 0;
  let lineName = opening.name;
  let note = opening.summary || null;
  let off = null;

  for (let i = 0; i < playedUci.length; i++) {
    const uci = playedUci[i];
    let found = null;
    for (const child of siblings) {
      if (childUci(pos, child) === uci) { found = child; break; }
    }
    if (!found) {
      off = { ply: i, side: i % 2 === 0 ? 'w' : 'b', uci };
      break;
    }
    if (!_applyUci(pos, uci)) { off = { ply: i, side: i % 2 === 0 ? 'w' : 'b', uci }; break; }
    matched = i + 1;
    if (found.name) lineName = found.name;
    if (found.note) note = found.note;
    siblings = found.children || [];
  }

  return { pos, siblings, matched, lineName, note, off };
}

// Public entry point.
//   playedUci     : array of UCI strings from move 1.
//   opts.openingId: restrict to a single opening (e.g. 'caro-kann'). Wins over
//                   opts.side. Use when the user has picked what to train.
//   opts.side     : 'w' | 'b' — the side the user is playing. If given (and no
//                   openingId), only openings for that side are considered.
// Returns null if no opening is a meaningful match (nothing matched at all).
function analyze(playedUci, opts = {}) {
  const moves = Array.isArray(playedUci) ? playedUci : [];
  const candidates = _REPERTOIRE.filter((o) =>
    opts.openingId ? o.id === opts.openingId : (!opts.side || o.side === opts.side)
  );
  if (!candidates.length) return null;

  let best = null;
  for (const opening of candidates) {
    const line = matchLine(opening, moves);
    if (!best || line.matched > best.line.matched) best = { opening, line };
  }
  if (!best) return null;

  const { opening, line } = best;
  // With no moves yet there is nothing to coach, but we still surface the plan.
  const userSide = opening.side;
  const sideToMove = moves.length % 2 === 0 ? 'w' : 'b';
  const userToMove = sideToMove === userSide;

  // Book options at the current frontier (either the next move, or — if someone
  // left book — the moves that SHOULD have been played at that ply).
  const bookMoves = line.siblings
    .map((node) => describeMove(line.pos, node))
    .filter((m) => m.uci);

  let status;
  if (line.off) {
    status = line.off.side === userSide ? 'user-left-book' : 'opp-left-book';
  } else if (line.siblings.length === 0) {
    status = 'line-complete';
  } else {
    status = 'on-book';
  }

  return {
    openingId: opening.id,
    openingName: opening.name,
    lineName: line.lineName,
    eco: opening.eco || null,
    note: line.note,
    status,                 // on-book | user-left-book | opp-left-book | line-complete
    matchedPlies: line.matched,
    userSide,
    sideToMove,
    userToMove,
    fen: _toFen(line.pos),
    off: line.off,          // { ply, side, uci } or null
    bookMoves,              // resolved [{san, uci, name, note}]
    // The single move to play, when it is the user's turn and we are on book.
    recommended: userToMove && !line.off && bookMoves.length ? bookMoves[0] : null
  };
}

if (_isNode) {
  module.exports = { analyze, matchLine, REPERTOIRE: _REPERTOIRE };
} else if (typeof globalThis !== 'undefined') {
  globalThis.analyze = analyze;
}
