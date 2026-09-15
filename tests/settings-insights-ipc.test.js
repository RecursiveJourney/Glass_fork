const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { EventEmitter } = require('node:events');
function harness() {
    const filename = path.join(__dirname, '../src/bridge/featureBridge.js'), source = fs.readFileSync(filename, 'utf8'), stubs = {}, handlers = new Map(), sent = [];
    for (const [, id] of source.matchAll(/require\('([^']+)'\)/g)) stubs[id] = new EventEmitter();
    const frame = {}, sender = { mainFrame: frame, getURL: () => 'file:///fixture/src/ui/settings.html' };
    const settings = { webContents: sender, isDestroyed: () => false };
    const header = { isDestroyed: () => false, webContents: { send: (channel, data) => sent.push({ channel, data }) } };
    stubs.electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: { getAppPath: () => '/fixture' }, BrowserWindow: { fromWebContents: value => value === sender ? settings : null, getAllWindows: () => [] } };
    stubs['../features/common/services/localAIManager'].startPeriodicSync = () => {};
    stubs['../features/settings/settingsInsightsService'] = { getSettingsInsightsService: () => ({ read: async () => ({ server: { state: 'reachable' } }) }) };
    const listen = stubs['../features/listen/listenService']; listen.getListenState = () => ({ phase: 'idle' });
    stubs['../window/windowManager'] = { windowPool: new Map([['settings', settings], ['header', header]]), closeSettingsWindow: () => sent.push({ channel: 'hidden-settings' }) };
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(id => stubs[id], module, module.exports); module.exports.initialize();
    return { handlers, event: { sender, senderFrame: frame }, sent, listen };
}

test('insights IPC is metadata-only, trusted-frame and no-payload', async () => {
    const h = harness(), handler = h.handlers.get('twin:insights');
    assert.equal(typeof handler, 'function');
    assert.deepEqual(await handler({}), { success: false, error: 'untrusted_sender' });
    assert.deepEqual(await handler(h.event, { path: 'private' }), { success: false, error: 'invalid_payload' });
    assert.deepEqual(await handler(h.event), { success: true, data: { server: { state: 'reachable' } } });
});

test('Setup targets the header through main IPC and refuses an active Listen', async () => {
    const h = harness(), handler = h.handlers.get('settings:open-setup');
    assert.equal(typeof handler, 'function');
    assert.deepEqual(await handler({ ...h.event, senderFrame: {} }), { success: false, error: 'untrusted_sender' });
    assert.deepEqual(await handler(h.event, {}), { success: false, error: 'invalid_payload' });
    h.listen.getListenState = () => ({ phase: 'active' });
    assert.deepEqual(await handler(h.event), { success: false, error: 'listen_active' }); assert.equal(h.sent.length, 0);
    h.listen.getListenState = () => ({ phase: 'stopped' });
    assert.deepEqual(await handler(h.event), { success: true });
    assert.ok(h.sent.some(item => item.channel === 'header:setup-requested'));
});
