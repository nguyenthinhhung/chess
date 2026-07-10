const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explainMove } = require('../ai/ai-service.js');
const { AI_PROVIDERS, DEFAULT_AI_PROVIDER } = require('../ai/providers.js');

const data = { fen: 'fen', bestMove: 'e2e4', depth: 16, eval: { type: 'cp', value: 40 }, pv: ['e2e4'], topMoves: [] };

test('defaults to Gemini when no provider (or an unknown one) is given', () => {
  assert.equal(DEFAULT_AI_PROVIDER, 'gemini');
});

test('routes gemini_native providers to the Gemini generateContent endpoint', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    const reply = { assessment: 's', whyBest: 'w', plan: 'p', line: [], alternatives: 'alt' };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) };
  };
  const result = await explainMove(data, { apiKey: 'AIza_test', provider: 'gemini', fetchImpl });
  assert.match(seenUrl, /^https:\/\/generativelanguage\.googleapis\.com\/.*models\/gemini-2\.5-flash:generateContent/);
  assert.equal(result.whyBest, 'w');
});

test('routes openai_compatible providers (Groq) to their chat/completions endpoint', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    const reply = { assessment: 's', whyBest: 'w', plan: 'p', line: [], alternatives: 'alt' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  const result = await explainMove(data, { apiKey: 'gsk_test', provider: 'groq', fetchImpl });
  assert.equal(seenUrl, `${AI_PROVIDERS.groq.baseUrl}/chat/completions`);
  assert.equal(result.whyBest, 'w');
});

test('falls back to the default provider for an unrecognized provider key', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  await explainMove(data, { apiKey: 'k', provider: 'not-a-real-provider', fetchImpl });
  assert.match(seenUrl, /generativelanguage\.googleapis\.com/);
});

test('an explicit model overrides the provider default', async () => {
  let seenBody;
  const fetchImpl = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  await explainMove(data, { apiKey: 'k', provider: 'groq', model: 'some-other-model', fetchImpl });
  assert.equal(seenBody.model, 'some-other-model');
});
