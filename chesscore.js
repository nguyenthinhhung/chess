// chesscore.js — a minimal chess engine, only as much as opening lines need:
// apply a move given in SAN or UCI, track castling/en-passant, and emit FEN.
//
// Board convention matches pgn.js: square index = rank * 8 + file, where
// rank 0 is rank 1 and file 0 is 'a'. Uppercase = White piece, lowercase =
// black, '.' = empty. Like pgn.js this file is DOM/chrome-free so it runs both
// as a content script (globals) and under the Node test runner.

function startBoard() {
  return [
    'R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R',
    'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P',
    '.', '.', '.', '.', '.', '.', '.', '.',
    '.', '.', '.', '.', '.', '.', '.', '.',
    '.', '.', '.', '.', '.', '.', '.', '.',
    '.', '.', '.', '.', '.', '.', '.', '.',
    'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p',
    'r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'
  ];
}

const KNIGHT_HOPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const SLIDERS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
};

const fileOf = (i) => i % 8;
const rankOf = (i) => (i / 8) | 0;
const sqName = (i) => String.fromCharCode(97 + fileOf(i)) + (rankOf(i) + 1);
const sqIndex = (name) => (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);

// Can a non-pawn piece on `from` slide/hop to `to` with a clear path?
function pieceReaches(board, from, to) {
  if (from === to) return false;
  const pt = board[from].toLowerCase();
  const ff = fileOf(from), fr = rankOf(from);
  const dx = fileOf(to) - ff, dy = rankOf(to) - fr;
  if (pt === 'n') return KNIGHT_HOPS.some(([x, y]) => x === dx && y === dy);
  if (pt === 'k') return KING_STEPS.some(([x, y]) => x === dx && y === dy);
  const dirs = SLIDERS[pt];
  if (!dirs) return false;
  for (const [ox, oy] of dirs) {
    let f = ff + ox, r = fr + oy;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const i = r * 8 + f;
      if (i === to) return true;
      if (board[i] !== '.') break;
      f += ox; r += oy;
    }
  }
  return false;
}

function createPosition() {
  return {
    board: startBoard(),
    turn: 'w',
    castling: { K: true, Q: true, k: true, q: true },
    ep: -1 // en-passant target square index, or -1
  };
}

function isWhitePiece(p) {
  return p !== '.' && p === p.toUpperCase();
}

// Strip the trailing rook/king castling rights when a piece leaves or a rook
// is captured on a corner square.
function updateCastling(pos, from, to) {
  const corners = { 0: 'Q', 7: 'K', 56: 'q', 63: 'k' };
  if (from === 4) { pos.castling.K = false; pos.castling.Q = false; }
  if (from === 60) { pos.castling.k = false; pos.castling.q = false; }
  if (corners[from]) pos.castling[corners[from]] = false;
  if (corners[to]) pos.castling[corners[to]] = false;
}

// Apply a UCI move (e.g. "e2e4", "e1g1", "e7e8q") in place. Returns the move's
// SAN, or null if the move is not playable from the current position.
function applyUci(pos, uci) {
  if (typeof uci !== 'string' || uci.length < 4) return null;
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  const promo = uci.length > 4 ? uci[4].toLowerCase() : '';
  const piece = pos.board[from];
  if (!piece || piece === '.') return null;
  if (isWhitePiece(piece) !== (pos.turn === 'w')) return null;
  return commitMove(pos, from, to, promo);
}

