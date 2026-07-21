const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explainMove } = require('../ai/openai-compatible-service.js');

function fakeFetch(reply) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] })
  });
}

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

test('explainMove parses a successful chat-completions reply', async () => {
  const reply = { assessment: 's', whyBest: 'w', plan: 'p', line: ['Nf3', 'Nc6'], alternatives: 'alt' };
  const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 }, pv: ['e2e4'], topMoves: [] };
  const result = await explainMove(data, { apiKey: 'k', baseUrl: 'https://api.groq.com/openai/v1', fetchImpl: fakeFetch(reply) });
  assert.equal(result.whyBest, 'w');
  assert.deepEqual(result.line, ['Nf3', 'Nc6']);
});

test('explainMove posts to <baseUrl>/chat/completions with a bearer token and json_object format', async () => {
  const reply = { assessment: 's', whyBest: 'w', plan: 'p', line: [], alternatives: 'alt' };
  const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 } };
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenOpts = opts;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  await explainMove(data, { apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', fetchImpl });
  assert.equal(seenUrl, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seenOpts.headers.Authorization, 'Bearer gsk_test');
  const body = JSON.parse(seenOpts.body);
  assert.equal(body.model, 'llama-3.3-70b-versatile');
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('explainMove surfaces a non-OK HTTP response', async () => {
  const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 } };
  const badFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => explainMove(data, { apiKey: 'k', fetchImpl: badFetch }), /AI_PROVIDER_429/);
});
