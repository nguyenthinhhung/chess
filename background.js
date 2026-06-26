const LICHESS_IMPORT_URL = 'https://lichess.org/api/import';
const RATE_LIMIT_MS = 3500;

async function importToLichess(pgn) {
  const { lichessToken } = await chrome.storage.local.get('lichessToken');
  if (!lichessToken) {
    return { error: 'No Lichess token. Click Settings in popup.' };
  }
  try {
    const body = new URLSearchParams({ pgn, analysis: 'true' });
    const resp = await fetch(LICHESS_IMPORT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lichessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `Lichess ${resp.status}: ${text.slice(0, 120)}` };
    }
    const data = await resp.json();
    return { url: data.url, id: data.id };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchChessComArchive(username, count = 5) {
  try {
    const archiveResp = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`);
    if (!archiveResp.ok) return { error: `Chess.com ${archiveResp.status} (check username)` };
    const { archives } = await archiveResp.json();
    if (!archives?.length) return { games: [] };
    // Walk months newest-first, prepending each so the result stays in
    // chronological order, until we have at least `count` games. This keeps
    // "last N games" working early in the month when the current month is thin.
    const collected = [];
    const cap = Math.max(1, count);
    for (let i = archives.length - 1; i >= 0 && collected.length < cap; i--) {
      const r = await fetch(archives[i]);
      if (!r.ok) continue;
      const { games } = await r.json();
      if (games?.length) collected.unshift(...games);
    }
    return { games: collected };
  } catch (e) {
    return { error: e.message };
  }
}

async function batchImport(pgns, port) {
  const results = [];
  for (let i = 0; i < pgns.length; i++) {
    const r = await importToLichess(pgns[i]);
    results.push(r);
    if (port) {
      try { port.postMessage({ type: 'progress', index: i, total: pgns.length, result: r }); } catch {}
    }
    if (i < pgns.length - 1) await new Promise(res => setTimeout(res, RATE_LIMIT_MS));
  }
  return results;
}

// ---- Stockfish engine (offscreen document) --------------------------------
// The engine runs in an offscreen document so it uses the extension's own CSP
// (wasm-unsafe-eval) instead of the host page's, which on chess.com would
// otherwise block a worker created from a content script.
let creatingOffscreen = null;

// DOMException does not inherit from Error, so String(e) yields the useless
// "[object DOMException]". Surface its name (e.g. AbortError) and message.
function errStr(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  const parts = [e.name, e.message].filter(Boolean);
  return parts.length ? parts.join(': ') : String(e);
}

async function ensureOffscreen() {
  try { if (await chrome.offscreen.hasDocument()) return; } catch {}
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run the Stockfish engine (WebAssembly) for the in-game coach.'
  }).catch((e) => {
    // A concurrent caller (or a prior call after an SW restart) may have
    // already created it; "single offscreen document" means we're fine.
    if (/single offscreen document/i.test(e?.message || '')) return;
    throw e;
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function engineAnalyze(payload) {
  await ensureOffscreen();
  // Delivered to the offscreen document (and ignored by everyone else); its
  // response carries either { result } or { error }.
  return await chrome.runtime.sendMessage({ type: 'CC_OFFSCREEN_GO', payload });
}

async function engineStop() {
  try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CC_ANALYZE') {
    engineAnalyze(msg).then(sendResponse).catch((e) => sendResponse({ error: errStr(e) }));
    return true;
  }
  if (msg.type === 'CC_ENGINE_STOP') { engineStop(); return false; }
  if (msg.action === 'importToLichess') {
    importToLichess(msg.pgn).then(sendResponse);
    return true;
  }
  if (msg.action === 'fetchArchive') {
    fetchChessComArchive(msg.username, msg.count || 5).then(sendResponse);
    return true;
  }
  if (msg.action === 'batchImport') {
    batchImport(msg.pgns).then(results => sendResponse({ results }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'batch') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'batchImport') {
      const results = await batchImport(msg.pgns, port);
      try { port.postMessage({ type: 'done', results }); } catch {}
    }
  });
});
