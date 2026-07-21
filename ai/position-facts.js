// ai/position-facts.js — computes the structural facts of a position straight
// from its FEN, so the AI coach reasons about a board it was TOLD about instead
// of one it had to read out of a FEN string (which language models do badly).
// This mirrors the codebase's existing rule — hand the model explicit facts
// (side to move, the move's piece description) rather than let it re-derive them.
//
// Pure: no DOM, no chrome, no network, and self-contained (its own tiny FEN
// board parser, no chesscore dependency) so it loads in the background service
// worker, as a content script, and under the Node test runner alike.
//
// describePosition(fen) → { material, phase, kings, openFiles, halfOpen,
// pawns, outposts, lines }. `lines` is the English, prompt-ready rendering;
// everything else is structured for tests and future callers.

const _pfIsNode = typeof module !== 'undefined' && module.exports;

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILE_CH = 'abcdefgh';

// FEN piece-placement → a 64-cell board indexed i = (rank-1)*8 + file, with
// file 0=a…7=h and rank 1…8 (so index 0 = a1, 63 = h8). Empty squares are '.'.
function parseBoard(fen) {
  const board = new Array(64).fill('.');
  const rows = String(fen || '').split(' ')[0].split('/');
  if (rows.length !== 8) return board;
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;           // the first FEN row is rank 8
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') file += ch.charCodeAt(0) - 48;
      else { if (file < 8) board[(rank - 1) * 8 + file] = ch; file++; }
    }
  }
  return board;
}

const fileOf = (i) => i % 8;
const rankOf = (i) => ((i / 8) | 0) + 1;
const sq = (file, rank) => FILE_CH[file] + rank;
const isWhitePiece = (p) => p >= 'A' && p <= 'Z';

// Split the board into the two sides' piece lists ({ char, file, rank }).
function collect(board) {
  const white = [], black = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === '.') continue;
    (isWhitePiece(p) ? white : black).push({ ch: p.toLowerCase(), file: fileOf(i), rank: rankOf(i) });
  }
  return { white, black };
}

const totalValue = (pieces) => pieces.reduce((m, x) => m + (VAL[x.ch] || 0), 0);

// A coarse game-phase label from the remaining non-pawn material (start = 24).
function phaseOf(white, black) {
  const count = (side, ch) => side.filter((x) => x.ch === ch).length;
  const minors = count(white, 'n') + count(white, 'b') + count(black, 'n') + count(black, 'b');
  const rooks = count(white, 'r') + count(black, 'r');
  const queens = count(white, 'q') + count(black, 'q');
  const score = minors + rooks * 2 + queens * 4;
  if (score >= 20) return 'opening';
  if (score >= 10) return 'middlegame';
  return 'endgame';
}

// Where a king sits and which wing it lives on (by file), so the coach can talk
// about same- vs opposite-side castling and pawn storms without guessing.
function kingInfo(pieces) {
  const k = pieces.find((x) => x.ch === 'k');
  if (!k) return null;
  const side = k.file >= 5 ? 'kingside' : (k.file <= 2 ? 'queenside' : 'center');
  return { sq: sq(k.file, k.rank), side };
}

// Per-file pawn presence for one side: files[f] = array of ranks with a pawn.
function pawnsByFile(pieces) {
  const files = Array.from({ length: 8 }, () => []);
  for (const p of pieces) if (p.ch === 'p') files[p.file].push(p.rank);
  return files;
}

function openAndHalfOpen(wFiles, bFiles) {
  const open = [], halfWhite = [], halfBlack = [];
  for (let f = 0; f < 8; f++) {
    const w = wFiles[f].length, b = bFiles[f].length;
    if (!w && !b) open.push(FILE_CH[f]);
    else if (!w && b) halfWhite.push(FILE_CH[f]);   // no White pawn → half-open FOR White
    else if (w && !b) halfBlack.push(FILE_CH[f]);
  }
  return { open, halfWhite, halfBlack };
}

// Pawn-structure weaknesses for one side. `dir` is +1 for White (pawns advance
// up the board), -1 for Black. `enemyFiles` is the opponent's pawnsByFile.
function pawnWeaknesses(myFiles, enemyFiles, dir) {
  const isolated = [], doubled = [], backward = [], passed = [];
  const hasMine = (f) => f >= 0 && f < 8 && myFiles[f].length > 0;

  for (let f = 0; f < 8; f++) {
    const ranks = myFiles[f];
    if (!ranks.length) continue;
    if (ranks.length >= 2) doubled.push(FILE_CH[f]);

    const neighbourless = !hasMine(f - 1) && !hasMine(f + 1);
    for (const r of ranks) {
      if (neighbourless) isolated.push(sq(f, r));

      // Passed: no enemy pawn on this or an adjacent file anywhere ahead.
      const ahead = (er) => (dir > 0 ? er > r : er < r);
      const blocked = [f - 1, f, f + 1].some((af) =>
        af >= 0 && af < 8 && enemyFiles[af].some(ahead));
      if (!blocked) passed.push(sq(f, r));

      // Backward: cannot be supported by a friendly pawn from behind/level, and
      // the square in front is covered by an enemy pawn — so it can't advance.
      const support = [f - 1, f + 1].some((af) =>
        af >= 0 && af < 8 && myFiles[af].some((mr) => (dir > 0 ? mr <= r : mr >= r)));
      const frontRank = r + dir;
      const frontCovered = [f - 1, f + 1].some((af) =>
        af >= 0 && af < 8 && enemyFiles[af].includes(frontRank + dir));
      if (!support && frontCovered && !neighbourless) backward.push(sq(f, r));
    }
  }
  return { isolated, doubled, backward, passed };
}

