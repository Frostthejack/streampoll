// library.js — Poll Library & Queue management
const { invoke } = window.__TAURI__.core;

// ── State ──────────────────────────────────────────────────────
let _savedPolls = [];
let _queue = [];      // array of saved poll IDs in order
let _queueIndex = 0;  // tracks current position (server-side, mirrored here for display)

// ── Public API ─────────────────────────────────────────────────
export async function initLibrary() {
  await refreshLibrary();
  setupLibraryTab();
}

export async function refreshLibrary() {
  try {
    _savedPolls = await invoke('get_saved_polls');
    _queue = await invoke('get_queue');
  } catch (e) {
    console.error('Library load error:', e);
  }
  renderLibraryList();
  renderQueueList();
  updateNextPollButton();
}

// Called from settings-window.js after saving a poll config
export async function saveCurrentPollToLibrary(config) {
  const name = prompt('Name for this poll:');
  if (!name || !name.trim()) return;
  try {
    const saved = await invoke('save_poll', { name: name.trim(), config });
    _savedPolls.push(saved);
    renderLibraryList();
    showLibraryToast(`"${name}" saved to library!`);
  } catch (e) {
    showLibraryToast('Failed to save: ' + e, true);
  }
}

// ── Rendering ──────────────────────────────────────────────────
function renderLibraryList() {
  const container = document.getElementById('library-list');
  if (!container) return;

  if (_savedPolls.length === 0) {
    container.innerHTML = '<p class="log-placeholder">No saved polls yet. Create a poll and click "Save to Library".</p>';
    return;
  }

  container.innerHTML = '';
  _savedPolls.forEach(poll => {
    const item = document.createElement('div');
    item.className = 'library-item';
    item.dataset.id = poll.id;

    const optCount = poll.config?.options?.length ?? 0;
    item.innerHTML = `
      <span class="library-item-name" title="${escHtml(poll.name)}">${escHtml(poll.name)}</span>
      <span class="library-item-meta">${optCount} option${optCount !== 1 ? 's' : ''}</span>
      <button class="lib-btn" data-action="load" title="Load into Poll tab">✏️ Edit</button>
      <button class="lib-btn" data-action="queue" title="Add to queue">+ Queue</button>
      <button class="lib-btn danger" data-action="delete" title="Delete">🗑</button>
    `;

    item.querySelector('[data-action="load"]').addEventListener('click', () => loadPollIntoEditor(poll));
    item.querySelector('[data-action="queue"]').addEventListener('click', () => addToQueue(poll.id));
    item.querySelector('[data-action="delete"]').addEventListener('click', () => deleteSavedPoll(poll.id, poll.name));

    container.appendChild(item);
  });
}

