/**
 * StreamPoll Remote — Client Application
 * WebSocket-based mobile remote control for StreamPoll
 */
(() => {
  'use strict';

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const RECONNECT_MULTIPLIER = 1.5;
  const VIBRATE_MS = 15;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────
  let ws = null;
  let pin = '';
  let appState = 'disconnected'; // disconnected | authenticating | connected
  let pollState = null; // latest poll data
  let configState = null; // latest poll config (with keywords)
  let savedPolls = [];
  let queue = [];
  let queueIndex = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let wasAuthenticated = false;

  // State flag to distinguish whether the editor is editing the current active poll or a new blank/library poll
  let currentEditingSource = 'active'; // 'active' | 'library' | 'new'
  let currentEditingPollId = null;     // if editing an existing library poll

  // ──────────────────────────────────────────────
  // DOM References
  // ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const el = {
    screenPin: $('#screen-pin'),
    screenDash: $('#screen-dashboard'),
    pinDots: $$('.pin-dot'),
    pinMessage: $('#pin-message'),
    keypad: $('.keypad'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    wsBadge: $('#ws-badge'),
    btnDisconnect: $('#btn-disconnect'),
    noPoll: $('#no-poll'),
    activePoll: $('#active-poll'),
    pollQuestion: $('#poll-question'),
    pollStatusBadge: $('#poll-status-badge'),
    pollTotalVotes: $('#poll-total-votes'),
    pollOptions: $('#poll-options'),
    controlsBar: $('#controls-bar'),
    btnStart: $('#btn-start'),
    btnPause: $('#btn-pause'),
    btnResume: $('#btn-resume'),
    btnStop: $('#btn-stop'),
    btnReset: $('#btn-reset'),
    btnNext: $('#btn-next'),
    overlayReconnect: $('#overlay-reconnect'),
    reconnectMessage: $('#reconnect-message'),
    btnRetry: $('#btn-retry'),
    // Editor
    btnEditPoll: $('#btn-edit-poll'),
    editorOverlay: $('#editor-overlay'),
    editorName: $('#editor-name'),
    editorQuestion: $('#editor-question'),
    editorOptionsList: $('#editor-options-list'),
    btnEditorAddOption: $('#btn-editor-add-option'),
    btnEditorClose: $('#btn-editor-close'),
    btnEditorCancel: $('#btn-editor-cancel'),
    btnEditorApply: $('#btn-editor-apply'),
    btnEditorSaveLib: $('#btn-editor-save-lib'),
    btnEditorSaveQueue: $('#btn-editor-save-queue'),
    // Panels & Tabs
    dashTabs: $('.dashboard-tabs'),
    btnCreatePollLib: $('#btn-create-poll-lib'),
    libraryList: $('#library-list'),
    queueList: $('#queue-list'),
    panelPoll: $('#panel-poll'),
    panelLibrary: $('#panel-library'),
    panelQueue: $('#panel-queue'),
  };

  // ──────────────────────────────────────────────
  // Utilities
  // ──────────────────────────────────────────────
  function vibrate(ms = VIBRATE_MS) {
    if (navigator.vibrate) navigator.vibrate(ms);
  }

  function buildWsUrl() {
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${loc.host}/ws`;
  }

  // ──────────────────────────────────────────────
  // Screen Navigation
  // ──────────────────────────────────────────────
  function showScreen(name) {
    el.screenPin.classList.toggle('active', name === 'pin');
    el.screenDash.classList.toggle('active', name === 'dashboard');
  }

  // ──────────────────────────────────────────────
  // PIN Entry
  // ──────────────────────────────────────────────
  function updatePinDisplay() {
    el.pinDots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < pin.length);
      dot.classList.remove('error');
    });
  }

  function showPinError(msg) {
    el.pinMessage.textContent = msg;
    el.pinMessage.classList.add('error');
    el.pinDots.forEach((dot) => dot.classList.add('error'));
    vibrate(100);

    setTimeout(() => {
      pin = '';
      updatePinDisplay();
      el.pinMessage.textContent = 'Enter PIN to connect';
      el.pinMessage.classList.remove('error');
    }, 1200);
  }

  function handleKeyPress(key) {
    vibrate();

    if (key === 'delete') {
      if (pin.length > 0) {
        pin = pin.slice(0, -1);
        updatePinDisplay();
      }
      return;
    }

    if (pin.length >= 4) return;
    pin += key;
    updatePinDisplay();

    if (pin.length === 4) {
      submitPin();
    }
  }

  function submitPin() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showPinError('Not connected to server');
      return;
    }
    appState = 'authenticating';
    el.pinMessage.textContent = 'Authenticating...';
    el.pinMessage.classList.remove('error');
    wsSend({ type: 'auth', pin });
  }

  // ──────────────────────────────────────────────
  // WebSocket
  // ──────────────────────────────────────────────
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = buildWsUrl();
    console.log('[StreamPoll] Connecting to', url);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[StreamPoll] WebSocket creation failed:', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[StreamPoll] Connected');
      reconnectAttempts = 0;
      hideReconnectOverlay();

      // If we were previously authenticated, re-auth automatically
      if (wasAuthenticated && pin.length === 4) {
        appState = 'authenticating';
        wsSend({ type: 'auth', pin });
      } else {
        // Check localStorage for saved PIN
        const savedPin = localStorage.getItem('streampoll_pin');
        if (savedPin && savedPin.length === 4) {
          pin = savedPin;
          appState = 'authenticating';
          wsSend({ type: 'auth', pin });
        }
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn('[StreamPoll] Bad message:', event.data);
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = (event) => {
      console.log('[StreamPoll] Disconnected:', event.code, event.reason);
      ws = null;

      if (appState === 'connected') {
        showReconnectOverlay();
      }
      scheduleReconnect();
    };

    ws.onerror = (event) => {
      console.error('[StreamPoll] WebSocket error:', event);
    };
  }

  function disconnect() {
    wasAuthenticated = false;
    pin = '';
    appState = 'disconnected';
    pollState = null;
    configState = null;
    localStorage.removeItem('streampoll_pin');
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;

    if (ws) {
      ws.onclose = null; // prevent reconnect
      ws.close();
      ws = null;
    }

    hideReconnectOverlay();
    showScreen('pin');
    updatePinDisplay();
    el.pinMessage.textContent = 'Enter PIN to connect';
    el.pinMessage.classList.remove('error');
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    console.log(`[StreamPoll] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);

    if (el.reconnectMessage) {
      el.reconnectMessage.textContent = `Reconnecting in ${Math.round(delay / 1000)}s...`;
    }

    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  function showReconnectOverlay() {
    el.overlayReconnect.style.display = 'flex';
  }

  function hideReconnectOverlay() {
    el.overlayReconnect.style.display = 'none';
  }
  // ──────────────────────────────────────────────
  // Message Handling
  // ──────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        handleAuthResult(msg);
        break;
      case 'poll_update':
        handlePollUpdate(msg.data);
        break;
      case 'state_snapshot':
        handleStateSnapshot(msg.data);
        break;
      case 'ws_status':
        updateWsBadge(msg.status);
        break;
      case 'auth_status':
        // Restream auth status — just update the badge
        break;
      case 'error':
        handleError(msg);
        break;
      case 'config_update':
        handleConfigUpdate(msg.data);
        break;
      case 'library_update':
        handleLibraryUpdate(msg.data);
        break;
      case 'queue_update':
        handleQueueUpdate(msg.data);
        break;
      default:
        console.log('[StreamPoll] Unknown message type:', msg.type);
    }
  }

  function handleAuthResult(msg) {
    if (msg.success) {
      appState = 'connected';
      wasAuthenticated = true;
      localStorage.setItem('streampoll_pin', pin);
      showScreen('dashboard');
      updateStatusIndicator('idle');
      // Request full state after auth
      wsSend({ type: 'command', action: 'get_state' });
    } else {
      appState = 'disconnected';
      showPinError(msg.message || 'Invalid PIN');
    }
  }

  function handlePollUpdate(data) {
    pollState = data;
    renderPoll();
  }

  function handleStateSnapshot(data) {
    if (data.poll) {
      pollState = data.poll;
      renderPoll();
    }
    if (data.ws_status) {
      updateWsBadge(data.ws_status);
    }
    if (data.config) {
      configState = data.config;
    }
    if (data.saved_polls !== undefined) {
      savedPolls = data.saved_polls || [];
      renderLibrary();
    }
    if (data.queue !== undefined) {
      queue = data.queue || [];
      renderQueue();
    }
    if (data.queue_index !== undefined) {
      queueIndex = data.queue_index || 0;
      renderQueue();
    }
  }

  function handleLibraryUpdate(polls) {
    savedPolls = polls || [];
    renderLibrary();
    renderQueue();
  }

  function handleQueueUpdate(data) {
    queue = data.queue || [];
    queueIndex = data.queue_index || 0;
    renderQueue();
  }

  function handleError(msg) {
    console.error('[StreamPoll] Server error:', msg.message);
    if (appState === 'authenticating') {
      showPinError(msg.message || 'Authentication failed');
      appState = 'disconnected';
    }
  }

  // ──────────────────────────────────────────────
  // Poll Rendering
  // ──────────────────────────────────────────────
  function renderPoll() {
    if (!pollState || !pollState.question) {
      el.noPoll.style.display = '';
      el.activePoll.style.display = 'none';
      updateStatusIndicator('idle');
      updateControlButtons(null);
      return;
    }

    el.noPoll.style.display = 'none';
    el.activePoll.style.display = '';

    // Question
    el.pollQuestion.textContent = pollState.question;

    // Status badge
    const status = (pollState.status || 'idle').toLowerCase();
    el.pollStatusBadge.textContent = status.toUpperCase();
    el.pollStatusBadge.className = 'poll-status-badge ' + status;

    // Total votes
    const total = pollState.total_votes || 0;
    el.pollTotalVotes.textContent = `${total.toLocaleString()} vote${total !== 1 ? 's' : ''}`;

    // Status indicator
    updateStatusIndicator(status);

    // Options
    renderOptions(pollState.options || []);

    // Buttons
    updateControlButtons(status);
  }

  function renderOptions(options) {
    // Find max percentage for "leading" highlight
    let maxPct = 0;
    options.forEach((o) => {
      if ((o.percentage || 0) > maxPct) maxPct = o.percentage || 0;
    });

    // Check if we need to rebuild or can update in-place
    const existing = el.pollOptions.querySelectorAll('.poll-option');
    const needsRebuild = existing.length !== options.length ||
      Array.from(existing).some((el, i) => el.dataset.id !== options[i].id);

    if (needsRebuild) {
      el.pollOptions.innerHTML = options.map((opt, i) => {
        const pct = opt.percentage || 0;
        const color = opt.color || '#6c63ff';
        const isLeading = pct > 0 && pct === maxPct;
        return `
          <div class="poll-option ${isLeading ? 'leading' : ''}" data-id="${opt.id}" style="animation-delay: ${i * 0.05}s">
            <div class="poll-option-bar" style="width: ${pct}%; background: ${color};"></div>
            <div class="poll-option-content">
              <span class="poll-option-label">${escapeHtml(opt.label)}</span>
              <div class="poll-option-stats">
                <span class="poll-option-pct">${pct.toFixed(1)}%</span>
                <span class="poll-option-votes">${(opt.votes || 0).toLocaleString()}</span>
              </div>
            </div>
            <div class="poll-option-progress">
              <div class="poll-option-progress-fill" style="width: ${pct}%; background: ${color};"></div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      // Update in-place for smooth bar animation
      existing.forEach((optEl, i) => {
        const opt = options[i];
        const pct = opt.percentage || 0;
        const color = opt.color || '#6c63ff';
        const isLeading = pct > 0 && pct === maxPct;

        optEl.classList.toggle('leading', isLeading);

        const bar = optEl.querySelector('.poll-option-bar');
        bar.style.width = pct + '%';
        bar.style.background = color;

        optEl.querySelector('.poll-option-label').textContent = opt.label;
        optEl.querySelector('.poll-option-pct').textContent = pct.toFixed(1) + '%';
        optEl.querySelector('.poll-option-votes').textContent = (opt.votes || 0).toLocaleString();

        const fill = optEl.querySelector('.poll-option-progress-fill');
        fill.style.width = pct + '%';
        fill.style.background = color;
      });
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ──────────────────────────────────────────────
  // Status & Controls
  // ──────────────────────────────────────────────
  function updateStatusIndicator(status) {
    el.statusDot.className = 'status-dot';
    switch (status) {
      case 'running':
        el.statusDot.classList.add('live');
        el.statusText.textContent = 'Live';
        break;
      case 'paused':
        el.statusDot.classList.add('paused');
        el.statusText.textContent = 'Paused';
        break;
      case 'stopped':
        el.statusText.textContent = 'Stopped';
        break;
      default:
        el.statusText.textContent = 'Connected';
        break;
    }
  }

  function updateWsBadge(status) {
    el.wsBadge.className = 'ws-badge';
    if (status === 'connected') {
      el.wsBadge.classList.add('connected');
      el.wsBadge.title = 'Restream: Connected';
    } else {
      el.wsBadge.classList.add('disconnected');
      el.wsBadge.title = 'Restream: Disconnected';
    }
  }

  function updateControlButtons(status) {
    // Show/hide and enable/disable based on poll status
    const show = (el) => { el.style.display = ''; };
    const hide = (el) => { el.style.display = 'none'; };
    const enable = (el) => { el.disabled = false; };
    const disable = (el) => { el.disabled = true; };

    switch (status) {
      case 'running':
        show(el.btnStart); disable(el.btnStart);
        show(el.btnPause); enable(el.btnPause);
        hide(el.btnResume);
        show(el.btnStop); enable(el.btnStop);
        show(el.btnReset); disable(el.btnReset);
        show(el.btnNext); disable(el.btnNext);
        break;

      case 'paused':
        show(el.btnStart); disable(el.btnStart);
        hide(el.btnPause);
        show(el.btnResume); enable(el.btnResume);
        show(el.btnStop); enable(el.btnStop);
        show(el.btnReset); disable(el.btnReset);
        show(el.btnNext); disable(el.btnNext);
        break;

      case 'stopped':
        show(el.btnStart); enable(el.btnStart);
        show(el.btnPause); disable(el.btnPause);
        hide(el.btnResume);
        show(el.btnStop); disable(el.btnStop);
        show(el.btnReset); enable(el.btnReset);
        show(el.btnNext); enable(el.btnNext);
        break;

      default: // idle or null
        show(el.btnStart); enable(el.btnStart);
        show(el.btnPause); disable(el.btnPause);
        hide(el.btnResume);
        show(el.btnStop); disable(el.btnStop);
        show(el.btnReset); enable(el.btnReset);
        show(el.btnNext); enable(el.btnNext);
        break;
    }
  }

  function sendCommand(action) {
    vibrate(25);
    wsSend({ type: 'command', action });
  }
  // ──────────────────────────────────────────────
  // Config Editor
  // ──────────────────────────────────────────────
  function handleConfigUpdate(data) {
    configState = data;
  }

  function openEditor(source = 'active', pollId = null) {
    vibrate();
    currentEditingSource = source;
    currentEditingPollId = pollId;

    if (source === 'active') {
      const cfg = configState || (pollState ? { question: pollState.question, options: pollState.options } : null) || { question: '', options: [] };
      el.editorName.value = '';
      el.editorName.disabled = true;
      el.editorName.placeholder = 'N/A (Active Poll)';
      el.editorQuestion.value = cfg.question || '';
      renderEditorOptions(cfg.options || []);
    } else if (source === 'library') {
      const poll = savedPolls.find(p => p.id === pollId);
      if (!poll) return;
      el.editorName.value = poll.name || '';
      el.editorName.disabled = false;
      el.editorName.placeholder = 'e.g. Winner Poll';
      el.editorQuestion.value = poll.config.question || '';
      renderEditorOptions(poll.config.options || []);
    } else { // new
      el.editorName.value = '';
      el.editorName.disabled = false;
      el.editorName.placeholder = 'e.g. New Poll';
      el.editorQuestion.value = '';
      renderEditorOptions([
        { label: '', keywords: ['1'], color: '#6c63ff' },
        { label: '', keywords: ['2'], color: '#ff6584' }
      ]);
    }
    el.editorOverlay.style.display = 'flex';
  }

  function closeEditor() {
    el.editorOverlay.style.display = 'none';
  }

  function renderEditorOptions(options) {
    const colors = ['#6c63ff', '#ff6584', '#43e97b', '#f59e0b', '#a78bfa', '#ec4899', '#06b6d4', '#84cc16'];
    el.editorOptionsList.innerHTML = options.map((opt, i) => {
      const kw = (opt.keywords || []).join(', ');
      const color = opt.color || colors[i % colors.length];
      return `
        <div class="editor-option-row" data-index="${i}">
          <input type="color" class="editor-option-color" value="${escapeAttr(color)}" />
          <div class="editor-option-fields">
            <input type="text" class="editor-option-label-input" value="${escapeAttr(opt.label || '')}" placeholder="Option label" autocomplete="off" />
            <input type="text" class="editor-option-keywords-input" value="${escapeAttr(kw)}" placeholder="Keywords (comma separated)" autocomplete="off" />
          </div>
          <button class="editor-option-delete" data-index="${i}" aria-label="Remove option">✕</button>
        </div>
      `;
    }).join('');
  }

  function addEditorOption() {
    vibrate();
    const colors = ['#6c63ff', '#ff6584', '#43e97b', '#f59e0b', '#a78bfa', '#ec4899', '#06b6d4', '#84cc16'];
    const existing = el.editorOptionsList.querySelectorAll('.editor-option-row');
    const i = existing.length;
    const color = colors[i % colors.length];
    const row = document.createElement('div');
    row.className = 'editor-option-row';
    row.dataset.index = i;
    row.innerHTML = `
      <input type="color" class="editor-option-color" value="${color}" />
      <div class="editor-option-fields">
        <input type="text" class="editor-option-label-input" value="" placeholder="Option label" autocomplete="off" />
        <input type="text" class="editor-option-keywords-input" value="" placeholder="Keywords (comma separated)" autocomplete="off" />
      </div>
      <button class="editor-option-delete" data-index="${i}" aria-label="Remove option">✕</button>
    `;
    el.editorOptionsList.appendChild(row);
    // Focus the new label input
    row.querySelector('.editor-option-label-input').focus();
  }

  function removeEditorOption(index) {
    vibrate();
    const rows = el.editorOptionsList.querySelectorAll('.editor-option-row');
    if (rows.length <= 1) return; // Must keep at least one option
    rows[index]?.remove();
    // Re-index remaining rows
    el.editorOptionsList.querySelectorAll('.editor-option-row').forEach((row, i) => {
      row.dataset.index = i;
      row.querySelector('.editor-option-delete').dataset.index = i;
    });
  }

  function getEditorConfigData() {
    const question = el.editorQuestion.value.trim() || 'Untitled Poll';
    const rows = el.editorOptionsList.querySelectorAll('.editor-option-row');
    const options = Array.from(rows).map((row, i) => {
      const label = row.querySelector('.editor-option-label-input').value.trim() || `Option ${i + 1}`;
      const kwStr = row.querySelector('.editor-option-keywords-input').value.trim();
      const keywords = kwStr ? kwStr.split(',').map(k => k.trim()).filter(k => k) : [String(i + 1)];
      const color = row.querySelector('.editor-option-color').value;
      return { id: `opt${i + 1}`, label, keywords, color };
    });
    const name = el.editorName.value.trim() || question || 'Remote Poll';
    return { name, question, options };
  }

  function saveEditorApply() {
    vibrate(25);
    const { question, options } = getEditorConfigData();
    if (options.length === 0) return;

    wsSend({
      type: 'set_config',
      data: { question, options }
    });
    closeEditor();
  }

  function saveEditorToLib() {
    vibrate(25);
    const { name, question, options } = getEditorConfigData();
    if (options.length === 0) return;

    if (currentEditingSource === 'library' && currentEditingPollId) {
      wsSend({ type: 'command', action: 'delete_poll', data: currentEditingPollId });
    }

    wsSend({
      type: 'command',
      action: 'save_poll',
      data: { name, config: { question, options } }
    });
    closeEditor();
  }

  function saveEditorAndQueue() {
    vibrate(25);
    const { name, question, options } = getEditorConfigData();
    if (options.length === 0) return;

    if (currentEditingSource === 'library' && currentEditingPollId) {
      wsSend({ type: 'command', action: 'delete_poll', data: currentEditingPollId });
    }

    wsSend({
      type: 'command',
      action: 'save_and_queue',
      data: { name, config: { question, options } }
    });
    closeEditor();
  }

  // ──────────────────────────────────────────────
  // Library Rendering
  // ──────────────────────────────────────────────
  function renderLibrary() {
    if (!el.libraryList) return;
    if (savedPolls.length === 0) {
      el.libraryList.innerHTML = `
        <div class="no-poll-card glass-card" style="padding: 20px; text-align: center;">
          <p style="color: var(--text-muted); margin: 0;">No saved polls in library.</p>
        </div>
      `;
      return;
    }

    el.libraryList.innerHTML = savedPolls.map((poll) => {
      const optionsBadges = (poll.config.options || [])
        .map(o => `<span class="mini-option-badge">${escapeHtml(o.label)}</span>`)
        .join('');

      return `
        <div class="library-item glass-card" data-id="${poll.id}">
          <div class="library-item-header">
            <span class="library-item-title">${escapeHtml(poll.name || 'Untitled Poll')}</span>
            <button class="edit-poll-btn btn-edit-lib-item" data-id="${poll.id}" aria-label="Edit Poll">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          </div>
          <div class="library-item-question">${escapeHtml(poll.config.question || 'No question')}</div>
          <div class="library-item-options">
            ${optionsBadges}
          </div>
          <div class="library-item-actions">
            <button class="library-btn library-btn-load" data-id="${poll.id}">Apply Now</button>
            <button class="library-btn library-btn-queue" data-id="${poll.id}">＋ Queue</button>
            <button class="library-btn library-btn-delete" data-id="${poll.id}">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // ──────────────────────────────────────────────
  // Queue Rendering
  // ──────────────────────────────────────────────
  function renderQueue() {
    if (!el.queueList) return;
    if (queue.length === 0) {
      el.queueList.innerHTML = `
        <div class="no-poll-card glass-card" style="padding: 20px; text-align: center;">
          <p style="color: var(--text-muted); margin: 0;">Queue is empty.</p>
        </div>
      `;
      return;
    }

    el.queueList.innerHTML = queue.map((id, index) => {
      const poll = savedPolls.find(p => p.id === id);
      const name = poll ? (poll.name || 'Saved Poll') : 'Unknown Poll';
      const question = poll ? (poll.config.question || '') : '';

      let badgeHtml = '';
      if (index === queueIndex) {
        badgeHtml = `<span class="queue-active-badge">Active</span>`;
      } else {
        badgeHtml = `<span class="queue-index-badge">${index + 1}</span>`;
      }

      return `
        <div class="queue-item glass-card ${index === queueIndex ? 'active-queue-item' : ''}" data-id="${id}" data-index="${index}">
          <div class="queue-item-header">
            <div style="display: flex; align-items: center; gap: 8px;">
              ${badgeHtml}
              <span class="queue-item-title">${escapeHtml(name)}</span>
            </div>
          </div>
          <div class="queue-item-question">${escapeHtml(question)}</div>
          <div class="queue-item-actions">
            <button class="queue-btn queue-btn-up" data-index="${index}">▲</button>
            <button class="queue-btn queue-btn-down" data-index="${index}">▼</button>
            <button class="queue-btn queue-btn-remove" data-index="${index}">Remove</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ──────────────────────────────────────────────
  // Event Binding
  // ──────────────────────────────────────────────
  function init() {
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('[StreamPoll] SW registration failed:', err);
      });
    }

    // Keypad events (use event delegation)
    el.keypad.addEventListener('click', (e) => {
      const btn = e.target.closest('.key');
      if (!btn || btn.disabled) return;
      handleKeyPress(btn.dataset.key);
    });

    // Also support physical keyboard for PIN
    document.addEventListener('keydown', (e) => {
      if (appState !== 'disconnected' && appState !== 'authenticating') return;
      if (!el.screenPin.classList.contains('active')) return;

      if (e.key >= '0' && e.key <= '9') {
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        handleKeyPress('delete');
      }
    });

    // Control buttons (event delegation)
    el.controlsBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.ctrl-btn');
      if (!btn || btn.disabled) return;
      sendCommand(btn.dataset.action);
    });

    // Disconnect button
    el.btnDisconnect.addEventListener('click', () => {
      vibrate(25);
      disconnect();
    });

    // Retry button on reconnect overlay
    el.btnRetry.addEventListener('click', () => {
      vibrate();
      clearTimeout(reconnectTimer);
      reconnectAttempts = 0;
      connect();
    });
    // Editor events
    el.btnEditPoll.addEventListener('click', () => openEditor('active'));
    el.btnEditorClose.addEventListener('click', () => closeEditor());
    el.btnEditorCancel.addEventListener('click', () => closeEditor());
    el.btnEditorApply.addEventListener('click', saveEditorApply);
    el.btnEditorSaveLib.addEventListener('click', saveEditorToLib);
    el.btnEditorSaveQueue.addEventListener('click', saveEditorAndQueue);
    el.btnEditorAddOption.addEventListener('click', () => addEditorOption());

    // Create Poll button on Library Panel
    if (el.btnCreatePollLib) {
      el.btnCreatePollLib.addEventListener('click', () => openEditor('new'));
    }

    // Tab switching
    if (el.dashTabs) {
      el.dashTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.dash-tab');
        if (!tab) return;
        vibrate();
        const tabName = tab.dataset.tab;

        // Toggle tabs active state
        $$('.dash-tab').forEach(t => t.classList.toggle('active', t === tab));

        // Toggle panels active state
        el.panelPoll.classList.toggle('active', tabName === 'poll');
        el.panelLibrary.classList.toggle('active', tabName === 'library');
        el.panelQueue.classList.toggle('active', tabName === 'queue');
        
        // Show/hide based on active state (fallback/styling)
        el.panelPoll.style.display = tabName === 'poll' ? '' : 'none';
        el.panelLibrary.style.display = tabName === 'library' ? '' : 'none';
        el.panelQueue.style.display = tabName === 'queue' ? '' : 'none';
      });
    }

    // Library item interactions (Apply, Add to Queue, Delete, Edit)
    if (el.libraryList) {
      el.libraryList.addEventListener('click', (e) => {
        const id = e.target.closest('[data-id]')?.dataset.id;
        if (!id) return;

        if (e.target.closest('.library-btn-load')) {
          vibrate();
          wsSend({ type: 'command', action: 'load_poll', data: id });
        } else if (e.target.closest('.library-btn-queue')) {
          vibrate();
          const btn = e.target.closest('.library-btn-queue');
          const card = e.target.closest('.library-item');

          if (btn && card) {
            card.classList.remove('queued-flash');
            void card.offsetWidth; // trigger reflow
            card.classList.add('queued-flash');

            const originalHTML = btn.innerHTML;
            btn.innerHTML = '✓ Queued';
            btn.classList.add('btn-queued-success');

            setTimeout(() => {
              btn.innerHTML = originalHTML;
              btn.classList.remove('btn-queued-success');
              card.classList.remove('queued-flash');
            }, 3000);
          }

          const newQueue = [...queue, id];
          wsSend({ type: 'command', action: 'set_queue', data: newQueue });
        } else if (e.target.closest('.library-btn-delete')) {
          if (confirm('Are you sure you want to delete this poll from library?')) {
            vibrate();
            wsSend({ type: 'command', action: 'delete_poll', data: id });
          }
        } else if (e.target.closest('.btn-edit-lib-item')) {
          openEditor('library', id);
        }
      });
    }

    // Queue item interactions (Up, Down, Remove)
    if (el.queueList) {
      el.queueList.addEventListener('click', (e) => {
        const index = parseInt(e.target.closest('[data-index]')?.dataset.index, 10);
        if (isNaN(index)) return;

        if (e.target.closest('.queue-btn-up')) {
          if (index <= 0) return;
          vibrate();
          const newQueue = [...queue];
          const temp = newQueue[index];
          newQueue[index] = newQueue[index - 1];
          newQueue[index - 1] = temp;
          wsSend({ type: 'command', action: 'set_queue', data: newQueue });
        } else if (e.target.closest('.queue-btn-down')) {
          if (index >= queue.length - 1) return;
          vibrate();
          const newQueue = [...queue];
          const temp = newQueue[index];
          newQueue[index] = newQueue[index + 1];
          newQueue[index + 1] = temp;
          wsSend({ type: 'command', action: 'set_queue', data: newQueue });
        } else if (e.target.closest('.queue-btn-remove')) {
          vibrate();
          const newQueue = queue.filter((_, i) => i !== index);
          wsSend({ type: 'command', action: 'set_queue', data: newQueue });
        }
      });
    }
    // Delete option (event delegation)
    el.editorOptionsList.addEventListener('click', (e) => {
      const btn = e.target.closest('.editor-option-delete');
      if (btn) {
        const idx = parseInt(btn.dataset.index, 10);
        removeEditorOption(idx);
      }
    });

    // Prevent pull-to-refresh / bounce scroll on iOS
    document.addEventListener('touchmove', (e) => {
      if (e.target.closest('.dashboard-content')) return;
      // Prevent on everything else
    }, { passive: true });

    // Initial connection
    showScreen('pin');
    connect();
  }

  // ──────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