// Squares that make a good knight home: standing in enemy territory, defended
// by one of my pawns, and un-attackable by any enemy pawn now or later.
function outposts(myFiles, enemyFiles, dir) {
  const ranks = dir > 0 ? [4, 5, 6] : [5, 4, 3];
  const out = [];
  for (const r of ranks) {
    for (let f = 0; f < 8; f++) {
      const defended = [f - 1, f + 1].some((af) =>
        af >= 0 && af < 8 && myFiles[af].includes(r - dir));
      if (!defended) continue;
      // An enemy pawn on an adjacent file that is still behind the square (from
      // its own advancing point of view) could one day come and attack it.
      const attackable = [f - 1, f + 1].some((af) =>
        af >= 0 && af < 8 && enemyFiles[af].some((er) => (dir > 0 ? er > r : er < r)));
      if (!attackable) out.push(sq(f, r));
    }
  }
  return out.slice(0, 3);
}

function materialLine(whiteMat, blackMat) {
  const diff = whiteMat - blackMat;
  if (diff === 0) return 'Material: roughly equal.';
  const who = diff > 0 ? 'White' : 'Black';
  const n = Math.abs(diff);
  const worth = n === 1 ? 'a pawn' : n === 2 ? 'about two pawns'
    : n === 3 ? 'a minor piece' : n === 5 ? 'a rook' : n === 9 ? 'a queen'
    : `about ${n} points`;
  return `Material: ${who} is up ${worth} (+${n}).`;
}

function pawnLine(side, w) {
  const bits = [];
  if (w.isolated.length) bits.push(`isolated pawn(s) on ${w.isolated.join(', ')}`);
  if (w.doubled.length) bits.push(`doubled pawns on the ${w.doubled.join(', ')}-file`);
  if (w.backward.length) bits.push(`backward pawn(s) on ${w.backward.join(', ')}`);
  if (w.passed.length) bits.push(`passed pawn(s) on ${w.passed.join(', ')}`);
  return bits.length ? `${side} pawn weaknesses/strengths: ${bits.join('; ')}.` : null;
}

function describePosition(fen) {
  const board = parseBoard(fen);
  const { white, black } = collect(board);
  const whiteMat = totalValue(white), blackMat = totalValue(black);
  const phase = phaseOf(white, black);
  const kings = { white: kingInfo(white), black: kingInfo(black) };

  const wFiles = pawnsByFile(white), bFiles = pawnsByFile(black);
  const files = openAndHalfOpen(wFiles, bFiles);
  const pawns = {
    white: pawnWeaknesses(wFiles, bFiles, +1),
    black: pawnWeaknesses(bFiles, wFiles, -1)
  };
  const outp = { white: outposts(wFiles, bFiles, +1), black: outposts(bFiles, wFiles, -1) };

  const lines = [];
  lines.push(materialLine(whiteMat, blackMat));
  lines.push(`Phase: ${phase}.`);
  const kingBit = (label, k) => k
    ? `${label} ${k.side === 'center' ? `king in the center (K${k.sq})` : `castled ${k.side} (K${k.sq})`}`
    : null;
  const kb = [kingBit('White', kings.white), kingBit('Black', kings.black)].filter(Boolean);
  if (kb.length) lines.push('Kings: ' + kb.join('; ') + '.');
  if (files.open.length) lines.push(`Open files: ${files.open.join(', ')}.`);
  const half = [];
  if (files.halfWhite.length) half.push(`White: ${files.halfWhite.join(', ')}`);
  if (files.halfBlack.length) half.push(`Black: ${files.halfBlack.join(', ')}`);
  if (half.length) lines.push('Half-open files — ' + half.join('; ') + '.');
  const wl = pawnLine('White', pawns.white); if (wl) lines.push(wl);
  const bl = pawnLine('Black', pawns.black); if (bl) lines.push(bl);
  const op = [];
  if (outp.white.length) op.push(`White ${outp.white.join(', ')}`);
  if (outp.black.length) op.push(`Black ${outp.black.join(', ')}`);
  if (op.length) lines.push('Outpost squares (pawn-protected, safe from enemy pawns): ' + op.join('; ') + '.');

  return { material: { white: whiteMat, black: blackMat }, phase, kings, openFiles: files.open, halfOpen: { white: files.halfWhite, black: files.halfBlack }, pawns, outposts: outp, lines };
}

const _pfExports = { describePosition, parseBoard };
if (_pfIsNode) {
  module.exports = _pfExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessPositionFacts = _pfExports;
}
