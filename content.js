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
  // Official Lichess knight logo (from lichess-org/lila public/logo/lichess.svg).
  btn.innerHTML = `
    <svg class="lichess-analyzer-fab__icon" viewBox="0 0 50 50" aria-hidden="true">
      <path fill="currentColor" stroke="currentColor" stroke-linejoin="round" d="M38.956.5c-3.53.418-6.452.902-9.286 2.984C5.534 1.786-.692 18.533.68 29.364 3.493 50.214 31.918 55.785 41.329 41.7c-7.444 7.696-19.276 8.752-28.323 3.084S-.506 27.392 4.683 17.567C9.873 7.742 18.996 4.535 29.03 6.405c2.43-1.418 5.225-3.22 7.655-3.187l-1.694 4.86 12.752 21.37c-.439 5.654-5.459 6.112-5.459 6.112-.574-1.47-1.634-2.942-4.842-6.036-3.207-3.094-17.465-10.177-15.788-16.207-2.001 6.967 10.311 14.152 14.04 17.663 3.73 3.51 5.426 6.04 5.795 6.756 0 0 9.392-2.504 7.838-8.927L37.4 7.171z"/>
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
