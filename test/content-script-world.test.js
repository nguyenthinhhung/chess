// In the extension, every content script in manifest.json runs as a CLASSIC
// script in ONE shared isolated-world global scope — not as separate modules
// like under the Node test runner. That means a top-level `const x` in one
// file collides with a global `function x` declared by an earlier file and
// throws a SyntaxError that silently kills the whole later file (this exact
// bug once disabled explain.js, and with it the entire engine pipeline).
// This test replays that environment: evaluate the pure content scripts in
// manifest order inside a single vm context and assert every global each
// later script depends on actually got defined.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The DOM-free subset of manifest.json's content_scripts js list, in load
// order. content.js and chess-coach.js are omitted only because they touch
// document/chrome at top level; every file that defines shared globals is here.
// Keep this in the SAME order as manifest.json — a missing or reordered entry
// is exactly how the fileOf/rankOf/isWhitePiece collision between chesscore.js
// and ai/position-facts.js slipped past this guard undetected.
const SCRIPTS = ['pgn.js', 'chesscore.js', 'i18n.js', 'explain.js', 'ply-view.js', 'ai/position-facts.js', 'ai/prompt-builder.js'];

test('content scripts evaluate in one shared global scope without collisions', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // Throws (e.g. "Identifier 'x' has already been declared") on collision.
    vm.runInContext(source, context, { filename: file });
  }

  // The globals chess-coach.js reads at startup — it disables itself if any
  // are missing, which shows up in the UI as a silently dead coach.
  for (const name of ['createPosition', 'applySan', 'applyUci', 'toFen', 'fromFen',
    'sliceToViewedPly', 'ChessExplain', 'ChessI18n', 'ChessAiPrompt', 'ChessPositionFacts']) {
    assert.ok(sandbox[name], `global "${name}" missing after loading content scripts`);
  }
  // Spot-check the delegated re-exports survived the shared scope.
  assert.equal(typeof sandbox.ChessExplain.kingInCheck, 'function');
  assert.equal(typeof sandbox.ChessExplain.explainBest, 'function');
});
