// poll-overlay.js — Minimal JS for the borderless poll overlay window
// Receives events from the backend and renders the poll. No settings logic.

function waitForTauri(cb, tries) {
  tries = tries || 0;
  if (window.__TAURI__ && window.__TAURI__.core) { cb(); }
  else if (tries < 50) { setTimeout(function() { waitForTauri(cb, tries + 1); }, 50); }
  else { console.error('Tauri not available'); }
}

var invoke, listen, appWindow;

waitForTauri(function() {
  invoke = window.__TAURI__.core.invoke;
  listen = window.__TAURI__.event.listen;
  appWindow = window.__TAURI__.window.getCurrentWindow();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOverlay);
  } else {
    bootOverlay();
  }
});

let _showPercentages = true;
let _showVoteCounts = true;
let previousVotes = {};
let isClickThrough = false;

async function bootOverlay() {
  // No close button needed — use Close Overlay in settings window

  // Listen for poll updates
  listen('poll_update', (event) => renderPollUpdate(event.payload));

  // Listen for settings changes (theme, font, opacity etc.)
  listen('settings_updated', (event) => applySettings(event.payload));

  // Listen for click-through toggle
  listen('toggle_click_through', async () => {
    isClickThrough = !isClickThrough;
    try { await invoke('set_click_through', { enabled: isClickThrough }); }
    catch(e) { console.error(e); }
    updateClickThroughUI(isClickThrough);
  });

  listen('click_through_changed', (event) => {
    isClickThrough = event.payload;
    updateClickThroughUI(isClickThrough);
  });

  // Load initial state
  try {
    const settings = await invoke('get_settings');
    applySettings(settings);
    const update = await invoke('get_poll_update');
    renderPollUpdate(update);
    const authStatus = await invoke('get_auth_status');
  } catch(e) { console.error('Overlay init error:', e); }
}

