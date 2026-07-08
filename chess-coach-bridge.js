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

  function readGame() {
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
    return { sans, playingAs, plyViewed };
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
        { __chessCoach: 'moves', sans: data.sans, playingAs: data.playingAs, plyViewed: data.plyViewed },
        '*'
      );
    } catch {}
  }

  setInterval(tick, 300);
  tick();
})();
