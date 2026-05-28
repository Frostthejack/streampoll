// app.js — Main app controller
// Uses window.__TAURI__ globals (withGlobalTauri: true in tauri.conf.json)

// Wait for Tauri to inject its globals, then boot
function waitForTauri(cb, tries) {
  tries = tries || 0;
  if (window.__TAURI__ && window.__TAURI__.core) {
    cb();
  } else if (tries < 50) {
    setTimeout(function() { waitForTauri(cb, tries + 1); }, 50);
  } else {
    console.error('Tauri global not available after 2.5s');
  }
}

// Tauri API refs (set after __TAURI__ is available)
var invoke, listen, getCurrentWindow, appWindow;

waitForTauri(function() {
  invoke = window.__TAURI__.core.invoke;
  listen = window.__TAURI__.event.listen;
  getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  appWindow = getCurrentWindow();
  // Boot the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
  } else {
    bootApp();
  }
});

// ── State ──────────────────────────────────────────────────────
let currentView = 'poll';
let isClickThrough = false;

// ── Init ───────────────────────────────────────────────────────
async function bootApp() {
  setupWindowControls();
  setupViewToggle();
  setupToast();
  initAuth();
  await initSettings();
  initPoll();
  await loadInitialState();
  setupGlobalListeners();
  setupKeyboardShortcuts();
}

// ── Window Controls ────────────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-close').addEventListener('click', () => appWindow.close());
  document.getElementById('btn-minimize').addEventListener('click', () => appWindow.minimize());
}

// ── View Toggle ────────────────────────────────────────────────
function setupViewToggle() {
  document.getElementById('btn-toggle-view').addEventListener('click', toggleView);
}

function toggleView() {
  if (currentView === 'poll') {
    showSettings();
  } else {
    showPoll();
  }
}

function showPoll() {
  currentView = 'poll';
  document.getElementById('view-poll').classList.remove('hidden');
  document.getElementById('view-settings').classList.add('hidden');
  document.getElementById('btn-toggle-view').title = 'Open Settings (Ctrl+,)';
  document.getElementById('btn-toggle-view').textContent = '⚙️';
}

function showSettings() {
  currentView = 'settings';
  document.getElementById('view-settings').classList.remove('hidden');
  document.getElementById('view-poll').classList.add('hidden');
  document.getElementById('btn-toggle-view').title = 'Back to Poll (Ctrl+,)';
  document.getElementById('btn-toggle-view').textContent = '📊';
}

// ── Load initial state from Rust ───────────────────────────────
async function loadInitialState() {
  try {
    const settings = await invoke('get_settings');
    applySettingsToUI(settings);
    window._settings = settings;

    const config = await invoke('get_poll_config');
    window._pollConfig = config;
    renderPollConfigUI(config);

    const authStatus = await invoke('get_auth_status');
    updateAuthUI(authStatus.authenticated);

    const pollUpdate = await invoke('get_poll_update');
    renderPollUpdate(pollUpdate);
  } catch (e) {
    console.error('Failed to load initial state:', e);
  }
}

// ── Global Tauri Event Listeners ───────────────────────────────
function setupGlobalListeners() {
  listen('settings_updated', (event) => {
    applySettingsToUI(event.payload);
  });

  listen('auth_status', (event) => {
    updateAuthUI(event.payload.authenticated);
    if (event.payload.error) {
      showToast('Auth error: ' + event.payload.error, 'error');
    }
  });

  listen('toggle_click_through', async () => {
    isClickThrough = !isClickThrough;
    try {
      await invoke('set_click_through', { enabled: isClickThrough });
      updateClickThroughUI(isClickThrough);
    } catch (e) { console.error(e); }
  });

  listen('click_through_changed', (event) => {
    isClickThrough = event.payload;
    updateClickThroughUI(isClickThrough);
  });

  listen('poll_update', (event) => {
    renderPollUpdate(event.payload);
  });

  listen('chat_message', (event) => {
    appendChatLog(event.payload);
  });

  listen('ws_status', (event) => {
    const status = event.payload;
    const indicator = document.getElementById('conn-status-indicator');
    const label = document.getElementById('conn-status-label');
    if (!indicator || !label) return;
    indicator.className = 'conn-dot';
    if (status === 'connected') {
      indicator.classList.add('connected');
      label.textContent = 'Connected to Restream';
    } else if (status === 'connecting' || status === 'reconnecting') {
      indicator.classList.add('connecting');
      label.textContent = status === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';
    } else {
      indicator.classList.add('disconnected');
      label.textContent = 'Not connected';
    }
  });
}