function applySettings(settings) {
  if (!settings) return;

  // Resolve base theme
  let activeTheme = settings.theme || 'glassmorphism';
  let depth = 0;
  while (activeTheme.startsWith('saved_') && depth < 10) {
    const savedThemes = settings.saved_themes || [];
    const saved = savedThemes.find(t => t.id === activeTheme.replace('saved_', ''));
    if (saved && saved.theme) {
      activeTheme = saved.theme;
    } else {
      activeTheme = 'glassmorphism';
    }
    depth++;
  }
  const validThemes = ['glassmorphism', 'neon', 'minimal', 'retro', 'gradient', 'custom'];
  if (!validThemes.includes(activeTheme)) {
    activeTheme = 'glassmorphism';
  }

  const pollContainer = document.getElementById('poll-container');
  if (pollContainer) pollContainer.className = `theme-${activeTheme}`;

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

  if (settings.font_size && settings.font_size > 0) {
    const base = settings.font_size; // e.g. 16
    const root = document.documentElement;
    // Scale all font variables relative to the chosen base size for the question/header
    root.style.setProperty('--font-size-base', base + 'px');
    root.style.setProperty('--font-size-sm',   Math.round(base * 0.8)  + 'px');
    root.style.setProperty('--font-size-lg',   Math.round(base * 1.2)  + 'px');
    root.style.setProperty('--font-size-xl',   Math.round(base * 1.5)  + 'px');
    // Also set html font-size so rem units work
    root.style.fontSize = base + 'px';
    const pollEl = document.getElementById('poll-container');
    if (pollEl) pollEl.style.fontSize = base + 'px';
  }

  // Set the font size specifically for the options container
  if (settings.options_font_size && settings.options_font_size > 0) {
    const optionsEl = document.querySelector('.poll-options');
    if (optionsEl) optionsEl.style.fontSize = settings.options_font_size + 'px';
  }

  if (settings.bar_height && settings.bar_height > 0) {
    document.documentElement.style.setProperty('--bar-height', settings.bar_height + 'px');
  }

  let alpha = 0.9;
  if (settings.overlay_opacity !== undefined) {
    alpha = typeof settings.overlay_opacity === 'number'
      ? settings.overlay_opacity
      : parseFloat(settings.overlay_opacity);
    if (alpha > 1) alpha = alpha / 100;
    if (alpha > 1) alpha = 1;
    if (alpha < 0) alpha = 0;
    document.documentElement.style.setProperty('--bg-alpha', alpha.toString());
  }

  // Helper to apply alpha to hex
  const applyAlpha = (color, a) => {
    if (!color || !color.startsWith('#')) return color;
    let hex = color.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
    const r = parseInt(hex.substring(0,2), 16);
    const g = parseInt(hex.substring(2,4), 16);
    const b = parseInt(hex.substring(4,6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  // Apply custom colors as CSS variables so themes can use them
  if (settings.custom_colors) {
    const cc = settings.custom_colors;
    document.documentElement.style.setProperty('--custom-bar-fill', cc.bar_fill);
    document.documentElement.style.setProperty('--custom-bar-bg', cc.bar_bg); 
    document.documentElement.style.setProperty('--custom-text', cc.text_color);
    document.documentElement.style.setProperty('--custom-bg', applyAlpha(cc.background, alpha));
    document.documentElement.style.setProperty('--custom-accent', cc.accent);
  }

  // Handle custom background image
  const pollEl = document.getElementById('poll-container');
  if (pollEl) {
    if (settings.custom_bg_image) {
      pollEl.style.backgroundImage = `url("${settings.custom_bg_image}")`;
      pollEl.style.backgroundSize = 'cover';
      pollEl.style.backgroundPosition = 'center';
    } else {
      pollEl.style.backgroundImage = '';
    }
  }

  // Handle custom bar background image
  if (settings.custom_bar_bg_image) {
    document.documentElement.style.setProperty('--custom-bar-bg-image', `url("${settings.custom_bar_bg_image}")`);
    document.documentElement.setAttribute('data-has-custom-bar-bg', 'true');
  } else {
    document.documentElement.style.removeProperty('--custom-bar-bg-image');
    document.documentElement.removeAttribute('data-has-custom-bar-bg');
  }

  // Handle custom bar fill image
  if (settings.custom_bar_fill_image) {
    document.documentElement.style.setProperty('--custom-bar-fill-image', `url("${settings.custom_bar_fill_image}")`);
    document.documentElement.setAttribute('data-has-custom-bar-fill', 'true');
  } else {
    document.documentElement.style.removeProperty('--custom-bar-fill-image');
    document.documentElement.removeAttribute('data-has-custom-bar-fill');
  }

  // Handle custom banner image
  if (settings.custom_banner_image) {
    document.documentElement.style.setProperty('--custom-banner-image', `url("${settings.custom_banner_image}")`);
    document.documentElement.setAttribute('data-has-custom-banner', 'true');
  } else {
    document.documentElement.style.removeProperty('--custom-banner-image');
    document.documentElement.removeAttribute('data-has-custom-banner');
  }

  // Apply theme class and layout mode
  document.body.className = '';
  document.body.classList.add(`theme-${activeTheme}`);
  
  if (settings.layout_mode && settings.layout_mode !== 'standard') {
    document.body.classList.add(`layout-${settings.layout_mode}`);
  }

  if (settings.bar_animations === false) {
    document.body.classList.add('disable-bar-animations');
  }
  if (settings.theme_effects === false) {
    document.body.classList.add('disable-theme-effects');
  }

  // Apply new ambient effects settings
  if (settings.global_overlay && settings.global_overlay !== 'none') {
    document.body.classList.add(`overlay-${settings.global_overlay}`);
  }

  // Set CSS variables for speed and strength
  const speed = settings.effect_speed !== undefined ? settings.effect_speed : 1.0;
  const strength = settings.effect_strength !== undefined ? settings.effect_strength : 1.0;
  const color = settings.global_overlay_color || '#ffffff';
  
  // To handle speed via CSS variables, we usually divide the base duration by the speed multiplier.
  // We'll set a multiplier variable that CSS `calc()` can use.
  document.documentElement.style.setProperty('--anim-speed-mult', speed);
  document.documentElement.style.setProperty('--effect-strength', strength);
  document.documentElement.style.setProperty('--overlay-color', color);

  const question = document.getElementById('poll-question');
  if (question) question.style.display = settings.show_question === false ? 'none' : '';

  _showPercentages = settings.show_percentages !== false;
  _showVoteCounts = settings.show_vote_counts !== false;
}

function renderPollUpdate(update) {
  if (!update) return;

  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const totalEl = document.getElementById('total-votes-display');
  if (dot) dot.className = `status-dot ${update.status}`;
  const statusLabels = { idle: 'Idle', running: '● Live', paused: '⏸ Paused' };
  if (label) label.textContent = statusLabels[update.status] || update.status;
  if (totalEl) totalEl.textContent = update.total_votes > 0
    ? `${update.total_votes} vote${update.total_votes !== 1 ? 's' : ''}` : '';

  const stopBtn = document.getElementById('btn-stop-poll');
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', update.status === 'idle');
  }

  invoke('get_queue').then(queue => {
    const nextBtn = document.getElementById('btn-next-poll');
    if (nextBtn) {
      nextBtn.classList.toggle('hidden', !queue || queue.length === 0);
    }
  }).catch(() => {});

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
      const statsEl = optEl.querySelector('.poll-opt-stats');
      if (statsEl) statsEl.style.display = (_showVoteCounts || _showPercentages) ? '' : 'none';
    }

    const pctEl = optEl.querySelector('.poll-opt-pct');
    if (pctEl) pctEl.textContent = option.percentage.toFixed(1) + '%';

    previousVotes[option.id] = option.votes;
  });
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

function updateClickThroughUI(enabled) {
  const badge = document.getElementById('click-through-indicator');
  if (badge) badge.classList.toggle('hidden', !enabled);
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Set up UI interactions
document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('poll-status-bar');
  if (statusBar) {
    statusBar.style.cursor = 'pointer';
    statusBar.title = 'Click to toggle Start/Pause/Resume';
    statusBar.addEventListener('click', async () => {
      const dot = document.getElementById('status-dot');
      if (!dot) return;
      try {
        if (dot.classList.contains('idle')) {
          await invoke('start_poll');
        } else if (dot.classList.contains('running')) {
          await invoke('pause_poll');
        } else if (dot.classList.contains('paused')) {
          await invoke('resume_poll');
        }
      } catch(e) { console.warn(e); }
    });
  }

  document.getElementById('btn-stop-poll')?.addEventListener('click', async () => {
    try { await invoke('stop_poll'); } catch(e) { console.warn(e); }
  });

  document.getElementById('btn-next-poll')?.addEventListener('click', async () => {
    try { await invoke('next_poll_in_queue'); } catch(e) { console.warn(e); }
  });
});
