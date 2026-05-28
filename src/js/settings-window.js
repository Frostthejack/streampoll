// settings-window.js — Controls for the settings window (primary window)
import { initLibrary, saveCurrentPollToLibrary, refreshLibrary } from './library.js';
import { initHistory } from './history.js';

function waitForTauri(cb, tries) {
  tries = tries || 0;
  if (window.__TAURI__ && window.__TAURI__.core) { cb(); }
  else if (tries < 50) { setTimeout(function() { waitForTauri(cb, tries + 1); }, 50); }
  else { console.error('Tauri not available'); }
}

var invoke, listen, WebviewWindow, getCurrentWindow;

waitForTauri(function() {
  invoke = window.__TAURI__.core.invoke;
  listen = window.__TAURI__.event.listen;
  WebviewWindow = window.__TAURI__.webviewWindow.WebviewWindow;
  getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSettings);
  } else {
    bootSettings();
  }
});

// ── State ──────────────────────────────────────────────────────
let overlayOpen = false;
let optionCounter = 100;
const OPTION_COLORS = ['#6c63ff','#ff6584','#43e97b','#4facfe','#f9c74f','#f8961e','#f72585','#4cc9f0'];

// ── Boot ───────────────────────────────────────────────────────
async function bootSettings() {
  setupTabs();
  setupPollSetupTab();
  setupAppearanceTab();
  setupWindowTab();
  setupControlsTab();
  setupChatLog();
  setupAuth();
  setupOverlayToggle();
  await loadInitialState();
  setupGlobalListeners();
  await initLibrary();
  await initHistory();

  // When library loads a poll into the editor
  window.addEventListener('library:load-poll', (e) => {
    const poll = e.detail;
    if (poll?.config) populatePollEditor(poll.config);
  });

  // When next_poll_in_queue loads a new config, refresh the poll editor
  window.addEventListener('library:poll-loaded', async () => {
    try {
      const config = await invoke('get_poll_config');
      populatePollEditor(config);
      await refreshLibrary();
    } catch(e) { console.error(e); }
  });
}

// ── Overlay window management ──────────────────────────────────
function setupOverlayToggle() {
  document.getElementById('btn-toggle-overlay')?.addEventListener('click', toggleOverlay);
}

async function toggleOverlay() {
  if (overlayOpen) {
    await closeOverlay();
  } else {
    await openOverlay();
  }
}

async function openOverlay() {
  try {
    // Try to get existing window first
    const existing = await WebviewWindow.getByLabel('poll-overlay');
    if (existing) {
      await existing.show();
      await existing.setFocus();
      overlayOpen = true;
      updateOverlayBtn(true);
      return;
    }
  } catch(e) { /* window doesn't exist yet */ }

  try {
    const overlay = new WebviewWindow('poll-overlay', {
      url: 'poll.html',
      title: 'Stream Poll Overlay',
      width: 420,
      height: 480,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      shadow: false,
      skipTaskbar: true,
      resizable: true,
    });

    overlay.once('tauri://created', () => {
      overlayOpen = true;
      updateOverlayBtn(true);
      showToast('Poll overlay opened');
    });

    overlay.once('tauri://error', (e) => {
      showToast('Failed to open overlay: ' + e, 'error');
      overlayOpen = false;
      updateOverlayBtn(false);
    });

    overlay.once('tauri://destroyed', () => {
      overlayOpen = false;
      updateOverlayBtn(false);
    });

  } catch(e) {
    const msg = e?.message || JSON.stringify(e) || String(e);
    showToast('Error opening overlay: ' + msg, 'error');
  }
}

async function closeOverlay() {
  try {
    const existing = await WebviewWindow.getByLabel('poll-overlay');
    if (existing) {
      await existing.close();
    }
  } catch(e) { /* already closed */ }
  overlayOpen = false;
  updateOverlayBtn(false);
}

function updateOverlayBtn(open) {
  const btn = document.getElementById('btn-toggle-overlay');
  if (!btn) return;
  if (open) {
    btn.textContent = '✕ Close Overlay';
    btn.classList.add('overlay-open');
  } else {
    btn.textContent = '▶ Show Overlay';
    btn.classList.remove('overlay-open');
  }
}

// ── Load initial state ─────────────────────────────────────────
async function loadInitialState() {
  try {
    const settings = await invoke('get_settings');
    syncSettingsUI(settings);
    window._settings = settings;

    const config = await invoke('get_poll_config');
    window._pollConfig = config;
    renderPollConfigUI(config);

    const authStatus = await invoke('get_auth_status');
    updateAuthUI(authStatus.authenticated);

    const pollUpdate = await invoke('get_poll_update');
    updateStatusBar(pollUpdate?.status, pollUpdate?.total_votes);
    updatePollControls(pollUpdate?.status);
  } catch(e) { console.error('Failed to load initial state:', e); }
}