// ── Apply settings to UI ───────────────────────────────────────
function applySettingsToUI(settings) {
  if (!settings) return;
  window._settings = settings;

  const pollContainer = document.getElementById('poll-container');
  if (pollContainer) {
    pollContainer.className = `theme-${settings.theme}`;
  }

  if (settings.theme === 'custom' && settings.custom_colors) {
    const root = document.documentElement;
    const cc = settings.custom_colors;
    root.style.setProperty('--custom-bar-fill', cc.bar_fill);
    root.style.setProperty('--custom-bar-bg', cc.bar_bg);
    root.style.setProperty('--custom-text', cc.text_color);
    root.style.setProperty('--custom-bg', cc.background);
    root.style.setProperty('--custom-accent', cc.accent);
  }

  if (settings.custom_font) {
    document.documentElement.style.setProperty('--font-main', `'${settings.custom_font}', -apple-system, sans-serif`);
  }

  if (settings.font_size) {
    document.getElementById('poll-container')?.style.setProperty('font-size', settings.font_size + 'px');
  }

  if (settings.overlay_opacity !== undefined) {
    document.body.style.opacity = settings.overlay_opacity;
  }

  const question = document.getElementById('poll-question');
  if (question) question.style.display = settings.show_question === false ? 'none' : '';

  window._showPercentages = settings.show_percentages !== false;
  window._showVoteCounts = settings.show_vote_counts !== false;

  syncSettingsUI(settings);
}

function syncSettingsUI(settings) {
  safeSet('toggle-always-on-top', 'checked', settings.always_on_top !== false);
  safeSet('toggle-click-through', 'checked', settings.click_through === true);
  safeSet('font-family-select', 'value', settings.custom_font || 'Inter');
  safeSet('font-size-slider', 'value', settings.font_size || 16);
  safeSet('font-size-value', 'textContent', settings.font_size || 16);
  safeSet('opacity-slider', 'value', Math.round((settings.overlay_opacity || 0.9) * 100));
  safeSet('opacity-value', 'textContent', Math.round((settings.overlay_opacity || 0.9) * 100));
  safeSet('toggle-show-percentages', 'checked', settings.show_percentages !== false);
  safeSet('toggle-show-counts', 'checked', settings.show_vote_counts !== false);
  safeSet('toggle-show-question', 'checked', settings.show_question !== false);
  safeSet('keybind-display', 'value', settings.click_through_keybind || 'CommandOrControl+Shift+T');
  safeSet('input-client-id', 'value', settings.client_id || '');

  if (settings.theme) {
    document.querySelectorAll('.theme-card').forEach(card => {
      card.classList.toggle('active', card.dataset.theme === settings.theme);
    });
    const customSection = document.getElementById('custom-colors-section');
    if (customSection) customSection.classList.toggle('hidden', settings.theme !== 'custom');
  }

  if (settings.custom_colors) {
    const cc = settings.custom_colors;
    safeSet('color-bar-fill', 'value', cc.bar_fill);
    safeSet('color-text', 'value', cc.text_color);
    safeSet('color-accent', 'value', cc.accent);
  }
}

function safeSet(id, prop, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined) el[prop] = value;
}

// ── Auth UI ────────────────────────────────────────────────────
function updateAuthUI(authenticated) {
  const indicator = document.getElementById('conn-status-indicator');
  const label = document.getElementById('conn-status-label');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');

  if (indicator) indicator.className = 'conn-dot ' + (authenticated ? 'connected' : 'disconnected');
  if (label) label.textContent = authenticated ? 'Connected to Restream' : 'Not connected';
  if (btnLogin) btnLogin.classList.toggle('hidden', authenticated);
  if (btnLogout) btnLogout.classList.toggle('hidden', !authenticated);
}

// ── Click-through UI ───────────────────────────────────────────
function updateClickThroughUI(enabled) {
  const badge = document.getElementById('click-through-indicator');
  if (badge) badge.classList.toggle('hidden', !enabled);
  const toggle = document.getElementById('toggle-click-through');
  if (toggle) toggle.checked = enabled;
  showToast(enabled ? 'Click-through ON' : 'Click-through OFF');
}

