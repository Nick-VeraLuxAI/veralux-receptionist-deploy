// VeraLux Desktop Control Center — Main Process
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');

// Linux sandbox workaround (local desktop app)
app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const { spawn, execSync, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────
const PROJECT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_DIR, '.env');
const LICENSE_PATH = path.join(PROJECT_DIR, 'LICENSE');
const EULA_ACCEPTANCE_PATH = path.join(__dirname, '.eula-accepted');
const COMPOSE_PROJECT = 'veralux';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

const SERVICES = [
  { id: 'control',     name: 'Control Plane', container: 'veralux-control',     port: 4000, healthPath: '/health' },
  { id: 'runtime',     name: 'Voice Runtime', container: 'veralux-runtime',      port: 4001, healthPath: '/health/live' },
  { id: 'brain',       name: 'Brain LLM',     container: 'veralux-brain',        port: null, healthPath: null },
  { id: 'whisper',     name: 'Whisper STT',   container: 'veralux-whisper',      port: null, healthPath: null },
  { id: 'xtts',        name: 'XTTS TTS',      container: 'veralux-xtts',         port: null, healthPath: null,  ttsEngine: 'coqui_xtts' },
  { id: 'kokoro',      name: 'Kokoro TTS',    container: 'veralux-kokoro',       port: null, healthPath: null,  ttsEngine: 'kokoro_http' },
  { id: 'redis',       name: 'Redis',         container: 'veralux-redis',        port: null, healthPath: null },
  { id: 'postgres',    name: 'PostgreSQL',    container: 'veralux-postgres',     port: null, healthPath: null },
  { id: 'cloudflared', name: 'Cloudflared',   container: 'veralux-cloudflared',  port: null, healthPath: null },
];

