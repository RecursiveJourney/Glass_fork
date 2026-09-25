const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../src');
const target = 'http://127.0.0.1:11435';
function load(relative, stubs = {}, env = { TWIN_CONTROL_URL: target }) {
    const filename = path.join(root, relative), module = { exports: {} }, local = createRequire(filename);
    const context = { require: id => Object.hasOwn(stubs, id) ? stubs[id] : local(id), module, exports: module.exports,
        process: { ...process, env: { ...env } }, console: { log() {}, warn() {}, error() {} },
        URL, Buffer, AbortController, ReadableStream, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone };
    // Resolver uses this module's test environment, not the runner's environment.
    context.require = id => Object.hasOwn(stubs, id) ? stubs[id] : id.endsWith('/twinEndpoint') || id === './twinEndpoint'
        ? load('features/common/services/twinEndpoint.js', {}, env) : local(id);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
}
function serviceHarness() {
    const requests = [], commands = [];
    const service = load('features/common/services/ollamaService.js', {
        electron: { app: {} }, 'node-fetch': async url => { requests.push(String(url)); return { ok: true, json: async () => ({ models: [] }) }; },
        child_process: { exec(c, cb) { commands.push(c); cb(null, 'installed'); }, spawn() { commands.push('spawn'); throw Error('unexpected_spawn'); } },
        '../utils/spawnHelper': { spawnAsync: async c => commands.push(c) },
        '../config/checksums': { DOWNLOAD_CHECKSUMS: {} }, '../repositories/ollamaModel': {}
    });
    return { service, requests, commands };
}
test('configured twin origin routes Ollama health and model discovery', async () => {
    const h = serviceHarness();
    await h.service.isServiceRunning(); await h.service.makeRequest('/api/tags');
    assert.deepEqual(h.requests, [target + '/api/ps', target + '/api/tags']);
});
test('configured twin endpoint never starts or kills machine-wide Ollama', async () => {
    const h = serviceHarness();
    assert.equal(await h.service.startService(), true);
    assert.equal(await h.service.stopService(), true);
    assert.equal(await h.service.shutdown(true), true);
    assert.deepEqual(h.commands, []);
});
test('configured twin origin routes provider validation, generateContent, chat and streaming', async () => {
    const requests = [];
    const provider = load('features/common/ai/providers/ollama.js', {
        'node-fetch': async url => { requests.push(String(url)); return { ok: true, json: async () => ({ message: { content: 'offline' } }), body: require("node:stream").Readable.from([]) }; }
    });
    await provider.OllamaProvider.validateApiKey();
    await provider.createLLM({ model: 'rj-twin' }).generateContent(['hello']);
    await provider.createLLM({ model: 'rj-twin' }).chat([{ role: 'user', content: 'hello' }]);
    await provider.createStreamingLLM({ model: 'rj-twin' }).streamChat([{ role: 'user', content: 'hello' }]);
    assert.deepEqual(requests, [target + '/api/tags', ...Array(3).fill(target + '/api/chat')]);
});
test('configured twin origin routes meeting subscription', () => {
    const urls = [];
    const MeetingFeedService = load('features/listen/meeting/meetingFeedService.js');
    const feed = new MeetingFeedService({ requestImpl(url) { urls.push(String(url)); const req = new EventEmitter(); req.end = () => {}; req.destroy = () => {}; return req; } });
    try { feed.start(); assert.deepEqual(urls, [target + '/v1/live/events']); } finally { feed.stop(); }
});
test('configured twin origin routes both control clients', async () => {
    const urls = [];
    const http = { request(url) { urls.push(String(url)); const req = new EventEmitter(); req.end = () => queueMicrotask(() => { req.emit('error', Error('offline')); req.emit('close'); }); return req; } };
    for (const [file, name] of [['twinRuntimeClient', 'TwinRuntimeClient'], ['mcpRuntimeClient', 'McpRuntimeClient']]) {
        const C = load('features/common/services/' + file + '.js', { 'node:http': http }, { TWIN_CONTROL_URL: target, TWIN_CONTROL_TOKEN: 'synthetic-control-'.repeat(3) })[name];
        await assert.rejects(new C().getState());
    }
    assert.deepEqual(urls, [target + '/v1/runtime-config', target + '/v1/mcp']);
});
test('explicit Glass profile is applied before the first application service import', () => {
    const wanted = path.resolve(__dirname, '../../../digital_twin-dev-runtime/glass-test'), boundary = Error('boundary');
    let profile = 'demo-default';
    const app = { setPath(name, value) { if (name === 'userData') profile = value; }, getPath() { return profile; } };
    assert.throws(() => load('index.js', {
        dotenv: { config() {} }, './features/common/services/secretRedactor': { registerSecrets() {} },
        './features/common/services/startupDiagnostics': { installConsoleRedaction() {} },
        'electron-squirrel-startup': false, electron: { app },
        './window/windowManager.js': (() => { const stub = {}; Object.defineProperty(stub, 'createWindows', { get() { throw boundary; } }); return stub; })()
    }, { TWIN_CONTROL_URL: target, GLASS_USER_DATA_DIR: wanted }), e => e === boundary);
    assert.equal(profile, wanted);
});
test('explicit profile keeps legacy user config out of the shared home directory', () => {
    const profile = path.resolve(__dirname, '../../../digital_twin-dev-runtime/glass-test');
    const reads = [];
    const config = load('features/common/config/config.js', { fs: {
        existsSync: () => true, readFileSync(p) { reads.push(p); throw Object.assign(Error('missing'), { code: 'ENOENT' }); }
    } }, { GLASS_USER_DATA_DIR: profile });
    assert.equal(config.getUserConfigPath(), path.join(profile, 'config.json'));
    assert.deepEqual(reads, [path.join(profile, 'config.json')]);
});
test('explicit profiles use different legacy keychain namespaces and never the demo namespace', async () => {
    const namespaces = [];
    for (const suffix of ['one', 'two']) {
        const profile = path.resolve(__dirname, '../../../digital_twin-dev-runtime/' + suffix);
        const service = load('features/common/services/encryptionService.js', {
            keytar: { async getPassword(service) { namespaces.push(service); return 'a'.repeat(64); } },
            './permissionService': { async markKeychainCompleted() {} }
        }, { GLASS_USER_DATA_DIR: profile });
        await service.initializeKey('synthetic-owner');
    }
    assert.ok(namespaces.every(name => name !== 'com.pickle.glass'));
    assert.notEqual(namespaces[0], namespaces[1]);
});
test('explicit profile scopes the embedded web runtime config file', async () => {
    const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const body = source.slice(source.indexOf('async function startWebStack()'));
    const paths = [], sentinel = Error('stop-before-servers');
    const profile = path.resolve(__dirname, '../../../digital_twin-dev-runtime/glass-test');
    const context = { process: { env: { GLASS_USER_DATA_DIR: profile } }, console: { log() {} }, path,
        __dirname: root, eventBridge: {}, getAvailablePort: async () => 12345,
        app: { isPackaged: false, getPath: name => name === 'userData' ? profile : 'shared-temp' },
        require: id => id === 'net' ? { createServer() { return { listen(port, cb) { cb(); }, address() { return { port: 12345 }; }, close(cb) { cb(); } }; } } : id === 'fs' ? { existsSync: () => true, writeFileSync(p) { paths.push(p); throw sentinel; } } : () => ({}) };
    vm.createContext(context);
    vm.runInContext(body + '\nthis.run = startWebStack;', context);
    await assert.rejects(context.run(), e => e === sentinel);
    assert.deepEqual(paths, [path.join(profile, 'runtime-config.json')]);
});
test('explicit profile keeps managed speech models and temporary audio separate', async () => {
    const profile = path.resolve(__dirname, '../../../digital_twin-dev-runtime/glass-test');
    const service = load('features/common/services/whisperService.js', {
        '../utils/spawnHelper': {}, '../config/checksums': { DOWNLOAD_CHECKSUMS: {} }
    }, { GLASS_USER_DATA_DIR: profile });
    service.ensureDirectories = async () => {};
    service.ensureWhisperBinary = async () => {};
    await service.initializeOnce();
    assert.equal(service.modelsDir, path.join(profile, 'whisper', 'models'));
    assert.equal(service.tempDir, path.join(profile, 'whisper', 'temp'));
});
test('origin resolver preserves default, normalizes configured roots, and rejects unsafe input without leaking it', () => {
    assert.equal(load('features/common/services/twinEndpoint.js', {}, {}).twinBaseUrl(), 'http://localhost:11434');
    assert.equal(load('features/common/services/twinEndpoint.js', {}, { TWIN_CONTROL_URL: target + '/' }).twinBaseUrl(), target);
    for (const value of ['', 'https://127.0.0.1:11435', 'http://external.example', target + '/path', target + '?secret=x', 'http://secret:password@localhost:11435']) {
        assert.throws(() => load('features/common/services/twinEndpoint.js', {}, { TWIN_CONTROL_URL: value }).twinBaseUrl(), e => e.message === 'invalid_runtime_url');
    }
});
test('model suggestions use the configured HTTP endpoint without invoking Ollama CLI', async () => {
    const h = serviceHarness();
    await h.service.getInstalledModelsList();
    assert.deepEqual(h.commands, []);
    assert.deepEqual(h.requests, [target + '/api/tags']);
});
test('externally managed endpoint rejects global installation before platform dispatch', async () => {
    const h = serviceHarness();
    h.service.installWindows = h.service.installMacOS = h.service.installLinux = async () => h.commands.push('installer');
    await assert.rejects(h.service.autoInstall(), /externally_managed_service/);
    assert.deepEqual(h.commands, []);
});
test('repair cannot kill or install machine-wide Ollama for an external twin', async () => {
    const h = serviceHarness(), commands = [];
    const manager = load('features/common/services/localAIManager.js', {
        './ollamaService': h.service, './whisperService': new EventEmitter(),
        child_process: { exec(command, cb) { commands.push(command); cb(null, ''); } }
    });
    manager.runDiagnostics = async () => ({ summary: { overallStatus: 'unhealthy' }, checks: { port: { status: 'fail' } } });
    manager.stopService = manager.startService = async () => {};
    manager.updateServiceState = async () => {};
    const result = await manager.repairService('ollama');
    assert.deepEqual(commands, []);
    assert.equal(result.success, false);
    assert.equal(result.error, 'externally_managed_service');
});
