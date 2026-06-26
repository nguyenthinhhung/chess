// offscreen.js — runs in the offscreen document, hosts the Stockfish engine
// (engine.js → globalThis.ChessEngine) and answers analysis requests relayed by
// the background service worker.

(function () {
  const Engine = globalThis.ChessEngine;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'CC_OFFSCREEN_GO') return;
    if (!Engine || !Engine.available()) { sendResponse({ error: 'engine unavailable' }); return; }
    const { fen, depth, multipv } = msg.payload || {};
    Engine.go(fen, { depth, multipv })
      .then((result) => sendResponse({ result }))
      .catch((e) => sendResponse({ error: (e && e.message) || String(e) }));
    return true; // async response
  });
})();
