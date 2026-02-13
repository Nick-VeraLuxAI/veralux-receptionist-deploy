// VeraLux Desktop — Renderer
// All UI logic: tabs, dashboard, owner panel, logs, settings

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── State ────────────────────────────────────────────────────────────────────
let services = [];
let currentTab = 'dashboard';
let logsPaused = false;
let logFilter = '';
let currentLogContainer = null;
let ownerLoaded = false;
let activeTtsMode = null; // resolved dynamically from tenant config

// ─── Tab Routing ──────────────────────────────────────────────────────────────

$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tab));

  if (tab === 'owner-panel' && !ownerLoaded) loadOwnerPanel();
  if (tab === 'settings') loadSettings();
  if (tab === 'logs' && !currentLogContainer) initLogs();
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function initDashboard() {
  services = await veralux.listServices();
  renderServiceGrid();
}

function ttsBadgeState(svc) {
  if (!svc.ttsEngine) return null;
  if (!activeTtsMode) return { label: '...', cls: 'tts-standby', inactive: false }; // still resolving
  const isActive = svc.ttsEngine === activeTtsMode;
  return { label: isActive ? 'Active' : 'Standby', cls: isActive ? 'tts-active' : 'tts-standby', inactive: !isActive };
}

function renderServiceGrid() {
  const grid = $('#service-grid');
  grid.innerHTML = services.map(svc => {
    const badge = ttsBadgeState(svc);
    const cardClasses = ['service-card'];
    if (badge && badge.inactive) cardClasses.push('tts-inactive');
    return `
    <div class="${cardClasses.join(' ')}" data-id="${svc.id}" ${svc.ttsEngine ? `data-tts-engine="${svc.ttsEngine}"` : ''}>
      <div class="service-card-header">
        <div class="status-dot unknown" id="dot-${svc.id}"></div>
        <span class="svc-name">${svc.name}</span>
        ${badge ? `<span class="tts-badge ${badge.cls}" id="tts-badge-${svc.id}">${badge.label}</span>` : ''}
        <span class="svc-status" id="status-${svc.id}">...</span>
      </div>
      <div class="service-card-meta">
        <span id="response-${svc.id}">—</span>
        <span id="uptime-${svc.id}">—</span>
      </div>
      <div class="service-card-actions">
        <button class="btn btn-sm btn-success" onclick="svcAction('start', '${svc.container}')">Start</button>
        <button class="btn btn-sm" onclick="svcAction('restart', '${svc.container}')">Restart</button>
        <button class="btn btn-sm btn-danger" onclick="svcAction('stop', '${svc.container}')">Stop</button>
      </div>
    </div>`;
  }).join('');
}

function updateTtsBadges() {
  for (const svc of services) {
    const badge_state = ttsBadgeState(svc);
    if (!badge_state) continue;
    const card = document.querySelector(`.service-card[data-tts-engine="${svc.ttsEngine}"]`);
    const badge = $(`#tts-badge-${svc.id}`);
    if (!card || !badge) continue;
    badge.textContent = badge_state.label;
    badge.className = `tts-badge ${badge_state.cls}`;
    card.classList.toggle('tts-inactive', badge_state.inactive);
  }
}

function updateDashboard(data) {
  const { services: svcHealth, gpu } = data;

  // Update active TTS mode if provided
  if (data.activeTtsMode && data.activeTtsMode !== activeTtsMode) {
    activeTtsMode = data.activeTtsMode;
    updateTtsBadges();
  }

  let healthyCount = 0, totalCount = 0;

  for (const svc of services) {
    const h = svcHealth[svc.id];
    if (!h) continue;
    totalCount++;
    if (h.status === 'healthy') healthyCount++;

    const dot = $(`#dot-${svc.id}`);
    const statusEl = $(`#status-${svc.id}`);
    const respEl = $(`#response-${svc.id}`);
    const upEl = $(`#uptime-${svc.id}`);

    if (dot) {
      dot.className = `status-dot ${h.status}`;
    }
    if (statusEl) statusEl.textContent = h.status;
    if (respEl) respEl.textContent = h.responseMs != null ? `${h.responseMs}ms` : '—';
    if (upEl) upEl.textContent = h.uptime != null ? formatUptime(h.uptime) : '—';
  }

  // Status summary
  const summary = $('#status-summary');
  if (summary) summary.textContent = `${healthyCount}/${totalCount} services healthy`;

  // GPU bar
  const gpuBar = $('#gpu-bar');
  if (gpu) {
    gpuBar.style.display = 'flex';
    $('#gpu-util').textContent = `${gpu.utilization}% util`;
    $('#gpu-mem').textContent = `${gpu.memUsedMB}/${gpu.memTotalMB} MB`;
    $('#gpu-fill').style.width = `${gpu.utilization}%`;
  }

  // Status bar
  updateStatusBar(svcHealth, healthyCount, totalCount);
}

