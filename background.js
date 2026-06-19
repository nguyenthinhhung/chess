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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
