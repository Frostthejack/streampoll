// settings.js — Settings UI: 5-tab panel, form handling, Tauri commands
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { startPoll, pausePoll, resumePoll, stopPoll, resetPoll } from './poll.js';

// ── Option counter for unique IDs ──────────────────────────────
let optionCounter = 100;
const OPTION_COLORS = [
  '#6c63ff', '#ff6584', '#43e97b', '#4facfe',
  '#f9c74f', '#f8961e', '#f72585', '#4cc9f0',
  '#06d6a0', '#b5179e', '#ffd60a', '#e07a5f',
];

// ── Init ───────────────────────────────────────────────────────
export async function initSettings() {
  setupTabs();
  setupPollSetup();
  setupAppearance();
  setupWindow();
  setupControls();
  setupChatLog();
  await loadAndRenderPollConfig();
}

// ── Tabs ───────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active');
        p.classList.add('hidden');
      });

      btn.classList.add('active');
      const panel = document.querySelector(`.tab-panel[data-panel="${tab}"]`);
      if (panel) {
        panel.classList.add('active');
        panel.classList.remove('hidden');
      }
    });
  });
}

// ── Poll Setup Tab ─────────────────────────────────────────────
function setupPollSetup() {
  document.getElementById('add-option-btn').addEventListener('click', () => {
    addOptionRow();
  });

  document.getElementById('save-poll-config-btn').addEventListener('click', async () => {
    await savePollConfig();
  });
}

async function loadAndRenderPollConfig() {
  try {
    const config = await invoke('get_poll_config');
    renderPollConfigUI(config);
  } catch (e) {
    console.error('Failed to load poll config:', e);
    // Add two default options
    addOptionRow('Option A', ['a', '1'], '#6c63ff');
    addOptionRow('Option B', ['b', '2'], '#ff6584');
  }
}

function renderPollConfigUI(config) {
  const questionInput = document.getElementById('poll-question-input');
  if (questionInput) questionInput.value = config.question || '';

  const toggle1 = document.getElementById('toggle-case-insensitive');
  if (toggle1) toggle1.checked = config.case_insensitive !== false;

  const toggle2 = document.getElementById('toggle-one-vote');
  if (toggle2) toggle2.checked = config.one_vote_per_user !== false;

  const list = document.getElementById('options-list');
  if (list) list.innerHTML = '';

  (config.options || []).forEach(opt => {
    addOptionRow(opt.label, opt.keywords, opt.color, opt.id);
  });

  if (!config.options || config.options.length === 0) {
    addOptionRow('Option A', ['a', '1'], '#6c63ff');
    addOptionRow('Option B', ['b', '2'], '#ff6584');
  }
}

function addOptionRow(label = '', keywords = [], color = null, existingId = null) {
  const id = existingId || `opt_${++optionCounter}`;
  const colorIdx = document.querySelectorAll('.option-row').length % OPTION_COLORS.length;
  const optColor = color || OPTION_COLORS[colorIdx];

  const row = document.createElement('div');
  row.className = 'option-row';
  row.dataset.optionId = id;
  row.innerHTML = `
    <div class="option-color-swatch" style="background: ${optColor}">
      <input type="color" class="opt-color" value="${optColor}" title="Option color" />
    </div>
    <div class="option-inputs">
      <input type="text" class="option-label-input settings-input" placeholder="Option label" value="${escapeAttr(label)}" />
      <input type="text" class="option-keywords-input" placeholder="Keywords (comma-separated, e.g. a, 1, yes)" value="${escapeAttr(keywords.join(', '))}" />
    </div>
    <button class="option-remove-btn" title="Remove option">✕</button>
  `;

  // Color picker sync
  const colorInput = row.querySelector('.opt-color');
  const swatch = row.querySelector('.option-color-swatch');
  colorInput.addEventListener('input', () => {
    swatch.style.background = colorInput.value;
  });

  // Remove button
  row.querySelector('.option-remove-btn').addEventListener('click', () => {
    row.remove();
  });

  document.getElementById('options-list').appendChild(row);
  return row;
}

