// options.html loads ai/providers.js and options.js as two plain <script src>
// tags, which — exactly like the content scripts (see
// content-script-world.test.js) — share ONE lexical scope. A top-level
// `const AI_PROVIDERS` in options.js once collided with the same name already
// declared by ai/providers.js, throwing "Identifier 'AI_PROVIDERS' has
// already been declared" that killed the whole options page (token field,
// language radios, provider dropdown — everything went blank). This test
// replays that shared scope so a future collision fails in CI instead of in
// a user's Settings page.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// options.html's script list, in load order.
const SCRIPTS = ['ai/providers.js', 'options.js'];

function makeElement() {
  return {
    value: '', textContent: '', href: '', placeholder: '', checked: false,
    appendChild() {}, addEventListener() {}
  };
}

function makeSandbox() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement: () => makeElement()
  };
  const chrome = {
    storage: {
      local: {
        get: (_keys, cb) => cb({}),
        set: (_obj, cb) => { if (cb) cb(); }
      }
    }
  };
  const sandbox = { document, chrome };
  sandbox.globalThis = sandbox;
  return sandbox;
}

test('options.html scripts evaluate in one shared global scope without collisions', () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);

  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // Throws (e.g. "Identifier 'x' has already been declared") on collision.
    vm.runInContext(source, context, { filename: file });
  }

  assert.ok(sandbox.ChessAiProviders, 'ai/providers.js global missing after loading options scripts');
});
