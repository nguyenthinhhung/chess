const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExplainResponse, stripCodeFence, AiParseError } = require('../ai/response-parser.js');

test('stripCodeFence removes a ```json fence', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('parseExplainResponse normalizes a well-formed reply', () => {
  const text = JSON.stringify({
    assessment: 'x', whyBest: 'y', plan: 'p', line: ['a', 'b'], alternatives: 'alt'
  });
  const r = parseExplainResponse(text);
  assert.equal(r.assessment, 'x');
  assert.equal(r.whyBest, 'y');
  assert.equal(r.plan, 'p');
  assert.deepEqual(r.line, ['a', 'b']);
  assert.equal(r.alternatives, 'alt');
});

test('parseExplainResponse strips a code fence first', () => {
  const inner = { assessment: 's', whyBest: 'w', plan: 'p', line: [], alternatives: 'a' };
  const r = parseExplainResponse('```json\n' + JSON.stringify(inner) + '\n```');
  assert.equal(r.assessment, 's');
});

test('parseExplainResponse defaults missing fields instead of throwing', () => {
  const r = parseExplainResponse(JSON.stringify({ whyBest: 'only this' }));
  assert.equal(r.whyBest, 'only this');
  assert.equal(r.assessment, '');
  assert.deepEqual(r.line, []);
});

test('parseExplainResponse ignores non-string entries in line', () => {
  const text = JSON.stringify({ assessment: '', whyBest: '', plan: '', line: ['a', 5, null, 'b'], alternatives: '' });
  assert.deepEqual(parseExplainResponse(text).line, ['a', 'b']);
});

test('parseExplainResponse throws AiParseError on invalid JSON', () => {
  assert.throws(() => parseExplainResponse('not json'), AiParseError);
});