async function savePollConfig() {
  const question = document.getElementById('poll-question-input')?.value?.trim() || 'Poll';
  const caseInsensitive = document.getElementById('toggle-case-insensitive')?.checked ?? true;
  const oneVote = document.getElementById('toggle-one-vote')?.checked ?? true;

  const options = [];
  document.querySelectorAll('.option-row').forEach(row => {
    const id = row.dataset.optionId;
    const label = row.querySelector('.option-label-input')?.value?.trim() || 'Option';
    const keywordsRaw = row.querySelector('.option-keywords-input')?.value || '';
    const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(k => k.length > 0);
    const color = row.querySelector('.opt-color')?.value || '#6c63ff';
    options.push({ id, label, keywords, color, votes: 0 });
  });

  if (options.length === 0) {
    window.showToast('Add at least one option', 'error');
    return;
  }

  try {
    const config = { question, options, case_insensitive: caseInsensitive, one_vote_per_user: oneVote };
    await invoke('set_poll_config', { config });
    window.showToast('Poll config saved!');
  } catch (e) {
    window.showToast('Failed to save: ' + e, 'error');
  }
}

// ── Appearance Tab ─────────────────────────────────────────────
function setupAppearance() {
  // Theme cards
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      const theme = card.dataset.theme;
      const customSection = document.getElementById('custom-colors-section');
      customSection.classList.toggle('hidden', theme !== 'custom');

      // Live preview
      const pollContainer = document.getElementById('poll-container');
      if (pollContainer) pollContainer.className = `theme-${theme}`;
    });
  });

  // Font size slider
  const fontSlider = document.getElementById('font-size-slider');
  const fontValue = document.getElementById('font-size-value');
  fontSlider?.addEventListener('input', () => {
    fontValue.textContent = fontSlider.value;
    const pollContainer = document.getElementById('poll-container');
    if (pollContainer) pollContainer.style.fontSize = fontSlider.value + 'px';
  });

  // Opacity slider
  const opacitySlider = document.getElementById('opacity-slider');
  const opacityValue = document.getElementById('opacity-value');
  opacitySlider?.addEventListener('input', () => {
    opacityValue.textContent = opacitySlider.value;
    document.body.style.opacity = opacitySlider.value / 100;
  });

  // Font family
  document.getElementById('font-family-select')?.addEventListener('change', (e) => {
    const font = e.target.value;
    document.documentElement.style.setProperty('--font-main', `'${font}', sans-serif`);
    const pollContainer = document.getElementById('poll-container');
    if (pollContainer) pollContainer.style.fontFamily = `'${font}', sans-serif`;
  });

  // Custom color pickers — live preview
  ['color-bar-fill', 'color-bar-bg', 'color-text', 'color-bg', 'color-accent'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateCustomColors);
  });

  // Show/hide toggles
  ['toggle-show-percentages', 'toggle-show-counts', 'toggle-show-question'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      window._showPercentages = document.getElementById('toggle-show-percentages')?.checked !== false;
      window._showVoteCounts = document.getElementById('toggle-show-counts')?.checked !== false;
      const question = document.getElementById('poll-question');
      if (question) question.style.display = document.getElementById('toggle-show-question')?.checked ? '' : 'none';
    });
  });

  // Save appearance button
  document.getElementById('save-appearance-btn')?.addEventListener('click', async () => {
    await saveAppearance();
  });
}

function updateCustomColors() {
  const root = document.documentElement;
  root.style.setProperty('--custom-bar-fill', document.getElementById('color-bar-fill')?.value || '#6c63ff');
  root.style.setProperty('--custom-bar-bg', document.getElementById('color-bar-bg')?.value || '#1a1a2e');
  root.style.setProperty('--custom-text', document.getElementById('color-text')?.value || '#ffffff');
  root.style.setProperty('--custom-bg', document.getElementById('color-bg')?.value || '#0f0f1e');
  root.style.setProperty('--custom-accent', document.getElementById('color-accent')?.value || '#a78bfa');
}

async function saveAppearance() {
  const activeCard = document.querySelector('.theme-card.active');
  const theme = activeCard?.dataset.theme || 'glassmorphism';

  const customColors = {
    bar_fill: document.getElementById('color-bar-fill')?.value || '#6c63ff',
    bar_bg: document.getElementById('color-bar-bg')?.value || '#1a1a2e',
    text_color: document.getElementById('color-text')?.value || '#ffffff',
    background: document.getElementById('color-bg')?.value || '#0f0f1e',
    accent: document.getElementById('color-accent')?.value || '#a78bfa',
  };

  try {
    const settings = await invoke('get_settings');
    settings.theme = theme;
    settings.custom_colors = customColors;
    settings.custom_font = document.getElementById('font-family-select')?.value || 'Inter';
    settings.font_size = parseInt(document.getElementById('font-size-slider')?.value || '16');
    settings.overlay_opacity = parseInt(document.getElementById('opacity-slider')?.value || '90') / 100;
    settings.show_percentages = document.getElementById('toggle-show-percentages')?.checked !== false;
    settings.show_vote_counts = document.getElementById('toggle-show-counts')?.checked !== false;
    settings.show_question = document.getElementById('toggle-show-question')?.checked !== false;

    await invoke('save_settings', { newSettings: settings });
    window.showToast('Appearance saved!');
  } catch (e) {
    window.showToast('Failed to save appearance: ' + e, 'error');
  }
}

