// offscreen.js — runs in the offscreen document, hosts the Stockfish engine
// (engine.js → globalThis.ChessEngine) and answers analysis requests relayed by
// the background service worker.

(function () {
  const Engine = globalThis.ChessEngine;

  // DOMException does not inherit from Error, so String(e) yields the useless
  // "[object DOMException]". Surface its name (e.g. AbortError) and message.
  function errStr(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    const parts = [e.name, e.message].filter(Boolean);
    return parts.length ? parts.join(': ') : String(e);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'CC_OFFSCREEN_GO') return;
    if (!Engine || !Engine.available()) { sendResponse({ error: 'engine unavailable' }); return; }
    const { fen, depth, multipv } = msg.payload || {};
    Engine.go(fen, { depth, multipv })
      .then((result) => sendResponse({ result }))
      .catch((e) => sendResponse({ error: errStr(e) }));
    return true; // async response
  });
})();
