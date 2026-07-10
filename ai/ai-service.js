// ai/ai-service.js — picks the right provider implementation (Gemini's native
// API, or an OpenAI-chat-completions-shaped one like Groq) based on the
// user's provider setting, and calls it. Runs in the background service
// worker (loaded via importScripts, after providers.js, gemini-service.js,
// and openai-compatible-service.js) or under the Node test runner.

const _asIsNode = typeof module !== 'undefined' && module.exports;
const _asProviders = _asIsNode ? require('./providers.js') : globalThis.ChessAiProviders;
const _asGemini = _asIsNode ? require('./gemini-service.js') : globalThis.ChessAiGemini;
const _asOpenAiCompatible = _asIsNode ? require('./openai-compatible-service.js') : globalThis.ChessAiOpenAiCompatible;

async function explainMove(data, { apiKey, model, provider, fetchImpl } = {}) {
  const providerKey = provider && _asProviders.AI_PROVIDERS[provider] ? provider : _asProviders.DEFAULT_AI_PROVIDER;
  const cfg = _asProviders.AI_PROVIDERS[providerKey];
  const resolvedModel = (model && model.trim()) || cfg.model;

  if (cfg.providerType === 'gemini_native') {
    return _asGemini.explainMove(data, { apiKey, model: resolvedModel, fetchImpl });
  }
  return _asOpenAiCompatible.explainMove(data, { apiKey, model: resolvedModel, baseUrl: cfg.baseUrl, fetchImpl });
}

const _asExports = { explainMove };
if (_asIsNode) {
  module.exports = _asExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiService = _asExports;
}
