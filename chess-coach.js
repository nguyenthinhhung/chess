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

  // Neutral Hint mode: one flat colour for every equivalent candidate — no
  // rank implied. Threshold is in centipawns (0.10-0.30 pawns per the spec).
  const NEUTRAL_COLOR = '#8a8a86';
  const NEUTRAL_THRESHOLD_MIN = 10, NEUTRAL_THRESHOLD_MAX = 30, NEUTRAL_THRESHOLD_DEFAULT = 20;

  // Hint interval: fixed numeric steps the picker offers, and the ladder
  // Adaptive mode's recommendation climbs (never past the largest step).
  const ADAPTIVE_STEPS = ['2', '3', '5', '10'];
  // Adaptive recommendation heuristic (session-scoped, deliberately simple —
  // see design discussion: a rolling window, a good-move ratio, a manual-hint
  // ceiling; no persistence, no ML).
  const HINT_LOG_MAX = 50;
  const HINT_LOG_MIN_WINDOW = 30;
  const HINT_GOOD_RATIO = 0.8;
  const HINT_MAX_MANUAL_RATIO = 0.1;

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
    // A candidate that's also the opening-book move gets the book colour
    // instead of its usual rank/neutral one — kept IN the list (not deduped
    // away) so opening practice still shows it sitting among the engine's
    // equally-good options, just recognisable as the book choice.
    const colorFor = (move, fallback) => (opts.bookMove && move === opts.bookMove) ? BOOK_COLOR : fallback;
    // Neutral Hint mode: the pre-filtered equivalent-candidate set, one flat
    // colour, no eval — deliberately doesn't reveal rank or the engine's pick.
    const items = opts.neutral
      ? opts.neutral.map((l) => moveItem(colorFor(l.move, NEUTRAL_COLOR), Explain.sanOf(pos, l.move), '')).join('')
      : list.slice(0, state.arrows).filter((l) => l.move)
          .map((l, i) => moveItem(colorFor(l.move, rankColor(i)), Explain.sanOf(pos, l.move), Explain.formatScore(l.score, side === 'b')))
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
  // POPULAR name to train, or null = auto-detect. hintInterval: '1'|'2'|'3'|'5'|
  // '10'|'manual'|'adaptive' — gates automatic suggestions only (Show Hint always
  // works). adaptiveBase: the numeric interval Adaptive mode is currently using.
  // suggestionStyle: 'best' shows the ranked top move; 'neutral' shows the set of
  // engine-equivalent candidates instead. neutralThreshold: centipawns.
  const state = {
    enabled: true, depth: 14, openingId: null, panelMin: false, arrows: 3, lang: 'en',
    hintInterval: '1', adaptiveBase: '2', suggestionStyle: 'best',
    neutralThreshold: NEUTRAL_THRESHOLD_DEFAULT,
    settingsOpen: false, // advanced settings (depth/arrows/threshold) collapsed by default
    // displayLevel: 'full' (arrows+eval+notation, today's behaviour), 'hint'
    // (a dot on the square of the piece to move — no path/eval/notation), or
    // 'hidden' (Stockfish doesn't run at all while it's your move). Only ever
    // restricts YOUR OWN pending decision — unaffected when it's not your turn.
    displayLevel: 'full'
  };
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

  // Hint interval: FENs where "Show Hint" was clicked before the move was made
  // there — consumed (and removed) once that move is graded, see
  // recordHintOutcome. Manual "Show Hint" always works regardless of interval.
  const manualHintFens = new Set();
  // FENs the user escalated from the reduced "Hint" detail (a bare dot) to Full
  // arrows + eval, via the "Show full arrows" button. Per-position, so it never
  // changes the standing Suggestion display level — the next position falls back
  // to the configured level. A separate step from Show Hint so the disclosure
  // ladder stays: nothing → dot → full arrows → Explain.
  const manualFullFens = new Set();
  // Rolling window of the user's last ~50 graded moves, for the Adaptive
  // recommendation heuristic only. Session-scoped (resets on reload/navigation)
  // and never persisted — this is a lightweight heuristic, not a stats engine.
  let hintLog = []; // [{ good, manual }]
  let hintLogRecommendedAt = 0; // hintLog.length at the last shown/dismissed recommendation
  const adaptiveRec = { active: false, from: null, to: null };

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

  // ---- hint interval (Feature 1) ---------------------------------------------
  // How many of `uci`'s plies were played by `side` — how many decisions that
  // side has already made in this line, used to place the NEXT one on the
  // interval ladder.
  function countSideMoves(uci, side) {
    let n = 0;
    for (let i = 0; i < uci.length; i++) if ((i % 2 === 0 ? 'w' : 'b') === side) n++;
    return n;
  }

  function currentIntervalN() {
    if (state.hintInterval === 'manual') return Infinity;
    if (state.hintInterval === 'adaptive') return Number(state.adaptiveBase) || 2;
    return Number(state.hintInterval) || 1;
  }

  // Whether an automatic hint is due for the decision the user is about to make
  // (after `already` decisions of theirs so far). The very first decision always
  // gets a hint; after that, one in every N — Manual only never auto-shows.
  function hintDue(already) {
    const n = currentIntervalN();
    return isFinite(n) && already % n === 0;
  }

  function nextAdaptiveStep(cur) {
    const i = ADAPTIVE_STEPS.indexOf(String(cur));
    return i >= 0 && i < ADAPTIVE_STEPS.length - 1 ? ADAPTIVE_STEPS[i + 1] : null;
  }

  function intervalLabel(n) {
    return n === '1' ? t('intervalEveryMove') : t('intervalEveryN', n);
  }

  // Whether the current position's forward-looking suggestions (arrows, panel
  // candidates, Explain button) should be visible. Only ever hides something
  // when it is the USER's own pending decision — book arrows and the after-the-
  // fact grading of moves already played are unaffected (see render()/resultsHtml).
  function computeHintVisible(view) {
    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    if (view.pos.turn !== userSide) return true;
    const already = countSideMoves(view.uci, userSide);
    return hintDue(already) || manualHintFens.has(view.fen);
  }

  // Display level "Hidden": while it's the user's own move, Stockfish does not
  // run at all (no background search, no arrows/dots, no CPU/battery spent) —
  // unless this exact position was manually revealed (Show Hint or Explain),
  // in which case a one-shot lazy search is allowed through. Grading after the
  // move is unaffected: it happens once it's the OPPONENT's turn, outside this
  // check's scope entirely.
  function shouldSkipEngine(view) {
    if (state.displayLevel !== 'hidden') return false;
    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    if (view.pos.turn !== userSide) return false;
    return !manualHintFens.has(view.fen);
  }

  // Whether a reveal that's already happening (due, or manually shown) should
  // render at the reduced "Hint" level of detail (a dot, no path/eval/notation)
  // rather than "Full". True for display level 'hint', and ALSO for 'hidden'
  // once manually revealed — Show Hint in Hidden mode surfaces one lazy search
  // at Hint-level detail, not a jump straight to Full (confirmed design).
  function isHintLevelDisplay(view) {
    // "Show full arrows" escalates exactly this position all the way to Full,
    // overriding the reduced detail it would otherwise render at.
    if (manualFullFens.has(view.fen)) return false;
    if (state.displayLevel === 'hint') return true;
    return state.displayLevel === 'hidden' && manualHintFens.has(view.fen);
  }

  // Called once per graded user move (see runEngine's review branch). Feeds the
  // Adaptive heuristic; never changes any setting itself — only ever proposes.
  function recordHintOutcome(classifyKey, parentFen) {
    const manual = manualHintFens.has(parentFen);
    manualHintFens.delete(parentFen);
    hintLog.push({ good: classifyKey === 'best' || classifyKey === 'good', manual });
    if (hintLog.length > HINT_LOG_MAX) hintLog.shift();
    maybeRecommendAdaptive();
  }

  function maybeRecommendAdaptive() {
    if (state.hintInterval !== 'adaptive' || adaptiveRec.active) return;
    if (hintLog.length < HINT_LOG_MIN_WINDOW) return;
    if (hintLog.length - hintLogRecommendedAt < HINT_LOG_MIN_WINDOW) return; // cooldown after a decision
    const goodRatio = hintLog.filter((h) => h.good).length / hintLog.length;
    const manualRatio = hintLog.filter((h) => h.manual).length / hintLog.length;
    if (goodRatio < HINT_GOOD_RATIO || manualRatio > HINT_MAX_MANUAL_RATIO) return;
    const next = nextAdaptiveStep(state.adaptiveBase);
    if (!next) return;
    adaptiveRec.active = true;
    adaptiveRec.from = state.adaptiveBase;
    adaptiveRec.to = next;
  }

  // Candidate lines within `thresholdCp` of the best (already-fetched MultiPV —
  // no extra search). Returns null (→ caller falls back to ranked Best-move
  // display) when fewer than two candidates qualify, per the spec.
  function neutralFilter(lines, thresholdCp) {
    const list = (lines || []).filter((l) => l.move && l.score);
    if (list.length < 2) return null;
    const bestCp = Explain.scoreToCp(list[0].score);
    const within = list.filter((l) => bestCp - Explain.scoreToCp(l.score) <= thresholdCp);
    return within.length >= 2 ? within : null;
  }

  // The candidates to show when Suggestion Style is Neutral — ALWAYS a list
  // (never null), so every caller renders flat/unranked regardless of the
  // "fewer than 2 within threshold" case. Falls back to just the single best
  // move rather than reverting the whole display to Best-move's rank colours/
  // eval reveal — that reversion is exactly the leak reported: a position
  // with a uniquely-best move must not visibly switch styling out from under
  // Neutral, or the switch itself gives away "this move stands out."
  function neutralCandidates(res) {
    if (state.suggestionStyle !== 'neutral') return null;
    return neutralFilter(res.lines, state.neutralThreshold) || res.lines.slice(0, 1);
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
    if (shouldSkipEngine(view)) return; // Display level "Hidden": no background search on your move
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
            const parentFen = toFen(parentPos);
            const pr = await engineGo(parentFen, { depth: state.depth, multipv: 1 });
            if (engineState.sig !== sig) return;
            const pBest = pr.lines && pr.lines[0];
            if (pBest && pBest.move && pr.score && r.score) {
              const eBest = Explain.scoreToCp(pr.score);   // parent side to move IS the user
              const ePlayed = -Explain.scoreToCp(r.score); // current eval is the opponent's POV
              const cpLoss = eBest - ePlayed;
              const replyUci = best && best.move ? best.move : null; // opponent's punishing reply
              const verdict = Explain.explainPlayed(parentPos, playedUci, pBest.move, cpLoss, replyUci, state.lang);
              // Deterministic (no LLM, no extra search) reason the engine likes its
              // own top move — Neutral Hint reveals this only after the move is made.
              const bestWhy = Explain.explainBest(parentPos, pBest.move, pr.score, null, state.lang);
              engineState.result.review = {
                ...verdict, // { key, label, text }
                playedUci, playedSan: Explain.sanOf(parentPos, playedUci),
                bestUci: pBest.move, bestSan: Explain.sanOf(parentPos, pBest.move),
                bestScore: pr.score, bestWhy
              };
              recordHintOutcome(verdict.key, parentFen);
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
    if (!haveEngine) {
      // Display level "Hidden": no background result exists by design — Explain
      // still always works (like Show Hint), it just runs its own lazy one-shot
      // search first (see bindPanel's click handler). Full/Hint modes just wait
      // for the continuous search already in flight — no reason to duplicate it.
      const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
      const userToMove = view.pos.turn === userSide;
      if (userToMove && state.displayLevel === 'hidden') {
        return `<div class="cc-prow cc-explain"><button class="cc-explain-btn" data-act="explain">${esc(t('explainThisMove'))}</button></div>`;
      }
      return '';
    }
    // Explain is manual/on-demand by nature (never automatic — see requestExplain)
    // so, like Show Hint, it always works once a result exists, independent of
    // Hint Interval's due/manual gate.

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
  //   { uci, color, dim? } for a path, or { square, color, dot: true } for a
  // Display-level "Hint" marker (see below) — drawArrows renders both.
  function computeArrows(view, haveEngine, hintVisible) {
    const arrows = [];
    // Book hints need the move sequence; when the view fell back to the raw
    // board FEN (synced=false) the move list is exactly what proved unreliable.
    const opening = view.synced ? detectOpening(view.uci) : null;
    const bm = view.synced ? bookMove(view.uci, opening) : null;
    if (bm) arrows.push({ uci: bm, color: BOOK_COLOR });

    // Hint interval: while it's the user's own move and no hint is due/revealed,
    // hintVisible is false and every engine-derived arrow (including the
    // opponent's hypothetical replies) stays hidden — only the book arrow shows.
    // (Display level "Hidden" reaches the same result differently: haveEngine
    // is false because the search never ran — see shouldSkipEngine.)
    if (haveEngine && hintVisible) {
      const res = engineState.result;
      const rank = (i) => RANK_COLORS[Math.min(i, RANK_COLORS.length - 1)];
      const budget = state.arrows - (bm ? 1 : 0);
      // ALWAYS a list when Suggestion Style is Neutral (never null) — see
      // neutralCandidates: the "fewer than 2 within threshold" case must stay
      // flat-coloured too, or the colour switch itself leaks "this move stands
      // out", exactly the reveal Neutral is supposed to withhold.
      const neutral = neutralCandidates(res);
      // Display level's rendering choice (dot vs arrow) applies uniformly no
      // matter whose turn is shown — only whether the engine RUNS AT ALL is
      // scoped to your own move (shouldSkipEngine); otherwise switching turns
      // while browsing would flip between dots and arrows, which is confusing.
      const displayHint = isHintLevelDisplay(view);

      // The pool to draw from, and the colour for the n-th one in it: Neutral
      // is always the flat colour (n unused); Best-move is always rank(n).
      const pool = neutral || res.lines;
      const colorOf = neutral ? () => NEUTRAL_COLOR : rank;

      if (displayHint) {
        // Display level "Hint": no path, no eval, no notation — just a dot on
        // the square of the piece to move, for every qualifying candidate. A
        // square shared by two candidates keeps the better one's colour (we
        // fill best-first).
        const squares = new Map();
        let n = 0;
        for (const ln of pool) {
          if (n >= budget) break;
          if (!ln.move || (bm && ln.move === bm)) continue;
          const s = ln.move.slice(0, 2);
          if (!squares.has(s)) squares.set(s, colorOf(n));
          n++;
        }
        squares.forEach((color, s) => arrows.push({ square: s, color, dot: true }));
      } else {
        let n = 0;
        for (const ln of pool) {
          if (n >= budget) break;
          if (!ln.move || (bm && ln.move === bm)) continue;
          arrows.push({ uci: ln.move, color: colorOf(n) });
          n++;
        }
      }
      // The other side's top replies after the best move (dimmer, since they are
      // one ply hypothetical). Display level "Hint" suppresses these too when
      // it's your own move — it's meant to be the minimal marker, not a second
      // hidden layer of arrows.
      if (!displayHint) {
        (res.replyLines || []).slice(0, state.arrows).forEach((ln, i) => {
          if (!ln.move) return;
          arrows.push({ uci: ln.move, color: rank(i), dim: true });
        });
      }
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
      if (a.dot) {
        // Display level "Hint": a plain marker on one square, no path — the
        // square of the piece to move, not where to move it. Nudged to the
        // square's top-right corner (dead centre sits right under the piece)
        // and given a white ring so it stays visible on any square/piece colour.
        const f = a.square.charCodeAt(0) - 97, r = +a.square[1];
        if (f < 0 || f > 7 || !(r >= 1 && r <= 8)) continue;
        const C = squareCentre(f, r, flipped);
        const cx = C.x + 0.27, cy = C.y - 0.27;
        shapes += `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="0.11" fill="${a.color}" ` +
          `stroke="#fff" stroke-width="0.025"></circle>`;
        continue;
      }
      const ff = a.uci.charCodeAt(0) - 97, fr = +a.uci[1];
      const tf = a.uci.charCodeAt(2) - 97, tr = +a.uci[3];
      if (ff < 0 || ff > 7 || tf < 0 || tf > 7 || !(fr >= 1 && fr <= 8) || !(tr >= 1 && tr <= 8)) continue;
      const A = squareCentre(ff, fr, flipped), B = squareCentre(tf, tr, flipped);
      const poly = arrowPolygon(A, B);
      const op = a.dim ? 0.38 : 0.62;
      // Neutral Hint arrows all share one flat colour, so a shorter one lying
      // exactly inside a longer, same-coloured one (e.g. e3 inside e2-e4)
      // would otherwise be invisible — a brighter white outline keeps its
      // silhouette visible even fully overlapped (its head is wider than the
      // longer arrow's shaft, so the outline still pokes out on both sides).
      // Rank/book colours differ arrow-to-arrow already, so they keep their
      // own-colour outline at the same opacity as before.
      const neutralArrow = a.color === NEUTRAL_COLOR;
      const outline = neutralArrow ? '#fff' : a.color;
      const outlineOp = neutralArrow ? Math.min(1, op + 0.3) : op;
      shapes += `<polygon points="${poly}" fill="${a.color}" fill-opacity="${op}" ` +
        `stroke="${outline}" stroke-opacity="${outlineOp}" stroke-width="0.02" stroke-linejoin="round"></polygon>`;
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
  function resultsHtml(view, hintVisible) {
    const sideToMove = view.pos.turn;
    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    const userToMove = sideToMove === userSide;
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

    // Display level "Hidden": Stockfish never ran for this position (see
    // shouldSkipEngine) — say so plainly instead of a misleading "Analysing…",
    // and offer both manual escape hatches (Show Hint / Explain, see below).
    if (userToMove && state.displayLevel === 'hidden' && !manualHintFens.has(view.fen)) {
      return chips + `<div class="cc-hint-hidden">
        <span class="cc-chip cc-info">${esc(t('engineHiddenMsg'))}</span>
        <button class="cc-explain-btn" data-act="showhint">${esc(t('showHint'))}</button>
      </div>`;
    }

    const haveEngine = engineState.status === 'done' && engineState.sig === curSig(view) && engineState.result;
    if (!haveEngine) {
      const msg = engineState.status === 'error' ? t('engineError') : t('analysingDepth', state.depth);
      return chips + `<span class="cc-chip cc-info">${esc(msg)}</span>`;
    }

    const res = engineState.result;

    // Hint interval: it's the user's own move to make and no hint is due or
    // manually revealed yet — hide every engine-derived suggestion (book arrow
    // above is unaffected) behind a "Show Hint" button.
    if (userToMove && !hintVisible) {
      return chips + `<div class="cc-hint-hidden">
        <span class="cc-chip cc-info">${esc(t('thinkItThrough'))}</span>
        <button class="cc-explain-btn" data-act="showhint">${esc(t('showHint'))}</button>
      </div>`;
    }

    // Opponent to move at the live head → the user just moved. Grade that move
    // instead of showing the opponent's best as if coaching them. Checked
    // BEFORE the display-level short-circuit below: grading is retrospective
    // feedback, not a forward hint, so it always shows in full regardless of
    // Suggestion display level.
    if (!userToMove && view.synced && view.uci.length >= 1 && atLiveHead()) {
      if (!res.review) {
        return chips + `<span class="cc-chip cc-info">${esc(t('reviewingYourMove'))}</span>`;
      }
      const rv = res.review;
      // Verdict + the move you should have played, on one line. The verdict keeps
      // its own quality colour (green → red) since a played move has no arrow.
      // Best-move mode only — Neutral mode reveals the engine's pick below instead,
      // unconditionally, since it was deliberately withheld before the move.
      let vline = `<div class="cc-side-line"><span class="cc-chip cc-cls-${rv.key}" title="${esc(rv.text || '')}">${esc(rv.label)} — <b>${esc(rv.playedSan)}</b></span>`;
      if (state.suggestionStyle !== 'neutral' && rv.bestUci && rv.bestUci !== rv.playedUci) {
        const evalText = Explain.formatScore(rv.bestScore, userSide === 'b'); // to White's POV, like the lines
        vline += `<span class="cc-chip cc-alts">${esc(t('shouldHavePlayed'))} <b>${esc(rv.bestSan)}</b> ${esc(evalText)}</span>`;
      }
      chips += vline + '</div>';
      if (state.suggestionStyle === 'neutral' && rv.bestSan) {
        chips += `<div class="cc-erow"><b>${esc(t('enginePreferredLabel'))}</b> ${esc(rv.bestSan)}${rv.bestWhy ? ' — ' + esc(rv.bestWhy) : ''}</div>`;
      }
      // The opponent's candidate replies — Display level applies here too, same
      // as the forward view below, so the board's dots and this text agree.
      if (isHintLevelDisplay(view)) {
        chips += `<div class="cc-hint-hidden"><span class="cc-erow">${esc(t('hintDotMsg'))}</span>
          <button class="cc-explain-btn" data-act="showfull">${esc(t('showFull'))}</button></div>`;
      } else {
        const neutralAfter = neutralCandidates(res);
        const afterOpts = {};
        if (neutralAfter) afterOpts.neutral = neutralAfter;
        if (bm) afterOpts.bookMove = bm;
        chips += sideLine(sideToMove, res.lines, res.pos, afterOpts);
      }
      return chips;
    }

    // Display level "Hint" (or "Hidden" manually revealed): applies uniformly
    // regardless of whose turn is shown (see computeArrows) — the board shows
    // a dot on the square to move; no move text, eval, or notation here.
    if (isHintLevelDisplay(view)) {
      return chips + `<div class="cc-hint-hidden"><span class="cc-erow">${esc(t('hintDotMsg'))}</span>
        <button class="cc-explain-btn" data-act="showfull">${esc(t('showFull'))}</button></div>`;
    }

    // Forward view: one line per side, White on top. The side to move gets its
    // candidates (res.lines, solid arrows); the other side gets its replies after
    // the best move (res.replyLines, dim arrows).
    const mine = { list: res.lines, pos: res.pos };
    const other = { list: res.replyLines, pos: res.replyPos };
    const white = sideToMove === 'w' ? mine : other;
    const black = sideToMove === 'w' ? other : mine;
    const whiteOpts = { dim: sideToMove !== 'w' };
    const blackOpts = { dim: sideToMove !== 'b' };
    // Neutral Hint, and the book-move colour, apply only to whoever is actually
    // to move here (the "mine" side) — the other side's line is a hypothetical
    // future reply, unaffected.
    const mineOpts = sideToMove === 'w' ? whiteOpts : blackOpts;
    const neutralMine = neutralCandidates(res);
    if (neutralMine) mineOpts.neutral = neutralMine;
    if (bm) mineOpts.bookMove = bm;
    chips += sideLine('w', white.list, white.pos, whiteOpts);
    chips += sideLine('b', black.list, black.pos, blackOpts);
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
  // Settings split in two: mode switches you'd flip mid-game (suggestion style,
  // hint interval) stay always visible; tuning knobs you set once (depth,
  // arrows, threshold) collapse behind the ⚙ toggle so the everyday view stays
  // short — both live in THIS panel, never a separate options page, so
  // changing them never means leaving the game tab.
  function buildPanel(ctx, view, hintVisible) {
    const min = state.panelMin;
    const opening = view.synced ? detectOpening(view.uci) : null;
    const titleText = opening ? `${opening.eco} · ${opening.name}` : (OPENINGS ? t('outOfBook') : t('coach'));
    const minMaxLabel = min ? t('expand') : t('minimize');
    const settingsLabel = state.settingsOpen ? t('hideAdvanced') : t('showAdvanced');
    const header = `<div class="cc-phead">
      <span class="cc-ptitle" title="${esc(titleText)}">♞ ${esc(titleText)}</span>
      <button class="cc-pbtn${state.settingsOpen ? ' cc-pbtn--on' : ''}" data-act="settings" title="${esc(settingsLabel)}" aria-label="${esc(settingsLabel)}">⚙</button>
      <button class="cc-pbtn" data-act="panelmin" title="${esc(minMaxLabel)}" aria-label="${esc(minMaxLabel)}">${min ? '▢' : '—'}</button>
    </div>`;
    if (min) return header;
    const legendHtml = legend().map((it) =>
      `<span class="cc-lg"><i style="background:${it.color}"></i>${esc(it.label)}</span>`
    ).join('');

    const userSide = mapSide(bridgePlayingAs) || detectUserSide() || 'w';
    const intervalOptions = ADAPTIVE_STEPS.concat(['1']).sort((a, b) => Number(a) - Number(b))
      .map((n) => `<option value="${n}"${state.hintInterval === n ? ' selected' : ''}>${esc(intervalLabel(n))}</option>`)
      .join('') +
      `<option value="manual"${state.hintInterval === 'manual' ? ' selected' : ''}>${esc(t('intervalManual'))}</option>` +
      `<option value="adaptive"${state.hintInterval === 'adaptive' ? ' selected' : ''}>${esc(t('intervalAdaptive'))}</option>`;
    const recommendHtml = adaptiveRec.active ? `<div class="cc-prow cc-recommend">
      <div class="cc-erow">${esc(t('adaptiveRecommend', intervalLabel(adaptiveRec.from), intervalLabel(adaptiveRec.to)))}</div>
      <div class="cc-recommend-actions">
        <button class="cc-pbtn" data-act="rec-keep">${esc(t('keepCurrent'))}</button>
        <button class="cc-explain-btn" data-act="rec-increase">${esc(t('increase'))}</button>
      </div>
    </div>` : '';

    // Quick-access: modes you'd realistically switch mid-game.
    const quickSettingsHtml = `
      <label class="cc-prow cc-select-row">${esc(t('suggestionStyle'))}<select class="cc-select" data-cc-style>
        <option value="best"${state.suggestionStyle === 'best' ? ' selected' : ''}>${esc(t('styleBest'))}</option>
        <option value="neutral"${state.suggestionStyle === 'neutral' ? ' selected' : ''}>${esc(t('styleNeutral'))}</option>
      </select></label>
      <label class="cc-prow cc-select-row">${esc(t('hintInterval'))}<select class="cc-select" data-cc-interval>${intervalOptions}</select></label>
      <label class="cc-prow cc-select-row">${esc(t('displayLevel'))}<select class="cc-select" data-cc-displaylevel>
        <option value="full"${state.displayLevel === 'full' ? ' selected' : ''}>${esc(t('displayFull'))}</option>
        <option value="hint"${state.displayLevel === 'hint' ? ' selected' : ''}>${esc(t('displayHint'))}</option>
        <option value="hidden"${state.displayLevel === 'hidden' ? ' selected' : ''}>${esc(t('displayHidden'))}</option>
      </select></label>`;

    // Advanced: tuning knobs you set once and rarely revisit.
    const neutralSliderHtml = state.suggestionStyle === 'neutral' ? `<label class="cc-prow cc-depth">${esc(t('neutralThreshold'))} <output data-cc-neutral-val>${(state.neutralThreshold / 100).toFixed(2)}</output>
        <input type="range" min="${NEUTRAL_THRESHOLD_MIN}" max="${NEUTRAL_THRESHOLD_MAX}" step="5" value="${state.neutralThreshold}" data-cc-neutral></label>` : '';
    const advancedSettingsHtml = state.settingsOpen ? `
      <label class="cc-prow cc-depth">${esc(t('depth'))} <output data-cc-depth-val>${state.depth}</output>
        <input type="range" min="6" max="22" step="1" value="${state.depth}" data-cc-depth></label>
      <label class="cc-prow cc-depth">${esc(t('arrows'))} <output data-cc-arrows-val>${state.arrows}</output>
        <input type="range" min="${ARROW_MIN}" max="${ARROW_MAX}" step="1" value="${state.arrows}" data-cc-arrows></label>
      ${neutralSliderHtml}` : '';

    return header + `<div class="cc-pbody">
      <div class="cc-prow">${openingPicker(userSide)}</div>
      ${quickSettingsHtml}
      ${advancedSettingsHtml}
      ${recommendHtml}
      <div class="cc-prow cc-results">${resultsHtml(view, hintVisible)}</div>
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
    // Hint interval: does the user's own pending decision (if any) get to show
    // its suggestions right now? Always true when it isn't the user's move.
    const hintVisible = state.enabled ? computeHintVisible(view) : true;
    const arrows = state.enabled ? computeArrows(view, haveEngine, hintVisible) : [];
    const arrowSig = (isFlipped() ? 'f|' : 'n|') + view.fen + '|' +
      arrows.map((a) => a.color + (a.dot ? 'd' + a.square : a.uci)).join('|');
    if (arrowSig !== lastArrowSig || !document.getElementById(ARROW_ID)) {
      drawArrows(arrows);
      lastArrowSig = arrowSig;
    }

    const showPanel = state.enabled;
    panel.style.display = showPanel ? '' : 'none';

    const sig = [ctx, state.enabled, state.panelMin, state.settingsOpen, showPanel, state.openingId || 'auto',
      state.depth, state.arrows, state.hintInterval, state.adaptiveBase, state.suggestionStyle,
      state.neutralThreshold, state.displayLevel, hintVisible, adaptiveRec.active, adaptiveRec.to,
      view.fen, view.synced, engineState.status, engineState.sig, !!OPENINGS].join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    bar.className = 'chess-coach-bar';
    (bar.querySelector('#cc-bulb-slot') || bar).innerHTML = buildBar();
    bindBar(bar);

    if (showPanel) {
      panel.className = 'chess-coach-panel' + (state.panelMin ? ' is-min' : '');
      panel.innerHTML = buildPanel(ctx, view, hintVisible);
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
    el.querySelector('[data-act="explain"]')?.addEventListener('click', async () => {
      const sig = curSig(view);
      let res = (engineState.status === 'done' && engineState.sig === sig) ? engineState.result : null;
      // A Show-Hint-triggered search for this exact position is already in
      // flight — let it finish rather than enqueueing a redundant one.
      if (!res && engineState.status === 'running' && engineState.sig === sig) return;
      if (!res) {
        // Display level "Hidden": no background result exists yet — this is the
        // one-shot lazy search Explain promises (see explainHtml). Cache it into
        // engineState like a normal search so a later Show Hint/re-click reuses
        // it instead of searching again.
        try {
          const r = await engineGo(view.fen, { depth: state.depth, multipv: state.arrows });
          if (curSig(view) !== sig) return; // position changed while we were searching
          res = { lines: r.lines || [], pv: r.pv || [], score: r.score, pos: view.pos, sideToMove: view.pos.turn, replyLines: [], replyPos: null };
          engineState.sig = sig;
          engineState.status = 'done';
          engineState.result = res;
          // Explain's own reveal counts the same as Show Hint's — the AI text
          // already names the best move, so there's no point leaving the results
          // row above it stuck on the "Hidden" placeholder.
          manualHintFens.add(view.fen);
          lastSig = '';
          render(detectContext());
        } catch { return; }
      }
      const data = buildExplainInput(res);
      if (data) requestExplain(data);
    });

    el.querySelector('[data-act="panelmin"]')?.addEventListener('click', () => {
      state.panelMin = !state.panelMin;
      save();
      lastSig = '';
      render(detectContext());
    });

    el.querySelector('[data-act="settings"]')?.addEventListener('click', () => {
      state.settingsOpen = !state.settingsOpen;
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

    const styleSel = el.querySelector('[data-cc-style]');
    if (styleSel) styleSel.addEventListener('change', () => {
      state.suggestionStyle = styleSel.value === 'neutral' ? 'neutral' : 'best';
      save();
      lastSig = '';
      render(detectContext());
    });

    const neutralRange = el.querySelector('[data-cc-neutral]');
    if (neutralRange) {
      const out = el.querySelector('[data-cc-neutral-val]');
      neutralRange.addEventListener('input', () => { if (out) out.textContent = (neutralRange.value / 100).toFixed(2); });
      neutralRange.addEventListener('change', () => {
        state.neutralThreshold = Math.max(NEUTRAL_THRESHOLD_MIN, Math.min(NEUTRAL_THRESHOLD_MAX, parseInt(neutralRange.value, 10) || NEUTRAL_THRESHOLD_DEFAULT));
        save();
        lastSig = '';
        render(detectContext());
      });
    }

    const intervalSel = el.querySelector('[data-cc-interval]');
    if (intervalSel) intervalSel.addEventListener('change', () => {
      state.hintInterval = intervalSel.value;
      save();
      lastSig = '';
      render(detectContext());
    });

    const displaySel = el.querySelector('[data-cc-displaylevel]');
    if (displaySel) displaySel.addEventListener('change', () => {
      state.displayLevel = ['full', 'hint', 'hidden'].includes(displaySel.value) ? displaySel.value : 'full';
      save();
      // No need to invalidate engineState.sig: switching levels never changes
      // depth/multipv, so any already-computed result is still valid data —
      // only how it's RENDERED changes. Switching to Hidden hides it from view
      // immediately (see resultsHtml); switching away from Hidden naturally
      // triggers a fresh search on its own, since maybeAnalyze only skipped it
      // in the first place because no result existed yet for this position.
      lastSig = '';
      render(detectContext());
    });

    // Manual "Show Hint" — always works regardless of the interval; reveals
    // suggestions for exactly this position and feeds the Adaptive heuristic
    // (see recordHintOutcome) once this move is graded.
    el.querySelector('[data-act="showhint"]')?.addEventListener('click', () => {
      manualHintFens.add(view.fen);
      lastSig = '';
      render(detectContext());
    });

    // "Show full arrows" — escalate this one position from the reduced Hint dot
    // to Full detail (arrows + eval + notation). The search already ran, so this
    // only changes how the existing result is rendered; no extra engine work.
    el.querySelector('[data-act="showfull"]')?.addEventListener('click', () => {
      manualFullFens.add(view.fen);
      lastSig = '';
      render(detectContext());
    });

    // Adaptive recommendation banner — purely a suggestion; the app never
    // changes the interval on its own, only in response to one of these clicks.
    el.querySelector('[data-act="rec-keep"]')?.addEventListener('click', () => {
      adaptiveRec.active = false;
      hintLogRecommendedAt = hintLog.length;
      lastSig = '';
      render(detectContext());
    });
    el.querySelector('[data-act="rec-increase"]')?.addEventListener('click', () => {
      if (adaptiveRec.to) { state.adaptiveBase = adaptiveRec.to; save(); }
      adaptiveRec.active = false;
      hintLogRecommendedAt = hintLog.length;
      lastSig = '';
      render(detectContext());
    });
  }

  function save() {
    try {
      chrome.storage.local.set({
        ccEnabled: state.enabled, ccDepth: state.depth, ccOpening: state.openingId,
        ccPanelMin: state.panelMin, ccArrows: state.arrows,
        ccHintInterval: state.hintInterval, ccAdaptiveBase: state.adaptiveBase,
        ccSuggestionStyle: state.suggestionStyle, ccNeutralThreshold: state.neutralThreshold,
        ccSettingsOpen: state.settingsOpen, ccDisplayLevel: state.displayLevel
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
    chrome.storage.local.get(['ccEnabled', 'ccDepth', 'ccOpening', 'ccPanelMin', 'ccArrows', 'ccLanguage',
      'ccHintInterval', 'ccAdaptiveBase', 'ccSuggestionStyle', 'ccNeutralThreshold', 'ccSettingsOpen', 'ccDisplayLevel'], (o) => {
      state.enabled = o.ccEnabled !== false;
      state.depth = Math.max(6, Math.min(22, o.ccDepth || 14));
      state.openingId = o.ccOpening || null;
      state.panelMin = !!o.ccPanelMin;
      state.arrows = Math.max(ARROW_MIN, Math.min(ARROW_MAX, o.ccArrows || 3));
      state.lang = o.ccLanguage === 'vi' ? 'vi' : 'en';
      const validIntervals = ADAPTIVE_STEPS.concat(['1', 'manual', 'adaptive']);
      state.hintInterval = validIntervals.includes(o.ccHintInterval) ? o.ccHintInterval : '1';
      state.adaptiveBase = ADAPTIVE_STEPS.includes(o.ccAdaptiveBase) ? o.ccAdaptiveBase : '2';
      state.suggestionStyle = o.ccSuggestionStyle === 'neutral' ? 'neutral' : 'best';
      state.neutralThreshold = Math.max(NEUTRAL_THRESHOLD_MIN, Math.min(NEUTRAL_THRESHOLD_MAX, o.ccNeutralThreshold || NEUTRAL_THRESHOLD_DEFAULT));
      state.settingsOpen = !!o.ccSettingsOpen;
      state.displayLevel = ['full', 'hint', 'hidden'].includes(o.ccDisplayLevel) ? o.ccDisplayLevel : 'full';
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