// ── Window Tab ─────────────────────────────────────────────────
function setupWindow() {
  // Always on top toggle
  document.getElementById('toggle-always-on-top')?.addEventListener('change', async (e) => {
    try {
      await invoke('set_always_on_top', { enabled: e.target.checked });
      window.showToast(`Always on top: ${e.target.checked ? 'ON' : 'OFF'}`);
    } catch (err) {
      window.showToast('Error: ' + err, 'error');
    }
  });

  // Click-through toggle
  document.getElementById('toggle-click-through')?.addEventListener('change', async (e) => {
    try {
      await invoke('set_click_through', { enabled: e.target.checked });
    } catch (err) {
      window.showToast('Error: ' + err, 'error');
    }
  });

  // Keybind recorder
  let recording = false;
  let recordedKeys = [];
  const keybindInput = document.getElementById('keybind-display');
  const recordBtn = document.getElementById('keybind-record-btn');
  const saveKeybindBtn = document.getElementById('keybind-save-btn');

  recordBtn?.addEventListener('click', () => {
    recording = !recording;
    recordedKeys = [];
    if (recording) {
      keybindInput.classList.add('recording');
      keybindInput.value = 'Press keys...';
      recordBtn.textContent = 'Stop';
    } else {
      keybindInput.classList.remove('recording');
      recordBtn.textContent = 'Record';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta', 'Command'].includes(key)) {
      parts.push(key.toUpperCase());
      const shortcut = parts.join('+');
      keybindInput.value = shortcut;
      recordedKeys = [shortcut];
      recording = false;
      keybindInput.classList.remove('recording');
      recordBtn.textContent = 'Record';
    }
  }, true);

  saveKeybindBtn?.addEventListener('click', async () => {
    const shortcut = keybindInput.value;
    if (!shortcut || shortcut === 'Press keys...') {
      window.showToast('Record a shortcut first', 'error');
      return;
    }
    try {
      await invoke('register_keybind', { shortcut });

      // Also save to settings
      const settings = await invoke('get_settings');
      settings.click_through_keybind = shortcut;
      await invoke('save_settings', { newSettings: settings });

      window.showToast(`Keybind set: ${shortcut}`);
    } catch (e) {
      window.showToast('Failed to register keybind: ' + e, 'error');
    }
  });
}

// ── Controls Tab ───────────────────────────────────────────────
function setupControls() {
  document.getElementById('ctrl-start')?.addEventListener('click', () => startPoll());
  document.getElementById('ctrl-pause')?.addEventListener('click', () => pausePoll());
  document.getElementById('ctrl-resume')?.addEventListener('click', () => resumePoll());
  document.getElementById('ctrl-stop')?.addEventListener('click', () => stopPoll());
  document.getElementById('ctrl-reset')?.addEventListener('click', () => resetPoll());
}

// ── Chat Log ───────────────────────────────────────────────────
function setupChatLog() {
  document.getElementById('clear-log-btn')?.addEventListener('click', () => {
    const log = document.getElementById('chat-log');
    if (log) log.innerHTML = '<p class="log-placeholder">Log cleared.</p>';
  });

  listen('chat_message', (event) => {
    appendChatLog(event.payload);
  });
}

function appendChatLog(msg) {
  const log = document.getElementById('chat-log');
  if (!log) return;

  // Remove placeholder
  const placeholder = log.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry${msg.matched ? ' matched' : ''}`;
  entry.innerHTML = `
    <span class="log-author">${escapeHtml(msg.author)}</span>:
    <span class="log-text">${escapeHtml(msg.text)}</span>
    ${msg.matched ? `<span class="log-match-badge">✓ ${escapeHtml(msg.matched)}</span>` : ''}
  `;

  log.appendChild(entry);

  // Keep max 100 entries
  while (log.children.length > 100) {
    log.removeChild(log.firstChild);
  }

  // Auto-scroll to bottom
  log.scrollTop = log.scrollHeight;
}

// ── Utils ──────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}