function updateStatusBar(svcHealth, healthyCount, totalCount) {
  const overallEl = $('#sb-overall');
  const svcEl = $('#sb-services');
  const allHealthy = healthyCount === totalCount && totalCount > 0;
  const color = allHealthy ? 'var(--success)' : (healthyCount > 0 ? 'var(--warning)' : 'var(--danger)');
  const label = allHealthy ? 'All systems operational' : `${healthyCount}/${totalCount} healthy`;
  overallEl.innerHTML = `<span class="dot-inline" style="background:${color}"></span> ${label}`;

  const parts = services.map(svc => {
    const h = svcHealth[svc.id];
    const c = !h ? 'var(--muted)' : h.status === 'healthy' ? 'var(--success)' : h.status === 'stopped' ? 'var(--muted)' : 'var(--danger)';
    return `<span class="dot-inline" style="background:${c}"></span>${svc.name}`;
  });
  svcEl.innerHTML = parts.join('  ');
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

async function svcAction(action, container) {
  try {
    if (action === 'start') await veralux.startService(container);
    else if (action === 'restart') await veralux.restartService(container);
    else if (action === 'stop') await veralux.stopService(container);
    showToast(`${action} ${container}...`);
  } catch (err) {
    showToast(`Failed: ${err.message}`, true);
  }
}

// Master controls
$('#btn-start-all').addEventListener('click', () => { veralux.startAll(); showToast('Starting all services...'); });
$('#btn-stop-all').addEventListener('click', () => { veralux.stopAll(); showToast('Stopping all services...'); });
$('#btn-restart-all').addEventListener('click', () => { veralux.restartAll(); showToast('Restarting all services...'); });

// ─── Recovery Mode ────────────────────────────────────────────────────────────

$('#btn-recovery').addEventListener('click', () => {
  const overlay = $('#recovery-overlay');
  const log = $('#recovery-log');
  const confirmBtn = $('#btn-recovery-confirm');
  const cancelBtn = $('#btn-recovery-cancel');

  // Reset modal state
  log.innerHTML = '<span class="step" style="color:var(--muted)">Waiting to start...</span>';
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Start Recovery';
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
  overlay.classList.remove('hidden');
});

$('#btn-recovery-cancel').addEventListener('click', () => {
  $('#recovery-overlay').classList.add('hidden');
});

$('#btn-recovery-confirm').addEventListener('click', async () => {
  const confirmBtn = $('#btn-recovery-confirm');
  const cancelBtn = $('#btn-recovery-cancel');
  const log = $('#recovery-log');

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Recovering...';
  cancelBtn.disabled = true;
  log.innerHTML = '';

  addRecoveryStep('Initiating recovery...', 'active');

  try {
    const result = await veralux.recovery();
    // Final result handled by progress listener
  } catch (err) {
    addRecoveryStep(`Error: ${err.message}`, 'error');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Retry';
    cancelBtn.disabled = false;
  }
});

function addRecoveryStep(message, cls = '') {
  const log = $('#recovery-log');
  const el = document.createElement('span');
  el.className = `step ${cls}`;
  el.textContent = message;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

// Listen for tray-triggered recovery
veralux.onTriggerRecovery(() => {
  $('#btn-recovery').click();
});

veralux.onRecoveryProgress((data) => {
  const confirmBtn = $('#btn-recovery-confirm');
  const cancelBtn = $('#btn-recovery-cancel');

  switch (data.step) {
    case 'scanning':
      addRecoveryStep(data.message, 'active');
      break;
    case 'killed':
      if (data.killed && data.killed.length > 0) {
        for (const k of data.killed) {
          addRecoveryStep(`  Killed PID ${k.pid} (${k.name}) on port ${k.port}`, 'warn');
        }
      }
      addRecoveryStep(data.message, data.killed?.length > 0 ? 'warn' : 'done');
      break;
    case 'teardown':
    case 'waiting':
    case 'starting':
      addRecoveryStep(data.message, 'active');
      break;
    case 'teardown-warn':
      addRecoveryStep(data.message, 'warn');
      break;
    case 'done':
      addRecoveryStep(data.message, data.success ? 'done' : 'warn');
      confirmBtn.textContent = 'Done';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Close';
      if (data.success) {
        showToast('Recovery complete — all services running');
      } else {
        showToast(`Recovery finished — ${data.running}/${data.total} services running`, true);
      }
      break;
  }
});

// ─── Owner Panel ──────────────────────────────────────────────────────────────

async function loadOwnerPanel() {
  const key = await veralux.getAdminKey();
  const frame = $('#owner-frame');
  // Load owner panel; auth token is passed via URL hash for the panel JS to pick up
  const url = key
    ? `http://localhost:4000/owner#token=${encodeURIComponent(key)}`
    : 'http://localhost:4000/owner';
  frame.src = url;
  ownerLoaded = true;
}

$('#btn-reload-owner').addEventListener('click', () => {
  const frame = $('#owner-frame');
  // Force reload by clearing src first, then reloading
  frame.src = 'about:blank';
  ownerLoaded = false;
  setTimeout(() => loadOwnerPanel(), 100);
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

async function initLogs() {
  const select = $('#log-service-select');
  if (select.children.length === 0) {
    services.forEach(svc => {
      const opt = document.createElement('option');
      opt.value = svc.container;
      opt.textContent = svc.name;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => startLogStream(select.value));
  }
  if (services.length > 0 && !currentLogContainer) {
    startLogStream(services[0].container);
  }
}

function startLogStream(container) {
  // Stop previous stream
  if (currentLogContainer) veralux.stopLogs(currentLogContainer);
  veralux.removeLogListeners();

  currentLogContainer = container;
  const output = $('#log-output');
  output.innerHTML = '';
  logsPaused = false;
  $('#btn-log-pause').textContent = 'Pause';

  veralux.startLogs(container, 200);
  veralux.onLogData(({ container: c, data }) => {
    if (c !== currentLogContainer || logsPaused) return;
    appendLogLines(data);
  });
}

function appendLogLines(text) {
  const output = $('#log-output');
  const filter = logFilter.toLowerCase();
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (filter && !line.toLowerCase().includes(filter)) continue;
    const el = document.createElement('span');
    el.className = 'log-line';
    if (line.match(/error|ERR|fatal|FATAL|panic/i)) el.classList.add('log-err');
    el.textContent = line;
    output.appendChild(el);
    output.appendChild(document.createTextNode('\n'));
  }
  // Keep max 5000 lines
  while (output.childNodes.length > 10000) {
    output.removeChild(output.firstChild);
  }
  // Auto-scroll
  if (!logsPaused) output.scrollTop = output.scrollHeight;
}

$('#btn-log-pause').addEventListener('click', () => {
  logsPaused = !logsPaused;
  $('#btn-log-pause').textContent = logsPaused ? 'Resume' : 'Pause';
});

$('#btn-log-clear').addEventListener('click', () => {
  $('#log-output').innerHTML = '';
});

$('#log-filter').addEventListener('input', (e) => {
  logFilter = e.target.value;
});

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const content = await veralux.loadSettings();
  $('#env-editor').value = content;
  $('#settings-status').textContent = '';
}

$('#btn-save-settings').addEventListener('click', async () => {
  const content = $('#env-editor').value;
  const result = await veralux.saveSettings(content);
  if (result.success) {
    $('#settings-status').textContent = 'Saved. Restart services to apply changes.';
    $('#settings-status').style.color = 'var(--success)';
  } else {
    $('#settings-status').textContent = `Error: ${result.error}`;
    $('#settings-status').style.color = 'var(--danger)';
  }
});

$('#btn-reload-settings').addEventListener('click', loadSettings);

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.style.borderColor = isError ? 'var(--danger)' : 'var(--border)';
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ─── Health Update Listener ───────────────────────────────────────────────────

veralux.onHealthUpdate(updateDashboard);

veralux.onDockerActionDone((phase, data) => {
  if (data.success) showToast(`${data.action} completed`);
  else showToast(`${data.action} failed: ${data.error || 'unknown'}`, true);
});

// ─── EULA / License Gate ──────────────────────────────────────────────────────

async function checkEula() {
  const result = await veralux.checkEula();
  if (result.accepted) {
    hideEula();
    return true;
  }
  // Show the EULA modal
  const overlay = $('#eula-overlay');
  const eulaText = $('#eula-text');
  const checkbox = $('#eula-agree-checkbox');
  const acceptBtn = $('#btn-eula-accept');
  const declineBtn = $('#btn-eula-decline');

  eulaText.textContent = result.licenseText;
  overlay.classList.remove('hidden');

  // Enable accept button only when checkbox is checked
  checkbox.addEventListener('change', () => {
    acceptBtn.disabled = !checkbox.checked;
  });

  return new Promise((resolve) => {
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = 'Saving...';
      const saveResult = await veralux.acceptEula();
      if (saveResult.success) {
        hideEula();
        resolve(true);
      } else {
        acceptBtn.textContent = 'Accept & Continue';
        acceptBtn.disabled = false;
        showToast('Failed to save acceptance: ' + (saveResult.error || 'unknown error'), true);
      }
    });

    declineBtn.addEventListener('click', () => {
      // Close the app if the user declines
      window.close();
    });
  });
}

function hideEula() {
  const overlay = $('#eula-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Gate: user must accept the license agreement before using the app
  await checkEula();

  await initDashboard();
  // Load initial health if available
  const health = await veralux.getHealth();
  if (health) {
    // health:get now returns { services, activeTtsMode }
    if (health.services && Object.keys(health.services).length > 0) {
      if (health.activeTtsMode) activeTtsMode = health.activeTtsMode;
      updateTtsBadges();
      updateDashboard({ services: health.services, gpu: null, activeTtsMode: activeTtsMode });
    } else if (Object.keys(health).length > 0 && !health.services) {
      // Backwards compat: old format was flat { serviceId: healthData }
      updateDashboard({ services: health, gpu: null });
    }
  }
})();
