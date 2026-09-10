/*
 * Endpoint-only Ollama regression tests. Run with Node 20: node --test tests/ollama-endpoint.test.js
 * Dependencies are stubbed to avoid Electron, processes, network, and the user's database.
 * Known upstream issue (outside this patch): SettingsView.handleSaveKey returns when
 * #key-input-ollama is absent before reaching its local-provider branch. Initial
 * registration here follows ApiKeyHeader's existing welcome submission sequence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');

const serviceDir = path.join(__dirname, '../src/features/common/services');
function loadService(name, stubs) {
    const filename = path.join(serviceDir, name);
    const module = { exports: {} };
    const load = id => {
        if (Object.hasOwn(stubs, id)) return stubs[id];
        if (isBuiltin(id)) return require(id);
        throw new Error('Unexpected dependency: ' + id);
    };
    const execute = vm.runInThisContext(
        '(function(require,module,exports,console){' + fs.readFileSync(filename, 'utf8') + '\n})',
        { filename }
    );
    execute(load, module, module.exports, { log() {}, warn() {}, error() {} });
    return module.exports;
}

function harness({ platform = 'win32', binary = false, appExists = false,
    healthy = true, rejectHealth = false, models = [{ name: 'rj-twin' }] } = {}) {
    const rows = new Map();
    const requests = [];
    const commands = [];
    const repository = {
        getInstalledModels: () => [...rows.values()].filter(row => row.installed),
        updateInstallStatus(name, installed, installing) {
            if (rows.has(name)) Object.assign(rows.get(name), { installed, installing });
        },
        upsertModel(row) { rows.set(row.name, { ...row }); }
    };
    const service = loadService('ollamaService.js', {
        electron: { app: {} },
        util: {
            promisify: fn => (...args) => new Promise((resolve, reject) =>
                fn(...args, (error, stdout, stderr) =>
                    error ? reject(error) : resolve({ stdout, stderr })))
        },
        child_process: {
            exec(command, callback) {
                commands.push(command);
                callback(binary ? null : new Error('not found'), binary ? '/local/ollama' : '');
            },
            spawn() { throw new Error('Unexpected process start'); }
        },
        fs: { promises: { async access() { if (!appExists) throw new Error('not found'); } } },
        'node-fetch': async (url, options) => {
            const route = new URL(url).pathname;
            requests.push({ route, ...options });
            if (route === '/api/ps') {
                if (rejectHealth) throw new Error('connection refused');
                return { ok: healthy, json: async () => ({ models: [] }) };
            }
            if (route === '/api/tags') return { ok: true, json: async () => ({ models }) };
            if (route === '/api/chat') return { ok: true, json: async () => ({ message: { content: 'OK' } }) };
            throw new Error('Unexpected route: ' + route);
        },
        '../utils/spawnHelper': { spawnAsync() { throw new Error('Unexpected process start'); } },
        '../config/checksums': { DOWNLOAD_CHECKSUMS: {} },
        '../repositories/ollamaModel': repository
    });
    service.getPlatform = () => platform;
    return { service, rows, requests, commands, repository };
}

for (const platform of ['win32', 'linux', 'darwin']) {
    test(platform + ': healthy endpoint is usable without a local installation', async () => {
        const h = harness({ platform });
        assert.equal(await h.service.isInstalled(), true);
        assert.equal(h.commands[0], platform === 'win32' ? 'where ollama' :
            platform === 'darwin' ? 'which /Applications/Ollama.app/Contents/Resources/ollama' : 'which ollama');
        assert.equal(h.requests[0].route, '/api/ps');
    });
}
test('missing binary and unhealthy endpoint remain uninstalled', async () => {
    assert.equal(await harness({ healthy: false }).service.isInstalled(), false);
});
test('connection failure remains uninstalled without throwing', async () => {
    assert.equal(await harness({ rejectHealth: true }).service.isInstalled(), false);
});
test('local binary preserves installed-but-stopped status', async () => {
    const h = harness({ binary: true, healthy: false });
    assert.equal(await h.service.isInstalled(), true);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(await h.service.handleGetStatus(),
        { success: true, installed: true, running: false, models: [] });
});
test('macOS application detection still succeeds without a health probe', async () => {
    const h = harness({ platform: 'darwin', appExists: true, healthy: false });
    assert.equal(await h.service.isInstalled(), true);
    assert.equal(h.commands.length, 0);
    assert.equal(h.requests.length, 0);
});
test('both status entry points expose endpoint-only models', async () => {
    const h = harness();
    for (const method of ['getStatus', 'handleGetStatus']) {
        const status = await h.service[method]();
        assert.equal(status.installed, true);
        assert.equal(status.running, true);
        assert.equal(status.models[0].name, 'rj-twin');
    }
});
test('discovery inserts a missing model with fallback size and remains idempotent', async () => {
    const h = harness();
    await h.service.syncState();
    await h.service.syncState();
    assert.equal(h.rows.size, 1);
    assert.deepEqual(h.rows.get('rj-twin'),
        { name: 'rj-twin', size: 'Unknown', installed: true, installing: false });
});
test('discovery refreshes an existing model and preserves a zero size', async () => {
    const h = harness({ models: [{ name: 'existing', size: 0 }] });
    h.rows.set('existing', { name: 'existing', size: 'old', installed: false, installing: true });
    await h.service.syncState();
    assert.deepEqual(h.rows.get('existing'),
        { name: 'existing', size: 0, installed: true, installing: false });
});
test('readiness waits for asynchronous synchronization before returning', async () => {
    const h = harness({ binary: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let syncStarted = false;
    h.service.syncState = async () => { syncStarted = true; await gate; };
    let finished = false;
    const ready = h.service.handleEnsureReady().then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(syncStarted, true);
    assert.equal(finished, false);
    release();
    assert.deepEqual(await ready, { success: true });
});
test('installed but stopped service is started before readiness synchronization', async () => {
    const h = harness({ binary: true, healthy: false });
    const order = [];
    h.service.startService = async () => { order.push('start'); };
    h.service.syncState = async () => { order.push('sync'); };
    assert.deepEqual(await h.service.handleEnsureReady(), { success: true });
    assert.deepEqual(order, ['start', 'sync']);
});
test('first welcome submission registers, selects and warms a discovered model before a timer tick', async () => {
    const h = harness();
    const settings = new Map();
    const active = {};
    let warming;
    const state = loadService('modelStateService.js', {
        'electron-store': class {},
        '../ai/factory': {
            PROVIDERS: require('../src/features/common/ai/factory').PROVIDERS,
            getProviderClass: () => ({ validateApiKey: async () => ({ success: true }) })
        },
        './encryptionService': {},
        './authService': { getCurrentUser: () => ({ isLoggedIn: false }) },
        '../repositories/ollamaModel': h.repository,
        '../repositories/providerSettings': {
            getAll: async () => [...settings.values()],
            getByProvider: async provider => settings.get(provider),
            upsert: async (provider, value) => settings.set(provider, { provider, ...value }),
            setActiveProvider: async (provider, type) => { active[type] = provider; },
            getActiveSettings: async () => ({ llm: settings.get(active.llm), stt: settings.get(active.stt) })
        },
        './localAIManager': { warmUpModel: model => (warming = h.service.warmUpModel(model)) }
    });
    // Same backend order as ApiKeyHeader: ensure ready, validate local, save selection.
    assert.deepEqual(await h.service.handleEnsureReady(), { success: true });
    assert.equal(h.rows.has('rj-twin'), true);
    assert.equal(settings.size, 0); // Discovery does not silently activate a provider.
    assert.deepEqual(await state.handleValidateKey('ollama', 'local'), { success: true });
    assert.equal(await state.handleSetSelectedModel('llm', 'rj-twin'), true);
    await warming;
    assert.equal(settings.get('ollama').api_key, 'local');
    assert.equal(settings.get('ollama').selected_llm_model, 'rj-twin');
    assert.equal(active.llm, 'ollama');
    assert.deepEqual(await state.getAvailableModels('llm'), [{ id: 'rj-twin', name: 'rj-twin' }]);
    assert.deepEqual(await state.handleValidateKey('whisper', 'local'), { success: true });
    assert.equal(await state.handleSetSelectedModel('stt', 'whisper-tiny'), true);
    assert.equal(active.stt, 'whisper');
    assert.equal(await state.areProvidersConfigured(), true);
    const chat = h.requests.find(request => request.route === '/api/chat');
    assert.ok(chat);
    assert.deepEqual(JSON.parse(chat.body), {
        model: 'rj-twin', messages: [{ role: 'user', content: 'Hi' }],
        stream: false, options: { num_predict: 1, temperature: 0 }
    });
});

function readinessState(settings, models = [{ name: 'rj-twin', installed: 1 }], isLoggedIn = false) {
    return loadService('modelStateService.js', {
        'electron-store': class {},
        '../ai/factory': require('../src/features/common/ai/factory'),
        './encryptionService': {},
        './authService': { getCurrentUser: () => ({ isLoggedIn }) },
        '../repositories/ollamaModel': { getInstalledModels: () => models },
        '../repositories/providerSettings': { getAll: async () => settings }
    });
}

const localOllama = { provider: 'ollama', api_key: 'local' };
const localWhisper = { provider: 'whisper', api_key: 'local' };
for (const [name, settings, models, expected] of [
    ['discovery without Ollama registration is not configured', [localWhisper], undefined, false],
    ['empty Ollama registration key is not configured',
        [{ provider: 'ollama', api_key: '' }, localWhisper], undefined, false],
    ['Ollama registration without installed models is not configured',
        [localOllama, localWhisper], [], false],
    ['Ollama without an STT provider is not configured', [localOllama], undefined, false],
    ['cloud provider with LLM and STT remains configured without Ollama models',
        [{ provider: 'openai', api_key: 'fake-test-key' }], [], true],
    ['cloud provider without a key remains unconfigured',
        [{ provider: 'openai', api_key: '' }, localWhisper], undefined, false],
    ['Whisper alone still cannot satisfy the LLM requirement', [localWhisper], [], false]
]) {
    test(name, async () => {
        assert.equal(await readinessState(settings, models).areProvidersConfigured(), expected);
    });
}
test('Firebase login still bypasses local provider configuration', async () => {
    assert.equal(await readinessState([], [], true).areProvidersConfigured(), true);
});
