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

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 config |
| `pgn.js` | Pure TCN→UCI→SAN→PGN conversion (shared with tests) |
| `content.js` | Button injection + PGN scrape on game pages |
| `background.js` | Service worker: Lichess API client + rate limiter |
| `popup.html/css/js` | Toolbar popup for batch + paste import |
| `options.html/js` | Lichess token settings |
| `styles.css` | Injected button style |
| `icons/` | Toolbar icons + `generate.js` to regenerate them |
| `test/` | Node tests for the PGN converter |

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
