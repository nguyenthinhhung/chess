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
