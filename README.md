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

## Opening Coach

A built-in repertoire trainer for the **Italian Game** (as White) and the
**Caro-Kann Defense** (as Black). A small panel docks to the top-right of the
board and, move by move, tells you the book move, names the line, and flags when
you or your opponent leave preparation.

**Fair play:** real-time guidance is shown **only** on practice surfaces — games
vs the computer/bots and the analysis board. In a game against a human the panel
refuses to give live hints and only offers an opening **review after the game has
ended**. Helping during a live game against another person is cheating and is
deliberately not built.

Pick what to train from the **Train** dropdown in the panel (Auto-detect, or a
specific opening such as Caro-Kann). Choosing one pins that opening and side, so
the coach guides you from move one instead of guessing. Toggle the whole thing
with the **ON/OFF** button in the panel header (all choices are remembered).
Edit `repertoire.js` to add lines or your own openings — the tree is plain SAN.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 config |
| `pgn.js` | Pure TCN→UCI→SAN→PGN conversion (shared with tests) |
| `chesscore.js` | Minimal chess engine (apply SAN/UCI, FEN) used by the coach |
| `repertoire.js` | Curated Italian / Caro-Kann opening trees (data) |
| `coach.js` | Pure engine: match played moves to the repertoire |
| `content.js` | Button injection + PGN scrape on game pages |
| `coach-ui.js` | Opening Coach panel + live chess.com integration |
| `background.js` | Service worker: Lichess API client + rate limiter |
| `popup.html/css/js` | Toolbar popup for batch + paste import |
| `options.html/js` | Lichess token settings |
| `styles.css` | Injected button + coach panel styles |
| `icons/` | Toolbar icons + `generate.js` to regenerate them |
| `test/` | Node tests for the PGN converter, chess engine, and coach |

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