// Resolve and apply a SAN move (e.g. "Nf3", "exd5", "O-O", "e8=Q"). Returns the
// move's UCI, or null if it cannot be matched to a legal-enough move.
function applySan(pos, sanRaw) {
  if (typeof sanRaw !== 'string') return null;
  const san = sanRaw.replace(/[+#!?]/g, '').trim();
  const white = pos.turn === 'w';

  if (san === 'O-O' || san === '0-0' || san === 'O-O-O' || san === '0-0-0') {
    const kingside = san.length === 3;
    const rank = white ? 0 : 7;
    const from = rank * 8 + 4;
    const to = rank * 8 + (kingside ? 6 : 2);
    if (pos.board[from] !== (white ? 'K' : 'k')) return null;
    const uci = sqName(from) + sqName(to);
    return commitMove(pos, from, to, '') ? uci : null;
  }

  const promoMatch = san.match(/=([QRBN])$/i);
  const promo = promoMatch ? promoMatch[1].toLowerCase() : '';
  const core = promo ? san.slice(0, san.length - 2) : san;

  // Pawn moves carry no leading piece letter.
  const isPawn = /^[a-h]/.test(core);
  let from = -1;
  let to;

  if (isPawn) {
    const capture = core.includes('x');
    if (capture) {
      const fromFile = core.charCodeAt(0) - 97;
      to = sqIndex(core.slice(core.indexOf('x') + 1));
      const dir = white ? -1 : 1;
      from = (rankOf(to) + dir) * 8 + fromFile;
    } else {
      to = sqIndex(core);
      const dir = white ? -1 : 1;
      const one = (rankOf(to) + dir) * 8 + fileOf(to);
      const want = white ? 'P' : 'p';
      if (pos.board[one] === want) {
        from = one;
      } else {
        const two = (rankOf(to) + 2 * dir) * 8 + fileOf(to);
        if (pos.board[one] === '.' && pos.board[two] === want) from = two;
      }
    }
    if (from < 0) return null;
    const uci = sqName(from) + sqName(to) + (promo || '');
    return commitMove(pos, from, to, promo) ? uci : null;
  }

  // Piece move: N/B/R/Q/K with optional disambiguation between the letter and
  // the destination, e.g. "Nbd2", "R1e2", "Qh4xe1".
  const pieceLetter = core[0];
  const body = core.slice(1).replace('x', '');
  to = sqIndex(body.slice(body.length - 2));
  const hint = body.slice(0, body.length - 2); // '', file, rank, or file+rank
  const want = white ? pieceLetter.toUpperCase() : pieceLetter.toLowerCase();

  const candidates = [];
  for (let i = 0; i < 64; i++) {
    if (pos.board[i] !== want) continue;
    if (!pieceReaches(pos.board, i, to)) continue;
    if (hint) {
      if (/[a-h]/.test(hint[0]) && fileOf(i) !== hint.charCodeAt(0) - 97) continue;
      const rankHint = hint.match(/[1-8]/);
      if (rankHint && rankOf(i) !== Number(rankHint[0]) - 1) continue;
    }
    candidates.push(i);
  }
  if (!candidates.length) return null;
  from = candidates[0];
  const uci = sqName(from) + sqName(to);
  return commitMove(pos, from, to, promo) ? uci : null;
}

// Mutate the board for a resolved from/to, handling castling rook movement,
// en-passant capture, and promotion. Returns the SAN of the move just played
// (without check/mate marks) so applyUci callers can label it.
function commitMove(pos, from, to, promo) {
  const piece = pos.board[from];
  const white = isWhitePiece(piece);
  const pt = piece.toLowerCase();
  let capture = pos.board[to] !== '.';
  let san;
  const nextEp = -1;

  if (pt === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    const kingside = fileOf(to) > fileOf(from);
    san = kingside ? 'O-O' : 'O-O-O';
    pos.board[to] = piece;
    pos.board[from] = '.';
    const rank = rankOf(from);
    const rFrom = rank * 8 + (kingside ? 7 : 0);
    const rTo = rank * 8 + (kingside ? 5 : 3);
    pos.board[rTo] = pos.board[rFrom];
    pos.board[rFrom] = '.';
  } else {
    // En passant: a pawn steps diagonally onto an empty square.
    if (pt === 'p' && fileOf(from) !== fileOf(to) && !capture) {
      capture = true;
      pos.board[rankOf(from) * 8 + fileOf(to)] = '.';
    }
    let dis = '';
    if (pt === 'p') {
      if (capture) dis = String.fromCharCode(97 + fileOf(from));
    } else if (pt !== 'k') {
      const rivals = [];
      for (let i = 0; i < 64; i++) {
        if (i === from || pos.board[i] === '.') continue;
        if (pos.board[i].toLowerCase() !== pt) continue;
        if (isWhitePiece(pos.board[i]) !== white) continue;
        if (pieceReaches(pos.board, i, to)) rivals.push(i);
      }
      if (rivals.length) {
        const ff = fileOf(from), fr = rankOf(from);
        if (rivals.every((r) => fileOf(r) !== ff)) dis = String.fromCharCode(97 + ff);
        else if (rivals.every((r) => rankOf(r) !== fr)) dis = String(fr + 1);
        else dis = sqName(from);
      }
    }
    const prefix = pt === 'p' ? '' : pt.toUpperCase();
    san = prefix + dis + (capture ? 'x' : '') + sqName(to);
    if (promo) san += '=' + promo.toUpperCase();
    pos.board[to] = promo ? (white ? promo.toUpperCase() : promo) : piece;
    pos.board[from] = '.';
  }

  updateCastling(pos, from, to);
  // Record a fresh en-passant target only after a two-square pawn push.
  pos.ep = (pt === 'p' && Math.abs(rankOf(to) - rankOf(from)) === 2)
    ? (rankOf(from) + (white ? 1 : -1)) * 8 + fileOf(from)
    : nextEp;
  pos.turn = white ? 'b' : 'w';
  return san;
}

function toFen(pos) {
  let rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (p === '.') { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const rights =
    (pos.castling.K ? 'K' : '') + (pos.castling.Q ? 'Q' : '') +
    (pos.castling.k ? 'k' : '') + (pos.castling.q ? 'q' : '');
  const ep = pos.ep >= 0 ? sqName(pos.ep) : '-';
  return `${rows.join('/')} ${pos.turn} ${rights || '-'} ${ep} 0 1`;
}

// Convenience: replay a list of SAN (or UCI) moves from the start and return
// the resulting position. Throws on the first move that won't resolve so bad
// repertoire data fails loudly in tests.
function replay(moves, { uci = false } = {}) {
  const pos = createPosition();
  moves.forEach((m, i) => {
    const ok = uci ? applyUci(pos, m) : applySan(pos, m);
    if (!ok) throw new Error(`Illegal move at ply ${i + 1}: "${m}"`);
  });
  return pos;
}

const _exports = {
  createPosition, applySan, applyUci, toFen, replay,
  startBoard, sqName, sqIndex, pieceReaches
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
} else if (typeof globalThis !== 'undefined') {
  // Content-script world: attach to globalThis so chess-coach.js / explain.js
  // can reach these regardless of cross-file const sharing quirks.
  Object.assign(globalThis, _exports);
}
