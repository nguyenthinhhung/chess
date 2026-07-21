// ai/gemini-service.js — calls the Gemini API and returns the validated
// explanation shape. Runs in the background service worker (loaded via
// importScripts, after prompt-builder.js and response-parser.js) or under the
// Node test runner with an injected fetchImpl. Never runs in a content
// script — chess.com's page would block the cross-origin fetch.

const _gsIsNode = typeof module !== 'undefined' && module.exports;
const _gsPrompt = _gsIsNode ? require('./prompt-builder.js') : globalThis.ChessAiPrompt;
const _gsParser = _gsIsNode ? require('./response-parser.js') : globalThis.ChessAiParser;

const DEFAULT_MODEL = 'gemini-2.5-flash';

// Gemini's responseSchema rejects `additionalProperties`, size-limit keywords,
// and any `properties` entry that isn't also `required` — sanitize a plain
// JSON Schema down to what it accepts. response-parser.js still validates the
// full shape afterward, so being permissive here is safe.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type === 'array') {
    return { type: 'array', items: toGeminiSchema(schema.items) };
  }
  if (schema.type !== 'object' || !schema.properties) return schema;
  const required = new Set(schema.required || []);
  const properties = {};
  for (const key of Object.keys(schema.properties)) {
    if (!required.has(key)) continue; // Gemini rejects optional properties
    properties[key] = toGeminiSchema(schema.properties[key]);
  }
  return { type: 'object', properties, required: Array.from(required) };
}

async function explainMove(data, { apiKey, model, fetchImpl } = {}) {
  if (!apiKey) throw new Error('AI_DISABLED: no Gemini API key configured');
  const skip = _gsPrompt.shouldSkipExplain(data);
  if (skip.skip) throw new Error(`AI_SKIPPED: ${skip.reason}`);

  const { system, user } = _gsPrompt.buildExplainPrompt(data);
  const doFetch = fetchImpl || fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(_gsPrompt.EXPLAIN_SCHEMA),
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`AI_PROVIDER_${resp.status}: ${errText.slice(0, 300)}`);
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI_EMPTY_RESPONSE');
  return _gsParser.parseExplainResponse(text);
}

const _gsExports = { explainMove, toGeminiSchema, DEFAULT_MODEL };
if (_gsIsNode) {
  module.exports = _gsExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiGemini = _gsExports;
}
