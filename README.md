# Chess.com to Lichess Analyzer

Chrome extension that imports chess.com games into Lichess for unlimited Stockfish analysis. Bypasses chess.com's daily Game Review limit by leveraging Lichess's free cloud analysis (which uses a stronger Stockfish version anyway).

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (`chess`)
4. Pin the extension icon to your toolbar

## Setup

1. Click the extension icon → **Settings**
2. Create a Lichess token at https://lichess.org/account/oauth/token/create (no scopes needed)
3. Paste it and save

## Usage

**Single game** — open any chess.com game page (`/game/live/...` or `/game/daily/...`). An *Analyze on Lichess* button appears next to chess.com's own controls. One click opens the analyzed game in a new tab.

**Batch import** — click the extension icon, enter your chess.com username and a count (default 5). It pulls your last N games (spanning previous months if the current one is thin) and imports them all. Throttled to ~17/min to stay under Lichess rate limits.

**Manual PGN** — paste any PGN into the popup textarea and import directly.

## Chess Coach

An in-game coach that recognises the opening, guides you along book lines, and
runs Stockfish to suggest moves throughout the rest of the game. A control bar
docks **under the board**, anchored by a 💡 lightbulb button that toggles
coaching on and off.

When coaching is on it draws arrows straight on the board:

- **Top 3 engine moves** for the side to move, coloured by rank — best (green),
  second (blue), third (amber).
- **Book move** (violet) while you're inside a known opening.
  In the opening this is the priority recommendation; the engine arrows are the
  alternatives.
- **Opponent's likely reply** (red, dashed) taken from Stockfish's principal
  variation, so you can read their intention.

The bar also shows the recognised opening name (ECO code + name), the evaluation,
a short grounded explanation of the best move, and the opponent's expected reply.

**Pick an opening to play** from the dropdown (Auto-detect, or one of ~30 popular
openings such as the Italian Game, Sicilian, or Queen's Gambit). Choosing one
guides you along that line move by move. **Set the Stockfish search depth** with
the slider (6–22; deeper is stronger but slower). All choices are remembered.

Opening names come from `openings.json` — a ~3,700-line ECO database built from
the open-source [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
dataset, fetched lazily so it never slows down page load.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 config |
| `pgn.js` | Pure TCN→UCI→SAN→PGN conversion (shared with tests) |
| `chesscore.js` | Minimal chess engine (apply SAN/UCI, FEN) used by the coach |
| `openings.json` | ECO opening database (UCI line → name), fetched on demand |
| `explain.js` | Turns an engine eval into a short, grounded explanation |
| `engine.js` | Stockfish (WASM) worker wrapper — UCI, MultiPV searches |
| `offscreen.html/js` | Offscreen document that hosts the engine (page-CSP-free) |
| `content.js` | Button injection + PGN scrape on game pages |
| `chess-coach.js` | Coach UI: under-board bar, bottom-right panel, board arrows |
| `chess-coach-bridge.js` | MAIN-world bridge: reads the live move list |
| `background.js` | Service worker: Lichess client + engine offscreen relay |
| `popup.html/css/js` | Toolbar popup for batch + paste import |
| `options.html/js` | Lichess token settings |
| `styles.css` | Injected button + coach bar styles |
| `icons/` | Toolbar icons + `generate.js` to regenerate them |
| `test/` | Node tests for the PGN converter, chess engine, and explainer |

## Development

The PGN conversion in `pgn.js` is the most fragile part (it hand-decodes
chess.com's TCN encoding and generates SAN), so it has unit tests:

```bash
npm test          # runs node --test
```

Regenerate the toolbar icons (no dependencies) with:

```bash
node icons/generate.js
```

## Known limits

- Chess.com's DOM changes occasionally — if the button stops appearing on a game page, scrape selectors in `content.js` (`injectButton`) may need adjusting.
- Lichess imports are rate-limited to ~20/min globally. The extension paces at 3.5s/game.
