// Pure ai/* modules (see plan.md) — loaded here, not in offscreen.js, since
// they call fetch() directly rather than going through the Stockfish worker.
importScripts(
  'i18n.js', 'ai/prompt-builder.js', 'ai/response-parser.js', 'ai/providers.js',
  'ai/gemini-service.js', 'ai/openai-compatible-service.js', 'ai/ai-service.js'
);
const ChessAiPrompt = globalThis.ChessAiPrompt;
const ChessAiProviders = globalThis.ChessAiProviders;
const ChessAiService = globalThis.ChessAiService;

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

// ---- AI move explanations (see plan.md Phases 1-5, 7) ----------------------
// Cached in chrome.storage.local keyed by provider+FEN+bestMove+depth (Phase
// 5): once a position has been explained by a given provider, re-analysing it
// never calls that provider again.
const AI_CACHE_PREFIX = 'ccAiCache:';

// The prompt version is baked into every cache key (see cacheKeyFor), so after
// a version bump the old entries can never be read again — but nothing else
// ever deletes them, and they'd sit in chrome.storage.local forever. Prune them
// on install/update, the only moments a bump can land.
async function pruneStaleAiCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const live = `:v${ChessAiPrompt.EXPLAIN_CACHE_VERSION}|`;
    const stale = Object.keys(all).filter((k) => k.startsWith(AI_CACHE_PREFIX) && !k.includes(live));
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch {}
}
chrome.runtime.onInstalled.addListener(() => { pruneStaleAiCache(); });

// aiApiKeys/aiModels hold one entry per provider (see options.js) so switching
// providers never loses the other one's saved key. geminiApiKey/geminiModel
// are the pre-multi-provider settings, kept as a fallback for users who
// configured Gemini before this existed and haven't reopened Settings since.
async function getAiSettings() {
  const { aiProvider, aiApiKeys, aiModels, geminiApiKey, geminiModel } =
    await chrome.storage.local.get(['aiProvider', 'aiApiKeys', 'aiModels', 'geminiApiKey', 'geminiModel']);
  const provider = (aiProvider && ChessAiProviders.AI_PROVIDERS[aiProvider])
    ? aiProvider : ChessAiProviders.DEFAULT_AI_PROVIDER;
  const legacy = provider === 'gemini' ? { apiKey: geminiApiKey, model: geminiModel } : {};
  const apiKey = (aiApiKeys && aiApiKeys[provider]) || legacy.apiKey || '';
  const model = (aiModels && aiModels[provider]) || legacy.model || '';
  return { provider, apiKey, model };
}

async function explainWithCache(data) {
  const { provider, apiKey, model } = await getAiSettings();
  const cacheKey = `${AI_CACHE_PREFIX}${provider}:${ChessAiPrompt.cacheKeyFor(data)}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return cached[cacheKey];

  const result = await ChessAiService.explainMove(data, { apiKey, model, provider });
  try { await chrome.storage.local.set({ [cacheKey]: result }); } catch {}
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CC_ANALYZE') {
    engineAnalyze(msg).then(sendResponse).catch((e) => sendResponse({ error: errStr(e) }));
    return true;
  }
  if (msg.type === 'CC_ENGINE_STOP') { engineStop(); return false; }
  if (msg.type === 'CC_EXPLAIN') {
    explainWithCache(msg.data).then((result) => sendResponse({ result })).catch((e) => sendResponse({ error: errStr(e) }));
    return true;
  }
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
