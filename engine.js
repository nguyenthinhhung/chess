// engine.js — a thin wrapper around the vendored single-threaded Stockfish
// (vendor/stockfish-18-lite-single.{js,wasm}). It runs the engine in a Web
// Worker spawned from the extension's own URL and speaks UCI over postMessage.
//
// The Stockfish build is written to run AS a worker: it reads the wasm path
// from its own location hash, so we pass the wasm URL there. Searches are
// serialised through a queue (one `go` at a time) and each resolves with the
// best move, the final score, and the principal variation.
//
// This file does NOT decide when analysis is allowed — chess-coach.js only ever
// calls it on the practice surfaces (games vs the computer / analysis board). It
// just computes.

(function () {
  const JS = 'vendor/stockfish-18-lite-single.js';
  const WASM = 'vendor/stockfish-18-lite-single.wasm';

  let worker = null;
  let readyPromise = null;
  let current = null;      // { resolve, info } for the in-flight search
  const queue = [];        // pending { fen, opts, resolve, reject }

  function url(path) {
    try { return chrome.runtime.getURL(path); } catch { return path; }
  }

  function available() {
    try {
      return typeof Worker === 'function' && !!chrome?.runtime?.id;
    } catch { return false; }
  }

  // Parse one "info ... [multipv K] ... score cp|mate N ... pv m1 m2 ..." line.
  function parseInfo(line) {
    const out = {};
    const dm = line.match(/\bdepth (\d+)/);
    if (dm) out.depth = Number(dm[1]);
    const mp = line.match(/\bmultipv (\d+)/);
    out.multipv = mp ? Number(mp[1]) : 1;
    const sm = line.match(/\bscore (cp|mate) (-?\d+)/);
    if (sm) out.score = { type: sm[1], value: Number(sm[2]) };
    const pm = line.match(/\bpv (.+)$/);
    if (pm) out.pv = pm[1].trim().split(/\s+/);
    return out;
  }

  function onMessage(e) {
    const line = typeof e.data === 'string' ? e.data : (e.data && e.data.data) || '';
    if (!line) return;
    if (!current) return;
    if (line.startsWith('info ') && /\bscore /.test(line)) {
      const info = parseInfo(line);
      if (!info.score) return;
      // Keep the deepest line per MultiPV slot. Slot 1 is the principal line.
      const k = info.multipv;
      current.lines[k] = { ...current.lines[k], ...info };
      if (k === 1) current.info = current.lines[1];
    } else if (line.startsWith('bestmove')) {
      const bm = line.split(/\s+/)[1] || null;
      const done = current;
      current = null;
      // Ordered candidate lines: [{ move, score, pv, depth }], best first.
      const lines = Object.keys(done.lines)
        .map(Number).sort((a, b) => a - b)
        .map((k) => done.lines[k])
        .filter((ln) => ln && ln.pv && ln.pv.length)
        .map((ln) => ({ move: ln.pv[0], score: ln.score || null, pv: ln.pv, depth: ln.depth || 0 }));
      done.resolve({
        bestmove: bm && bm !== '(none)' ? bm : null,
        score: done.info.score || null,
        pv: done.info.pv || (bm ? [bm] : []),
        depth: done.info.depth || 0,
        lines
      });
      pump();
    }
  }

  function send(cmd) {
    try { worker.postMessage(cmd); } catch {}
  }

  function init() {
    if (readyPromise) return readyPromise;
    if (!available()) return Promise.reject(new Error('engine unavailable'));
    readyPromise = new Promise((resolve, reject) => {
      const jsUrl = url(JS);
      const wasmUrl = url(WASM);
      console.log('[coach engine] booting worker from', jsUrl, 'wasm', wasmUrl);
      try {
        worker = new Worker(jsUrl + '#' + encodeURIComponent(wasmUrl));
      } catch (err) {
        console.error('[coach engine] Worker constructor failed:', err);
        reject(err); return;
      }
      let ready = false;
      const fail = (err) => {
        if (ready) return;
        console.error('[coach engine] boot failed:', err);
        readyPromise = null; // allow a later retry
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => fail(new Error('engine boot timed out (no readyok)')), 20000);
      const boot = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line.includes('uciok')) send('isready');
        else if (line.includes('readyok') && !ready) {
          ready = true;
          clearTimeout(timer);
          worker.removeEventListener('message', boot);
          worker.addEventListener('message', onMessage);
          send('ucinewgame');
          console.log('[coach engine] ready');
          resolve();
        }
      };
      worker.addEventListener('message', boot);
      worker.addEventListener('error', (ev) => {
        console.error('[coach engine] worker error event:', ev.message || ev.error || ev);
        clearTimeout(timer);
        fail(ev.error || new Error(ev.message || 'worker error'));
      });
      send('uci');
    });
    return readyPromise;
  }

  function pump() {
    if (current || !queue.length) return;
    const job = queue.shift();
    current = { resolve: job.resolve, info: {}, lines: {} };
    const depth = Math.max(1, Math.min(30, job.opts.depth || 12));
    const mpv = Math.max(1, Math.min(8, job.opts.multipv || 1));
    send(`setoption name MultiPV value ${mpv}`);
    send('position fen ' + job.fen);
    const sm = job.opts.searchmoves ? ' searchmoves ' + [].concat(job.opts.searchmoves).join(' ') : '';
    send(`go depth ${depth}${sm}`);
  }

  // Analyse `fen`. opts: { depth, searchmoves, multipv }. searchmoves restricts
  // the search to specific UCI moves (used to score the move actually played);
  // multipv asks for the top-N lines. Resolves with
  // { bestmove, score, pv, depth, lines }; scores are from the perspective of
  // the side to move in `fen`.
  function go(fen, opts = {}) {
    return init().then(() => new Promise((resolve, reject) => {
      queue.push({ fen, opts, resolve, reject });
      pump();
    }));
  }

  function dispose() {
    try { if (worker) { send('quit'); worker.terminate(); } } catch {}
    worker = null; readyPromise = null; current = null; queue.length = 0;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.ChessEngine = { available, init, go, dispose };
  }
})();