// ── Keyboard Shortcuts ─────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      toggleView();
    }
  });
}

// ── Toast ──────────────────────────────────────────────────────
function setupToast() {
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.appendChild(toast);
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = type === 'error' ? 'rgba(248,113,113,0.4)' : 'var(--border)';
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ── Poll rendering (inline, no module deps) ────────────────────
let previousVotes = {};

function initPoll() {
  setupQuickControls();
}

function setupQuickControls() {
  document.getElementById('qc-start')?.addEventListener('click', () => startPoll());
  document.getElementById('qc-pause')?.addEventListener('click', () => pausePoll());
  document.getElementById('qc-resume')?.addEventListener('click', () => resumePoll());
  document.getElementById('qc-stop')?.addEventListener('click', () => stopPoll());
}

async function startPoll() {
  try { await invoke('start_poll'); }
  catch (e) { showToast('Error: ' + e, 'error'); }
}
async function pausePoll() {
  try { await invoke('pause_poll'); }
  catch (e) { showToast('Error: ' + e, 'error'); }
}
async function resumePoll() {
  try { await invoke('resume_poll'); }
  catch (e) { showToast('Error: ' + e, 'error'); }
}
async function stopPoll() {
  try { await invoke('stop_poll'); }
  catch (e) { showToast('Error: ' + e, 'error'); }
}
async function resetPoll() {
  try { await invoke('reset_poll'); }
  catch (e) { showToast('Error: ' + e, 'error'); }
}

function renderPollUpdate(update) {
  if (!update) return;

  updateStatusBar(update.status, update.total_votes);

  const qEl = document.getElementById('poll-question');
  if (qEl) qEl.textContent = update.question || 'Configure your poll in settings';

  const container = document.getElementById('poll-options');
  if (!container) return;

  syncOptionElements(container, update.options);

  update.options.forEach((option) => {
    const optEl = document.getElementById(`poll-opt-${option.id}`);
    if (!optEl) return;

    const barFill = optEl.querySelector('.poll-bar-fill');
    if (barFill) {
      const pct = Math.max(option.percentage, option.votes > 0 ? 1 : 0);
      barFill.style.width = pct + '%';
      barFill.style.setProperty('--option-color', option.color);
    }

    const countEl = optEl.querySelector('.poll-opt-count');
    if (countEl) {
      const prev = previousVotes[option.id] || 0;
      if (option.votes !== prev) {
        countEl.textContent = option.votes;
        countEl.classList.remove('count-pop');
        void countEl.offsetWidth;
        countEl.classList.add('count-pop');
      }
      optEl.querySelector('.poll-opt-stats').style.display =
        (window._showVoteCounts !== false || window._showPercentages !== false) ? '' : 'none';
    }

    const pctEl = optEl.querySelector('.poll-opt-pct');
    if (pctEl) pctEl.textContent = option.percentage.toFixed(1) + '%';

    previousVotes[option.id] = option.votes;
  });

  updateQuickControls(update.status);
}

function syncOptionElements(container, options) {
  const needed = new Set(options.map(o => `poll-opt-${o.id}`));
  [...container.querySelectorAll('.poll-option')].forEach(el => {
    if (!needed.has(el.id)) el.remove();
  });

  options.forEach((option, idx) => {
    const id = `poll-opt-${option.id}`;
    if (!document.getElementById(id)) {
      container.appendChild(createOptionElement(option, idx));
    }
    const optEl = document.getElementById(id);
    if (optEl) {
      const labelEl = optEl.querySelector('.poll-option-label');
      if (labelEl) labelEl.textContent = option.label;
      const barFill = optEl.querySelector('.poll-bar-fill');
      if (barFill) barFill.style.setProperty('--option-color', option.color);
    }
  });
}

function createOptionElement(option, idx) {
  const div = document.createElement('div');
  div.className = 'poll-option';
  div.id = `poll-opt-${option.id}`;
  div.style.animationDelay = (idx * 0.05) + 's';
  div.innerHTML = `
    <div class="poll-option-header">
      <span class="poll-option-label">${escapeHtml(option.label)}</span>
      <div class="poll-opt-stats poll-option-stats">
        <span><span class="poll-opt-count">${option.votes}</span> votes</span>
        <span class="poll-opt-pct">${option.percentage.toFixed(1)}%</span>
      </div>
    </div>
    <div class="poll-bar-track">
      <div class="poll-bar-fill" style="width:${option.percentage}%;--option-color:${option.color}"></div>
    </div>`;
  return div;
}

function updateStatusBar(status, totalVotes) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const totalEl = document.getElementById('total-votes-display');
  if (dot) dot.className = `status-dot ${status}`;
  const labels = { idle: 'Idle', running: '● Live', paused: '⏸ Paused' };
  if (label) label.textContent = labels[status] || status;
  if (totalEl) totalEl.textContent = totalVotes > 0 ? `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` : '';
}

