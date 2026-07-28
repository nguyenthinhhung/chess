# Chess Coach for Chess.com

A Chrome extension that adds a **real-time Stockfish coach** to chess.com — move
suggestions, opening recognition, move-by-move grading, and (optionally)
AI-written strategic explanations — in every game, whether you're playing bots
or live humans. It also does **one-click PGN import to Lichess** for deeper
cloud analysis, bypassing chess.com's daily Game Review limit by leaning on
Lichess's free (and stronger) cloud Stockfish.

Everything runs locally: Stockfish 18 (WASM) is bundled and runs in-browser. The
only network calls are the games you explicitly import to Lichess and, if you
enable it, the AI explanations.

The whole UI is **bilingual — English and Tiếng Việt** (see *Language* below).

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (`chess`)
4. Pin the extension icon to your toolbar

## Setup

Open the extension icon → **Settings** (the options page):

1. **Lichess API token** (for import) — create one at
   <https://lichess.org/account/oauth/token/create> (no scopes needed) and paste it.
2. **AI Coach** *(optional)* — pick a provider (**Gemini** or **Groq**), paste its
   API key, and optionally override the model. Keys and models are stored
   per-provider, so switching back and forth keeps both.
   - Gemini: free key at <https://aistudio.google.com/app/apikey> (default model `gemini-2.5-flash`)
   - Groq: free key at <https://console.groq.com/keys> (default model `llama-3.3-70b-versatile`)
   - Without a key, the coach still works fully — you just won't get the AI
     "Explain this move" panel (the built-in explanations remain).
3. **Language** — English or Tiếng Việt. Applies to the coach panel **and** both
   the built-in and AI explanations, live (no reload needed).
4. **Skill level** — Beginner (~600–900) / Intermediate (~1000–1400) / Advanced
   (~1500–2000). The engine analysis is identical at every level; only *who the
   AI explanation is written for* changes — a beginner gets plain "don't hang
   your knight" advice, an advanced player gets prophylaxis and pawn breaks.
   Also picked up live.

## Chess Coach

On any chess.com board the coach shows two surfaces: a small **💡 lightbulb bar
under the board** (click to toggle coaching on/off) and a minimizable
**coach panel** in the bottom-right with the opening name, suggestions,
settings, and explanations. It activates in analysis, bot/computer games, and
live/daily human games, and auto-detects board orientation (including a flipped
board).

### On the board — arrows

When coaching is on it draws arrows straight on the board:

- **Top engine moves** for the side to move, coloured by rank — best (green),
  2nd (blue), 3rd (amber). How many show is the **Arrows** setting (1–5).
- **Book move** (violet) while you're inside a known opening — the priority
  recommendation there; the engine arrows are the alternatives.
- **Opponent's likely replies** (dimmed) taken from Stockfish's principal
  variation, so you can read their intention.

A legend in the panel maps the colours (Book / Best / 2nd / 3rd).

### Opening recognition & book moves

The panel title shows the recognised opening as `ECO · Name` (or *Out of book*
once you leave known theory). Opening names come from `openings.json` — a
~3,700-line ECO database built from the open-source
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
dataset, fetched lazily so it never slows page load. The opening name shows even
when Stockfish coaching is off.

