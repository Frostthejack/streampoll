// history.js — Poll history tab management
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let _history = [];

export async function initHistory() {
  await loadHistory();
  setupHistoryTab();
  // Listen for backend push when a poll stops and records history
  await listen('history_updated', async () => {
    await loadHistory();
  });
}

async function loadHistory() {
  try {
    _history = await invoke('get_history');
  } catch (e) {
    console.error('History load error:', e);
    _history = [];
  }
  renderHistory();
}

function setupHistoryTab() {
  document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
    if (!confirm('Clear all poll history? This cannot be undone.')) return;
    try {
      await invoke('clear_history');
      _history = [];
      renderHistory();
      showHistoryToast('History cleared');
    } catch (e) {
      showHistoryToast('Failed: ' + e, true);
    }
  });
}

function renderHistory() {
  const container = document.getElementById('history-list');
  const emptyMsg = document.getElementById('history-empty-msg');
  if (!container) return;

  // Remove old cards (keep emptyMsg in place)
  Array.from(container.children).forEach(c => {
    if (c.id !== 'history-empty-msg') c.remove();
  });

  if (_history.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  _history.forEach(entry => {
    const card = buildHistoryCard(entry);
    container.appendChild(card);
  });
}

function buildHistoryCard(entry) {
  const card = document.createElement('div');
  card.className = 'history-card';
  card.dataset.id = entry.id;

  const date = new Date(entry.timestamp);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit'
  });

  // Find winner(s) — max votes
  const maxVotes = Math.max(...(entry.results || []).map(r => r.votes), 0);

  const optionsHtml = (entry.results || []).map(opt => {
    const pct = entry.total_votes > 0
      ? Math.round((opt.votes / entry.total_votes) * 100)
      : 0;
    const isWinner = opt.votes === maxVotes && maxVotes > 0;
    const color = opt.color || '#6c63ff';

    return `
      <div class="history-option">
        <div class="history-option-header">
          <span class="history-option-label" style="color:${escAttr(color)}">
            ${isWinner ? '🏆 ' : ''}${escHtml(opt.label)}
          </span>
          <span class="history-option-stats">${opt.votes} vote${opt.votes !== 1 ? 's' : ''} &bull; ${pct}%</span>
        </div>
        <div class="history-bar-track">
          <div class="history-bar-fill" style="width:${pct}%; background:${escAttr(color)};"></div>
        </div>
      </div>
    `;
  }).join('');

  card.innerHTML = `
    <div class="history-card-header">
      <span class="history-card-date">${escHtml(dateStr)} &bull; ${escHtml(timeStr)}</span>
      <span class="history-card-total">${entry.total_votes} total vote${entry.total_votes !== 1 ? 's' : ''}</span>
    </div>
    <div class="history-card-question">${escHtml(entry.question)}</div>
    ${optionsHtml}
  `;

  return card;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showHistoryToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.className = '', 2500);
  }
}
