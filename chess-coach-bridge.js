// chess-coach-bridge.js — runs in the MAIN world (see manifest "world": "MAIN").
//
// chess.com's board is a <wc-chess-board> custom element that exposes a `game`
// API in the page's JS context. Content scripts run in an isolated world and
// can't touch that object, so this tiny bridge lives in the main world, reads
// the move list straight from the game API (clean SAN, no figurine/DOM
// scraping), and forwards it to the isolated-world coach via window.postMessage.
//
// It only READS and only forwards moves. Whether those moves are turned into
// live hints is decided by chess-coach.js, which suppresses real-time help in
// games against humans.

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
    return { sans, playingAs };
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
      window.postMessage({ __chessCoach: 'moves', sans: data.sans, playingAs: data.playingAs }, '*');
    } catch {}
  }

  setInterval(tick, 300);
  tick();
})();