// Active TTS mode (fetched from control-plane; null = not yet resolved)
let activeTtsMode = null;
let lastTtsFetchTime = 0;
const TTS_FETCH_INTERVAL_MS = 60000; // re-check TTS mode every 60s, not every poll

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let healthState = {};       // { serviceId: { status, responseMs, uptime, error } }
let healthInterval = null;
let logProcesses = {};      // { containerId: ChildProcess }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dockerCompose(args, opts = {}) {
  const fullArgs = ['compose', '-p', COMPOSE_PROJECT, '-f', path.join(PROJECT_DIR, 'docker-compose.yml'), ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', fullArgs, { cwd: PROJECT_DIR, ...opts });
    let stdout = '', stderr = '';
    proc.stdout?.on('data', d => stdout += d);
    proc.stderr?.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker compose ${args.join(' ')} failed (${code}): ${stderr}`));
    });
    proc.on('error', reject);
  });
}

function httpHealth(port, path, timeoutMs = 4000) {
  return new Promise(resolve => {
    const start = Date.now();
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, ms: Date.now() - start });
      });
    });
    req.on('error', () => resolve({ ok: false, ms: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeoutMs }); });
  });
}

function dockerInspectHealth(container) {
  return new Promise(resolve => {
    exec(`docker inspect --format='{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}' ${container} 2>/dev/null`, (err, stdout) => {
      if (err) return resolve({ status: 'stopped', uptime: null });
      const [state, health, startedAt] = stdout.trim().replace(/'/g, '').split('|');
      const uptime = startedAt ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000) : null;
      let status = 'stopped';
      if (state === 'running') {
        status = (!health || health === 'healthy' || health === 'none') ? 'healthy' : (health === 'starting' ? 'starting' : 'unhealthy');
      }
      resolve({ status, uptime });
    });
  });
}

async function checkGpu() {
  return new Promise(resolve => {
    exec('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null', (err, stdout) => {
      if (err) return resolve(null);
      const parts = stdout.trim().split(',').map(s => s.trim());
      if (parts.length >= 3) {
        resolve({ utilization: parseInt(parts[0]), memUsedMB: parseInt(parts[1]), memTotalMB: parseInt(parts[2]) });
      } else resolve(null);
    });
  });
}

// ─── Active TTS Mode ──────────────────────────────────────────────────────────

function readAdminKey() {
  try {
    const env = fs.readFileSync(ENV_PATH, 'utf-8');
    const m = env.match(/^ADMIN_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function httpGetJson(pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: 4000, path: pathStr, method: 'GET', timeout: 3000, headers };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchActiveTtsMode() {
  try {
    const adminKey = readAdminKey();
    const headers = {};
    if (adminKey) headers['X-Admin-Key'] = adminKey;

    // Resolve the real tenant (first non-default, non-unknown tenant)
    try {
      const tenantsRes = await httpGetJson('/api/admin/tenants', headers);
      const tenantsList = tenantsRes.tenants || [];
      const realTenant = tenantsList.find(t => t.id !== 'default' && t.id !== 'unknown');
      if (realTenant) headers['X-Tenant-ID'] = realTenant.id;
    } catch { /* proceed without tenant header */ }

    const cfg = await httpGetJson('/api/tts/config', headers);
    const resolved = cfg.ttsMode || cfg.mode || null;
    if (resolved) return resolved;
    // API responded but no mode field — keep current value
    return activeTtsMode;
  } catch {
    // API unreachable or rate-limited — keep current value (don't reset to default)
    return activeTtsMode;
  }
}

// ─── Health Polling ───────────────────────────────────────────────────────────

async function pollHealth() {
  const results = {};
  const promises = SERVICES.map(async svc => {
    const inspect = await dockerInspectHealth(svc.container);
    let httpResult = null;
    if (svc.port && svc.healthPath && inspect.status !== 'stopped') {
      httpResult = await httpHealth(svc.port, svc.healthPath);
    }
    results[svc.id] = {
      status: inspect.status === 'stopped' ? 'stopped'
        : (httpResult ? (httpResult.ok ? 'healthy' : 'unhealthy') : inspect.status),
      responseMs: httpResult?.ms ?? null,
      uptime: inspect.uptime,
    };
  });
  await Promise.all(promises);
  const now = Date.now();
  // Always try to fetch if we haven't resolved TTS yet; otherwise throttle to every 60s
  const shouldFetchTts = !activeTtsMode || (now - lastTtsFetchTime) >= TTS_FETCH_INTERVAL_MS;
  const gpuPromise = checkGpu();
  const ttsPromise = shouldFetchTts ? fetchActiveTtsMode() : Promise.resolve(activeTtsMode);
  const [gpu, ttsMode] = await Promise.all([gpuPromise, ttsPromise]);
  if (shouldFetchTts && ttsMode) lastTtsFetchTime = now;
  if (ttsMode) activeTtsMode = ttsMode;
  healthState = results;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('health-update', { services: results, gpu, activeTtsMode });
  }
  updateTrayIcon();
}

function startHealthPolling() {
  pollHealth();
  healthInterval = setInterval(pollHealth, 5000);
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function getOverallStatus() {
  const states = Object.values(healthState);
  if (states.length === 0) return 'unknown';
  if (states.every(s => s.status === 'healthy')) return 'healthy';
  if (states.some(s => s.status === 'unhealthy' || s.status === 'stopped')) return 'unhealthy';
  return 'starting';
}

function createTrayIcon(color) {
  // Dynamically create a 32x32 colored circle icon
  const size = 32;
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="16" cy="16" r="14" fill="${color}" />
    <text x="16" y="21" text-anchor="middle" fill="white" font-size="14" font-family="sans-serif" font-weight="bold">V</text>
  </svg>`;
  return nativeImage.createFromBuffer(Buffer.from(canvas));
}

function updateTrayIcon() {
  if (!tray) return;
  const status = getOverallStatus();
  const colors = { healthy: '#34d399', starting: '#fbbf24', unhealthy: '#f87171', unknown: '#8a8477' };
  tray.setImage(createTrayIcon(colors[status] || colors.unknown));
  tray.setToolTip(`VeraLux Receptionist — ${status}`);
}

