const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExplainResponse, stripCodeFence, AiParseError } = require('../ai/response-parser.js');

test('stripCodeFence removes a ```json fence', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('parseExplainResponse normalizes a well-formed reply', () => {
  const text = JSON.stringify({
    summary: 'x', whyBest: 'y', strategy: 'z', tactics: 't',
    nextPlan: ['a', 'b'], commonMistake: 'm', difficulty: 3
  });
  const r = parseExplainResponse(text);
  assert.equal(r.whyBest, 'y');
  assert.deepEqual(r.nextPlan, ['a', 'b']);
  assert.equal(r.difficulty, 3);
});

test('parseExplainResponse strips a code fence first', () => {
  const inner = { summary: 's', whyBest: 'w', strategy: 'st', tactics: 'ta', nextPlan: [], commonMistake: 'c', difficulty: 5 };
  const r = parseExplainResponse('```json\n' + JSON.stringify(inner) + '\n```');
  assert.equal(r.summary, 's');
});

test('parseExplainResponse clamps an out-of-range difficulty', () => {
  const text = JSON.stringify({ summary: '', whyBest: '', strategy: '', tactics: '', nextPlan: [], commonMistake: '', difficulty: 99 });
  assert.equal(parseExplainResponse(text).difficulty, 5);
});

test('parseExplainResponse ignores non-string entries in nextPlan', () => {
  const text = JSON.stringify({ summary: '', whyBest: '', strategy: '', tactics: '', nextPlan: ['a', 5, null, 'b'], commonMistake: '', difficulty: 1 });
  assert.deepEqual(parseExplainResponse(text).nextPlan, ['a', 'b']);
});

test('parseExplainResponse throws AiParseError on invalid JSON', () => {
  assert.throws(() => parseExplainResponse('not json'), AiParseError);
});
