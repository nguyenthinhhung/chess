const BUTTON_ID = 'lichess-analyzer-btn';
let contextDead = false;

// chrome.runtime.id becomes undefined once the extension is reloaded/uninstalled
// while the old content script is still attached to the page.
function isCtxAlive() {
  if (contextDead) return false;
  try {
    if (!chrome?.runtime?.id) {
      contextDead = true;
      teardown();
      return false;
    }
    return true;
  } catch {
    contextDead = true;
    teardown();
    return false;
  }
}

function teardown() {
  try { navObserver?.disconnect(); } catch {}
  document.getElementById(BUTTON_ID)?.remove();
}

function getGameIdFromUrl() {
  const m = location.pathname.match(/\/(?:game|analysis\/game)\/(live|daily)\/(\d+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

function getGameIdFromDom() {
  const el = document.querySelector('[data-game-id], [data-cy="game-id"]');
  const id = el?.getAttribute('data-game-id');
  if (id && /^\d+$/.test(id)) return { type: 'live', id };
  return null;
}

function getGameId() {
  return getGameIdFromUrl() || getGameIdFromDom();
}

async function fetchPgnFromCallback(type, id) {
  try {
    const resp = await fetch(`https://www.chess.com/callback/${type}/game/${id}`, {
      credentials: 'include'
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const game = data?.game;
    if (!game) return null;
    if (typeof game.pgn === 'string' && /\b1\./.test(game.pgn)) return game.pgn;
    if (game.pgnHeaders && game.moveList) return buildPgn(game);
    return null;
  } catch {
    return null;
  }
}

// TCN decoding and SAN generation live in pgn.js, which is loaded as a content
// script before this one (see manifest.json) so decodeTcn / uciListToSan /
// buildPgn are available here as globals.

function scrapePgnFromDom() {
  const els = document.querySelectorAll('textarea, pre, code');
  for (const el of els) {
    const text = el.value || el.textContent || '';
    if (text.includes('[Event ') && /\d+\./.test(text)) return text;
  }
  return null;
}

async function extractPgn() {
  const game = getGameId();
  if (game) {
    const pgn = await fetchPgnFromCallback(game.type, game.id);
    if (pgn) return pgn;
  }
  return scrapePgnFromDom();
}

function createButton() {
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.className = 'lichess-analyzer-fab';
  btn.title = 'Analyze on Lichess';
  btn.innerHTML = `
    <svg class="lichess-analyzer-fab__icon" viewBox="0 0 64 64" aria-hidden="true">
      <path fill="currentColor" d="M38.94 9.81c1.27-.13 2.55 0 3.78.32.78.2 1.6.59 1.95 1.36.39.95-.32 2.08-1.32 2.2-1.05.17-1.96-.55-2.93-.78-1.69-.43-3.6.11-4.74 1.45-1.27 1.46-1.41 3.81-.27 5.41.78 1.13 2.06 1.7 2.83 2.84.92 1.34 1.16 3.1.61 4.64-.46 1.34-1.43 2.45-2.59 3.25-1.69 1.18-3.7 1.85-5.74 2.06l-.04.21c1.59 1.86 3.16 3.74 4.83 5.53 1.83 1.96 3.95 3.66 6.34 4.84 1.78.88 3.74 1.4 5.74 1.31 1.49-.07 2.95-.6 4.1-1.55.86-.7 1.99-1.31 3.13-1.03 1.27.26 2.13 1.7 1.71 2.95-.36 1.04-1.41 1.59-2.34 2.04-2.3 1.04-4.86 1.42-7.37 1.27-3.31-.2-6.5-1.39-9.33-3.07-3.05-1.81-5.66-4.29-7.95-7-.71-.86-1.43-1.71-2.04-2.64-2.18 1-4.43 1.91-6.79 2.32-.97.16-1.97.27-2.95.13-1.04-.16-2.07-.71-2.5-1.71-.4-.92.13-2.05 1.07-2.32 1.03-.34 2.06.21 3.09.27 1.93.21 3.81-.42 5.58-1.13.65-.27 1.27-.6 1.86-.97-.41-.85-.83-1.69-1.18-2.56-.61-1.51-1.05-3.1-1.04-4.74.02-1.97.76-3.92 2.04-5.42 1.85-2.21 4.61-3.59 7.46-3.85zM10.43 47.32c.94-1.27 2.36-2.13 3.87-2.51 1.59-.4 3.31-.21 4.78.55 1.69-1.04 3.79-1.36 5.69-.75 1.59.49 2.94 1.65 3.71 3.12 1.43-.92 3.18-1.34 4.86-1 1.84.34 3.5 1.53 4.39 3.18 1.13-.81 2.5-1.28 3.89-1.21 1.93.08 3.78 1.18 4.79 2.83 1.81-.93 4.13-.43 5.51 1.05.96 1.04 1.39 2.45 1.49 3.84.08.91-.04 1.92-.65 2.63-.78.88-2 1.21-3.13 1.21H8.61c-1.32 0-2.7-.36-3.61-1.36-.95-.99-1.1-2.47-.96-3.78.21-1.55.91-3.13 2.18-4.1.81-.62 1.83-.93 2.85-.95.2-.91.79-1.7 1.36-2.4z"/>
    </svg>
    <span class="lichess-analyzer-fab__label">Analyze on Lichess</span>
  `;
  const labelEl = btn.querySelector('.lichess-analyzer-fab__label');
  const setLabelText = (text, disabled = false) => {
    labelEl.textContent = text;
    btn.title = text; // icon-only button: surface status via the tooltip
    btn.disabled = disabled;
  };
  const resetLabel = () => setLabelText('Analyze on Lichess', false);
  btn.addEventListener('click', async () => {
    if (!isCtxAlive()) {
      setLabelText('Reload page (extension updated)', true);
      return;
    }
    setLabelText('Extracting PGN...', true);
    const pgn = await extractPgn();
    if (!pgn) {
      setLabelText('PGN not found (use popup)', true);
      setTimeout(resetLabel, 2500);
      return;
    }
    setLabelText('Sending to Lichess...', true);
    chrome.runtime.sendMessage({ action: 'importToLichess', pgn }, (resp) => {
      if (resp?.url) {
        window.open(resp.url + '#analysis', '_blank');
        setLabelText('Opened in new tab', true);
      } else {
        setLabelText((resp?.error || 'Failed').slice(0, 40), true);
      }
      setTimeout(resetLabel, 2500);
    });
  });
  return btn;
}

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return;
  if (!getGameId()) return;
  (document.body || document.documentElement).appendChild(createButton());
}

// SPA navigation observer for button injection. chess.com mutates the DOM
// constantly, so coalesce bursts into a single injectButton() call instead of
// running it on every mutation.
let lastUrl = location.href;
let injectScheduled = false;
function scheduleInject(delay) {
  if (injectScheduled) return;
  injectScheduled = true;
  setTimeout(() => {
    injectScheduled = false;
    injectButton();
  }, delay);
}
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // New page — wait for chess.com to render the new game's DOM.
    scheduleInject(600);
  } else {
    scheduleInject(150);
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });
injectButton();