function createTray() {
  tray = new Tray(createTrayIcon('#8a8477'));
  tray.setToolTip('VeraLux Receptionist');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Start All', click: () => dockerAction('up', '-d') },
    { label: 'Stop All', click: () => dockerAction('stop') },
    { label: 'Restart All', click: () => dockerAction('restart') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── Docker Actions via IPC ───────────────────────────────────────────────────

async function dockerAction(action, ...extraArgs) {
  try {
    if (mainWindow) mainWindow.webContents.send('docker-action-start', { action });
    await dockerCompose([action, ...extraArgs]);
    if (mainWindow) mainWindow.webContents.send('docker-action-done', { action, success: true });
    setTimeout(pollHealth, 2000);
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('docker-action-done', { action, success: false, error: err.message });
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function setupIPC() {
  // Docker controls
  ipcMain.handle('docker:start-all', () => dockerAction('up', '-d'));
  ipcMain.handle('docker:stop-all', () => dockerAction('stop'));
  ipcMain.handle('docker:restart-all', () => dockerAction('restart'));
  ipcMain.handle('docker:restart-service', (_e, container) => {
    return new Promise((resolve, reject) => {
      exec(`docker restart ${container}`, (err, _stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        setTimeout(pollHealth, 2000);
        resolve();
      });
    });
  });
  ipcMain.handle('docker:start-service', (_e, container) => {
    return new Promise((resolve, reject) => {
      exec(`docker start ${container}`, (err, _stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        setTimeout(pollHealth, 2000);
        resolve();
      });
    });
  });
  ipcMain.handle('docker:stop-service', (_e, container) => {
    return new Promise((resolve, reject) => {
      exec(`docker stop ${container}`, (err, _stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        setTimeout(pollHealth, 2000);
        resolve();
      });
    });
  });

  // Log streaming
  ipcMain.on('logs:start', (event, { container, lines }) => {
    if (logProcesses[container]) {
      logProcesses[container].kill();
      delete logProcesses[container];
    }
    const proc = spawn('docker', ['logs', '--follow', '--tail', String(lines || 100), '--timestamps', container]);
    logProcesses[container] = proc;
    const send = (data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('logs:data', { container, data: data.toString() });
      }
    };
    proc.stdout.on('data', send);
    proc.stderr.on('data', send);
    proc.on('close', () => { delete logProcesses[container]; });
  });

  ipcMain.on('logs:stop', (_event, { container }) => {
    if (logProcesses[container]) {
      logProcesses[container].kill();
      delete logProcesses[container];
    }
  });

  // Settings (.env)
  ipcMain.handle('settings:load', () => {
    try {
      return fs.readFileSync(ENV_PATH, 'utf-8');
    } catch { return ''; }
  });

  ipcMain.handle('settings:save', (_e, content) => {
    try {
      fs.writeFileSync(ENV_PATH, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get services definition
  ipcMain.handle('services:list', () => SERVICES);

  // Health snapshot
  ipcMain.handle('health:get', () => ({ services: healthState, activeTtsMode }));

  // ─── EULA / License Agreement ──────────────────────────────────────────────
  ipcMain.handle('eula:check', () => {
    try {
      const licenseText = fs.readFileSync(LICENSE_PATH, 'utf-8');
      const currentHash = crypto.createHash('sha256').update(licenseText).digest('hex').slice(0, 16);
      if (fs.existsSync(EULA_ACCEPTANCE_PATH)) {
        const accepted = fs.readFileSync(EULA_ACCEPTANCE_PATH, 'utf-8').trim();
        if (accepted === currentHash) return { accepted: true, licenseText };
      }
      return { accepted: false, licenseText };
    } catch {
      return { accepted: false, licenseText: 'License file not found. Contact nick@veralux.ai.' };
    }
  });

  ipcMain.handle('eula:accept', () => {
    try {
      const licenseText = fs.readFileSync(LICENSE_PATH, 'utf-8');
      const currentHash = crypto.createHash('sha256').update(licenseText).digest('hex').slice(0, 16);
      fs.writeFileSync(EULA_ACCEPTANCE_PATH, currentHash, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get admin API key for owner panel auth
  ipcMain.handle('auth:admin-key', () => {
    try {
      const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
      const match = envContent.match(/^ADMIN_API_KEY=(.+)$/m);
      return match ? match[1].trim() : null;
    } catch { return null; }
  });
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'VeraLux Receptionist',
    icon: ICON_PATH,
    backgroundColor: '#070708',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  setupIPC();
  createTray();
  createWindow();
  startHealthPolling();
});

app.on('window-all-closed', () => {
  // Keep running in tray on Linux
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  if (healthInterval) clearInterval(healthInterval);
  Object.values(logProcesses).forEach(p => p.kill());
});