function renderQueueList() {
  const container = document.getElementById('queue-list');
  const emptyMsg = document.getElementById('queue-empty-msg');
  if (!container) return;

  // Clear, keep empty-msg placeholder
  Array.from(container.children).forEach(c => {
    if (c.id !== 'queue-empty-msg') c.remove();
  });

  if (_queue.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    document.getElementById('queue-position-label').textContent = '';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  document.getElementById('queue-position-label').textContent = `${_queue.length} poll${_queue.length !== 1 ? 's' : ''}`;

  _queue.forEach((pollId, idx) => {
    const poll = _savedPolls.find(p => p.id === pollId);
    const name = poll ? poll.name : `(deleted poll)`;

    const item = document.createElement('div');
    item.className = 'queue-item';
    item.dataset.id = pollId;
    item.dataset.idx = idx;
    item.draggable = true;
    item.innerHTML = `
      <span class="queue-drag-handle" title="Drag to reorder">⠿</span>
      <span class="queue-item-num">${idx + 1}</span>
      <span class="queue-item-name" title="${escHtml(name)}">${escHtml(name)}</span>
      <button class="lib-btn danger" data-action="remove" title="Remove from queue">✕</button>
    `;

    item.querySelector('[data-action="remove"]').addEventListener('click', () => removeFromQueue(idx));

    // Drag-and-drop reorder
    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragover', onDragOver);
    item.addEventListener('dragleave', onDragLeave);
    item.addEventListener('drop', onDrop);
    item.addEventListener('dragend', onDragEnd);

    container.appendChild(item);
  });

  updateNextPollButton();
}

// ── Library Actions ────────────────────────────────────────────
async function deleteSavedPoll(id, name) {
  if (!confirm(`Delete "${name}"? It will also be removed from the queue.`)) return;
  try {
    await invoke('delete_poll', { id });
    _savedPolls = _savedPolls.filter(p => p.id !== id);
    _queue = _queue.filter(qid => qid !== id);
    renderLibraryList();
    renderQueueList();
    showLibraryToast(`"${name}" deleted.`);
  } catch (e) {
    showLibraryToast('Delete failed: ' + e, true);
  }
}

function loadPollIntoEditor(poll) {
  // Emit a custom event that settings-window.js will listen to
  window.dispatchEvent(new CustomEvent('library:load-poll', { detail: poll }));
  // Switch to Poll tab
  document.querySelector('[data-tab="poll-setup"]')?.click();
  showLibraryToast(`Loaded "${poll.name}" into editor`);
}

async function addToQueue(pollId) {
  if (_queue.includes(pollId)) {
    showLibraryToast('Already in queue');
    return;
  }
  _queue.push(pollId);
  await persistQueue();
  renderQueueList();
  const poll = _savedPolls.find(p => p.id === pollId);
  showLibraryToast(`Added "${poll?.name}" to queue`);
}

async function removeFromQueue(idx) {
  _queue.splice(idx, 1);
  await persistQueue();
  renderQueueList();
}

async function persistQueue() {
  try {
    await invoke('set_queue', { ids: _queue });
    updateNextPollButton();
  } catch (e) {
    console.error('Queue persist error:', e);
  }
}

function updateNextPollButton() {
  const btn = document.getElementById('ctrl-next-poll');
  if (!btn) return;
  btn.classList.toggle('hidden', _queue.length === 0);
}

// ── Drag and Drop ──────────────────────────────────────────────
let _dragSrcIdx = null;

function onDragStart(e) {
  _dragSrcIdx = parseInt(e.currentTarget.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}
async function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const destIdx = parseInt(e.currentTarget.dataset.idx);
  if (_dragSrcIdx === null || _dragSrcIdx === destIdx) return;
  const [moved] = _queue.splice(_dragSrcIdx, 1);
  _queue.splice(destIdx, 0, moved);
  _dragSrcIdx = null;
  await persistQueue();
  renderQueueList();
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('drag-over');
  _dragSrcIdx = null;
}

// ── Next Poll button ───────────────────────────────────────────
function setupLibraryTab() {
  document.getElementById('ctrl-next-poll')?.addEventListener('click', async () => {
    try {
      const result = await invoke('next_poll_in_queue');
      showLibraryToast(`▶▶ Loaded: ${result.loaded} (${result.remaining} remaining)`);
      // Refresh the poll editor UI to reflect new config
      window.dispatchEvent(new CustomEvent('library:poll-loaded'));
    } catch (e) {
      showLibraryToast('Next poll: ' + e, true);
    }
  });

  document.getElementById('btn-reset-queue')?.addEventListener('click', async () => {
    try {
      // Re-set queue to reset index server-side
      await invoke('set_queue', { ids: _queue });
      showLibraryToast('Queue position reset to start');
    } catch (e) {
      showLibraryToast('Reset failed: ' + e, true);
    }
  });
}

// ── Utility ────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showLibraryToast(msg, isError = false) {
  // Reuse the existing toast if available, otherwise console.log
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.className = '', 2500);
  } else {
    console.log('[Library]', msg);
  }
}
