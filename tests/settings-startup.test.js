const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
function load(relative, stubs) {
    const filename = path.join(__dirname, '../src', relative), module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,console){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(id => Object.hasOwn(stubs, id) ? stubs[id] : require(id), module, module.exports, { log() {}, warn() {}, error() {} });
    return module.exports;
}
test('malformed preference file surfaces failure and cannot overwrite the original', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-config-'));
    try {
        fs.mkdirSync(path.join(dir, '.pickleglass')); const file = path.join(dir, '.pickleglass/config.json'); fs.writeFileSync(file, '{broken');
        const config = load('features/common/config/config.js', { os: { homedir: () => dir } });
        assert.equal(config.loadError, 'config_read_failed');
        assert.throws(() => config.saveUserConfig(), { code: 'config_read_failed' });
        assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    } finally { fs.rmSync(dir, { recursive: true }); }
});
test('atomic preference save surfaces rename failure and preserves last readable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-config-'));
    try {
        fs.mkdirSync(path.join(dir, '.pickleglass')); const file = path.join(dir, '.pickleglass/config.json'); fs.writeFileSync(file, '{"apiTimeout":42}');
        const config = load('features/common/config/config.js', { os: { homedir: () => dir }, fs: { ...fs, renameSync() { throw Error('synthetic-io'); } } });
        config.set('apiTimeout', 43);
        assert.throws(() => config.saveUserConfig(), { code: 'config_write_failed' });
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiTimeout, 42);
    } finally { fs.rmSync(dir, { recursive: true }); }
});
test('legacy decryption only reads an existing owner key and never creates one', async () => {
    const crypto = require('node:crypto'), key = Buffer.alloc(32, 9), iv = Buffer.alloc(16, 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update('synthetic-legacy'), cipher.final()]);
    const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    let writes = 0;
    const service = load('features/common/services/encryptionService.js', {
        keytar: { getPassword: async (_service, owner) => owner === 'alice' ? key.toString('hex') : null, setPassword: async () => writes++ },
        './permissionService': {}, './secretRedactor': { registerSecrets() {} },
    });
    assert.equal(typeof service.readExistingLegacy, 'function');
    assert.equal(await service.readExistingLegacy(ciphertext, 'alice'), 'synthetic-legacy');
    await assert.rejects(service.readExistingLegacy(ciphertext, 'bob'), { code: 'credential_locked' });
    assert.equal(writes, 0);
});
test('startup diagnostics keep only allowlisted metadata and redact console errors', () => {
    let createStartupDiagnostics;
    try { ({ createStartupDiagnostics } = require('../src/features/common/services/startupDiagnostics')); } catch {}
    assert.equal(typeof createStartupDiagnostics, 'function');
    const records = [];
    const diag = createStartupDiagnostics({ output: record => records.push(record) });
    diag.record('migration', { status: 'ready', providerCount: 2, api_key: 'synthetic-input', rows: [{ secret: 'synthetic-input' }] });
    assert.equal(JSON.stringify(records).includes('synthetic-input'), false);
    assert.equal(records[0].providerCount, 2);
});
test('auth resolves identity before any legacy-key generation or virtual-key write', async () => {
    let callback, generated = 0, requested = 0;
    const service = load('features/common/services/authService.js', {
        'firebase/auth': { onAuthStateChanged: (_auth, fn) => { callback = fn; } },
        electron: { BrowserWindow: { getAllWindows: () => [] }, shell: {} },
        './firebaseClient': { getFirebaseAuth: () => ({}) },
        'node-fetch': async () => { requested++; return { ok: true, json: async () => ({ data: { virtualKey: 'synthetic-virtual' } }) }; },
        './encryptionService': { initializeKey: async () => generated++, resetSessionKey() {} },
        './migrationService': { checkAndRunMigration() {} },
        '../repositories/session': { setAuthService() {}, endAllActiveSessions: async () => {} },
        '../repositories/providerSettings': {}, './permissionService': { checkKeychainCompleted: async () => true },
        './secretRedactor': { registerSecrets() {} },
    });
    const initialized = service.initialize();
    await callback({ uid: 'alice', email: 'synthetic@example.invalid', getIdToken: async () => 'synthetic-token' });
    await initialized;
    assert.equal(service.getCurrentUserId(), 'alice');
    assert.equal(generated, 0); assert.equal(requested, 0);
    assert.equal(typeof service.completeCredentialInitialization, 'function');
});
test('post-migration compaction failure is distinct and never resets data', () => {
    const { compactCredentialStorage } = require('../src/features/common/services/settingsMigrationService');
    assert.equal(typeof compactCredentialStorage, 'function');
    const commands = [];
    const result = compactCredentialStorage({ pragma: command => { commands.push(command); throw Error('synthetic-disk-failure'); }, exec: command => commands.push(command) });
    assert.deepEqual(result, { status: 'compaction_pending', code: 'compaction_failed' });
    assert.deepEqual(commands, ['wal_checkpoint(TRUNCATE)']);
});
