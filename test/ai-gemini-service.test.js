const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explainMove, toGeminiSchema } = require('../ai/gemini-service.js');
const { EXPLAIN_SCHEMA } = require('../ai/prompt-builder.js');

function fakeFetch(reply) {
  return async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] })
  });
}

test('toGeminiSchema drops optional properties and keeps required ones', () => {
  const sanitized = toGeminiSchema(EXPLAIN_SCHEMA);
  assert.deepEqual(Object.keys(sanitized.properties).sort(), [...EXPLAIN_SCHEMA.required].sort());
  assert.equal(sanitized.properties.line.type, 'array');
});

test('explainMove throws without an API key', async () => {
  await assert.rejects(() => explainMove({ bestMove: 'e2e4', depth: 16 }, {}), /AI_DISABLED/);
});

test('explainMove throws on cost-control skip instead of calling the network', async () => {
  let called = false;
  await assert.rejects(
    () => explainMove({ bestMove: 'e2e4', depth: 4 }, { apiKey: 'k', fetchImpl: async () => { called = true; } }),
    /AI_SKIPPED/
  );
  assert.equal(called, false);
});

test('explainMove parses a successful Gemini reply', async () => {
  const reply = { assessment: 's', whyBest: 'w', plan: 'p', line: ['Nf3', 'Nc6'], alternatives: 'alt' };
  const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 }, pv: ['e2e4'], topMoves: [] };
  const result = await explainMove(data, { apiKey: 'k', fetchImpl: fakeFetch(reply) });
  assert.equal(result.whyBest, 'w');
  assert.deepEqual(result.line, ['Nf3', 'Nc6']);
});

test('explainMove surfaces a non-OK HTTP response', async () => {
  const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 } };
  const badFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => explainMove(data, { apiKey: 'k', fetchImpl: badFetch }), /AI_PROVIDER_429/);
});
