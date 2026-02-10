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

function renderServiceGrid() {
  const grid = $('#service-grid');
  grid.innerHTML = services.map(svc => `
    <div class="service-card" data-id="${svc.id}">
      <div class="service-card-header">
        <div class="status-dot unknown" id="dot-${svc.id}"></div>
        <span class="svc-name">${svc.name}</span>
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
    </div>
  `).join('');
}

function updateDashboard(data) {
  const { services: svcHealth, gpu } = data;
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
  ownerLoaded = false;
  loadOwnerPanel();
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

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await initDashboard();
  // Load initial health if available
  const health = await veralux.getHealth();
  if (health && Object.keys(health).length > 0) {
    updateDashboard({ services: health, gpu: null });
  }
})();
