// ai/providers.js — the AI providers the coach can call for move
// explanations, and what each one needs (auth style, default model, where to
// get a key). Pure data: no DOM, no chrome, no network — shared by
// background.js (to pick which service implementation to call) and
// options.js (to render the settings UI).

const _apIsNode = typeof module !== 'undefined' && module.exports;

const AI_PROVIDERS = {
  gemini: {
    label: 'Gemini',
    providerType: 'gemini_native',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza...'
  },
  groq: {
    label: 'Groq',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_...'
  }
};

const DEFAULT_AI_PROVIDER = 'gemini';

const _apExports = { AI_PROVIDERS, DEFAULT_AI_PROVIDER };
if (_apIsNode) {
  module.exports = _apExports;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ChessAiProviders = _apExports;
}
