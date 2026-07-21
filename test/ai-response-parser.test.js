const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExplainResponse, stripCodeFence, AiParseError } = require('../ai/response-parser.js');

test('stripCodeFence removes a ```json fence', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('parseExplainResponse normalizes a well-formed reply', () => {
  const text = JSON.stringify({ whyBest: 'y', plan: 'p', opponentReply: 'o', principle: 'm' });
  const r = parseExplainResponse(text);
  assert.equal(r.whyBest, 'y');
  assert.equal(r.plan, 'p');
  assert.equal(r.opponentReply, 'o');
  assert.equal(r.principle, 'm');
});

test('parseExplainResponse strips a code fence first', () => {
  const inner = { whyBest: 'w', plan: 'p', opponentReply: 'o' };
  const r = parseExplainResponse('```json\n' + JSON.stringify(inner) + '\n```');
  assert.equal(r.whyBest, 'w');
});

test('parseExplainResponse defaults missing fields instead of throwing', () => {
  const r = parseExplainResponse(JSON.stringify({ whyBest: 'only this' }));
  assert.equal(r.whyBest, 'only this');
  assert.equal(r.plan, '');
  assert.equal(r.opponentReply, '');
});

test('parseExplainResponse ignores non-string field values', () => {
  const text = JSON.stringify({ whyBest: 42, plan: null, opponentReply: 'o' });
  const r = parseExplainResponse(text);
  assert.equal(r.whyBest, '');
  assert.equal(r.plan, '');
  assert.equal(r.opponentReply, 'o');
});

test('parseExplainResponse throws AiParseError on invalid JSON', () => {
  assert.throws(() => parseExplainResponse('not json'), AiParseError);
});