function updateQuickControls(status) {
  const ids = { start: ['qc-start','ctrl-start'], pause: ['qc-pause','ctrl-pause'],
                 resume: ['qc-resume','ctrl-resume'], stop: ['qc-stop','ctrl-stop'] };
  const show = (keys) => keys.forEach(k => {
    const els = ids[k];
    els.forEach(id => document.getElementById(id)?.classList.remove('hidden'));
  });
  const hide = (keys) => keys.forEach(k => {
    const els = ids[k];
    els.forEach(id => document.getElementById(id)?.classList.add('hidden'));
  });

  if (status === 'idle')    { show(['start']); hide(['pause','resume','stop']); }
  if (status === 'running') { show(['pause','stop']); hide(['start','resume']); }
  if (status === 'paused')  { show(['resume','stop']); hide(['start','pause']); }
}

// ── Auth (inline) ──────────────────────────────────────────────
function initAuth() {
  document.getElementById('btn-login')?.addEventListener('click', async () => {
    const clientId = document.getElementById('input-client-id')?.value?.trim();
    const clientSecret = document.getElementById('input-client-secret')?.value?.trim();
    if (!clientId || !clientSecret) {
      showToast('Enter Client ID and Secret first', 'error'); return;
    }
    try {
      const settings = await invoke('get_settings');
      settings.client_id = clientId;
      settings.client_secret = clientSecret;
      await invoke('save_settings', { newSettings: settings });
    } catch(e) { console.error(e); }

    const btn = document.getElementById('btn-login');
    btn.textContent = '⏳ Opening browser...';
    btn.disabled = true;
    try {
      await invoke('login');
      showToast('Connected to Restream!');
    } catch(e) {
      showToast('Login failed: ' + e, 'error');
      btn.textContent = '🔐 Connect to Restream';
      btn.disabled = false;
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try { await invoke('logout'); showToast('Disconnected'); }
    catch(e) { showToast('Error: ' + e, 'error'); }
  });
}

// ── Settings (inline) ──────────────────────────────────────────
let optionCounter = 100;
const OPTION_COLORS = ['#6c63ff','#ff6584','#43e97b','#4facfe','#f9c74f','#f8961e','#f72585','#4cc9f0'];

async function initSettings() {
  setupTabs();
  setupPollSetupTab();
  setupAppearanceTab();
  setupWindowTab();
  setupControlsTab();
  setupChatLog();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
      btn.classList.add('active');
      const panel = document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`);
      if (panel) { panel.classList.add('active'); panel.classList.remove('hidden'); }
    });
  });
}

function renderPollConfigUI(config) {
  const questionInput = document.getElementById('poll-question-input');
  if (questionInput) questionInput.value = config.question || '';
  safeSet('toggle-case-insensitive', 'checked', config.case_insensitive !== false);
  safeSet('toggle-one-vote', 'checked', config.one_vote_per_user !== false);
  const list = document.getElementById('options-list');
  if (list) list.innerHTML = '';
  (config.options || []).forEach(opt => addOptionRow(opt.label, opt.keywords, opt.color, opt.id));
  if (!config.options || config.options.length === 0) {
    addOptionRow('Option A', ['a','1'], '#6c63ff');
    addOptionRow('Option B', ['b','2'], '#ff6584');
  }
}

function setupPollSetupTab() {
  document.getElementById('add-option-btn')?.addEventListener('click', () => addOptionRow());
  document.getElementById('save-poll-config-btn')?.addEventListener('click', savePollConfig);
}

function addOptionRow(label='', keywords=[], color=null, existingId=null) {
  const id = existingId || `opt_${++optionCounter}`;
  const optColor = color || OPTION_COLORS[document.querySelectorAll('.option-row').length % OPTION_COLORS.length];
  const row = document.createElement('div');
  row.className = 'option-row';
  row.dataset.optionId = id;
  row.innerHTML = `
    <div class="option-color-swatch" style="background:${optColor}">
      <input type="color" class="opt-color" value="${optColor}" title="Option color"/>
    </div>
    <div class="option-inputs">
      <input type="text" class="option-label-input settings-input" placeholder="Option label" value="${escapeAttr(label)}"/>
      <input type="text" class="option-keywords-input" placeholder="Keywords (comma-separated, e.g. a, 1, yes)" value="${escapeAttr(keywords.join(', '))}"/>
    </div>
    <button class="option-remove-btn" title="Remove">✕</button>`;
  const colorInput = row.querySelector('.opt-color');
  const swatch = row.querySelector('.option-color-swatch');
  colorInput.addEventListener('input', () => swatch.style.background = colorInput.value);
  row.querySelector('.option-remove-btn').addEventListener('click', () => row.remove());
  document.getElementById('options-list')?.appendChild(row);
}

async function savePollConfig() {
  const question = document.getElementById('poll-question-input')?.value?.trim() || 'Poll';
  const caseInsensitive = document.getElementById('toggle-case-insensitive')?.checked ?? true;
  const oneVote = document.getElementById('toggle-one-vote')?.checked ?? true;
  const options = [];
  document.querySelectorAll('.option-row').forEach(row => {
    const id = row.dataset.optionId;
    const label = row.querySelector('.option-label-input')?.value?.trim() || 'Option';
    const kw = row.querySelector('.option-keywords-input')?.value || '';
    const keywords = kw.split(',').map(k=>k.trim()).filter(k=>k.length>0);
    const color = row.querySelector('.opt-color')?.value || '#6c63ff';
    options.push({ id, label, keywords, color, votes: 0 });
  });
  if (!options.length) { showToast('Add at least one option','error'); return; }
  try {
    await invoke('set_poll_config', { config: { question, options, case_insensitive: caseInsensitive, one_vote_per_user: oneVote } });
    showToast('Poll config saved!');
  } catch(e) { showToast('Failed: '+e,'error'); }
}

function setupAppearanceTab() {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('active'));
      card.classList.add('active');
      const theme = card.dataset.theme;
      document.getElementById('custom-colors-section')?.classList.toggle('hidden', theme !== 'custom');
      document.getElementById('poll-container').className = `theme-${theme}`;
    });
  });

  const fontSlider = document.getElementById('font-size-slider');
  fontSlider?.addEventListener('input', () => {
    document.getElementById('font-size-value').textContent = fontSlider.value;
    document.getElementById('poll-container').style.fontSize = fontSlider.value + 'px';
  });

  const opacitySlider = document.getElementById('opacity-slider');
  opacitySlider?.addEventListener('input', () => {
    document.getElementById('opacity-value').textContent = opacitySlider.value;
    document.body.style.opacity = opacitySlider.value / 100;
  });

  document.getElementById('font-family-select')?.addEventListener('change', (e) => {
    document.documentElement.style.setProperty('--font-main', `'${e.target.value}', sans-serif`);
    document.getElementById('poll-container').style.fontFamily = `'${e.target.value}', sans-serif`;
  });

  ['color-bar-fill','color-bar-bg','color-text','color-bg','color-accent'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      document.documentElement.style.setProperty('--custom-bar-fill', document.getElementById('color-bar-fill')?.value||'#6c63ff');
      document.documentElement.style.setProperty('--custom-bar-bg', document.getElementById('color-bar-bg')?.value||'#1a1a2e');
      document.documentElement.style.setProperty('--custom-text', document.getElementById('color-text')?.value||'#ffffff');
      document.documentElement.style.setProperty('--custom-bg', document.getElementById('color-bg')?.value||'#0f0f1e');
      document.documentElement.style.setProperty('--custom-accent', document.getElementById('color-accent')?.value||'#a78bfa');
    });
  });

  document.getElementById('save-appearance-btn')?.addEventListener('click', saveAppearance);
}

async function saveAppearance() {
  const theme = document.querySelector('.theme-card.active')?.dataset.theme || 'glassmorphism';
  try {
    const settings = await invoke('get_settings');
    settings.theme = theme;
    settings.custom_colors = {
      bar_fill: document.getElementById('color-bar-fill')?.value || '#6c63ff',
      bar_bg: document.getElementById('color-bar-bg')?.value || '#1a1a2e',
      text_color: document.getElementById('color-text')?.value || '#ffffff',
      background: document.getElementById('color-bg')?.value || '#0f0f1e',
      accent: document.getElementById('color-accent')?.value || '#a78bfa',
    };
    settings.custom_font = document.getElementById('font-family-select')?.value || 'Inter';
    settings.font_size = parseInt(document.getElementById('font-size-slider')?.value || '16');
    settings.overlay_opacity = parseInt(document.getElementById('opacity-slider')?.value || '90') / 100;
    settings.show_percentages = document.getElementById('toggle-show-percentages')?.checked !== false;
    settings.show_vote_counts = document.getElementById('toggle-show-counts')?.checked !== false;
    settings.show_question = document.getElementById('toggle-show-question')?.checked !== false;
    await invoke('save_settings', { newSettings: settings });
    showToast('Appearance saved!');
  } catch(e) { showToast('Failed: '+e,'error'); }
}

function setupWindowTab() {
  document.getElementById('toggle-always-on-top')?.addEventListener('change', async (e) => {
    try { await invoke('set_always_on_top', { enabled: e.target.checked }); showToast(`Always on top: ${e.target.checked?'ON':'OFF'}`); }
    catch(e) { showToast('Error: '+e,'error'); }
  });

  document.getElementById('toggle-click-through')?.addEventListener('change', async (e) => {
    try { await invoke('set_click_through', { enabled: e.target.checked }); }
    catch(e) { showToast('Error: '+e,'error'); }
  });

  let recording = false;
  const keybindInput = document.getElementById('keybind-display');
  const recordBtn = document.getElementById('keybind-record-btn');

  recordBtn?.addEventListener('click', () => {
    recording = !recording;
    keybindInput.classList.toggle('recording', recording);
    recordBtn.textContent = recording ? 'Stop' : 'Record';
    if (recording) keybindInput.value = 'Press keys...';
  });

  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    if (!['Control','Shift','Alt','Meta','Command'].includes(e.key)) {
      parts.push(e.key.toUpperCase());
      keybindInput.value = parts.join('+');
      recording = false;
      keybindInput.classList.remove('recording');
      recordBtn.textContent = 'Record';
    }
  }, true);

  document.getElementById('keybind-save-btn')?.addEventListener('click', async () => {
    const shortcut = keybindInput.value;
    if (!shortcut || shortcut === 'Press keys...') { showToast('Record a shortcut first','error'); return; }
    try {
      await invoke('register_keybind', { shortcut });
      const settings = await invoke('get_settings');
      settings.click_through_keybind = shortcut;
      await invoke('save_settings', { newSettings: settings });
      showToast(`Keybind: ${shortcut}`);
    } catch(e) { showToast('Failed: '+e,'error'); }
  });
}

function setupControlsTab() {
  document.getElementById('ctrl-start')?.addEventListener('click', () => startPoll());
  document.getElementById('ctrl-pause')?.addEventListener('click', () => pausePoll());
  document.getElementById('ctrl-resume')?.addEventListener('click', () => resumePoll());
  document.getElementById('ctrl-stop')?.addEventListener('click', () => stopPoll());
  document.getElementById('ctrl-reset')?.addEventListener('click', () => resetPoll());
}

function setupChatLog() {
  document.getElementById('clear-log-btn')?.addEventListener('click', () => {
    const log = document.getElementById('chat-log');
    if (log) log.innerHTML = '<p class="log-placeholder">Log cleared.</p>';
  });
}

function appendChatLog(msg) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const placeholder = log.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();
  const entry = document.createElement('div');
  entry.className = `log-entry${msg.matched ? ' matched' : ''}`;
  entry.innerHTML = `<span class="log-author">${escapeHtml(msg.author||'')}</span>: <span class="log-text">${escapeHtml(msg.text||'')}</span>${msg.matched?`<span class="log-match-badge">✓ ${escapeHtml(msg.matched)}</span>`:''}`;
  log.appendChild(entry);
  while (log.children.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ── Utils ──────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(str) {
  return String(str||'').replace(/"/g,'&quot;');
}

// Expose globally for debugging
window._app = { showToast, toggleView, showPoll, showSettings };
