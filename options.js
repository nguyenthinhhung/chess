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

const geminiKeyInput = $('geminiKey');
const geminiModelInput = $('geminiModel');
const savedGemini = $('savedGemini');

chrome.storage.local.get(['geminiApiKey', 'geminiModel'], (state) => {
  if (state.geminiApiKey) geminiKeyInput.value = state.geminiApiKey;
  if (state.geminiModel) geminiModelInput.value = state.geminiModel;
});

$('saveGemini').addEventListener('click', () => {
  const apiKey = geminiKeyInput.value.trim();
  const model = geminiModelInput.value.trim();
  chrome.storage.local.set({ geminiApiKey: apiKey, geminiModel: model }, () => {
    savedGemini.textContent = apiKey ? 'Saved' : 'Cleared';
    setTimeout(() => (savedGemini.textContent = ''), 2000);
  });
});

geminiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveGemini').click();
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
