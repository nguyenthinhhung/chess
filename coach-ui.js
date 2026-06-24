// coach-ui.js — wires the pure coach engine (coach.js / chesscore.js) into the
// live chess.com page. Loaded after content.js, so it shares the same isolated
// world and can reuse its globals (getGameId, decodeTcn, analyze, applySan...).
//
// FAIR PLAY: real-time move guidance is shown ONLY on practice surfaces — games
// vs the computer/bots and the analysis board. In a game against a human the
// coach refuses to give live hints and only offers an opening review AFTER the
// game has ended. Helping someone during a live game against another person is
// cheating and is intentionally not built.

(function () {
  // Pulled from globalThis so we don't depend on cross-file const sharing.
  const analyze = globalThis.analyze;
  const createPosition = globalThis.createPosition;
  const applySan = globalThis.applySan;
  if (!analyze || !createPosition || !applySan) return; // core failed to load

  const PANEL_ID = 'opening-coach-panel';
  // openingId: null = auto-detect; otherwise a repertoire id to train.
  const state = { enabled: true, min: false, openingId: null };
  let lastSig = '';

  // Move list pushed from the MAIN-world bridge (coach-bridge.js). null until the
  // first message arrives.
  let bridgeSans = null;
  let bridgePlayingAs = null;

  const alive = () => {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  };

  // chess.com getPlayingAs() → our 'w' | 'b' | null.
  function mapSide(p) {
    if (p === 1 || p === 'white' || p === 'w') return 'w';
    if (p === 2 || p === 'black' || p === 'b') return 'b';
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__openingCoach !== 'moves') return;
    bridgeSans = Array.isArray(d.sans) ? d.sans : [];
    bridgePlayingAs = d.playingAs ?? null;
    lastSig = '';
    schedule(50);
  });

  // ---- context & orientation -------------------------------------------------
  function detectContext() {
    const p = location.pathname;
    if (p.startsWith('/analysis')) return 'analysis';
    if (/\/play\/(computer|bots)/.test(p) || /\/game\/computer/.test(p)) return 'bot';
    if (/\/game\/(live|daily)\//.test(p) || p.startsWith('/play/') || p.startsWith('/live')) {
      return 'live-human';
    }
    return 'other';
  }

  function detectUserSide() {
    const b = document.querySelector(
      'wc-chess-board, chess-board, .board, cg-board, .board-board'
    );
    if (!b) return null;
    return (b.classList.contains('flipped') || b.closest('.flipped')) ? 'b' : 'w';
  }

  function isGameOver() {
    return !!document.querySelector(
      '.game-over-modal-content, .game-over-header-component, [class*="game-over"], .result-message-component'
    );
  }

  // ---- moves -----------------------------------------------------------------
  // Convert a SAN list to UCI, stopping at the first move that won't replay so
  // a bad tail can't poison the analysis.
  function sanToUci(sans) {
    const pos = createPosition();
    const uci = [];
    for (const s of sans) {
      const u = applySan(pos, s);
      if (!u) break;
      uci.push(u);
    }
    return uci;
  }

  // Try both repertoires; pick the deeper match, breaking ties by known side.
  function bestResult(uci, knownSide) {
    const rw = analyze(uci, { side: 'w' });
    const rb = analyze(uci, { side: 'b' });
    if (!rw) return rb;
    if (!rb) return rw;
    if (rw.matchedPlies !== rb.matchedPlies) {
      return rw.matchedPlies > rb.matchedPlies ? rw : rb;
    }
    return (knownSide || detectUserSide()) === 'b' ? rb : rw;
  }

  // ---- panel -----------------------------------------------------------------
  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    el.className = 'opening-coach';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
    lastSig = '';
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Dropdown to pick which opening to train (Auto + each repertoire).
  function openingPicker() {
    const reps = globalThis.REPERTOIRE || [];
    const opt = (val, label, sel) => `<option value="${esc(val)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
    let opts = opt('', 'Auto-detect', !state.openingId);
    for (const o of reps) {
      opts += opt(o.id, `${o.name} (${o.side === 'w' ? 'White' : 'Black'})`, state.openingId === o.id);
    }
    return `<div class="opening-coach__row opening-coach__pick">
      <span class="opening-coach__pick-label">Train</span>
      <select class="opening-coach__select" data-coach-select>${opts}</select>
    </div>`;
  }

  function header(titleHtml) {
    return `
      <div class="opening-coach__head">
        <div class="opening-coach__title">${titleHtml}</div>
        <button class="opening-coach__btn" data-act="min" title="Collapse / expand">${state.min ? '▢' : '—'}</button>
        <button class="opening-coach__btn ${state.enabled ? 'opening-coach__btn--on' : ''}" data-act="toggle">${state.enabled ? 'ON' : 'OFF'}</button>
      </div>`;
  }

  function bodyForCoaching(res, ctx, side) {
    if (!res) {
      return `<div class="opening-coach__row opening-coach__status--info">No repertoire opening recognised yet (Italian / Caro-Kann).</div>`;
    }
    const mode = ctx === 'bot' ? 'vs Bot' : 'Analysis';
    const sideLabel = res.userSide === 'w' ? 'White' : 'Black';
    let html = `<div class="opening-coach__row">
      <span class="opening-coach__badge">${mode} · You: ${sideLabel}</span></div>`;

    if (res.status === 'on-book' && res.userToMove && res.recommended) {
      html += `<div class="opening-coach__row opening-coach__status--good">Play:</div>
        <div class="opening-coach__row"><span class="opening-coach__move">${esc(res.recommended.san)}</span>
        <span class="opening-coach__move-uci">${esc(res.recommended.uci || '')}</span></div>`;
    } else if (res.status === 'on-book') {
      html += `<div class="opening-coach__row opening-coach__status--info">On book. Waiting for your opponent.</div>`;
    } else if (res.status === 'user-left-book') {
      const moves = res.bookMoves.map((m) => esc(m.san)).join(', ') || '—';
      html += `<div class="opening-coach__row opening-coach__status--warn">⚠ You just left the book.</div>
        <div class="opening-coach__row">Repertoire move: <b>${moves}</b></div>`;
    } else if (res.status === 'opp-left-book') {
      const items = res.bookMoves.map((m) => `<li><b>${esc(m.san)}</b>${m.note ? ' — ' + esc(m.note) : ''}</li>`).join('');
      html += `<div class="opening-coach__row opening-coach__status--info">Opponent left the repertoire.</div>
        ${items ? `<ul class="opening-coach__list">${items}</ul>` : ''}`;
    } else if (res.status === 'line-complete') {
      html += `<div class="opening-coach__row opening-coach__status--good">✓ Opening fully developed per the repertoire.</div>`;
    }

    if (res.note) html += `<div class="opening-coach__row opening-coach__note">${esc(res.note)}</div>`;
    return html;
  }

  function titleFor(res) {
    if (!res) return 'Opening Coach';
    const line = res.lineName && res.lineName !== res.openingName ? ` <small>· ${esc(res.lineName)}</small>` : '';
    return `${esc(res.openingName)}${line}`;
  }

  function render(ctx) {
    const el = ensurePanel();

    // Disabled: minimal panel so the user can switch it back on.
    if (!state.enabled) {
      const sig = `disabled`;
      if (sig === lastSig) return;
      lastSig = sig;
      el.className = 'opening-coach is-min';
      el.innerHTML = header('Opening Coach') +
        `<div class="opening-coach__body"><div class="opening-coach__row">Coach is off.</div></div>`;
      bind(el, ctx);
      return;
    }

    if (ctx === 'live-human') {
      const over = isGameOver();
      const sig = `live|${state.min}|${over}`;
      if (sig === lastSig) return;
      lastSig = sig;
      el.className = 'opening-coach' + (state.min ? ' is-min' : '');
      el.innerHTML = header('Opening Coach') + `<div class="opening-coach__body">
        <div class="opening-coach__row opening-coach__fair">⚖ Live game vs a human — real-time coaching is disabled to respect chess.com fair-play rules.</div>
        ${over
          ? `<div class="opening-coach__row"><button class="opening-coach__btn" data-act="review">Review this game's opening</button></div>
             <div class="opening-coach__row" data-review></div>`
          : `<div class="opening-coach__row opening-coach__status--info">Review unlocks after the game ends.</div>`}
      </div>`;
      bind(el, ctx);
      return;
    }

    // bot / analysis → live coaching, fed by the MAIN-world bridge.
    const uci = sanToUci(bridgeSans || []);
    const res = state.openingId
      ? analyze(uci, { openingId: state.openingId })
      : bestResult(uci, mapSide(bridgePlayingAs));
    const sig = `${ctx}|${state.min}|${state.openingId || 'auto'}|${uci.join(',')}`;
    if (sig === lastSig) return;
    lastSig = sig;

    el.className = 'opening-coach' + (state.min ? ' is-min' : '');
    el.innerHTML = header(titleFor(res)) +
      `<div class="opening-coach__body">${openingPicker()}${bodyForCoaching(res, ctx, detectUserSide())}</div>`;
    bind(el, ctx);
  }

  // ---- review (post-game, human games) --------------------------------------
  async function fetchGameUci() {
    if (typeof getGameId !== 'function' || typeof decodeTcn !== 'function') return null;
    const g = getGameId();
    if (!g) return null;
    try {
      const r = await fetch(`https://www.chess.com/callback/${g.type}/game/${g.id}`, { credentials: 'include' });
      if (!r.ok) return null;
      const game = (await r.json())?.game;
      return game?.moveList ? decodeTcn(game.moveList) : null;
    } catch { return null; }
  }

  async function runReview(el) {
    const slot = el.querySelector('[data-review]');
    if (slot) slot.textContent = 'Reading the game…';
    const uci = await fetchGameUci();
    if (!uci || !uci.length) {
      if (slot) slot.textContent = 'Could not read the game moves.';
      return;
    }
    const res = bestResult(uci);
    if (!slot) return;
    if (!res) { slot.textContent = 'This game does not match the Italian/Caro-Kann repertoire.'; return; }
    let msg;
    if (res.status === 'user-left-book') {
      const moveNo = Math.floor(res.off.ply / 2) + 1;
      const book = res.bookMoves.map((m) => m.san).join(', ');
      msg = `${res.openingName}: you followed the book for ${res.matchedPlies} plies, then deviated on move ${moveNo}. The repertoire move was: ${book}.`;
    } else if (res.status === 'opp-left-book') {
      msg = `${res.openingName}: you stayed in the repertoire; your opponent was the one who left theory first (move ${Math.floor(res.off.ply / 2) + 1}).`;
    } else {
      msg = `${res.openingName}: you followed the repertoire for all ${res.matchedPlies} opening plies. 👍`;
    }
    slot.innerHTML = `<span class="opening-coach__status--info">${esc(msg)}</span>`;
  }

  // ---- events ---------------------------------------------------------------
  function bind(el, ctx) {
    const sel = el.querySelector('[data-coach-select]');
    if (sel) {
      sel.onchange = () => {
        state.openingId = sel.value || null;
        save();
        lastSig = '';
        render(detectContext());
      };
    }
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        if (act === 'toggle') {
          state.enabled = !state.enabled;
          save();
        } else if (act === 'min') {
          state.min = !state.min;
          save();
        } else if (act === 'review') {
          runReview(el);
          return;
        }
        lastSig = '';
        render(detectContext());
      };
    });
  }

  function save() {
    try {
      chrome.storage.local.set({
        coachEnabled: state.enabled, coachMin: state.min, coachOpening: state.openingId
      });
    } catch {}
  }

  // ---- lifecycle ------------------------------------------------------------
  let scheduled = false;
  function schedule(delay) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!alive()) return;
      const ctx = detectContext();
      if (ctx === 'other') { removePanel(); return; }
      render(ctx);
    }, delay);
  }

  function start() {
    let lastUrl = location.href;
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; lastSig = ''; schedule(500); }
      else schedule(200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    schedule(300);
  }

  try {
    chrome.storage.local.get(['coachEnabled', 'coachMin', 'coachOpening'], (o) => {
      state.enabled = o.coachEnabled !== false;
      state.min = !!o.coachMin;
      state.openingId = o.coachOpening || null;
      start();
    });
  } catch {
    start();
  }
})();
