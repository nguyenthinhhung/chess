// Pure PGN conversion helpers, shared by content.js (loaded as a content
// script before content.js) and the Node tests in test/pgn.test.js.
// Nothing here touches the DOM or chrome APIs, so it runs in both worlds.

// Chess.com encodes moves in TCN: 2 chars per move (from-square, to-square)
// drawn from a 64-char alphabet. Indices >63 in the to-position encode
// promotions: piece = floor((idx-64)/3), file offset = (idx-64)%3 - 1.
const TCN_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
const TCN_PROMO_PIECES = ['q', 'n', 'r', 'b'];

function decodeTcn(moveList) {
  if (typeof moveList !== 'string' || !moveList.length) return null;
  const moves = [];
  for (let i = 0; i < moveList.length; i += 2) {
    const from = TCN_CHARS.indexOf(moveList[i]);
    let to = TCN_CHARS.indexOf(moveList[i + 1]);
    if (from < 0 || to < 0) return null;

    let promotion = '';
    if (to > 63) {
      const code = to - 64;
      promotion = TCN_PROMO_PIECES[Math.floor(code / 3)] || 'q';
      const direction = (code % 3) - 1;
      const fromFile = from % 8;
      const fromRank = Math.floor(from / 8);
      const toFile = fromFile + direction;
      const toRank = fromRank === 6 ? 7 : 0;
      to = toRank * 8 + toFile;
    }

    const fromSq = String.fromCharCode(97 + (from % 8)) + (Math.floor(from / 8) + 1);
    const toSq = String.fromCharCode(97 + (to % 8)) + (Math.floor(to / 8) + 1);
    moves.push(fromSq + toSq + promotion);
  }
  return moves;
}

// Replay UCI moves on a virtual board to produce SAN. Lichess's PGN parser
// accepts pawn UCI by accident (it overlaps with LAN) but rejects piece UCI
// like `d8d5`, so we have to convert. Check/mate marks are omitted — Lichess
// re-derives them from the game on import.
const SAN_KNIGHT = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const SAN_KING = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
const SAN_SLIDERS = {
  b: [[1,1],[1,-1],[-1,1],[-1,-1]],
  r: [[1,0],[-1,0],[0,1],[0,-1]],
  q: [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
};

function sanStartingBoard() {
  return [
    'R','N','B','Q','K','B','N','R',
    'P','P','P','P','P','P','P','P',
    '.','.','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.',
    '.','.','.','.','.','.','.','.',
    'p','p','p','p','p','p','p','p',
    'r','n','b','q','k','b','n','r'
  ];
}

function sanReachable(board, from, to) {
  const pt = board[from].toLowerCase();
  const ff = from % 8, fr = (from / 8) | 0;
  const tf = to % 8, tr = (to / 8) | 0;
  const dx = tf - ff, dy = tr - fr;
  if (pt === 'n') return SAN_KNIGHT.some(([x, y]) => x === dx && y === dy);
  if (pt === 'k') return SAN_KING.some(([x, y]) => x === dx && y === dy);
  const dirs = SAN_SLIDERS[pt];
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

function uciListToSan(uciMoves, board = sanStartingBoard()) {
  const out = [];
  for (const uci of uciMoves) {
    const from = (uci.charCodeAt(1) - 49) * 8 + (uci.charCodeAt(0) - 97);
    const to = (uci.charCodeAt(3) - 49) * 8 + (uci.charCodeAt(2) - 97);
    const promo = uci.length > 4 ? uci[4].toLowerCase() : '';
    const piece = board[from];
    if (!piece || piece === '.') return null;
    const isWhite = piece === piece.toUpperCase();
    const pt = piece.toLowerCase();
    let isCapture = board[to] !== '.';
    let san;

    if (pt === 'k' && Math.abs((to % 8) - (from % 8)) === 2) {
      san = (to % 8) > (from % 8) ? 'O-O' : 'O-O-O';
      board[to] = piece;
      board[from] = '.';
      const rank = (from / 8) | 0;
      const kingside = (to % 8) > (from % 8);
      const rFrom = rank * 8 + (kingside ? 7 : 0);
      const rTo = rank * 8 + (kingside ? 5 : 3);
      board[rTo] = board[rFrom];
      board[rFrom] = '.';
    } else {
      // En passant: pawn moves diagonally to empty square.
      if (pt === 'p' && (from % 8) !== (to % 8) && !isCapture) {
        isCapture = true;
        board[((from / 8) | 0) * 8 + (to % 8)] = '.';
      }
      let dis = '';
      if (pt === 'p') {
        if (isCapture) dis = String.fromCharCode(97 + (from % 8));
      } else if (pt !== 'k') {
        const rivals = [];
        for (let i = 0; i < 64; i++) {
          if (i === from || board[i] === '.') continue;
          if (board[i].toLowerCase() !== pt) continue;
          if ((board[i] === board[i].toUpperCase()) !== isWhite) continue;
          if (sanReachable(board, i, to)) rivals.push(i);
        }
        if (rivals.length) {
          const ff = from % 8, fr = (from / 8) | 0;
          if (rivals.every((r) => (r % 8) !== ff)) {
            dis = String.fromCharCode(97 + ff);
          } else if (rivals.every((r) => ((r / 8) | 0) !== fr)) {
            dis = String(fr + 1);
          } else {
            dis = String.fromCharCode(97 + ff) + (fr + 1);
          }
        }
      }
      const prefix = pt === 'p' ? '' : pt.toUpperCase();
      const target = String.fromCharCode(97 + (to % 8)) + (((to / 8) | 0) + 1);
      san = prefix + dis + (isCapture ? 'x' : '') + target;
      if (promo) san += '=' + promo.toUpperCase();
      board[to] = promo ? (isWhite ? promo.toUpperCase() : promo) : piece;
      board[from] = '.';
    }
    out.push(san);
  }
  return out;
}

function buildPgn(game) {
  if (!game.pgnHeaders) return null;
  const headers = Object.entries(game.pgnHeaders)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n');
  const uci = decodeTcn(game.moveList);
  if (!uci || !uci.length) return null;
  const moves = uciListToSan(uci) || uci;
  const body = moves
    .map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m))
    .join(' ');
  const result = game.pgnHeaders.Result || '*';
  return `${headers}\n\n${body} ${result}\n`;
}

// Exported for the Node test runner; a no-op in the content-script world
// where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decodeTcn, uciListToSan, buildPgn, sanStartingBoard };
}
