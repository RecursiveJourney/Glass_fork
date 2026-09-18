// Test-only preload: stop at the real launcher's application handoff before any
// application network, OS registration, windows or credential persistence occurs.
const Module = require('node:module');
const path = require('node:path');
const appEntry = path.resolve(__dirname, '../../src/index.js');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (typeof parent?.filename === 'string' && path.resolve(path.dirname(parent.filename), request) === appEntry) {
    const { app, BrowserWindow } = require('electron');
    const service = require('../../src/features/settings/mcpSettingsService').getMcpSettingsService();
    const proofIds = [service.newIdentity(), service.newIdentity()];
    let identityBudgetExhausted = false;
    try { service.newIdentity(); } catch (error) { identityBudgetExhausted = error.message === 'proof_identity_budget_exhausted'; }
    const record = {
      electron: process.versions.electron,
      processType: process.type,
      entry: path.resolve(process.argv[1]),
      profile: app.getPath('userData'),
      controlPresent: Boolean(process.env.TWIN_CONTROL_TOKEN),
      providerAbsent: process.env.GEMINI_API_KEY === undefined,
      preloadAbsent: process.env.NODE_OPTIONS === undefined,
      dotenvDisabled: Object.keys(require('dotenv').config().parsed).length === 0,
      proofIds,
      identityBudgetExhausted,
    };
    if (!app.isReady()) app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await window.loadURL('about:blank');
      record.nativeWindowLoaded = !window.isDestroyed() && window.webContents.getURL() === 'about:blank';
      process.stdout.write('MCP_LAUNCH_BOUNDARY:' + JSON.stringify(record) + '\n');
      window.destroy();
      app.exit(0);
    }).catch(() => { process.stderr.write('test_startup_boundary_failed\n'); app.exit(1); });
    return {};
  }
  return originalLoad.apply(this, arguments);
};



