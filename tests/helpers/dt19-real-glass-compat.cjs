// Launch src/index.js unchanged. Only external I/O and real screen capture are
// blocked; production windows, preload, IPC, services and repositories are used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.env.DT19_COMPAT_OUTPUT;
if (!output || !path.isAbsolute(output) || !process.env.GLASS_USER_DATA_DIR?.startsWith(output + path.sep)) throw Error('isolated_profile_required');
const { app, session, BrowserWindow, desktopCapturer, dialog } = require('electron');
app.setAppPath(path.resolve(__dirname, '../..'));
app.setPath('userData', process.env.GLASS_USER_DATA_DIR); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
const listenerOrigin = new URL(process.env.TWIN_CONTROL_URL).origin;
const blocked = [], rendererRequests = [];
let stage = 'startup';
const net = require('node:net'), connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = net._normalizeArgs(args)[0];
  const host = normalized.host || 'localhost';
  if (normalized.port && !['localhost', '127.0.0.1', '::1'].includes(host)) { blocked.push('node_external'); throw Error('external_network_blocked'); }
  return connect.apply(this, args);
};
// Never read the workspace dotenv file or capture the user's desktop.
require('dotenv').config = () => ({ parsed: {} });
desktopCapturer.getSources = async () => [];
dialog.showErrorBox = () => { throw Error('real_app_startup_dialog'); };
require('electron-updater').autoUpdater.checkForUpdatesAndNotify = async () => null;
require('electron-updater').autoUpdater.checkForUpdates = async () => null;
app.on('browser-window-created', (_event, win) => {
  win.webContents.openDevTools = () => {};
  win.on('show', () => win.hide());
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) {
      const u = new URL(details.url);
      if (u.origin === listenerOrigin) rendererRequests.push({ method: details.method, path: u.pathname });
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { blocked.push('chromium_external'); callback({ cancel: true }); return; }
    }
    callback({});
  });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 25000;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error(label); await pause(100); }
}
require('../../src/index.js');
(async () => {
  const windows = require('../../src/window/windowManager');
  await until(() => windows.windowPool.has('header'), 'header_not_created');
  const model = require('../../src/features/common/services/modelStateService');
  stage = 'local_model';
  assert.equal((await model.setApiKey('ollama', 'local')).success, true);
  const installed = await require('../../src/features/common/services/ollamaService').getInstalledModels();
  assert.ok(installed.some(item => item.name === 'rj-twin'));
  // Seed only this isolated profile's selection catalogue from the real tags reply.
  require('../../src/features/common/repositories/ollamaModel').upsertModel({ name: 'rj-twin', size: '0', installed: true });
  assert.notEqual(await model.setSelectedModel('llm', 'rj-twin'), false);
  windows.handleHeaderStateChanged('main');
  await until(() => windows.windowPool.has('settings') && windows.windowPool.has('ask'), 'feature_windows_missing');
  const settings = windows.windowPool.get('settings'), ask = windows.windowPool.get('ask');
  await until(() => !settings.webContents.isLoading() && !ask.webContents.isLoading(), 'renderer_not_loaded');
  stage = 'insights';
  const state = await settings.webContents.executeJavaScript(`(async()=>{const r=await window.api.settingsView.getTwinInsights();if(!r.success)throw Error('insights_failed');return r.data;})()`);
  assert.equal(state.server.state, 'reachable'); assert.equal(state.knowledge.state, 'current');
  assert.equal(state.knowledge.data.dossier.name, 'compatibility.txt');
  // Inspect the actual settings renderer and its nested production components.
  const painted = await settings.webContents.executeJavaScript(`(async()=>{const walk=root=>{for(const e of root.querySelectorAll('*')){if(e.localName==='twin-insights-settings')return e;const found=e.shadowRoot&&walk(e.shadowRoot);if(found)return found;}};let c;const end=Date.now()+5000;while(!(c=walk(document))){if(Date.now()>end)throw Error('insights_component_missing');await new Promise(r=>setTimeout(r,50));}await c.refresh();await c.updateComplete;return {text:c.shadowRoot.textContent,rows:Object.fromEntries([...c.shadowRoot.querySelectorAll('.row')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]))};})()`);
  assert.match(painted.text, /Knowledge/); assert.match(painted.text, /compatibility.txt/);
  fs.writeFileSync(path.join(output, 'rendered-status.json'), JSON.stringify(painted.rows, null, 2));
  for (const [name, value] of [['Digital Twin server', 'Reachable'], ['Gemini', 'Not tested'], ['Transcription', 'Fireflies · Unconfigured'], ['Fireflies', 'Unconfigured'], ['MCP', 'Disabled']]) assert.ok(painted.rows[name]?.includes(value), name + ' rendered state');
  stage = 'meeting_reconciliation';
  const meeting = await settings.webContents.executeJavaScript(`(async()=>{const r=await window.api.settingsView.getTwinSettings();if(!r.success)throw Error('meeting_read');return window.api.settingsView.saveTwinSettings({expectedRevision:r.data.savedRevision,enabled:true,meetingLink:'https://meet.google.com/abc-defg-hij',credential:{action:'set',value:'synthetic-dt19-fireflies'}});})()`);
  assert.equal(meeting.success, true);
  await until(async () => { const r = await settings.webContents.executeJavaScript('window.api.settingsView.getTwinSettings()'); return r.success && r.data.savedRevision === 1 && r.data.appliedRevision === 1 && r.data.state === 'applied'; }, 'meeting_not_applied');
  stage = 'mcp_reconciliation';
  const mcp = await settings.webContents.executeJavaScript(`(async()=>{const r=await window.api.settingsView.getMcpSettings();if(!r.success)throw Error('mcp_read');return window.api.settingsView.saveMcpSettings({expectedRevision:r.data.savedRevision,config:{schemaVersion:1,revision:r.data.savedRevision+1,connections:[]},credentials:[]});})()`);
  assert.equal(mcp.success, true);
  await until(async () => { const r = await settings.webContents.executeJavaScript('window.api.settingsView.getMcpSettings()'); return r.success && r.data.savedRevision === 1 && r.data.appliedRevision === 1 && r.data.state === 'applied'; }, 'mcp_not_applied');
  stage = 'ask';
  const answer = await ask.webContents.executeJavaScript("window.api.askView.sendMessage('Synthetic compatibility question')");
  assert.equal(answer.success, true);
  const askState = require('../../src/features/ask/askService').state;
  assert.match(askState.currentResponse, /Synthetic Glass compatibility answer/);
  stage = 'complete';
  fs.writeFileSync(path.join(output, 'glass-result.json'), JSON.stringify({ passed: true, entry: 'glass/src/index.js',
    runtime: { execPath: process.execPath, node: process.versions.node, electron: process.versions.electron, processType: process.type },
    renderedStates: painted.rows, rendererListenerRequests: rendererRequests.length, rendererRequests, blockedExternalAttempts: blocked.length,
    assertions: ['status_pills', 'knowledge', 'meeting_reconciliation', 'mcp_reconciliation', 'renderer_ipc_ask'], externalInvitations: 0 }, null, 2));
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  app.exit(0);
})().catch(error => {
  fs.writeFileSync(path.join(output, 'glass-result.json'), JSON.stringify({ passed: false, stage, code: error.code || error.message, rendererListenerRequests: rendererRequests.length, blockedExternalAttempts: blocked.length }, null, 2));
  app.exit(1);
});
