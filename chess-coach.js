// chess-coach.js — an in-game coach for chess.com. It recognises the opening
// (from a bundled ECO database), guides you along a chosen opening's book moves,
// and once out of book draws Stockfish's top moves as arrows directly on the
// board — plus the opponent's likely reply, so you can read their intention.
//
// Loaded after content.js in the same isolated world; the MAIN-world bridge
// (chess-coach-bridge.js) feeds it the live move list via postMessage.
//

(function () {
  const createPosition = globalThis.createPosition;
  const applySan = globalThis.applySan;
  const applyUci = globalThis.applyUci;
  const toFen = globalThis.toFen;
  if (!createPosition || !applySan) return; // core failed to load

  const Explain = globalThis.ChessExplain;

  // The Stockfish engine runs in an offscreen document (see background.js /
  // offscreen.js). Content scripts on chess.com can't host the worker because
  // the page CSP blocks it, so we relay analysis requests through the background
  // service worker and await the result.
  function engineAvailable() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }
  function engineGo(fen, opts) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'CC_ANALYZE', fen, depth: opts.depth, multipv: opts.multipv },
          (resp) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            if (!resp) return reject(new Error('no engine response'));
            if (resp.error) return reject(new Error(resp.error));
            resolve(resp.result);
          }
        );
      } catch (e) { reject(e); }
    });
  }
  function engineStop() {
    try { chrome.runtime.sendMessage({ type: 'CC_ENGINE_STOP' }); } catch {}
  }

  const BAR_ID = 'chess-coach-bar';     // under the board: lightbulb + opening name
  const PANEL_ID = 'chess-coach-panel'; // bottom-right: settings + results, min/maxable
  const ARROW_ID = 'chess-coach-arrows';
  const ARROW_MIN = 1, ARROW_MAX = 5; // user-selectable arrow count (per side)
  const MAX_BOOK_PLY = 24;    // stop consulting the opening book after this depth

  // Openings offered in the picker, tagged by the side that chooses them, so the
  // dropdown can show only the openings relevant to the side you're playing.
  // Resolved to their canonical (shortest) UCI line from openings.json on load.
  const POPULAR = [
    { name: 'Italian Game', side: 'w' }, { name: 'Ruy Lopez', side: 'w' },
    { name: 'Scotch Game', side: 'w' }, { name: 'Four Knights Game', side: 'w' },
    { name: 'Vienna Game', side: 'w' }, { name: "King's Gambit", side: 'w' },
    { name: "Bishop's Opening", side: 'w' }, { name: 'Ponziani Opening', side: 'w' },
    { name: 'Center Game', side: 'w' }, { name: 'Catalan Opening', side: 'w' },
    { name: 'London System', side: 'w' }, { name: 'English Opening', side: 'w' },
    { name: 'Réti Opening', side: 'w' }, { name: 'Bird Opening', side: 'w' },
    { name: 'Sicilian Defense', side: 'b' }, { name: 'French Defense', side: 'b' },
    { name: 'Caro-Kann Defense', side: 'b' }, { name: 'Scandinavian Defense', side: 'b' },
    { name: 'Pirc Defense', side: 'b' }, { name: 'Modern Defense', side: 'b' },
    { name: 'Alekhine Defense', side: 'b' }, { name: 'Philidor Defense', side: 'b' },
    { name: "Queen's Gambit Declined", side: 'b' }, { name: "Queen's Gambit Accepted", side: 'b' },
    { name: 'Slav Defense', side: 'b' }, { name: "King's Indian Defense", side: 'b' },
    { name: 'Nimzo-Indian Defense', side: 'b' }, { name: "Queen's Indian Defense", side: 'b' },
    { name: 'Grünfeld Defense', side: 'b' }, { name: 'Dutch Defense', side: 'b' }
  ];

  // Arrow colours by RANK only (best → 3rd) — the same palette for both sides,
  // since the board already shows whose piece is moving. Book move is violet.
  const RANK_COLORS = ['#22ac38', '#2b86d8', '#e0a000']; // green / blue / amber
  const BOOK_COLOR = '#9b59b6';
  const LEGEND = [
    { color: BOOK_COLOR, label: 'Book' },
    { color: RANK_COLORS[0], label: 'Best' },
    { color: RANK_COLORS[1], label: '2nd' },
    { color: RANK_COLORS[2], label: '3rd' }
  ];

  // enabled: the lightbulb toggle. depth: Stockfish search depth. openingId: a
  // POPULAR name to train, or null = auto-detect.
  const state = { enabled: true, depth: 14, openingId: null, panelMin: false, arrows: 3 };
  let lastSig = '';
  let lastArrowSig = '';

  let bridgeSans = null;
  let bridgePlayingAs = null;

  // openings.json, lazily fetched the first time we land on a coached surface.
  let OPENINGS = null;
  let popularResolved = null;
  let openingsLoading = false;

  //   status: 'idle' | 'running' | 'done' | 'error'
  const engineState = { sig: null, status: 'idle', result: null };
  let pendingUci = null;
  // Circuit breaker: after repeated failures, stop touching the engine for the
  // rest of the session so a broken Stockfish can never be spawned in a loop.
  let engineFailures = 0;
  let engineDead = false;

  const alive = () => { try { return !!chrome?.runtime?.id; } catch { return false; } };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function mapSide(p) {
    if (p === 1 || p === 'white' || p === 'w') return 'w';
    if (p === 2 || p === 'black' || p === 'b') return 'b';
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__chessCoach !== 'moves') return;
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
    if (/\/game\/(live|daily)/.test(p) || p.startsWith('/play') || p.startsWith('/live')) {
      return 'live-human';
    }
    // Fallback: chess.com's live-game URL shifts once matchmaking completes
    // (e.g. the SPA leaves /play/online/new), so any other page that actually
    // has a board is treated as a human game rather than dropped to 'other'.
    if (findBoard()) return 'live-human';
    return 'other';
  }

  function findBoard() {
    // Query in priority order — a union selector returns the first match in DOM
    // order, which can pick a stray .board element over the real chess.com board.
    for (const sel of ['wc-chess-board', 'chess-board', 'cg-board', '.board-board', '.board']) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Orientation. Trust real geometry over CSS classes: chess.com tags every piece
  // with a `square-<file><rank>` class (e.g. square-51 = e1), so we compare a real
  // piece's rendered centre against where it would sit in each orientation. Falls
  // back to the `.flipped` class when no piece is found.
  function isFlipped() {
    const b = findBoard();
    if (!b) return false;
    try {
      const piece = b.querySelector('.piece[class*="square-"]');
      const m = piece && piece.className.match(/square-(\d)(\d)/);
      if (m) {
        const f = +m[1], r = +m[2];
        const br = b.getBoundingClientRect();
        const pr = piece.getBoundingClientRect();
        if (br.width > 0 && pr.width > 0) {
          const sq = br.width / 8;
          const cx = pr.left + pr.width / 2 - br.left;
          const cy = pr.top + pr.height / 2 - br.top;
          const dWhite = Math.hypot(cx - (f - 0.5) * sq, cy - (8 - r + 0.5) * sq);
          const dFlip = Math.hypot(cx - (8 - f + 0.5) * sq, cy - (r - 0.5) * sq);
          return dFlip < dWhite;
        }
      }
    } catch {}
    return !!(b.classList.contains('flipped') || b.closest('.flipped'));
  }

  function detectUserSide() {
    if (!findBoard()) return null;
    return isFlipped() ? 'b' : 'w';
  }

  function isGameOver() {
    return !!document.querySelector(
      '.game-over-modal-content, .game-over-header-component, [class*="game-over"], .result-message-component'
    );
  }

  // ---- moves -----------------------------------------------------------------
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

  // Replay a UCI list and return the resulting position.
  function replayMoves(uci) {
    const pos = createPosition();
    for (const u of uci) { if (!applyUci(pos, u)) break; }
    return pos;
  }

  // ---- openings (ECO) --------------------------------------------------------
  function loadOpenings() {
    if (OPENINGS || openingsLoading) return;
    openingsLoading = true;
    try {
      fetch(chrome.runtime.getURL('openings.json'))
        .then((r) => r.json())
        .then((data) => {
          OPENINGS = data;
          resolvePopular();
          lastSig = '';
          schedule(20);
        })
        .catch(() => { openingsLoading = false; });
    } catch { openingsLoading = false; }
  }

  const stripEco = (v) => v.replace(/^[A-E]\d+\s+/, '');

  // For each POPULAR name, keep the shortest (canonical root) UCI line.
  function resolvePopular() {
    const wanted = new Set(POPULAR.map((o) => o.name));
    const best = {};
    for (const key in OPENINGS) {
      const name = stripEco(OPENINGS[key]);
      if (!wanted.has(name)) continue;
      const plies = key.split(' ').length;
      if (!best[name] || plies < best[name].plies) best[name] = { uci: key.split(' '), plies };
    }
    popularResolved = POPULAR
      .filter((o) => best[o.name])
      .map((o) => ({ name: o.name, side: o.side, uci: best[o.name].uci }));
  }

  function chosenLine() {
    if (!state.openingId || !popularResolved) return null;
    const o = popularResolved.find((x) => x.name === state.openingId);
    return o ? o.uci : null;
  }

  function isPrefix(a, b) {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Deepest known continuation of the exact line played so far → its next move.
  function treeExtend(uci) {
    const cur = uci.join(' ');
    const need = cur ? cur + ' ' : '';
    let move = null, deepest = -1;
    for (const key in OPENINGS) {
      if (!key.startsWith(need)) continue;
      const rest = key.slice(need.length);
      if (!rest) continue;
      const plies = key.split(' ').length;
      if (plies > deepest) { deepest = plies; move = rest.split(' ', 1)[0]; }
    }
    return move;
  }

  // The book move to recommend now (UCI), or null if we're out of book.
  function bookMove(uci, openingInfo) {
    if (!OPENINGS || uci.length >= MAX_BOOK_PLY) return null;
    const chosen = chosenLine();
    if (chosen) {
      // Still walking into the chosen opening: follow its line move by move.
      if (uci.length < chosen.length) return isPrefix(uci, chosen) ? chosen[uci.length] : null;
      // Past its root but diverged from the chosen family → out of book.
      if (!isPrefix(chosen, uci)) return null;
      return treeExtend(uci);
    }
    // Auto mode: only offer book moves while we still match a named opening.
    if (!openingInfo) return null;
    return treeExtend(uci);
  }

  // Longest opening name matching the played line.
  function detectOpening(uci) {
    if (!OPENINGS) return null;
    const n = Math.min(uci.length, MAX_BOOK_PLY);
    for (let L = n; L >= 1; L--) {
      const v = OPENINGS[uci.slice(0, L).join(' ')];
      if (v) return { eco: v.slice(0, v.indexOf(' ')), name: stripEco(v), depth: L };
    }
    return null;
  }

  // ---- engine (continuous, bot/analysis only) --------------------------------
  function curSig(uci) { return state.depth + ':' + state.arrows + '@' + uci.join(','); }

  function maybeAnalyze(uci) {
    if (engineDead || !engineAvailable() || !Explain) return;
    const sig = curSig(uci);
    // Already running, done, OR errored for this exact position+depth — leave it
    // be. Critically, a failed search must NOT be retried for the same position:
    // doing so loops render→runEngine→error→render and respawns the Stockfish
    // worker until the browser hangs. It only re-runs when the position or depth
    // changes (which yields a new sig).
    if (engineState.sig === sig) return;
    // A different position is mid-search: remember the latest, run it next.
    if (engineState.status === 'running') { pendingUci = uci; return; }
    runEngine(uci, sig);
  }

  async function runEngine(uci, sig) {
    engineState.sig = sig;
    engineState.status = 'running';
    engineState.result = null;
    lastSig = '';
    render(detectContext());
    try {
      const pos = replayMoves(uci);
      const fen = toFen(pos);
      const sideToMove = uci.length % 2 === 0 ? 'w' : 'b';
      const r = await engineGo(fen, { depth: state.depth, multipv: state.arrows });
      engineFailures = 0; // a clean search resets the breaker
      if (engineState.sig !== sig) return; // user moved on

      // Second search: the other side's top replies AFTER the best move, so the
      // opponent gets candidate arrows too (symmetric with yours).
      let replyLines = [], replyPos = null;
      const best = r.lines && r.lines[0];
      if (best && best.move) {
        try {
          replyPos = replayMoves([...uci, best.move]);
          const r2 = await engineGo(toFen(replyPos), { depth: state.depth, multipv: state.arrows });
          if (engineState.sig !== sig) return;
          replyLines = r2.lines || [];
        } catch { replyPos = null; }
      }

      if (engineState.sig === sig) {
        engineState.result = {
          lines: r.lines || [], pv: r.pv || [], score: r.score, pos, sideToMove,
          replyLines, replyPos
        };
        engineState.status = 'done';
      }
    } catch (e) {
      // DOMException doesn't subclass Error, so logging it bare prints the
      // useless "[object DOMException]"; pull its name/message out explicitly.
      const detail = e && (e.name || e.message)
        ? [e.name, e.message].filter(Boolean).join(': ') : String(e);
      console.error('[chess-coach] analysis failed:', detail, e);
      if (engineState.sig === sig) engineState.status = 'error';
      if (++engineFailures >= 3) {
        engineDead = true;
        engineStop();
        console.warn('[chess-coach] disabling engine after repeated failures');
      }
    }
    lastSig = '';
    render(detectContext());
    if (pendingUci) { const p = pendingUci; pendingUci = null; maybeAnalyze(p); }
  }

  // ---- arrows ----------------------------------------------------------------
  function clearArrows() {
    document.getElementById(ARROW_ID)?.remove();
    lastArrowSig = '';
  }

  const squareCentre = (file, rank, flipped) => flipped
    ? { x: (7 - file) + 0.5, y: (rank - 1) + 0.5 }
    : { x: file + 0.5, y: (8 - rank) + 0.5 };

  // Render-ready arrows. Each carries a resolved colour (by side + rank) so the
  // drawer stays dumb. z-order: book first, then candidates, reply last.
  //   { uci, color, dim? }
  function computeArrows(uci, haveEngine) {
    const arrows = [];
    const opening = detectOpening(uci);
    const bm = bookMove(uci, opening);
    if (bm) arrows.push({ uci: bm, color: BOOK_COLOR });

    if (haveEngine) {
      const res = engineState.result;
      const rank = (i) => RANK_COLORS[Math.min(i, RANK_COLORS.length - 1)];
      // Candidate moves for whoever is to move (solid). A shown book arrow takes
      // one of the configured slots, so we draw one fewer engine move to keep the
      // total at `state.arrows`.
      const budget = state.arrows - (bm ? 1 : 0);
      let n = 0;
      for (const ln of res.lines) {
        if (n >= budget) break;
        if (!ln.move || (bm && ln.move === bm)) continue;
        arrows.push({ uci: ln.move, color: rank(n) });
        n++;
      }
      // The other side's top replies after the best move (dimmer, since they are
      // one ply hypothetical). Same rank palette — the board shows whose move it is.
      (res.replyLines || []).slice(0, state.arrows).forEach((ln, i) => {
        if (!ln.move) return;
        arrows.push({ uci: ln.move, color: rank(i), dim: true });
      });
    }
    return arrows;
  }

  // A smooth Lichess-style arrow as a single polygon (tapered shaft + head),
  // expressed in board-square units. Kept slim so it obscures the squares as
  // little as possible.
  function arrowPolygon(A, B) {
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;     // direction
    const px = -uy, py = ux;                 // perpendicular
    const startGap = 0.12, tipGap = 0.04, headL = 0.22, shaftW = 0.03, headW = 0.1;
    const S = { x: A.x + ux * startGap, y: A.y + uy * startGap };
    const T = { x: B.x - ux * tipGap, y: B.y - uy * tipGap };
    const H = { x: T.x - ux * headL, y: T.y - uy * headL };
    const pts = [
      [S.x + px * shaftW, S.y + py * shaftW],
      [H.x + px * shaftW, H.y + py * shaftW],
      [H.x + px * headW, H.y + py * headW],
      [T.x, T.y],
      [H.x - px * headW, H.y - py * headW],
      [H.x - px * shaftW, H.y - py * shaftW],
      [S.x - px * shaftW, S.y - py * shaftW]
    ];
    return pts.map((p) => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(' ');
  }

  function drawArrows(list) {
    const board = findBoard();
    if (!board || !list.length) { clearArrows(); return; }
    const flipped = isFlipped();

    let svg = document.getElementById(ARROW_ID);
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = ARROW_ID;
      svg.setAttribute('viewBox', '0 0 8 8');
      svg.setAttribute('preserveAspectRatio', 'none');
      Object.assign(svg.style, {
        position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '50', overflow: 'visible'
      });
      if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
      board.appendChild(svg);
    }

    let shapes = '';
    for (const a of list) {
      const ff = a.uci.charCodeAt(0) - 97, fr = +a.uci[1];
      const tf = a.uci.charCodeAt(2) - 97, tr = +a.uci[3];
      if (ff < 0 || ff > 7 || tf < 0 || tf > 7 || !(fr >= 1 && fr <= 8) || !(tr >= 1 && tr <= 8)) continue;
      const A = squareCentre(ff, fr, flipped), B = squareCentre(tf, tr, flipped);
      const poly = arrowPolygon(A, B);
      const op = a.dim ? 0.38 : 0.62;
      shapes += `<polygon points="${poly}" fill="${a.color}" stroke="${a.color}" ` +
        `stroke-width="0.02" stroke-linejoin="round" opacity="${op}"></polygon>`;
    }
    svg.innerHTML = shapes;
  }

  // ---- bar (UI under the board) ----------------------------------------------
  function ensureBar() {
    let el = document.getElementById(BAR_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BAR_ID;
    el.className = 'chess-coach-bar';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    el.className = 'chess-coach-panel';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function removeUi() {
    document.getElementById(BAR_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    clearArrows();
    lastSig = '';
  }

  // Anchor the bulb near the board's bottom-RIGHT corner, nudged left/down so it
  // clears the clock that sits in the bottom strip. Returns false if there is no
  // usable board.
  function positionBar(el) {
    const board = findBoard();
    if (!board) return false;
    const r = board.getBoundingClientRect();
    if (r.width < 60) return false;
    el.style.left = 'auto';
    el.style.right = Math.max(4, Math.round(window.innerWidth - r.right) + 150) + 'px';
    el.style.top = Math.round(r.bottom + 4 + 10) + 'px';
    return true;
  }

  function openingPicker(userSide) {
    const all = popularResolved || [];
    // Show only openings for the side you're playing; always keep the current
    // pick visible even if it belongs to the other side.
    const list = all.filter((o) => o.side === userSide || o.name === state.openingId);
    const sideLabel = userSide === 'b' ? 'Black' : 'White';
    let opts = `<option value=""${!state.openingId ? ' selected' : ''}>Auto-detect (${sideLabel})</option>`;
    for (const o of list) {
      opts += `<option value="${esc(o.name)}"${state.openingId === o.name ? ' selected' : ''}>${esc(o.name)}</option>`;
    }
    return `<select class="cc-select" data-cc-opening>${opts}</select>`;
  }

  // Compact, inline result chips for the single-line layout.
  function resultsHtml(uci) {
    const sideToMove = uci.length % 2 === 0 ? 'w' : 'b';
    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    const opening = detectOpening(uci);
    let chips = '';

    const bm = bookMove(uci, opening);
    if (bm) {
      const san = Explain.sanOf(replayMoves(uci), bm);
      chips += `<span class="cc-chip cc-book">${esc(san)}</span>`;
    }

    if (engineDead) {
      return chips + `<span class="cc-chip cc-info" title="Reload the page to retry">⚠ Stockfish stopped</span>`;
    }
    if (!engineAvailable()) {
      return chips + `<span class="cc-chip cc-info">Stockfish unavailable</span>`;
    }

    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(uci) && engineState.result;
    if (!haveEngine) {
      const msg = engineState.status === 'error' ? '⚠ Engine error' : `Analysing… (d${state.depth})`;
      return chips + `<span class="cc-chip cc-info">${msg}</span>`;
    }

    const res = engineState.result;
    const userToMove = sideToMove === userSide;
    const moveCls = userToMove ? 'cc-good' : 'cc-opp';

    const best = res.lines[0];
    if (best && best.move) {
      const san = Explain.sanOf(res.pos, best.move);
      const evalText = Explain.formatScore(best.score, !userToMove);
      const expl = Explain.explainBest(res.pos, best.move, best.score, best.pv && best.pv[1]);
      const icon = userToMove ? '★' : '⚔';
      chips += `<span class="cc-chip ${moveCls}" title="${esc(expl || '')}">${icon} <b>${esc(san)}</b> ${esc(evalText)}</span>`;
    }
    const alts = res.lines.slice(1, state.arrows).filter((l) => l.move)
      .map((l) => esc(Explain.sanOf(res.pos, l.move)));
    if (alts.length) chips += `<span class="cc-chip cc-alts">${alts.join(' · ')}</span>`;

    // The other side's best reply (and a couple of alternatives).
    const rep = res.replyLines && res.replyPos ? res.replyLines.filter((l) => l.move) : [];
    if (rep.length) {
      const replyCls = userToMove ? 'cc-opp' : 'cc-good';
      const icon = userToMove ? '⚔' : '★';
      const label = userToMove ? "Opponent's reply" : 'Your reply';
      const sans = rep.slice(0, state.arrows).map((l) => esc(Explain.sanOf(res.replyPos, l.move)));
      chips += `<span class="cc-chip ${replyCls}" title="${esc(label)}">${icon} ${sans.join(' · ')}</span>`;
    }
    return chips;
  }

  // Under the board: just the on/off lightbulb — no box, no text — so it stays
  // tiny and clear of the clock. The opening name lives in the panel header.
  function buildBar() {
    const lit = state.enabled;
    return `<button class="cc-bulb${lit ? ' cc-bulb--on' : ''}" data-act="toggle" title="${lit ? 'Turn coaching off' : 'Turn coaching on'}" aria-label="Toggle coaching">💡</button>`;
  }

  // Bottom-right of the screen: settings + results, with a minimize/expand button.
  function buildPanel(ctx, uci) {
    const min = state.panelMin;
    const opening = detectOpening(uci);
    const titleText = opening ? `${opening.eco} · ${opening.name}` : (OPENINGS ? 'Out of book' : 'Coach');
    const header = `<div class="cc-phead">
      <span class="cc-ptitle" title="${esc(titleText)}">♞ ${esc(titleText)}</span>
      <button class="cc-pbtn" data-act="panelmin" title="${min ? 'Expand' : 'Minimize'}" aria-label="${min ? 'Expand' : 'Minimize'}">${min ? '▢' : '—'}</button>
    </div>`;
    if (min) return header;
    const legend = LEGEND.map((it) =>
      `<span class="cc-lg"><i style="background:${it.color}"></i>${esc(it.label)}</span>`
    ).join('');

    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    return header + `<div class="cc-pbody">
      <div class="cc-prow">${openingPicker(userSide)}</div>
      <label class="cc-prow cc-depth">Depth <output data-cc-depth-val>${state.depth}</output>
        <input type="range" min="6" max="22" step="1" value="${state.depth}" data-cc-depth></label>
      <label class="cc-prow cc-depth">Arrows <output data-cc-arrows-val>${state.arrows}</output>
        <input type="range" min="${ARROW_MIN}" max="${ARROW_MAX}" step="1" value="${state.arrows}" data-cc-arrows></label>
      <div class="cc-prow cc-results">${resultsHtml(uci)}</div>
      <div class="cc-prow cc-legend">${legend}</div>
    </div>`;
  }

  // ---- render ----------------------------------------------------------------
  function render(ctx) {
    if (ctx === 'other') { removeUi(); return; }

    const bar = ensureBar();
    const panel = ensurePanel();
    if (!positionBar(bar)) {
      bar.style.display = 'none';
      panel.style.display = 'none';
      clearArrows();
      return;
    }
    bar.style.display = '';

    // The ECO book is light and powers the opening name (shown even when
    // coaching is off), so load it whenever we're on a board. Stockfish — the
    // heavy WASM — stays on-demand and only fires while coaching is on.
    loadOpenings();

    const uci = sanToUci(bridgeSans || []);

    // Kick off / refresh continuous analysis only while coaching is on.
    if (state.enabled) maybeAnalyze(uci);

    // Arrows (independent of the bar's text so a board re-render can't strand them).
    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(uci) && engineState.result;
    const arrows = state.enabled ? computeArrows(uci, haveEngine) : [];
    const arrowSig = (isFlipped() ? 'f|' : 'n|') + arrows.map((a) => a.color + a.uci).join('|');
    if (arrowSig !== lastArrowSig || !document.getElementById(ARROW_ID)) {
      drawArrows(arrows);
      lastArrowSig = arrowSig;
    }

    const showPanel = state.enabled;
    panel.style.display = showPanel ? '' : 'none';

    const sig = [ctx, state.enabled, state.panelMin, showPanel, state.openingId || 'auto',
      state.depth, uci.join(','), engineState.status, engineState.sig, !!OPENINGS].join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    bar.className = 'chess-coach-bar';
    bar.innerHTML = buildBar();
    bindBar(bar);

    if (showPanel) {
      panel.className = 'chess-coach-panel' + (state.panelMin ? ' is-min' : '');
      panel.innerHTML = buildPanel(ctx, uci);
      bindPanel(panel);
    }
  }

  // ---- events ----------------------------------------------------------------
  function bindBar(el) {
    el.querySelector('[data-act="toggle"]')?.addEventListener('click', () => {
      state.enabled = !state.enabled;
      save();
      if (!state.enabled) clearArrows();
      lastSig = '';
      render(detectContext());
    });
  }

  function bindPanel(el) {
    el.querySelector('[data-act="panelmin"]')?.addEventListener('click', () => {
      state.panelMin = !state.panelMin;
      save();
      lastSig = '';
      render(detectContext());
    });

    const sel = el.querySelector('[data-cc-opening]');
    if (sel) sel.addEventListener('change', () => {
      state.openingId = sel.value || null;
      save();
      lastSig = '';
      render(detectContext());
    });

    const depth = el.querySelector('[data-cc-depth]');
    if (depth) {
      const out = el.querySelector('[data-cc-depth-val]');
      depth.addEventListener('input', () => { if (out) out.textContent = depth.value; });
      depth.addEventListener('change', () => {
        state.depth = Math.max(6, Math.min(22, parseInt(depth.value, 10) || 14));
        save();
        engineState.sig = null; // force re-analysis at the new depth
        lastSig = '';
        render(detectContext());
      });
    }

    const arrows = el.querySelector('[data-cc-arrows]');
    if (arrows) {
      const out = el.querySelector('[data-cc-arrows-val]');
      arrows.addEventListener('input', () => { if (out) out.textContent = arrows.value; });
      arrows.addEventListener('change', () => {
        state.arrows = Math.max(ARROW_MIN, Math.min(ARROW_MAX, parseInt(arrows.value, 10) || 3));
        save();
        engineState.sig = null; // re-run: MultiPV count changed
        lastSig = '';
        render(detectContext());
      });
    }
  }

  function save() {
    try {
      chrome.storage.local.set({
        ccEnabled: state.enabled, ccDepth: state.depth, ccOpening: state.openingId,
        ccPanelMin: state.panelMin, ccArrows: state.arrows
      });
    } catch {}
  }

  // ---- lifecycle -------------------------------------------------------------
  let scheduled = false;
  function schedule(delay) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!alive()) return;
      const ctx = detectContext();
      if (ctx === 'other') { removeUi(); return; }
      render(ctx);
    }, delay);
  }

  function start() {
    let lastUrl = location.href;
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; lastSig = ''; lastArrowSig = ''; schedule(500); }
      else schedule(200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    addEventListener('scroll', () => schedule(60), true);
    addEventListener('resize', () => schedule(60));
    schedule(300);
  }

  try {
    chrome.storage.local.get(['ccEnabled', 'ccDepth', 'ccOpening', 'ccPanelMin', 'ccArrows'], (o) => {
      state.enabled = o.ccEnabled !== false;
      state.depth = Math.max(6, Math.min(22, o.ccDepth || 14));
      state.openingId = o.ccOpening || null;
      state.panelMin = !!o.ccPanelMin;
      state.arrows = Math.max(ARROW_MIN, Math.min(ARROW_MAX, o.ccArrows || 3));
      start();
    });
  } catch {
    start();
  }
})();
