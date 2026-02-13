// Secure bridge between main and renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('veralux', {
  // Docker controls
  startAll:        () => ipcRenderer.invoke('docker:start-all'),
  stopAll:         () => ipcRenderer.invoke('docker:stop-all'),
  restartAll:      () => ipcRenderer.invoke('docker:restart-all'),
  restartService:  (container) => ipcRenderer.invoke('docker:restart-service', container),
  startService:    (container) => ipcRenderer.invoke('docker:start-service', container),
  stopService:     (container) => ipcRenderer.invoke('docker:stop-service', container),
  recovery:        () => ipcRenderer.invoke('docker:recovery'),
  onRecoveryProgress: (cb) => ipcRenderer.on('recovery-progress', (_e, data) => cb(data)),
  onTriggerRecovery: (cb) => ipcRenderer.on('trigger-recovery', () => cb()),

  // Services
  listServices: () => ipcRenderer.invoke('services:list'),
  getHealth:    () => ipcRenderer.invoke('health:get'),

  // Health updates (push)
  onHealthUpdate:    (cb) => ipcRenderer.on('health-update', (_e, data) => cb(data)),
  onDockerAction:    (cb) => ipcRenderer.on('docker-action-start', (_e, data) => cb('start', data)),
  onDockerActionDone:(cb) => ipcRenderer.on('docker-action-done', (_e, data) => cb('done', data)),

  // Log streaming
  startLogs: (container, lines) => ipcRenderer.send('logs:start', { container, lines }),
  stopLogs:  (container)        => ipcRenderer.send('logs:stop', { container }),
  onLogData: (cb)               => ipcRenderer.on('logs:data', (_e, data) => cb(data)),
  removeLogListeners: ()        => ipcRenderer.removeAllListeners('logs:data'),

  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (content) => ipcRenderer.invoke('settings:save', content),

  // Auth
  getAdminKey: () => ipcRenderer.invoke('auth:admin-key'),

  // EULA / License Agreement
  checkEula:  () => ipcRenderer.invoke('eula:check'),
  acceptEula: () => ipcRenderer.invoke('eula:accept'),
});
