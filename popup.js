const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['chessUsername'], ({ chessUsername }) => {
  if (chessUsername) $('username').value = chessUsername;
});

function setStatus(text) { $('status').textContent = text; }

function appendResult(label, result) {
  const div = document.createElement('div');
  div.className = 'item';
  if (result.url) {
    const a = document.createElement('a');
    a.href = result.url + '#analysis';
    a.target = '_blank';
    a.textContent = `${label}: ${result.url.replace('https://lichess.org/', '')}`;
    div.appendChild(a);
  } else {
    div.className += ' err';
    div.textContent = `${label}: ${result.error || 'failed'}`;
  }
  $('results').appendChild(div);
}

$('batchBtn').addEventListener('click', () => {
  const username = $('username').value.trim();
  const count = Math.max(1, Math.min(50, parseInt($('count').value, 10) || 5));
  if (!username) { setStatus('Enter username first.'); return; }

  chrome.storage.local.set({ chessUsername: username });
  setStatus(`Fetching archive for ${username}...`);
  $('results').innerHTML = '';
  $('batchBtn').disabled = true;

  chrome.runtime.sendMessage({ action: 'fetchArchive', username, count }, (resp) => {
    if (!resp || resp.error) {
      setStatus('Error: ' + (resp?.error || 'no response'));
      $('batchBtn').disabled = false;
      return;
    }
    const games = resp.games.slice(-count);
    if (!games.length) {
      setStatus('No games found this month.');
      $('batchBtn').disabled = false;
      return;
    }
    const eta = Math.ceil(games.length * 3.5);
    setStatus(`Importing ${games.length} games (~${eta}s)...`);

    const port = chrome.runtime.connect({ name: 'batch' });
    port.postMessage({ action: 'batchImport', pgns: games.map(g => g.pgn) });
    port.onMessage.addListener((m) => {
      if (m.type === 'progress') {
        appendResult(`Game ${m.index + 1}/${m.total}`, m.result);
        setStatus(`Imported ${m.index + 1}/${m.total}...`);
      } else if (m.type === 'done') {
        const ok = m.results.filter(r => r.url).length;
        setStatus(`Done. ${ok}/${m.results.length} imported.`);
        $('batchBtn').disabled = false;
        port.disconnect();
      }
    });
  });
});

$('pasteBtn').addEventListener('click', () => {
  const pgn = $('pgnPaste').value.trim();
  if (!pgn) { setStatus('Paste PGN first.'); return; }
  setStatus('Importing...');
  $('pasteBtn').disabled = true;
  chrome.runtime.sendMessage({ action: 'importToLichess', pgn }, (resp) => {
    $('pasteBtn').disabled = false;
    if (resp?.url) {
      setStatus('Imported. Opening tab...');
      chrome.tabs.create({ url: resp.url + '#analysis' });
    } else {
      setStatus('Error: ' + (resp?.error || 'failed'));
    }
  });
});

$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
