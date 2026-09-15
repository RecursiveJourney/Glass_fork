const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
function harness() {
    const rows = [{ provider: 'openai', hasKey: true, status: 'stored', enabled: false, selected_llm_model: 'saved-offline-model', is_active_llm: 1 }];
    const registered = [], events = [], writes = [];
    const repository = {
        getAll: async () => rows, getByProvider: async p => rows.find(r => r.provider === p),
        getActiveSettings: async () => ({ llm: rows[0], stt: null }), getActiveProvider: async () => rows[0],
        resolveCredential: async () => 'synthetic-provider-secret',
        upsert: async (...args) => writes.push(args), setActiveProvider: async (...args) => writes.push(args),
    };
    const stubs = {
        events: { EventEmitter }, 'electron-store': class { get() {} },
        '../ai/factory': { PROVIDERS: { openai: { llmModels: [{ id: 'other' }], sttModels: [] } }, getProviderClass: () => ({ validateApiKey: async key => { assert.ok(registered.includes(key), 'redaction before validation'); return { success: false, error: key }; } }) },
        './encryptionService': {}, '../repositories/providerSettings': repository,
        './authService': { getCurrentUser: () => ({ isLoggedIn: false }), getCurrentUserId: () => 'default_user' },
        '../repositories/ollamaModel': { getInstalledModels: () => [] }, './localAIManager': new EventEmitter(),
        './secretRedactor': { registerSecrets: values => registered.push(...values) },
    };
    const filename = path.join(__dirname, '../src/features/common/services/modelStateService.js'), module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,console){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(id => { if (Object.hasOwn(stubs, id)) return stubs[id]; throw Error('Unexpected dependency: ' + id); }, module, module.exports, { log() {}, warn() {}, error() {} });
    const service = module.exports; service.on('state-updated', e => events.push(e));
    return { service, rows, writes, events, registered, repository };
}

test('explicit Clear cannot reselect the saved model of a now-unusable provider', async () => {
    const { service, rows, writes } = harness();
    rows[0].hasKey = false; rows[0].status = 'missing';
    rows[0].selected_llm_model = 'other';
    await service._autoSelectAvailableModels(['llm']);
    assert.deepEqual(writes, [[null, 'llm']]);
});

function settingsMethod(name, nextName, api) {
    const source = fs.readFileSync(path.join(__dirname, '../src/ui/settings/SettingsView.js'), 'utf8');
    const body = source.slice(source.indexOf('    async ' + name + '('), source.indexOf('    ' + nextName + '('));
    return vm.runInNewContext('({' + body + '})', { window: { api: { settingsView: api } }, alert() {}, console: { log() {}, error() {} } })[name];
}

test('upstream provider replacement clears input and saving state when IPC rejects', async () => {
    const input = { value: 'synthetic-input' }, view = { shadowRoot: { querySelector: () => input }, saving: false };
    await settingsMethod('handleSaveKey', 'async handleClearKey', { validateKey: async () => { throw Error('synthetic-input'); } }).call(view, 'openai');
    assert.equal(input.value, ''); assert.equal(view.saving, false);
});

test('legacy save handler never retains replacement in component state', async () => {
    const input = { value: 'synthetic-input' }, view = { shadowRoot: { getElementById: () => input }, requestUpdate() {} };
    await settingsMethod('handleSaveApiKey', 'handleQuit', { saveApiKey: async () => ({ success: true }) }).call(view);
    assert.equal(input.value, ''); assert.equal(view.apiKey, undefined);
});
test('public model state is metadata only while main inference can resolve its credential', async () => {
    const { service } = harness();
    const state = await service.getLiveState();
    assert.deepEqual(state.providers.openai, { hasKey: true, status: 'stored', enabled: false });
    assert.equal(state.apiKeys, undefined);
    assert.equal((await service.getCurrentModelInfo('llm')).apiKey, 'synthetic-provider-secret');
    assert.equal(typeof service.getAllApiKeys, 'undefined');
});
test('provider validation registers before use and never returns upstream error text', async () => {
    const { service } = harness();
    assert.deepEqual(await service.validateApiKey('openai', 'synthetic-candidate'), { success: false, error: 'credential_validation_failed' });
});
test('offline startup and local service loss preserve selected model identity', async () => {
    const { service, writes } = harness();
    await service._autoSelectAvailableModels([], true);
    await service.handleLocalAIStateChange('ollama', { running: false, installed: false });
    assert.equal(writes.length, 0);
    assert.equal((await service.getSelectedModels()).llm, 'saved-offline-model');
});
test('raw stored-key IPC and preload APIs are absent', () => {
    for (const file of ['src/preload.js', 'src/bridge/featureBridge.js', 'src/features/settings/settingsService.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.equal(/model:get-all-keys|getAllApiKeys|getAllKeys/.test(source), false, file);
    }
});
test('credential IPC rejects foreign frames and malformed payloads with fixed errors', async () => {
    const handlers = new Map(), filename = path.join(__dirname, '../src/bridge/featureBridge.js');
    const source = fs.readFileSync(filename, 'utf8'), stubs = {};
    for (const [, id] of source.matchAll(/require\('([^']+)'\)/g)) stubs[id] = new EventEmitter();
    const frame = {}, sender = { mainFrame: frame, getURL: () => 'file:///fixture/src/ui/settings.html' };
    const win = { webContents: sender, isDestroyed: () => false };
    stubs.electron = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app: { getAppPath: () => '/fixture' }, BrowserWindow: { fromWebContents: wc => wc === sender ? win : null, getAllWindows: () => [win] } };
    stubs['../features/common/services/localAIManager'].startPeriodicSync = () => {};
    const model = stubs['../features/common/services/modelStateService'];
    model.getProviderConfig = () => ({ openai: {} });
    model.setApiKey = async () => { throw Error('synthetic-secret'); };
    model.handleValidateKey = model.setApiKey;
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(id => stubs[id], module, module.exports);
    module.exports.initialize();
    const handler = handlers.get('model:set-api-key');
    assert.deepEqual(await handler({}, { provider: 'openai', key: 'synthetic-secret' }), { success: false, error: 'untrusted_sender' });
    assert.deepEqual(await handler({ sender, senderFrame: {} }, { provider: 'openai', key: 'synthetic-secret' }), { success: false, error: 'untrusted_sender' });
    assert.deepEqual(await handler({ sender, senderFrame: frame }, { provider: 'openai', key: 'synthetic-secret', extra: true }), { success: false, error: 'invalid_payload' });
    assert.deepEqual(await handler({ sender, senderFrame: frame }, { provider: 'openai', key: 'synthetic-secret' }), { success: false, error: 'credential_operation_failed' });
});
test('web key-save bridge reports validation failure and never returns raw credential errors', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    const setup = source.slice(source.indexOf('function setupWebDataHandlers()'), source.indexOf('async function handleCustomUrl'));
    const eventBridge = new EventEmitter();
    let throwFailure = false;
    const context = { eventBridge, modelStateService: { setApiKey: async () => {
        if (throwFailure) throw Error('synthetic-private-key');
        return { success: false, error: 'credential_validation_failed' };
    } }, require: () => ({}), console: { error() {} } };
    vm.runInNewContext(setup + '\nsetupWebDataHandlers();', context);
    const request = () => new Promise(resolve => { eventBridge.once('result', resolve); eventBridge.emit('web-data-request', 'save-api-key', 'result', { provider: 'openai', apiKey: 'synthetic-private-key' }); });
    const invalid = await request(); assert.equal(invalid.success, false);
    throwFailure = true; const failed = await request(); assert.equal(failed.success, false); assert.equal(failed.error, 'credential_operation_failed');
});
