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
  const fromFen = globalThis.fromFen;
  // Explain is load-bearing for the whole panel (resultsHtml calls it
  // unconditionally) — if any dependency failed to load, don't half-run with
  // book arrows but a dead engine; disable the coach outright.
  if (!createPosition || !applySan || !globalThis.ChessExplain) return;

  const Explain = globalThis.ChessExplain;
  const sliceToViewedPly = globalThis.sliceToViewedPly;
  const AiPrompt = globalThis.ChessAiPrompt;
  const I18n = globalThis.ChessI18n;
  const t = (key, ...args) => (I18n ? I18n.t(state.lang, key, ...args) : key);

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
  // The opponent-reply arrows are one-ply hints; search cost grows steeply with
  // depth while the top replies barely change past this, so the second search
  // is capped here regardless of the user's depth setting.
  const REPLY_DEPTH = 10;

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
  const rankColor = (i) => RANK_COLORS[Math.min(i, RANK_COLORS.length - 1)];
  // Results are grouped one line per side (W / B tag), and each move within a
  // line is coloured by its rank to match the board arrows (best green, then
  // blue, amber…), so panel and board speak one colour language.
  const moveItem = (color, san, evalText) =>
    `<span class="cc-mv" style="color:${color}"><b>${esc(san)}</b>${evalText ? ' ' + esc(evalText) : ''}</span>`;
  // One side's candidate line: its W/B tag then its moves (rank-coloured). Evals
  // are shown on one shared scale — White's point of view, like an eval bar — so
  // the two lines are directly comparable; a Black move's score (from Black's own
  // POV) is flipped to get there. Returns '' when empty.
  function sideLine(side, list, pos, opts = {}) {
    if (!list || !list.length || !pos) return '';
    const items = list.slice(0, state.arrows).filter((l) => l.move)
      .map((l, i) => moveItem(rankColor(i), Explain.sanOf(pos, l.move), Explain.formatScore(l.score, side === 'b')))
      .join('');
    if (!items) return '';
    const tag = `<span class="cc-side-tag" title="${esc(side === 'w' ? t('sideWhite') : t('sideBlack'))}"><i class="cc-dot cc-dot-${side}"></i></span>`;
    return `<div class="cc-side-line${opts.dim ? ' cc-dim' : ''}">${tag}${items}</div>`;
  }
  const legend = () => [
    { color: BOOK_COLOR, label: t('legendBook') },
    { color: RANK_COLORS[0], label: t('legendBest') },
    { color: RANK_COLORS[1], label: t('legend2nd') },
    { color: RANK_COLORS[2], label: t('legend3rd') }
  ];

  // enabled: the lightbulb toggle. depth: Stockfish search depth. openingId: a
  // POPULAR name to train, or null = auto-detect.
  const state = { enabled: true, depth: 14, openingId: null, panelMin: false, arrows: 3, lang: 'en' };
  let lastSig = '';
  let lastArrowSig = '';

  let bridgeSans = null;
  let bridgePlayingAs = null;
  let bridgePlyViewed = null; // ply currently on screen; null/out-of-range = end of game (live play)
  let bridgeFen = null; // chess.com's own getFEN() for the on-screen position — ground truth, see buildView()

  // openings.json, lazily fetched the first time we land on a coached surface.
  let OPENINGS = null;
  let popularResolved = null;
  let openingsLoading = false;

  //   status: 'idle' | 'running' | 'done' | 'error'
  const engineState = { sig: null, status: 'idle', result: null };
  let pendingView = null;

  // Gemini explanation of the current best move, fetched on demand (user
  // clicks "Explain") — never automatically, see plan.md Phase 7 cost control.
  //   key: cacheKeyFor-style string identifying which position this belongs to
  //   status: 'idle' | 'running' | 'done' | 'error'
  const explainState = { key: null, status: 'idle', data: null, error: null };
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

  // True when the viewed position is the latest one in the game (not scrubbing
  // back through history). Only at the head is "the move just played" the last
  // move of the record — which is what the live move-review grades.
  function atLiveHead() {
    const all = bridgeSans || [];
    const viewed = sliceToViewedPly ? sliceToViewedPly(all, bridgePlyViewed) : all;
    return viewed.length >= all.length;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__chessCoach !== 'moves') return;
    bridgeSans = Array.isArray(d.sans) ? d.sans : [];
    bridgePlayingAs = d.playingAs ?? null;
    bridgePlyViewed = typeof d.plyViewed === 'number' ? d.plyViewed : null;
    bridgeFen = typeof d.fen === 'string' ? d.fen : null;
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

  // ---- position view ----------------------------------------------------------
  const clonePos = (p) => ({ board: p.board.slice(), turn: p.turn, castling: { ...p.castling }, ep: p.ep });

  // Board, turn and castling only. En passant is skipped on purpose: our toFen
  // records the ep square after every double push, while chess.com's FEN may
  // list it only when a capture is actually possible — comparing that field
  // would flag a phantom "desync" on ordinary pawn moves and stall the coach
  // for a whole ply. Halfmove/fullmove counters we don't track at all.
  const fenCore = (fen) => (typeof fen === 'string' ? fen.split(' ').slice(0, 3).join(' ') : null);

  let lastDesyncWarn = '';

  // One consistent description of the position to coach, computed per render:
  //   uci    — the viewed moves replayed from the start (short if parsing broke)
  //   pos    — the position to analyze
  //   fen    — its FEN: the engine input and the analysis cache key
  //   synced — our replay provably matches the live board, so move-list-derived
  //            features (the opening book) can be trusted
  //
  // The SAN replay can go wrong two ways: applySan fails outright on a move
  // (uci comes up short), or — worse — resolves an ambiguous SAN to the wrong
  // piece and silently corrupts every later position. Either way Stockfish
  // would confidently describe a board that isn't the one on screen ("gives
  // check" when it doesn't, wrong side to move). So the replay is verified
  // against chess.com's own getFEN() (ground truth, forwarded by the bridge);
  // on any disagreement the coach analyzes THAT FEN directly instead — engine
  // arrows/eval/explain keep working, only book hints pause. Returns null only
  // when the replay broke AND no ground-truth FEN is available.
  function buildView() {
    const viewedSans = sliceToViewedPly ? sliceToViewedPly(bridgeSans || [], bridgePlyViewed) : (bridgeSans || []);
    const pos = createPosition();
    const uci = [];
    let parseOk = true;
    for (const s of viewedSans) {
      const u = applySan(pos, s);
      if (!u) { parseOk = false; break; }
      uci.push(u);
    }
    const real = fenCore(bridgeFen);
    if (parseOk && (!real || fenCore(toFen(pos)) === real)) {
      return { uci, pos, fen: toFen(pos), synced: true };
    }

    const warnKey = (bridgeFen || 'no-fen') + '@' + viewedSans.length;
    if (warnKey !== lastDesyncWarn) {
      lastDesyncWarn = warnKey;
      console.warn("[chess-coach] move-list replay does not match the live board — coaching from chess.com's FEN", {
        parseOk, failedAt: parseOk ? null : viewedSans[uci.length],
        ours: fenCore(toFen(pos)), real, plyViewed: bridgePlyViewed
      });
    }
    const fallback = bridgeFen && fromFen ? fromFen(bridgeFen) : null;
    if (!fallback) return null;
    return { uci, pos: fallback, fen: toFen(fallback), synced: false };
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
  // Keyed by the position's FEN (not the move order) — transpositions share one
  // search, and the FEN-fallback view (see buildView) needs no move list at all.
  function curSig(view) { return state.depth + ':' + state.arrows + '@' + view.fen; }

  function maybeAnalyze(view) {
    if (engineDead || !engineAvailable() || !Explain) return;
    const sig = curSig(view);
    // Already running, done, OR errored for this exact position+depth — leave it
    // be. Critically, a failed search must NOT be retried for the same position:
    // doing so loops render→runEngine→error→render and respawns the Stockfish
    // worker until the browser hangs. It only re-runs when the position or depth
    // changes (which yields a new sig).
    if (engineState.sig === sig) return;
    // A different position is mid-search: remember the latest, run it next.
    if (engineState.status === 'running') { pendingView = view; return; }
    runEngine(view, sig);
  }

  async function runEngine(view, sig) {
    engineState.sig = sig;
    engineState.status = 'running';
    engineState.result = null;
    lastSig = '';
    render(detectContext());
    try {
      const pos = view.pos;
      const r = await engineGo(view.fen, { depth: state.depth, multipv: state.arrows });
      engineFailures = 0; // a clean search resets the breaker
      if (engineState.sig !== sig) return; // user moved on

      // Publish immediately: arrows, eval and the Explain button need nothing
      // from the reply search, so the user shouldn't stare at "Analysing…"
      // while a second search runs. The reply arrows stream in afterwards.
      engineState.result = {
        lines: r.lines || [], pv: r.pv || [], score: r.score, pos, sideToMove: pos.turn,
        replyLines: [], replyPos: null
      };
      engineState.status = 'done';
      lastSig = '';
      render(detectContext());

      const best = r.lines && r.lines[0];
      const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
      // When it is the opponent's turn at the live head, the user has just moved
      // and has nothing to play now — so instead of coaching the opponent, grade
      // the move they just made. This needs no extra-cost search beyond the
      // parent: the played move's value is the CURRENT eval (opponent to move)
      // negated, and the best is the parent's own top line.
      const reviewable = view.synced && view.uci.length >= 1 && atLiveHead() && pos.turn !== userSide;

      if (reviewable && !pendingView) {
        try {
          const parentPos = createPosition();
          let ok = true;
          for (const u of view.uci.slice(0, -1)) if (!applyUci(parentPos, u)) { ok = false; break; }
          const playedUci = view.uci[view.uci.length - 1];
          if (ok) {
            const pr = await engineGo(toFen(parentPos), { depth: state.depth, multipv: 1 });
            if (engineState.sig !== sig) return;
            const pBest = pr.lines && pr.lines[0];
            if (pBest && pBest.move && pr.score && r.score) {
              const eBest = Explain.scoreToCp(pr.score);   // parent side to move IS the user
              const ePlayed = -Explain.scoreToCp(r.score); // current eval is the opponent's POV
              const cpLoss = eBest - ePlayed;
              const replyUci = best && best.move ? best.move : null; // opponent's punishing reply
              const verdict = Explain.explainPlayed(parentPos, playedUci, pBest.move, cpLoss, replyUci, state.lang);
              engineState.result.review = {
                ...verdict, // { key, label, text }
                playedUci, playedSan: Explain.sanOf(parentPos, playedUci),
                bestUci: pBest.move, bestSan: Explain.sanOf(parentPos, pBest.move),
                bestScore: pr.score
              };
              lastSig = '';
              render(detectContext());
            }
          }
        } catch {} // the review is optional — keep the published main result
      } else if (best && best.move && !pendingView) {
        // Second search: the other side's top replies AFTER the best move, so the
        // opponent gets candidate arrows too (symmetric with yours). Skipped when
        // a newer position is already waiting — its main search matters more than
        // this position's hint arrows.
        try {
          const after = clonePos(pos);
          if (applyUci(after, best.move)) {
            const r2 = await engineGo(toFen(after), { depth: Math.min(state.depth, REPLY_DEPTH), multipv: state.arrows });
            if (engineState.sig !== sig) return;
            engineState.result.replyLines = r2.lines || [];
            engineState.result.replyPos = after;
          }
        } catch {} // reply arrows are optional — keep the published main result
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
    if (pendingView) { const p = pendingView; pendingView = null; maybeAnalyze(p); }
  }

  // ---- Gemini explanation (on demand) -----------------------------------------
  // SAN of a move including a trailing '+' when it gives check — our core SAN
  // omits check/mate marks, but they're worth grounding so the model can say
  // "with check" only when it's actually true.
  function sanChecked(pos, uci) {
    const f = Explain.moveFacts(pos, uci);
    if (!f) return Explain.sanOf(pos, uci);
    return f.san + (f.givesCheck ? '+' : '');
  }

  // Replay a UCI line from `startPos` and return its moves in SAN (with check
  // marks). moveFacts reads the pre-move position without mutating it, so the
  // facts are computed before applyUci advances the board.
  function lineToSan(startPos, uciLine) {
    const pos = clonePos(startPos);
    const out = [];
    for (const u of uciLine || []) {
      const f = Explain.moveFacts(pos, u);
      if (!applyUci(pos, u)) break;
      out.push(f ? f.san + (f.givesCheck ? '+' : '') : u);
    }
    return out;
  }

  // A plain-English, board-grounded description of a move — "White knight
  // g1–f3, capturing the bishop, giving check". Built from moveFacts (which
  // reads the real board), so the piece names are always correct; this is what
  // we hand Gemini instead of a bare UCI string, whose piece identity it would
  // otherwise have to (and often does wrongly) infer from the FEN.
  function describeMove(uci, facts) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const white = facts.pieceChar === facts.pieceChar.toUpperCase();
    const color = white ? 'White' : 'Black';
    let s = facts.isCastle
      ? `${color} castles (${facts.san})`
      : `${color} ${Explain.pieceName(facts.pieceChar, 'en')} ${from}–${to}`;
    if (facts.captured) s += `, capturing the ${Explain.pieceName(facts.captured, 'en')}`;
    if (facts.promo) s += `, promoting to a ${Explain.pieceName(facts.promo, 'en')}`;
    if (facts.givesCheck) s += ', giving check';
    return s;
  }

  // Shape data for the AI service from the already-computed engine result —
  // never the raw Stockfish log (see plan.md Phase 1). Moves are pre-resolved
  // to SAN and an explicit piece description here (from the real board) so the
  // model never has to read piece identities out of the FEN itself.
  // The move actually played from the analyzed position — known only when the
  // user is reviewing history (the viewed ply sits before the end of the game;
  // the next SAN in the record is what was played from here). Validated by
  // replaying it against the analyzed position itself, so a desynced move list
  // can never attach a move that is illegal on this board.
  function playedFromHere(pos) {
    const all = bridgeSans || [];
    const viewed = sliceToViewedPly ? sliceToViewedPly(all, bridgePlyViewed) : all;
    if (viewed.length >= all.length) return null; // live head: nothing played yet
    const clone = clonePos(pos);
    const uci = applySan(clone, all[viewed.length]);
    if (!uci) return null;
    const facts = Explain.moveFacts(pos, uci);
    return {
      san: sanChecked(pos, uci),
      description: facts ? describeMove(uci, facts) : null
    };
  }

  function buildExplainInput(res) {
    const best = res.lines && res.lines[0];
    if (!best || !best.move) return null;
    const pos = res.pos;
    const facts = Explain.moveFacts(pos, best.move);
    const played = playedFromHere(pos);
    return {
      fen: toFen(pos),
      bestMove: best.move,
      bestSan: sanChecked(pos, best.move),
      moveDescription: facts ? describeMove(best.move, facts) : null,
      playedMove: played ? played.san : null,
      playedDescription: played ? played.description : null,
      userSide: mapSide(bridgePlayingAs) || detectUserSide() || 'w',
      eval: best.score,
      depth: best.depth || state.depth,
      pv: (best.pv || []).slice(0, 8),
      pvSan: lineToSan(pos, best.pv || []).slice(0, 8),
      topMoves: res.lines.slice(0, 4).filter((l) => l.move)
        .map((l) => ({ move: l.move, san: sanChecked(pos, l.move), eval: l.score })),
      lang: state.lang
    };
  }

  function requestExplain(data) {
    const key = AiPrompt ? AiPrompt.cacheKeyFor(data) : `${data.fen}|${data.bestMove}|${data.depth}`;
    if (explainState.key === key && explainState.status !== 'idle') return; // already fetching/fetched
    explainState.key = key;
    explainState.status = 'running';
    explainState.data = null;
    explainState.error = null;
    lastSig = '';
    render(detectContext());
    try {
      chrome.runtime.sendMessage({ type: 'CC_EXPLAIN', data }, (resp) => {
        if (explainState.key !== key) return; // user moved on to a different position
        const err = chrome.runtime.lastError;
        if (err) { explainState.status = 'error'; explainState.error = err.message; }
        else if (resp && resp.error) { explainState.status = 'error'; explainState.error = resp.error; }
        else if (resp && resp.result) { explainState.status = 'done'; explainState.data = resp.result; }
        else { explainState.status = 'error'; explainState.error = 'no response'; }
        lastSig = '';
        render(detectContext());
      });
    } catch (e) {
      explainState.status = 'error';
      explainState.error = e && e.message ? e.message : String(e);
    }
  }

  // Renders the Explain button, its loading/error state, or the result — a
  // self-contained row like resultsHtml(), recomputing haveEngine itself.
  function explainHtml(view) {
    if (!AiPrompt) return '';
    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(view) && engineState.result;
    if (!haveEngine) return '';

    const data = buildExplainInput(engineState.result);
    const skip = AiPrompt.shouldSkipExplain(data);
    if (skip.skip) {
      return `<div class="cc-prow cc-explain"><span class="cc-chip cc-info">${esc(skip.reason)}</span></div>`;
    }

    const key = AiPrompt.cacheKeyFor(data);
    if (explainState.key !== key || explainState.status === 'idle') {
      return `<div class="cc-prow cc-explain"><button class="cc-explain-btn" data-act="explain">${esc(t('explainThisMove'))}</button></div>`;
    }
    if (explainState.status === 'running') {
      return `<div class="cc-prow cc-explain"><span class="cc-chip cc-info">${esc(t('analysing'))}</span></div>`;
    }
    if (explainState.status === 'error') {
      return `<div class="cc-prow cc-explain">
        <span class="cc-chip cc-info" title="${esc(explainState.error || '')}">${esc(t('explainFailed'))}</span>
        <button class="cc-explain-btn" data-act="explain">${esc(t('retry'))}</button>
      </div>`;
    }

    // Strategy-first: Stockfish's numbers already live in the chips above, so
    // the AI panel shows only the fields that add the human plan — what the best
    // move does, the middlegame plan, the opponent's intent, and the reusable
    // principle (the transferable takeaway that makes it a lesson, not commentary).
    const d = explainState.data;
    return `<div class="cc-prow cc-explain-result">
      ${d.whyBest ? `<div class="cc-erow"><b>${esc(t('bestMoveLabel'))}</b> ${esc(d.whyBest)}</div>` : ''}
      ${d.plan ? `<div class="cc-erow"><b>${esc(t('planLabel'))}</b> ${esc(d.plan)}</div>` : ''}
      ${d.opponentReply ? `<div class="cc-erow"><b>${esc(t('replyLabel'))}</b> ${esc(d.opponentReply)}</div>` : ''}
      ${d.principle ? `<div class="cc-erow"><b>${esc(t('principleLabel'))}</b> ${esc(d.principle)}</div>` : ''}
    </div>`;
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
  function computeArrows(view, haveEngine) {
    const arrows = [];
    // Book hints need the move sequence; when the view fell back to the raw
    // board FEN (synced=false) the move list is exactly what proved unreliable.
    const opening = view.synced ? detectOpening(view.uci) : null;
    const bm = view.synced ? bookMove(view.uci, opening) : null;
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
    // A dedicated slot for the bulb's HTML, so content.js can insert the
    // "Analyze on Lichess" button as a sibling without it getting wiped out
    // by this file's innerHTML re-renders below.
    el.innerHTML = '<span id="cc-bulb-slot" class="cc-bulb-slot"></span>';
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
    const sideLabel = userSide === 'b' ? t('sideBlack') : t('sideWhite');
    let opts = `<option value=""${!state.openingId ? ' selected' : ''}>${esc(t('autoDetect', sideLabel))}</option>`;
    for (const o of list) {
      opts += `<option value="${esc(o.name)}"${state.openingId === o.name ? ' selected' : ''}>${esc(o.name)}</option>`;
    }
    return `<select class="cc-select" data-cc-opening>${opts}</select>`;
  }

  // Compact, inline result chips for the single-line layout.
  function resultsHtml(view) {
    const sideToMove = view.pos.turn;
    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    let chips = '';

    const opening = view.synced ? detectOpening(view.uci) : null;
    const bm = view.synced ? bookMove(view.uci, opening) : null;
    if (bm) {
      const san = Explain.sanOf(view.pos, bm);
      chips += `<div class="cc-side-line"><span class="cc-side-tag" title="${esc(t('legendBook'))}">📖</span>${moveItem(BOOK_COLOR, san, '')}</div>`;
    }

    if (engineDead) {
      return chips + `<span class="cc-chip cc-info" title="${esc(t('reloadToRetry'))}">${esc(t('stockfishStopped'))}</span>`;
    }
    if (!engineAvailable()) {
      return chips + `<span class="cc-chip cc-info">${esc(t('stockfishUnavailable'))}</span>`;
    }

    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(view) && engineState.result;
    if (!haveEngine) {
      const msg = engineState.status === 'error' ? t('engineError') : t('analysingDepth', state.depth);
      return chips + `<span class="cc-chip cc-info">${esc(msg)}</span>`;
    }

    const res = engineState.result;
    const userToMove = sideToMove === userSide;

    // Opponent to move at the live head → the user just moved. Grade that move
    // instead of showing the opponent's best as if coaching them.
    if (!userToMove && view.synced && view.uci.length >= 1 && atLiveHead()) {
      if (!res.review) {
        return chips + `<span class="cc-chip cc-info">${esc(t('reviewingYourMove'))}</span>`;
      }
      const rv = res.review;
      // Verdict + the move you should have played, on one line. The verdict keeps
      // its own quality colour (green → red) since a played move has no arrow.
      let vline = `<div class="cc-side-line"><span class="cc-chip cc-cls-${rv.key}" title="${esc(rv.text || '')}">${esc(rv.label)} — <b>${esc(rv.playedSan)}</b></span>`;
      if (rv.bestUci && rv.bestUci !== rv.playedUci) {
        const evalText = Explain.formatScore(rv.bestScore, userSide === 'b'); // to White's POV, like the lines
        vline += `<span class="cc-chip cc-alts">${esc(t('shouldHavePlayed'))} <b>${esc(rv.bestSan)}</b> ${esc(evalText)}</span>`;
      }
      chips += vline + '</div>';
      // The opponent's candidate replies, on their own W/B line (they have arrows).
      chips += sideLine(sideToMove, res.lines, res.pos, {});
      return chips;
    }

    // Forward view: one line per side, White on top. The side to move gets its
    // candidates (res.lines, solid arrows); the other side gets its replies after
    // the best move (res.replyLines, dim arrows).
    const mine = { list: res.lines, pos: res.pos };
    const other = { list: res.replyLines, pos: res.replyPos };
    const white = sideToMove === 'w' ? mine : other;
    const black = sideToMove === 'w' ? other : mine;
    chips += sideLine('w', white.list, white.pos, { dim: sideToMove !== 'w' });
    chips += sideLine('b', black.list, black.pos, { dim: sideToMove !== 'b' });
    return chips;
  }

  // Under the board: just the on/off lightbulb — no box, no text — so it stays
  // tiny and clear of the clock. The opening name lives in the panel header.
  function buildBar() {
    const lit = state.enabled;
    return `<button class="cc-bulb${lit ? ' cc-bulb--on' : ''}" data-act="toggle" title="${esc(lit ? t('turnCoachingOff') : t('turnCoachingOn'))}" aria-label="${esc(t('toggleCoaching'))}">
      <svg class="cc-bulb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
        <path d="M9 18h6"/>
        <path d="M10 22h4"/>
      </svg>
    </button>`;
  }

  // Bottom-right of the screen: settings + results, with a minimize/expand button.
  function buildPanel(ctx, view) {
    const min = state.panelMin;
    const opening = view.synced ? detectOpening(view.uci) : null;
    const titleText = opening ? `${opening.eco} · ${opening.name}` : (OPENINGS ? t('outOfBook') : t('coach'));
    const minMaxLabel = min ? t('expand') : t('minimize');
    const header = `<div class="cc-phead">
      <span class="cc-ptitle" title="${esc(titleText)}">♞ ${esc(titleText)}</span>
      <button class="cc-pbtn" data-act="panelmin" title="${esc(minMaxLabel)}" aria-label="${esc(minMaxLabel)}">${min ? '▢' : '—'}</button>
    </div>`;
    if (min) return header;
    const legendHtml = legend().map((it) =>
      `<span class="cc-lg"><i style="background:${it.color}"></i>${esc(it.label)}</span>`
    ).join('');

    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    return header + `<div class="cc-pbody">
      <div class="cc-prow">${openingPicker(userSide)}</div>
      <label class="cc-prow cc-depth">${esc(t('depth'))} <output data-cc-depth-val>${state.depth}</output>
        <input type="range" min="6" max="22" step="1" value="${state.depth}" data-cc-depth></label>
      <label class="cc-prow cc-depth">${esc(t('arrows'))} <output data-cc-arrows-val>${state.arrows}</output>
        <input type="range" min="${ARROW_MIN}" max="${ARROW_MAX}" step="1" value="${state.arrows}" data-cc-arrows></label>
      <div class="cc-prow cc-results">${resultsHtml(view)}</div>
      ${explainHtml(view)}
      <div class="cc-prow cc-legend">${legendHtml}</div>
    </div>`;
  }

  // The position we'd analyze doesn't (yet) match what's really on screen —
  // see the two checks in render() below. Rather than leave stale arrows/panel
  // content up (which is exactly the "confidently wrong suggestion" bug this
  // guards against), clear them and show a small syncing state instead.
  function showOutOfSync(bar, panel) {
    clearArrows();
    bar.style.display = '';
    bar.className = 'chess-coach-bar';
    (bar.querySelector('#cc-bulb-slot') || bar).innerHTML = buildBar();
    bindBar(bar);
    if (state.enabled) {
      panel.style.display = '';
      panel.className = 'chess-coach-panel' + (state.panelMin ? ' is-min' : '');
      const header = `<div class="cc-phead"><span class="cc-ptitle">♞ ${esc(t('coach'))}</span></div>`;
      panel.innerHTML = state.panelMin ? header :
        header + `<div class="cc-pbody"><div class="cc-prow"><span class="cc-chip cc-info">${esc(t('syncing'))}</span></div></div>`;
    } else {
      panel.style.display = 'none';
    }
    lastSig = '';
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

    // The position to coach, verified against chess.com's own FEN (or rebuilt
    // straight from that FEN when our move-list replay can't be trusted — see
    // buildView). Null only when the replay broke AND no ground truth exists.
    const view = buildView();
    if (!view) {
      showOutOfSync(bar, panel);
      schedule(200);
      return;
    }

    // Kick off / refresh continuous analysis only while coaching is on.
    if (state.enabled) maybeAnalyze(view);

    // Arrows (independent of the bar's text so a board re-render can't strand them).
    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(view) && engineState.result;
    const arrows = state.enabled ? computeArrows(view, haveEngine) : [];
    const arrowSig = (isFlipped() ? 'f|' : 'n|') + view.fen + '|' +
      arrows.map((a) => a.color + a.uci).join('|');
    if (arrowSig !== lastArrowSig || !document.getElementById(ARROW_ID)) {
      drawArrows(arrows);
      lastArrowSig = arrowSig;
    }

    const showPanel = state.enabled;
    panel.style.display = showPanel ? '' : 'none';

    const sig = [ctx, state.enabled, state.panelMin, showPanel, state.openingId || 'auto',
      state.depth, view.fen, view.synced, engineState.status, engineState.sig, !!OPENINGS].join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    bar.className = 'chess-coach-bar';
    (bar.querySelector('#cc-bulb-slot') || bar).innerHTML = buildBar();
    bindBar(bar);

    if (showPanel) {
      panel.className = 'chess-coach-panel' + (state.panelMin ? ' is-min' : '');
      panel.innerHTML = buildPanel(ctx, view);
      bindPanel(panel, view);
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

  function bindPanel(el, view) {
    el.querySelector('[data-act="explain"]')?.addEventListener('click', () => {
      const haveEngine = engineState.status === 'done' && engineState.sig === curSig(view) && engineState.result;
      if (!haveEngine) return;
      const data = buildExplainInput(engineState.result);
      if (data) requestExplain(data);
    });

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
    chrome.storage.local.get(['ccEnabled', 'ccDepth', 'ccOpening', 'ccPanelMin', 'ccArrows', 'ccLanguage'], (o) => {
      state.enabled = o.ccEnabled !== false;
      state.depth = Math.max(6, Math.min(22, o.ccDepth || 14));
      state.openingId = o.ccOpening || null;
      state.panelMin = !!o.ccPanelMin;
      state.arrows = Math.max(ARROW_MIN, Math.min(ARROW_MAX, o.ccArrows || 3));
      state.lang = o.ccLanguage === 'vi' ? 'vi' : 'en';
      start();
    });
    // The language lives on the options page, a separate context — pick up a
    // change immediately instead of requiring a chess.com page reload.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ccLanguage) return;
      state.lang = changes.ccLanguage.newValue === 'vi' ? 'vi' : 'en';
      lastSig = '';
      render(detectContext());
    });
  } catch {
    start();
  }
})();