**Pick an opening to play** from the dropdown (Auto-detect, or one of ~30 popular
lines filtered to the side you play — Italian Game, Ruy Lopez, London System,
Sicilian, French, Caro-Kann, King's Indian…). Choosing one guides you along that
line move by move.

### Position themes (concept spotlight)

Below the suggestions the panel labels the position's **structural themes** —
open files, isolated/doubled/backward/passed pawns, outposts, opposite-side
castling — computed directly from the board (no engine or AI call, so it's
instant and always right). It's the same structural read that grounds the AI
plan, surfaced so each position doubles as a lesson in *what to look for*, not
just *which move to play*.

### Move grading (after you move)

Once you've moved and it's the opponent's turn, the coach grades the move you
just played — **Best / Good / Inaccuracy / Mistake / Blunder** (green→red chip) —
and shows the move you should have played with its evaluation. No extra engine
search is spent: it reuses the analysis already in flight.

### AI "Explain this move"

With an AI provider configured, an **✨ Explain this move** button turns one
engine analysis into a short strategic lesson (on-demand only, to control cost).
It answers in four fields:

| Field | What it gives |
|-------|---------------|
| ⭐ **Best move** | Who stands better (from *your* point of view) + what the key move does |
| 🎯 **Plan** | A concrete plan for you over the next several moves, matched to the pawn structure |
| 🛡 **What the opponent wants** | The opponent's idea/threat to watch |
| 💡 **Principle** | One transferable maxim a ~1200 player can reuse |

The prompt is grounded: it's fed the engine's move, the principal variation, and
a block of **position facts computed directly from the board** (material, king
safety, open files, weak pawns, outposts), and is told to build the plan on those
rather than re-reading the FEN. Evaluations are oriented to the coached player
(positive = you're better) so the "who's winning" read never inverts. Explanations
are skipped when there's nothing to add (no analysis yet, depth too shallow, or a
forced mate the engine already shows), and cached per provider + position + depth
+ language.

### Settings (in the panel)

Quick settings (always visible):

| Setting | Options | Default | What it does |
|---------|---------|---------|--------------|
| **Coaching** | on / off | on | The 💡 lightbulb toggle under the board |
| **Opening** | Auto-detect or ~30 named lines | Auto-detect | Which opening to be guided along |
| **Suggestions** | Best move / Neutral hints | Best move | *Neutral* shows a flat-coloured set of engine-equivalent moves (within a threshold) without revealing the single best pick until after you move |
| **Hint interval** | Every move / Every 2·3·5·10 / Manual / Adaptive | Every move | How often suggestions appear on your turn. *Adaptive* proposes raising the interval after a run of strong moves (never changes it silently) |
| **Display** | Full / Hint / Hidden | Full | *Full* = arrows + evals; *Hint* = just a dot on the piece to move; *Hidden* = nothing until you ask |

Advanced settings (behind ⚙):

| Setting | Range | Default | What it does |
|---------|-------|---------|--------------|
| **Depth** | 6–22 | 14 | Stockfish search depth — deeper is stronger but slower |
| **Arrows** | 1–5 | 3 | How many candidate moves to show (MultiPV) |
| **Threshold** | 0.10–0.30 | 0.20 | *(Neutral hints only)* how close in eval a move must be to count as "equivalent" |

All choices are remembered.

### Progressive disclosure

The coach is built as a ladder so you can think first and reveal only as much as
you want, per position: **nothing → a dot → full arrows → an AI explanation.**

- **Show Hint** — reveal the suggestion for this position when it isn't
  auto-due (Manual/interval), or in Hidden mode (where Stockfish otherwise
  doesn't even run on your move, to save CPU/battery).
- **Show full arrows** — escalate a single dot-only (Hint-level) position to full
  arrows + evals, without changing your default Display level.

## Lichess import

**Single game** — open any chess.com game page (`/game/live/...` or
`/game/daily/...`). An *Analyze on Lichess* button appears near the board; one
click imports that game (with server-side analysis requested) and opens it on
Lichess in a new tab.

**Batch import** — click the extension icon, enter your chess.com username and a
count (default 5, up to 50). It pulls your most recent games via chess.com's
public API (spanning previous months if the current one is thin) and imports them
all, paced at ~3.5 s/game to stay under Lichess rate limits, with per-game
progress.

**Manual PGN** — paste any PGN into the popup and import it directly.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 config |
| `pgn.js` | Pure TCN→UCI→SAN→PGN conversion (shared with tests) |
| `chesscore.js` | Minimal chess engine (apply SAN/UCI, FEN) used by the coach |
| `openings.json` | ECO opening database (UCI line → name), fetched on demand |
| `explain.js` | Turns an engine eval into a short, grounded explanation + move grading |
| `ply-view.js` | Resolves which prefix of the move list is on screen while scrubbing |
| `engine.js` | Stockfish 18 (WASM) worker wrapper — UCI, MultiPV searches |
| `offscreen.html/js` | Offscreen document that hosts the engine (page-CSP-free) |
| `content.js` | Button injection + PGN scrape on game pages |
| `chess-coach.js` | Coach UI: under-board bar, bottom-right panel, board arrows, grading, settings |
| `chess-coach-bridge.js` | MAIN-world bridge: reads the live move list |
| `background.js` | Service worker: Lichess client, engine offscreen relay, AI relay + cache |
| `ai/providers.js` | AI provider catalog (Gemini, Groq) — auth style, default model, key URL |
| `ai/prompt-builder.js` | Builds the explain prompt + JSON schema, strategy-theme gating |
| `ai/position-facts.js` | Computes structural facts (material, files, weak pawns, outposts) from a FEN |
| `ai/ai-service.js` | Dispatches an explain request to the configured provider |
| `ai/gemini-service.js` | Gemini native API client |
| `ai/openai-compatible-service.js` | OpenAI-compatible client (Groq) |
| `ai/response-parser.js` | Parses/validates the model's JSON answer |
| `i18n.js` | All UI strings, English + Tiếng Việt |
| `popup.html/js` | Toolbar popup for batch + paste import |
| `options.html/js` | Settings: Lichess token, AI provider/key/model, language |
| `styles.css` | Injected button + coach styles |
| `icons/` | Toolbar icons + `generate.js` to regenerate them |
| `test/` | Node tests (PGN, chess core, explainer, ply-view, position facts, AI prompt/services) |

## Development

Pure, DOM-free modules (`pgn.js`, `chesscore.js`, `explain.js`, `ply-view.js`,
and everything in `ai/`) have Node unit tests — the PGN converter especially,
since it hand-decodes chess.com's TCN encoding:

```bash
npm test          # runs node --test
```

Regenerate the toolbar icons (no dependencies) with:

```bash
node icons/generate.js
```

## Known limits

- Chess.com's DOM changes occasionally — if the *Analyze on Lichess* button stops
  appearing on a game page, the scrape selectors in `content.js` (`injectButton`)
  may need adjusting.
- Lichess imports are rate-limited (~20/min globally); the extension paces at
  3.5 s/game.
- After 3 consecutive engine failures the coach disables Stockfish for the
  session (shown as *Stockfish stopped*) — reload the page to retry.
- The AI "Explain" panel needs a provider key; everything else works without one.
