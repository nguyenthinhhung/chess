// chess-coach-bridge.js — runs in the MAIN world (see manifest "world": "MAIN").
//
// chess.com's board is a <wc-chess-board> custom element that exposes a `game`
// API in the page's JS context. Content scripts run in an isolated world and
// can't touch that object, so this tiny bridge lives in the main world, reads
// the move list straight from the game API (clean SAN, no figurine/DOM
// scraping), and forwards it to the isolated-world coach via window.postMessage.
//
// It only READS and only forwards moves; chess-coach.js decides what to do with
// them (it coaches in every game, including live games against humans).

(function () {
  let last = '';

  // A single attempt at a self-consistent snapshot. Returns:
  //   null      — no board/game right now (not worth retrying)
  //   undefined — a move landed mid-read and tore this snapshot (caller should retry)
  //   object    — a consistent { sans, playingAs, plyViewed, fen }
  function readGameOnce() {
    const board = document.querySelector('wc-chess-board, chess-board');
    const game = board && board.game;
    if (!game || typeof game.getHistorySANs !== 'function') return null;
    let sans;
    try { sans = game.getHistorySANs() || []; } catch { return null; }
    let playingAs = null;
    try { playingAs = typeof game.getPlayingAs === 'function' ? game.getPlayingAs() : null; } catch {}
    // getHistorySANs() always returns the FULL game, even while the user is
    // scrubbing back through past moves — only getSelectedNode() tracks what is
    // actually on screen (null at the starting position, before any move).
    // Confirmed live: on a finished game, moveBackward() changes getFEN() and
    // getSelectedNode().ply but leaves getHistorySANs() untouched.
    let plyViewed = sans.length;
    try {
      if (typeof game.getSelectedNode === 'function') {
        const node = game.getSelectedNode();
        plyViewed = node && typeof node.ply === 'number' ? node.ply : 0;
      }
    } catch {}
    // A move can land on the board between the two reads above (most likely
    // in a fast live game). If it did, `sans` and `plyViewed` now describe two
    // different instants — e.g. plyViewed already counts a move `sans` doesn't
    // have yet — and chess-coach would analyse/label a stale ply as if it were
    // live. Re-read the history right after; if its length changed, the reads
    // were torn — signal the caller to retry rather than reporting them.
    let sansRecheck;
    try { sansRecheck = game.getHistorySANs() || []; } catch { return null; }
    if (sansRecheck.length !== sans.length) return undefined;
    // Ground truth for whatever position is actually on screen right now —
    // chess-coach.js replays `sans`/`plyViewed` into its own FEN, but that's
    // only correct if those two actually describe this position. Forwarding
    // chess.com's own getFEN() lets it double-check its replay against reality
    // instead of trusting its own move list unconditionally.
    let fen = null;
    try { fen = typeof game.getFEN === 'function' ? game.getFEN() : null; } catch {}
    return { sans, playingAs, plyViewed, fen };
  }

  // A torn read (see readGameOnce) is a sub-millisecond race — a move commits
  // between two synchronous reads. Retrying right here resolves it almost
  // every time, near-instantly. Deferring to the next tick instead (as an
  // earlier version of this did) meant the coach's arrows visibly sat on the
  // pre-move position for up to 300ms — or longer, if it kept landing in the
  // same race a few polls in a row — every time the user actually moved.
  function readGame() {
    for (let i = 0; i < 4; i++) {
      const r = readGameOnce();
      if (r !== undefined) return r; // null (no board) or a consistent snapshot — stop either way
    }
    return null; // torn on every attempt; the next 300ms tick will pick it up
  }

  function tick() {
    // When there is no board/game (page transition, re-render), keep the last
    // reported line instead of blanking it — only a real, present game that
    // reads empty should reset the coach to the start position.
    const data = readGame();
    if (!data) return;
    const sig = JSON.stringify(data);
    if (sig === last) return;
    last = sig;
    try {
      window.postMessage(
        { __chessCoach: 'moves', sans: data.sans, playingAs: data.playingAs, plyViewed: data.plyViewed, fen: data.fen },
        '*'
      );
    } catch {}
  }

  setInterval(tick, 300);
  tick();
})();
