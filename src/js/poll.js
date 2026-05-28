// poll.js — Poll renderer, theme engine, live updates
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// ── State ──────────────────────────────────────────────────────
let currentPollStatus = 'idle';
let previousVotes = {};

// ── Init ───────────────────────────────────────────────────────
export async function initPoll() {
  await setupPollListeners();
  setupQuickControls();
}

// ── Tauri Event Listeners ──────────────────────────────────────
async function setupPollListeners() {
  await listen('poll_update', (event) => {
    renderPollUpdate(event.payload);
  });

  // Also listen for internal app events
  window.addEventListener('poll_update', (event) => {
    renderPollUpdate(event.detail);
  });
}

// ── Quick Controls ─────────────────────────────────────────────
function setupQuickControls() {
  document.getElementById('qc-start').addEventListener('click', () => startPoll());
  document.getElementById('qc-pause').addEventListener('click', () => pausePoll());
  document.getElementById('qc-resume').addEventListener('click', () => resumePoll());
  document.getElementById('qc-stop').addEventListener('click', () => stopPoll());
}

// ── Poll Control Functions ─────────────────────────────────────
export async function startPoll() {
  try {
    await invoke('start_poll');
  } catch (e) {
    window.showToast('Error: ' + e, 'error');
  }
}

export async function pausePoll() {
  try {
    await invoke('pause_poll');
  } catch (e) {
    window.showToast('Error: ' + e, 'error');
  }
}

export async function resumePoll() {
  try {
    await invoke('resume_poll');
  } catch (e) {
    window.showToast('Error: ' + e, 'error');
  }
}

export async function stopPoll() {
  try {
    await invoke('stop_poll');
  } catch (e) {
    window.showToast('Error: ' + e, 'error');
  }
}

export async function resetPoll() {
  try {
    await invoke('reset_poll');
  } catch (e) {
    window.showToast('Error: ' + e, 'error');
  }
}

// ── Render ─────────────────────────────────────────────────────
function renderPollUpdate(update) {
  if (!update) return;

  currentPollStatus = update.status;

  // Status bar
  updateStatusBar(update.status, update.total_votes);

  // Question
  const qEl = document.getElementById('poll-question');
  if (qEl) qEl.textContent = update.question || 'Configure your poll in settings';

  // Options
  const container = document.getElementById('poll-options');
  if (!container) return;

  const showPercentages = window._showPercentages !== false;
  const showVoteCounts = window._showVoteCounts !== false;

  // Sync DOM options with data (add/remove as needed)
  syncOptionElements(container, update.options);

  // Update each option
  update.options.forEach((option, idx) => {
    const optEl = document.getElementById(`poll-opt-${option.id}`);
    if (!optEl) return;

    // Update bar width
    const barFill = optEl.querySelector('.poll-bar-fill');
    if (barFill) {
      const pct = Math.max(option.percentage, option.votes > 0 ? 1 : 0);
      barFill.style.width = pct + '%';
      barFill.style.setProperty('--option-color', option.color);
      barFill.style.background = getBarFillStyle(option.color);
    }

    // Update vote count with pop animation
    const countEl = optEl.querySelector('.poll-opt-count');
    if (countEl && showVoteCounts) {
      const prev = previousVotes[option.id] || 0;
      if (option.votes !== prev) {
        countEl.textContent = option.votes;
        countEl.classList.remove('count-pop');
        void countEl.offsetWidth; // force reflow
        countEl.classList.add('count-pop');
      }
      countEl.parentElement.style.display = '';
    } else if (countEl) {
      countEl.parentElement.style.display = 'none';
    }

    // Update percentage
    const pctEl = optEl.querySelector('.poll-opt-pct');
    if (pctEl && showPercentages) {
      pctEl.textContent = option.percentage.toFixed(1) + '%';
      pctEl.parentElement.style.display = '';
    } else if (pctEl) {
      pctEl.parentElement.style.display = 'none';
    }

    previousVotes[option.id] = option.votes;
  });

  // Update quick control buttons
  updateQuickControls(update.status);
}

function getBarFillStyle(color) {
  // For themes that use gradient, return that; others use the color directly
  // The CSS handles the actual gradient via ::after or var(--option-color)
  // We just set the CSS variable; the theme's CSS handles the rest
  return ''; // Let CSS handle it via --option-color
}

function syncOptionElements(container, options) {
  const existing = new Set([...container.querySelectorAll('.poll-option')].map(el => el.id));
  const needed = new Set(options.map(o => `poll-opt-${o.id}`));

  // Remove stale elements
  container.querySelectorAll('.poll-option').forEach(el => {
    if (!needed.has(el.id)) el.remove();
  });

  // Add missing elements
  options.forEach((option, idx) => {
    const id = `poll-opt-${option.id}`;
    if (!document.getElementById(id)) {
      const el = createOptionElement(option, idx);
      container.appendChild(el);
    }

    // Update label and color
    const optEl = document.getElementById(id);
    if (optEl) {
      const labelEl = optEl.querySelector('.poll-option-label');
      if (labelEl) labelEl.textContent = option.label;

      const barFill = optEl.querySelector('.poll-bar-fill');
      if (barFill) {
        barFill.style.setProperty('--option-color', option.color);
      }
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
      <div class="poll-option-stats">
        <span><span class="poll-opt-count">${option.votes}</span> votes</span>
        <span class="poll-opt-pct">${option.percentage.toFixed(1)}%</span>
      </div>
    </div>
    <div class="poll-bar-track">
      <div class="poll-bar-fill" style="width: ${option.percentage}%; --option-color: ${option.color}"></div>
    </div>
  `;
  return div;
}

function updateStatusBar(status, totalVotes) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const totalEl = document.getElementById('total-votes-display');

  if (dot) {
    dot.className = `status-dot ${status}`;
  }

  const labels = { idle: 'Idle', running: '● Live', paused: '⏸ Paused' };
  if (label) label.textContent = labels[status] || status;
  if (totalEl) totalEl.textContent = totalVotes > 0 ? `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` : '';
}

function updateQuickControls(status) {
  const start = document.getElementById('qc-start');
  const pause = document.getElementById('qc-pause');
  const resume = document.getElementById('qc-resume');
  const stop = document.getElementById('qc-stop');

  // Also sync big controls in settings
  const bStart = document.getElementById('ctrl-start');
  const bPause = document.getElementById('ctrl-pause');
  const bResume = document.getElementById('ctrl-resume');
  const bStop = document.getElementById('ctrl-stop');

  if (status === 'idle') {
    setVisible(start, true); setVisible(pause, false);
    setVisible(resume, false); setVisible(stop, false);
    setVisible(bStart, true); setVisible(bPause, false);
    setVisible(bResume, false); setVisible(bStop, false);
  } else if (status === 'running') {
    setVisible(start, false); setVisible(pause, true);
    setVisible(resume, false); setVisible(stop, true);
    setVisible(bStart, false); setVisible(bPause, true);
    setVisible(bResume, false); setVisible(bStop, true);
  } else if (status === 'paused') {
    setVisible(start, false); setVisible(pause, false);
    setVisible(resume, true); setVisible(stop, true);
    setVisible(bStart, false); setVisible(bPause, false);
    setVisible(bResume, true); setVisible(bStop, true);
  }
}

function setVisible(el, show) {
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { currentPollStatus };