// ── Global event listeners ─────────────────────────────────────
function setupGlobalListeners() {
  listen('settings_updated', (event) => syncSettingsUI(event.payload));

  listen('auth_status', (event) => {
    updateAuthUI(event.payload.authenticated);
    if (event.payload.error) showToast('Auth: ' + event.payload.error, 'error');
  });

  listen('poll_update', (event) => {
    const u = event.payload;
    updateStatusBar(u.status, u.total_votes);
    updatePollControls(u.status);
  });

  listen('chat_message', (event) => appendChatLog(event.payload));

  listen('ws_status', (event) => {
    updateWsStatus(event.payload);
  });
}

// ── Sync settings UI from saved state ─────────────────────────
function syncSettingsUI(settings) {
  if (!settings) return;
  window._settings = settings;
  safeSet('toggle-always-on-top', 'checked', settings.always_on_top !== false);
  safeSet('toggle-click-through', 'checked', settings.click_through === true);
  if (settings.custom_font) safeSet('font-family-select', 'value', settings.custom_font);
  if (settings.font_size) {
    safeSet('font-size-slider', 'value', settings.font_size);
    safeSet('font-size-value', 'textContent', settings.font_size);
  }
  if (settings.options_font_size) {
    safeSet('options-font-size-slider', 'value', settings.options_font_size);
    safeSet('options-font-size-value', 'textContent', settings.options_font_size);
  }
  if (settings.bar_height) {
    safeSet('bar-height-slider', 'value', settings.bar_height);
    safeSet('bar-height-value', 'textContent', settings.bar_height);
  }
  if (settings.overlay_opacity) {
    safeSet('opacity-slider', 'value', Math.round(settings.overlay_opacity * 100));
    safeSet('opacity-value', 'textContent', Math.round(settings.overlay_opacity * 100));
  }
  
  if (settings.layout_mode) {
    safeSet('layout-mode-select', 'value', settings.layout_mode);
  }
  if (settings.global_overlay) {
    safeSet('global-overlay-select', 'value', settings.global_overlay);
  }
  if (settings.global_overlay_color) {
    safeSet('global-overlay-color', 'value', settings.global_overlay_color);
  }
  if (settings.effect_speed !== undefined) {
    safeSet('effect-speed-slider', 'value', Math.round(settings.effect_speed * 100));
    safeSet('effect-speed-value', 'textContent', settings.effect_speed.toFixed(1));
  }
  if (settings.effect_strength !== undefined) {
    safeSet('effect-strength-slider', 'value', Math.round(settings.effect_strength * 100));
    safeSet('effect-strength-value', 'textContent', Math.round(settings.effect_strength * 100));
  }
  safeSet('toggle-bar-animations', 'checked', settings.bar_animations !== false);
  safeSet('toggle-theme-effects', 'checked', settings.theme_effects !== false);
  safeSet('toggle-show-percentages', 'checked', settings.show_percentages !== false);
  safeSet('toggle-show-counts', 'checked', settings.show_vote_counts !== false);
  safeSet('toggle-show-question', 'checked', settings.show_question !== false);
  safeSet('keybind-display', 'value', settings.click_through_keybind || 'CommandOrControl+Shift+T');
  safeSet('input-client-id', 'value', settings.client_id || '');
  safeSet('input-client-secret', 'value', settings.client_secret || '');

  if (settings.theme) {
    document.querySelectorAll('.theme-card').forEach(card =>
      card.classList.toggle('active', card.dataset.theme === settings.theme));
  }

  if (settings.custom_colors) {
    const cc = settings.custom_colors;
    safeSet('color-bar-fill', 'value', cc.bar_fill);
    safeSet('color-bar-bg', 'value', cc.bar_bg);
    safeSet('color-text', 'value', cc.text_color);
    safeSet('color-bg', 'value', cc.background);
    safeSet('color-accent', 'value', cc.accent);
  }

  window._customBgImage = settings.custom_bg_image || '';
  if (window._customBgImage) {
    const preview = document.getElementById('bg-image-preview');
    if (preview) { preview.src = window._customBgImage; preview.style.display = 'block'; }
  } else {
    const preview = document.getElementById('bg-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('input-bg-image');
    if (fileInput) fileInput.value = '';
  }

  window._customBarBgImage = settings.custom_bar_bg_image || '';
  if (window._customBarBgImage) {
    const preview = document.getElementById('bar-bg-image-preview');
    if (preview) { preview.src = window._customBarBgImage; preview.style.display = 'block'; }
  } else {
    const preview = document.getElementById('bar-bg-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('input-bar-bg-image');
    if (fileInput) fileInput.value = '';
  }

  window._customBarFillImage = settings.custom_bar_fill_image || '';
  if (window._customBarFillImage) {
    const preview = document.getElementById('bar-fill-image-preview');
    if (preview) { preview.src = window._customBarFillImage; preview.style.display = 'block'; }
  } else {
    const preview = document.getElementById('bar-fill-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('input-bar-fill-image');
    if (fileInput) fileInput.value = '';
  }

  window._customBannerImage = settings.custom_banner_image || '';
  if (window._customBannerImage) {
    const preview = document.getElementById('banner-image-preview');
    if (preview) { preview.src = window._customBannerImage; preview.style.display = 'block'; }
  } else {
    const preview = document.getElementById('banner-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('input-banner-image');
    if (fileInput) fileInput.value = '';
  }
}

// ── Auth ───────────────────────────────────────────────────────
function setupAuth() {
  document.getElementById('btn-login')?.addEventListener('click', async () => {
    const clientId = document.getElementById('input-client-id')?.value?.trim();
    const clientSecret = document.getElementById('input-client-secret')?.value?.trim();
    if (!clientId || !clientSecret) { showToast('Enter Client ID and Secret first', 'error'); return; }

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

  document.getElementById('btn-reconnect')?.addEventListener('click', async () => {
    try {
      showToast('Attempting to reconnect...');
      await invoke('force_refresh');
      showToast('Reconnected successfully!');
    } catch(e) {
      showToast('Reconnect failed: ' + e, 'error');
    }
  });

  document.getElementById('btn-toggle-secret')?.addEventListener('click', () => {
    const input = document.getElementById('input-client-secret');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      document.getElementById('btn-toggle-secret').textContent = '🙈';
    } else {
      input.type = 'password';
      document.getElementById('btn-toggle-secret').textContent = '👁';
    }
  });
}

function updateAuthUI(authenticated) {
  ['conn-status-indicator', 'conn-status-indicator-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'conn-dot ' + (authenticated ? 'connected' : 'disconnected');
  });
  ['conn-status-label', 'conn-status-label-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = authenticated ? '● Connected to Restream' : 'Not connected';
  });
  document.getElementById('btn-login')?.classList.toggle('hidden', authenticated);
  document.getElementById('btn-logout')?.classList.toggle('hidden', !authenticated);
}

function updateWsStatus(status) {
  ['conn-status-indicator', 'conn-status-indicator-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'conn-dot';
    if (status === 'connected') el.classList.add('connected');
    else if (status === 'connecting' || status === 'reconnecting') el.classList.add('connecting');
    else el.classList.add('disconnected');
  });
  ['conn-status-label', 'conn-status-label-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (status === 'connected') el.textContent = '● Connected to Restream';
    else if (status === 'reconnecting') el.textContent = 'Reconnecting...';
    else if (status === 'connecting') el.textContent = 'Connecting...';
    else el.textContent = 'Not connected';
  });
}

// ── Tabs ───────────────────────────────────────────────────────
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

// ── Poll Setup Tab ─────────────────────────────────────────────
function setupPollSetupTab() {
  document.getElementById('add-option-btn')?.addEventListener('click', () => addOptionRow());
  document.getElementById('save-poll-config-btn')?.addEventListener('click', savePollConfig);
  document.getElementById('save-poll-library-btn')?.addEventListener('click', async () => {
    // Build config from current editor state then save
    const config = buildCurrentPollConfig();
    if (!config) return;
    await saveCurrentPollToLibrary(config);
    await refreshLibrary();
  });
}

// Alias used by library events
function populatePollEditor(config) { renderPollConfigUI(config); }

function renderPollConfigUI(config) {
  safeSet('poll-question-input', 'value', config.question || '');
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
      <input type="text" class="option-keywords-input" placeholder="Keywords (e.g. a, 1, yes)" value="${escapeAttr(keywords.join(', '))}"/>
    </div>
    <button class="option-remove-btn" title="Remove">✕</button>`;
  const colorInput = row.querySelector('.opt-color');
  const swatch = row.querySelector('.option-color-swatch');
  colorInput.addEventListener('input', () => swatch.style.background = colorInput.value);
  row.querySelector('.option-remove-btn').addEventListener('click', () => row.remove());
  document.getElementById('options-list')?.appendChild(row);
}

function buildCurrentPollConfig() {
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
  if (!options.length) { showToast('Add at least one option','error'); return null; }
  return { question, options, case_insensitive: caseInsensitive, one_vote_per_user: oneVote };
}

async function savePollConfig() {
  const config = buildCurrentPollConfig();
  if (!config) return;
  try {
    await invoke('set_poll_config', { config });
    showToast('Poll config saved!');
  } catch(e) { showToast('Failed: '+e,'error'); }
}

// ── Controls Tab ───────────────────────────────────────────────
function setupControlsTab() {
  document.getElementById('ctrl-start')?.addEventListener('click', () => startPoll());
  document.getElementById('ctrl-pause')?.addEventListener('click', () => pausePoll());
  document.getElementById('ctrl-resume')?.addEventListener('click', () => resumePoll());
  document.getElementById('ctrl-stop')?.addEventListener('click', () => stopPoll());
  document.getElementById('ctrl-reset')?.addEventListener('click', () => resetPoll());
}

async function startPoll() {
  try {
    await invoke('start_poll');
    // Auto-open the overlay when poll starts
    if (!overlayOpen) await openOverlay();
  } catch(e) { showToast('Error: ' + e, 'error'); }
}
async function pausePoll() { try { await invoke('pause_poll'); } catch(e) { showToast('Error: '+e,'error'); } }
async function resumePoll() { try { await invoke('resume_poll'); } catch(e) { showToast('Error: '+e,'error'); } }
async function stopPoll() { try { await invoke('stop_poll'); } catch(e) { showToast('Error: '+e,'error'); } }
async function resetPoll() { try { await invoke('reset_poll'); showToast('Votes reset'); } catch(e) { showToast('Error: '+e,'error'); } }

function updateStatusBar(status, totalVotes) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const totalEl = document.getElementById('total-votes-display');
  if (dot) dot.className = `status-dot ${status || 'idle'}`;
  const labels = { idle: 'Idle', running: '● Live', paused: '⏸ Paused' };
  if (label) label.textContent = labels[status] || 'Idle';
  if (totalEl) totalEl.textContent = totalVotes > 0 ? `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` : '';
}

function updatePollControls(status) {
  const ids = { start:'ctrl-start', pause:'ctrl-pause', resume:'ctrl-resume', stop:'ctrl-stop' };
  Object.values(ids).forEach(id => document.getElementById(id)?.classList.add('hidden'));
  if (status === 'idle')    { document.getElementById('ctrl-start')?.classList.remove('hidden'); }
  if (status === 'running') { ['ctrl-pause','ctrl-stop'].forEach(id => document.getElementById(id)?.classList.remove('hidden')); }
  if (status === 'paused')  { ['ctrl-resume','ctrl-stop'].forEach(id => document.getElementById(id)?.classList.remove('hidden')); }
}

// ── Appearance Tab ─────────────────────────────────────────────
const THEME_DEFAULTS = {
  glassmorphism: { bar_fill: '#6c63ff', bar_bg: '#1a1a2e', text_color: '#f0f0ff', background: '#0a0a1e', accent: '#6c63ff', overlay_color: '#ffffff' },
  neon:          { bar_fill: '#b464ff', bar_bg: '#1a1a2e', text_color: '#e0e0ff', background: '#04041a', accent: '#b464ff', overlay_color: '#ffffff' },
  minimal:       { bar_fill: '#6c63ff', bar_bg: '#000000', text_color: '#1a1a2e', background: '#f8f8fc', accent: '#6c63ff', overlay_color: '#ffffff' },
  retro:         { bar_fill: '#00ff88', bar_bg: '#001100', text_color: '#00ff88', background: '#000011', accent: '#00ff88', overlay_color: '#00ff88' },
  gradient:      { bar_fill: '#6c63ff', bar_bg: '#ffffff', text_color: '#f5f0ff', background: '#1e0a3c', accent: '#c084fc', overlay_color: '#ffffff' },
  custom:        { bar_fill: '#6c63ff', bar_bg: '#ffffff', text_color: '#ffffff', background: '#0a0a1e', accent: '#ffffff', overlay_color: '#ffffff' },
};

function applyThemeSnapshot(themeSnapshot) {
  safeSet('color-bar-fill', 'value', themeSnapshot.custom_colors.bar_fill);
  safeSet('color-bar-bg', 'value', themeSnapshot.custom_colors.bar_bg);
  safeSet('color-text', 'value', themeSnapshot.custom_colors.text_color);
  safeSet('color-bg', 'value', themeSnapshot.custom_colors.background);
  safeSet('color-accent', 'value', themeSnapshot.custom_colors.accent);
  
  safeSet('font-family-select', 'value', themeSnapshot.custom_font);
  safeSet('opacity-slider', 'value', Math.round(themeSnapshot.overlay_opacity * 100));
  safeSet('opacity-value', 'textContent', Math.round(themeSnapshot.overlay_opacity * 100));
  
  safeSet('layout-mode-select', 'value', themeSnapshot.layout_mode);
  safeSet('global-overlay-select', 'value', themeSnapshot.global_overlay);
  safeSet('global-overlay-color', 'value', themeSnapshot.global_overlay_color);
  
  safeSet('effect-speed-slider', 'value', Math.round(themeSnapshot.effect_speed * 100));
  safeSet('effect-speed-value', 'textContent', themeSnapshot.effect_speed.toFixed(1));
  safeSet('effect-strength-slider', 'value', Math.round(themeSnapshot.effect_strength * 100));
  safeSet('effect-strength-value', 'textContent', Math.round(themeSnapshot.effect_strength * 100));
  
  safeSet('toggle-bar-animations', 'checked', themeSnapshot.bar_animations);
  safeSet('toggle-theme-effects', 'checked', themeSnapshot.theme_effects);
  
  window._customBgImage = themeSnapshot.custom_bg_image || '';
  window._customBarBgImage = themeSnapshot.custom_bar_bg_image || '';
  window._customBarFillImage = themeSnapshot.custom_bar_fill_image || '';
  window._customBannerImage = themeSnapshot.custom_banner_image || '';
  const preview = document.getElementById('bg-image-preview');
  if (preview) {
    if (themeSnapshot.custom_bg_image) {
      preview.src = themeSnapshot.custom_bg_image;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  }
  const previewBarBg = document.getElementById('bar-bg-image-preview');
  if (previewBarBg) {
    if (themeSnapshot.custom_bar_bg_image) {
      previewBarBg.src = themeSnapshot.custom_bar_bg_image;
      previewBarBg.style.display = 'block';
    } else {
      previewBarBg.style.display = 'none';
    }
  }
  const previewBarFill = document.getElementById('bar-fill-image-preview');
  if (previewBarFill) {
    if (themeSnapshot.custom_bar_fill_image) {
      previewBarFill.src = themeSnapshot.custom_bar_fill_image;
      previewBarFill.style.display = 'block';
    } else {
      previewBarFill.style.display = 'none';
    }
  }
  const previewBanner = document.getElementById('banner-image-preview');
  if (previewBanner) {
    if (themeSnapshot.custom_banner_image) {
      previewBanner.src = themeSnapshot.custom_banner_image;
      previewBanner.style.display = 'block';
    } else {
      previewBanner.style.display = 'none';
    }
  }
}

function setupAppearanceTab() {
  document.querySelectorAll('.theme-card').forEach(card => {
    // Custom saved cards are dynamically added and have their own listener.
    if (card.classList.contains('custom-saved')) return;

    card.addEventListener('click', async () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const themeName = card.dataset.theme;
      
      const s = await invoke('get_settings');
      let snapshot = null;
      if (s.theme_overrides && s.theme_overrides[themeName]) {
        snapshot = s.theme_overrides[themeName];
      } else {
        const def = THEME_DEFAULTS[themeName];
        if (def) {
          snapshot = {
            custom_colors: { ...def },
            custom_font: 'Inter',
            overlay_opacity: 0.9,
            custom_bg_image: '',
            custom_bar_bg_image: '',
            custom_bar_fill_image: '',
            custom_banner_image: '',
            bar_animations: true,
            theme_effects: true,
            layout_mode: 'standard',
            effect_speed: 1.0,
            effect_strength: 1.0,
            global_overlay: 'none',
            global_overlay_color: def.overlay_color || '#ffffff'
          };
        }
      }
      if (snapshot) {
        applyThemeSnapshot(snapshot);
      }
      saveAppearance();
    });
  });

  document.querySelectorAll('.btn-reset-color').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.target;
      const themeName = document.querySelector('.theme-card.active')?.dataset.theme || 'custom';
      
      let def;
      if (themeName.startsWith('saved_')) {
        const s = await invoke('get_settings');
        const saved = (s.saved_themes || []).find(t => t.id === themeName.replace('saved_', ''));
        if (saved) def = { ...saved.custom_colors, overlay_color: saved.global_overlay_color };
      } else {
        def = THEME_DEFAULTS[themeName];
      }

      if (def && def[target] !== undefined) {
        const idMap = { 'bar_fill': 'color-bar-fill', 'bar_bg': 'color-bar-bg', 'text_color': 'color-text', 'background': 'color-bg', 'accent': 'color-accent', 'overlay_color': 'global-overlay-color' };
        safeSet(idMap[target], 'value', def[target]);
        saveAppearance();
      }
    });
  });

  document.getElementById('btn-reset-theme')?.addEventListener('click', async () => {
    const themeName = document.querySelector('.theme-card.active')?.dataset.theme || 'custom';
    try {
      const s = await invoke('get_settings');
      if (s.theme_overrides && s.theme_overrides[themeName]) {
        delete s.theme_overrides[themeName];
        await invoke('save_settings', { newSettings: s });
        showToast('Theme reset to defaults!');
        // Click the card again to reload defaults
        document.querySelector(`.theme-card[data-theme="${themeName}"]`)?.click();
      } else {
        showToast('Theme is already at defaults.');
      }
    } catch(e) { showToast('Error resetting: '+e, 'error'); }
  });

  const fontSlider = document.getElementById('font-size-slider');
  fontSlider?.addEventListener('input', () => {
    safeSet('font-size-value','textContent', fontSlider.value);
    saveAppearance();
  });

  const optionsFontSlider = document.getElementById('options-font-size-slider');
  optionsFontSlider?.addEventListener('input', () => {
    safeSet('options-font-size-value','textContent', optionsFontSlider.value);
    saveAppearance();
  });

  const barHeightSlider = document.getElementById('bar-height-slider');
  barHeightSlider?.addEventListener('input', () => {
    safeSet('bar-height-value','textContent', barHeightSlider.value);
    saveAppearance();
  });

  const opacitySlider = document.getElementById('opacity-slider');
  opacitySlider?.addEventListener('input', () => safeSet('opacity-value','textContent', opacitySlider.value));
  opacitySlider?.addEventListener('change', saveAppearance);

  const speedSlider = document.getElementById('effect-speed-slider');
  speedSlider?.addEventListener('input', () => safeSet('effect-speed-value','textContent', (speedSlider.value / 100).toFixed(1)));
  speedSlider?.addEventListener('change', saveAppearance);

  const strengthSlider = document.getElementById('effect-strength-slider');
  strengthSlider?.addEventListener('input', () => safeSet('effect-strength-value','textContent', strengthSlider.value));
  strengthSlider?.addEventListener('change', saveAppearance);

  document.getElementById('save-appearance-btn')?.addEventListener('click', saveAppearance);

  // Auto-save appearance on any manual input change
  const appearanceInputs = document.querySelectorAll('.tab-panel[data-panel="appearance"] input, .tab-panel[data-panel="appearance"] select');
  appearanceInputs.forEach(el => el.addEventListener('change', saveAppearance));

  document.querySelectorAll('.option-color-swatch input[type="color"]').forEach(el => {
    el.addEventListener('input', () => el.parentElement.style.background = el.value);
  });

  const fileInput = document.getElementById('input-bg-image');
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        window._customBgImage = ev.target.result;
        const preview = document.getElementById('bg-image-preview');
        if (preview) { preview.src = window._customBgImage; preview.style.display = 'block'; }
        saveAppearance();
      };
      reader.readAsDataURL(file);
    }
  });

  const fileInputBarBg = document.getElementById('input-bar-bg-image');
  fileInputBarBg?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        window._customBarBgImage = ev.target.result;
        const preview = document.getElementById('bar-bg-image-preview');
        if (preview) { preview.src = window._customBarBgImage; preview.style.display = 'block'; }
        saveAppearance();
      };
      reader.readAsDataURL(file);
    }
  });

  const fileInputBarFill = document.getElementById('input-bar-fill-image');
  fileInputBarFill?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        window._customBarFillImage = ev.target.result;
        const preview = document.getElementById('bar-fill-image-preview');
        if (preview) { preview.src = window._customBarFillImage; preview.style.display = 'block'; }
        saveAppearance();
      };
      reader.readAsDataURL(file);
    }
  });

  const fileInputBanner = document.getElementById('input-banner-image');
  fileInputBanner?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        window._customBannerImage = ev.target.result;
        const preview = document.getElementById('banner-image-preview');
        if (preview) { preview.src = window._customBannerImage; preview.style.display = 'block'; }
        saveAppearance();
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('btn-clear-bg-image')?.addEventListener('click', () => {
    window._customBgImage = '';
    const preview = document.getElementById('bg-image-preview');
    if (preview) preview.style.display = 'none';
    if (fileInput) fileInput.value = '';
    saveAppearance();
  });

  document.getElementById('btn-clear-bar-bg-image')?.addEventListener('click', () => {
    window._customBarBgImage = '';
    const preview = document.getElementById('bar-bg-image-preview');
    if (preview) preview.style.display = 'none';
    if (fileInputBarBg) fileInputBarBg.value = '';
    saveAppearance();
  });

  document.getElementById('btn-clear-bar-fill-image')?.addEventListener('click', () => {
    window._customBarFillImage = '';
    const preview = document.getElementById('bar-fill-image-preview');
    if (preview) preview.style.display = 'none';
    if (fileInputBarFill) fileInputBarFill.value = '';
    saveAppearance();
  });

  document.getElementById('btn-clear-banner-image')?.addEventListener('click', () => {
    window._customBannerImage = '';
    const preview = document.getElementById('banner-image-preview');
    if (preview) preview.style.display = 'none';
    if (fileInputBanner) fileInputBanner.value = '';
    saveAppearance();
  });

  // Modal logic for saving a theme
  const saveThemeBtn = document.getElementById('btn-save-custom-theme');
  const saveThemeModal = document.getElementById('save-theme-modal');
  const cancelSaveTheme = document.getElementById('btn-cancel-save-theme');
  const confirmSaveTheme = document.getElementById('btn-confirm-save-theme');
  const themeNameInput = document.getElementById('input-theme-name');

  saveThemeBtn?.addEventListener('click', () => {
    themeNameInput.value = '';
    saveThemeModal.classList.remove('hidden');
    themeNameInput.focus();
  });

  cancelSaveTheme?.addEventListener('click', () => {
    saveThemeModal.classList.add('hidden');
  });

  confirmSaveTheme?.addEventListener('click', async () => {
    const name = themeNameInput.value.trim();
    if (!name) return;
    saveThemeModal.classList.add('hidden');

    try {
      const currentSettings = await invoke('get_settings');
      // Create a snapshot of current appearance settings
      const newTheme = {
        id: Date.now().toString() + Math.floor(Math.random()*1000),
        name: name,
        theme: currentSettings.theme, // The base underlying theme
        custom_colors: { ...currentSettings.custom_colors },
        custom_font: currentSettings.custom_font,
        overlay_opacity: currentSettings.overlay_opacity,
        custom_bg_image: currentSettings.custom_bg_image || '',
        custom_bar_bg_image: currentSettings.custom_bar_bg_image || '',
        custom_bar_fill_image: currentSettings.custom_bar_fill_image || '',
        custom_banner_image: currentSettings.custom_banner_image || '',
        bar_animations: currentSettings.bar_animations,
        theme_effects: currentSettings.theme_effects,
        layout_mode: currentSettings.layout_mode,
        effect_speed: currentSettings.effect_speed,
        effect_strength: currentSettings.effect_strength,
        global_overlay: currentSettings.global_overlay,
        global_overlay_color: currentSettings.global_overlay_color
      };

      if (!currentSettings.saved_themes) currentSettings.saved_themes = [];
      
      if (newTheme.theme.startsWith('saved_')) {
        const parent = currentSettings.saved_themes.find(t => t.id === newTheme.theme.replace('saved_',''));
        newTheme.theme = parent ? parent.theme : 'glassmorphism';
      }

      currentSettings.saved_themes.push(newTheme);
      currentSettings.theme = 'saved_' + newTheme.id;

      await invoke('save_settings', { newSettings: currentSettings });
      showToast(`Saved theme "${name}"!`);
      
      renderSavedThemes(currentSettings);
    } catch(e) { showToast('Failed to save theme: '+e, 'error'); }
  });
  
  document.getElementById('btn-close-settings')?.addEventListener('click', () => {
    getCurrentWindow().close();
  });

  invoke('get_settings').then(s => renderSavedThemes(s));
}

async function saveAppearance() {
  const theme = document.querySelector('.theme-card.active')?.dataset.theme || 'glassmorphism';
  const fontSize = parseInt(document.getElementById('font-size-slider')?.value) || 16;
  const optionsFontSize = parseInt(document.getElementById('options-font-size-slider')?.value) || 14;
  const barHeight = parseInt(document.getElementById('bar-height-slider')?.value) || 20;
  const opacity = parseInt(document.getElementById('opacity-slider')?.value) || 90;
  try {
    const settings = await invoke('get_settings');
    settings.theme = theme;
    
    const themeSnapshot = {
      id: theme.startsWith('saved_') ? theme.replace('saved_','') : theme,
      name: theme,
      theme: theme,
      custom_colors: {
        bar_fill: document.getElementById('color-bar-fill')?.value || '#6c63ff',
        bar_bg: document.getElementById('color-bar-bg')?.value || '#1a1a2e',
        text_color: document.getElementById('color-text')?.value || '#ffffff',
        background: document.getElementById('color-bg')?.value || '#0f0f1e',
        accent: document.getElementById('color-accent')?.value || '#a78bfa',
      },
      custom_font: document.getElementById('font-family-select')?.value || 'Inter',
      overlay_opacity: opacity / 100,
      custom_bg_image: window._customBgImage || '',
      custom_bar_bg_image: window._customBarBgImage || '',
      custom_bar_fill_image: window._customBarFillImage || '',
      custom_banner_image: window._customBannerImage || '',
      bar_animations: document.getElementById('toggle-bar-animations')?.checked !== false,
      theme_effects: document.getElementById('toggle-theme-effects')?.checked !== false,
      layout_mode: document.getElementById('layout-mode-select')?.value || 'standard',
      effect_speed: (parseInt(document.getElementById('effect-speed-slider')?.value) || 100) / 100,
      effect_strength: (parseInt(document.getElementById('effect-strength-slider')?.value) || 100) / 100,
      global_overlay: document.getElementById('global-overlay-select')?.value || 'none',
      global_overlay_color: document.getElementById('global-overlay-color')?.value || '#ffffff'
    };

    // Apply globally
    Object.assign(settings, themeSnapshot);
    settings.font_size = fontSize;
    settings.options_font_size = optionsFontSize;
    settings.bar_height = barHeight;
    settings.show_percentages = document.getElementById('toggle-show-percentages')?.checked !== false;
    settings.show_vote_counts = document.getElementById('toggle-show-counts')?.checked !== false;
    settings.show_question = document.getElementById('toggle-show-question')?.checked !== false;

    // Apply to override or saved theme
    if (!settings.theme_overrides) settings.theme_overrides = {};
    
    if (theme.startsWith('saved_')) {
      const idx = settings.saved_themes.findIndex(t => t.id === themeSnapshot.id);
      if (idx !== -1) {
        themeSnapshot.name = settings.saved_themes[idx].name; // keep original name
        themeSnapshot.theme = settings.saved_themes[idx].theme; // keep original base theme
        settings.theme_overrides[theme] = themeSnapshot;
      }
    } else {
      settings.theme_overrides[theme] = themeSnapshot;
    }

    if (theme.startsWith('saved_')) {
      const cardPreview = document.querySelector(`.theme-card[data-theme="${theme}"] .theme-preview`);
      if (cardPreview) {
        cardPreview.style.background = themeSnapshot.custom_colors.background;
        cardPreview.style.border = `2px solid ${themeSnapshot.custom_colors.accent}`;
        const barBgs = cardPreview.querySelectorAll('div > div');
        if (barBgs.length === 2) {
          barBgs[0].style.background = themeSnapshot.custom_colors.bar_bg;
          barBgs[1].style.background = themeSnapshot.custom_colors.bar_bg;
          barBgs[0].firstElementChild.style.background = themeSnapshot.custom_colors.bar_fill;
          barBgs[1].firstElementChild.style.background = themeSnapshot.custom_colors.bar_fill;
        }
      }
    }

    await invoke('save_settings', { newSettings: settings });
  } catch(e) { console.error('Failed to save appearance:', e); }
}

// ── Window Tab ─────────────────────────────────────────────────
function setupWindowTab() {
  document.getElementById('toggle-always-on-top')?.addEventListener('change', async (e) => {
    try { await invoke('set_always_on_top', { enabled: e.target.checked }); showToast(`Overlay always on top: ${e.target.checked?'ON':'OFF'}`); }
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
    keybindInput?.classList.toggle('recording', recording);
    if (recordBtn) recordBtn.textContent = recording ? 'Stop' : 'Record';
    if (recording && keybindInput) keybindInput.value = 'Press keys...';
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
      if (keybindInput) keybindInput.value = parts.join('+');
      recording = false;
      keybindInput?.classList.remove('recording');
      if (recordBtn) recordBtn.textContent = 'Record';
    }
  }, true);

  document.getElementById('keybind-save-btn')?.addEventListener('click', async () => {
    const shortcut = keybindInput?.value;
    if (!shortcut || shortcut === 'Press keys...') { showToast('Record a shortcut first','error'); return; }
    try {
      await invoke('register_keybind', { shortcut });
      const settings = await invoke('get_settings');
      settings.click_through_keybind = shortcut;
      await invoke('save_settings', { newSettings: settings });
      showToast(`Keybind saved: ${shortcut}`);
    } catch(e) { showToast('Failed: '+e,'error'); }
  });
}

// ── Chat Log ───────────────────────────────────────────────────
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

// ── Toast ──────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = type === 'error' ? 'rgba(248,113,113,0.4)' : 'var(--border, rgba(255,255,255,0.1))';
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ── Utils ──────────────────────────────────────────────────────
function safeSet(id, prop, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined) {
    el[prop] = value;
    if (el.type === 'color' && el.parentElement && el.parentElement.classList.contains('option-color-swatch')) {
      el.parentElement.style.background = value;
    }
  }
}
function escapeHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(str) {
  return String(str||'').replace(/"/g,'&quot;');
}

function renderSavedThemes(settings) {
  document.querySelectorAll('.theme-card.custom-saved').forEach(el => el.remove());
  
  const grid = document.querySelector('.theme-grid');
  const customCard = document.getElementById('theme-card-custom'); // we will insert after this
  if (!grid || !customCard) return;
  
  if (!settings.saved_themes) return;
  
  let insertAfterElement = customCard;
  settings.saved_themes.forEach(theme => {
    const card = document.createElement('div');
    card.className = 'theme-card custom-saved';
    card.dataset.theme = 'saved_' + theme.id;
    if (settings.theme === card.dataset.theme) card.classList.add('active');
    
    const activeSnapshot = settings.theme_overrides && settings.theme_overrides['saved_' + theme.id]
                           ? settings.theme_overrides['saved_' + theme.id]
                           : theme;
    
    card.innerHTML = `
      <div class="theme-preview" style="background: ${escapeAttr(activeSnapshot.custom_colors.background)}; border: 2px solid ${escapeAttr(activeSnapshot.custom_colors.accent)}; border-radius: 6px; display: flex; flex-direction: column; justify-content: center; padding: 0 8px; gap: 4px;">
        <div style="width: 100%; height: 6px; background: ${escapeAttr(activeSnapshot.custom_colors.bar_bg)}; border-radius: 3px; overflow: hidden; display: flex;">
          <div style="width: 70%; height: 100%; background: ${escapeAttr(activeSnapshot.custom_colors.bar_fill)};"></div>
        </div>
        <div style="width: 100%; height: 6px; background: ${escapeAttr(activeSnapshot.custom_colors.bar_bg)}; border-radius: 3px; overflow: hidden; display: flex;">
          <div style="width: 40%; height: 100%; background: ${escapeAttr(activeSnapshot.custom_colors.bar_fill)};"></div>
        </div>
      </div>
      <span>${escapeHtml(theme.name)}</span>
      <button class="btn-delete-theme" data-id="${theme.id}" title="Delete Theme" style="position:absolute; top:-6px; right:-6px; background:#ff4444; color:white; border:none; border-radius:50%; width:20px; height:20px; font-size:12px; cursor:pointer; display:none; align-items:center; justify-content:center; z-index:10;">✕</button>
    `;
    
    card.addEventListener('mouseenter', () => { 
      const btn = card.querySelector('.btn-delete-theme');
      if (btn) btn.style.display = 'flex'; 
    });
    card.addEventListener('mouseleave', () => { 
      const btn = card.querySelector('.btn-delete-theme');
      if (btn) btn.style.display = 'none'; 
    });
    
    card.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-delete-theme')) {
        try {
          const currentSettings = await invoke('get_settings');
          currentSettings.saved_themes = currentSettings.saved_themes.filter(t => t.id !== theme.id);
          if (currentSettings.theme === 'saved_' + theme.id) {
             currentSettings.theme = 'glassmorphism'; // fallback
          }
          await invoke('save_settings', { newSettings: currentSettings });
          
          // Re-render
          renderSavedThemes(currentSettings);
          // Auto-select fallback if we deleted active
          if (document.querySelector('.theme-card.active') === null) {
            const fallback = document.querySelector('.theme-card[data-theme="glassmorphism"]');
            if (fallback) fallback.click();
          }
          showToast('Theme deleted.');
        } catch(err) { showToast('Error deleting: '+err, 'error'); }
        return;
      }
      
      // Apply theme
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      
      const s = await invoke('get_settings');
      let snapshot = null;
      if (s.theme_overrides && s.theme_overrides[card.dataset.theme]) {
        snapshot = s.theme_overrides[card.dataset.theme];
      } else {
        snapshot = theme;
      }
      
      if (snapshot) {
        applyThemeSnapshot(snapshot);
      }
      
      saveAppearance();
    });
    
    grid.insertBefore(card, insertAfterElement.nextSibling);
    insertAfterElement = card;
  });
}
