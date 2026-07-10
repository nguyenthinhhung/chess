// ai/openai-compatible-service.js — calls any OpenAI-chat-completions-shaped
// API (Groq, etc.) and returns the same validated explanation shape as
// gemini-service.js. Runs in the background service worker (loaded via
// importScripts, after prompt-builder.js and response-parser.js) or under the
// Node test runner with an injected fetchImpl. Never runs in a content
// script — chess.com's page would block the cross-origin fetch.

const _ocIsNode = typeof module !== 'undefined' && module.exports;
const _ocPrompt = _ocIsNode ? require('./prompt-builder.js') : globalThis.ChessAiPrompt;
const _ocParser = _ocIsNode ? require('./response-parser.js') : globalThis.ChessAiParser;

async function explainMove(data, { apiKey, model, baseUrl, fetchImpl } = {}) {
  if (!apiKey) throw new Error('AI_DISABLED: no API key configured');
  const skip = _ocPrompt.shouldSkipExplain(data);
  if (skip.skip) throw new Error(`AI_SKIPPED: ${skip.reason}`);

  const { system, user } = _ocPrompt.buildExplainPrompt(data);
  const doFetch = fetchImpl || fetch;
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  };

  const resp = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`AI_PROVIDER_${resp.status}: ${errText.slice(0, 300)}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI_EMPTY_RESPONSE');
  return _ocParser.parseExplainResponse(text);
}

const _ocExports = { explainMove };
if (_ocIsNode) {
  module.exports = _ocExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiOpenAiCompatible = _ocExports;
}
