const $ = (id) => document.getElementById(id);
const tokenInput = $('token');
const saved = $('saved');

chrome.storage.local.get('lichessToken', (state) => {
  if (state.lichessToken) tokenInput.value = state.lichessToken;
});

$('save').addEventListener('click', () => {
  const v = tokenInput.value.trim();
  chrome.storage.local.set({ lichessToken: v }, () => {
    saved.textContent = v ? 'Saved' : 'Cleared';
    setTimeout(() => (saved.textContent = ''), 2000);
  });
});

tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save').click();
});

// Each provider's key/model lives in its own slot (aiApiKeys[provider],
// aiModels[provider]) so switching the dropdown never overwrites the other
// provider's saved settings — the whole point is to be able to flip back and
// forth without re-entering keys.
// Renamed away from AI_PROVIDERS/DEFAULT_AI_PROVIDER: ai/providers.js already
// declares top-level consts with those exact names, and since it's loaded as
// a plain <script src> alongside this file, both share one lexical scope —
// redeclaring the same name here is a SyntaxError that kills this whole file
// (see test/content-script-world.test.js for the same footgun in the content
// scripts; options.html needs the same discipline).
const AI_PROVIDER_CONFIGS = (globalThis.ChessAiProviders || {}).AI_PROVIDERS || {};
const DEFAULT_PROVIDER_KEY = (globalThis.ChessAiProviders || {}).DEFAULT_AI_PROVIDER || 'gemini';

const aiProviderSelect = $('aiProvider');
const aiKeyInput = $('aiKey');
const aiModelInput = $('aiModel');
const aiKeyLink = $('aiKeyLink');
const savedAi = $('savedAi');

for (const [key, cfg] of Object.entries(AI_PROVIDER_CONFIGS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = cfg.label;
  aiProviderSelect.appendChild(opt);
}

let aiApiKeys = {};
let aiModels = {};
let currentAiProvider = DEFAULT_PROVIDER_KEY;

function applyAiProviderFields(provider) {
  const cfg = AI_PROVIDER_CONFIGS[provider] || {};
  aiKeyInput.placeholder = cfg.keyPlaceholder || '';
  aiModelInput.placeholder = cfg.model || '';
  aiKeyInput.value = aiApiKeys[provider] || '';
  aiModelInput.value = aiModels[provider] || '';
  if (cfg.keyUrl) {
    aiKeyLink.href = cfg.keyUrl;
    aiKeyLink.textContent = cfg.keyUrl.replace(/^https?:\/\//, '');
  }
}

chrome.storage.local.get(['aiProvider', 'aiApiKeys', 'aiModels', 'geminiApiKey', 'geminiModel'], (state) => {
  aiApiKeys = { ...(state.aiApiKeys || {}) };
  aiModels = { ...(state.aiModels || {}) };
  // Migrate the pre-multi-provider Gemini-only settings if the new slot is
  // still empty, so upgrading never loses an already-configured key.
  if (!aiApiKeys.gemini && state.geminiApiKey) aiApiKeys.gemini = state.geminiApiKey;
  if (!aiModels.gemini && state.geminiModel) aiModels.gemini = state.geminiModel;

  currentAiProvider = (state.aiProvider && AI_PROVIDER_CONFIGS[state.aiProvider]) ? state.aiProvider : DEFAULT_PROVIDER_KEY;
  aiProviderSelect.value = currentAiProvider;
  applyAiProviderFields(currentAiProvider);
});

aiProviderSelect.addEventListener('change', () => {
  // Stash whatever's typed for the outgoing provider in memory (not yet
  // saved) so flipping the dropdown back doesn't drop an unsaved edit.
  aiApiKeys[currentAiProvider] = aiKeyInput.value.trim();
  aiModels[currentAiProvider] = aiModelInput.value.trim();
  currentAiProvider = aiProviderSelect.value;
  applyAiProviderFields(currentAiProvider);
});

$('saveAi').addEventListener('click', () => {
  aiApiKeys[currentAiProvider] = aiKeyInput.value.trim();
  aiModels[currentAiProvider] = aiModelInput.value.trim();
  chrome.storage.local.set({ aiProvider: currentAiProvider, aiApiKeys, aiModels }, () => {
    savedAi.textContent = aiApiKeys[currentAiProvider] ? 'Saved' : 'Cleared';
    setTimeout(() => (savedAi.textContent = ''), 2000);
  });
});

aiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveAi').click();
});

const langEn = $('langEn');
const langVi = $('langVi');

chrome.storage.local.get('ccLanguage', (state) => {
  (state.ccLanguage === 'vi' ? langVi : langEn).checked = true;
});

for (const radio of [langEn, langVi]) {
  radio.addEventListener('change', () => {
    if (radio.checked) chrome.storage.local.set({ ccLanguage: radio.value });
  });
}
