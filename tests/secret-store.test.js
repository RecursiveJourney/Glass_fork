const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
let SecretStore, createSecretRedactor;
try { ({ SecretStore } = require('../src/features/common/services/secretStore')); } catch {}
try { ({ createSecretRedactor } = require('../src/features/common/services/secretRedactor')); } catch {}
// Synthetic authenticated codec: Electron integration separately exercises the OS backend.
function codec() {
    const key = randomBytes(32);
    return {
        isEncryptionAvailable: () => true,
        encryptString(value) {
            const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
            return Buffer.concat([iv, c.getAuthTag(), data]);
        },
        decryptString(blob) {
            const c = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
            c.setAuthTag(blob.subarray(12, 28));
            return Buffer.concat([c.update(blob.subarray(28)), c.final()]).toString('utf8');
        },
    };
}
function store(options = {}) {
    assert.equal(typeof SecretStore, 'function', 'OS-envelope store is implemented');
    return new SecretStore({ codec: codec(), isReady: () => true, platform: 'win32', ...options });
}
const binding = { ref: 'fixture-reference', scope: 'fixture-installation' };
test('sealed credentials survive a new reader with the same OS codec and binding', () => {
    const backend = codec(), first = store({ codec: backend }), second = store({ codec: backend });
    const blob = first.seal('synthetic-secret', binding);
    assert.ok(Buffer.isBuffer(blob));
    assert.equal(blob.includes(Buffer.from('synthetic-secret')), false);
    assert.equal(second.open(blob, binding), 'synthetic-secret');
    assert.deepEqual(second.status({ ...binding, ciphertext: blob }), { hasKey: true, status: 'stored' });
});
test('swapped references, scope, ciphertext and envelope versions fail closed', () => {
    const backend = codec(), s = store({ codec: backend }), blob = s.seal('synthetic-secret', binding);
    for (const b of [{ ...binding, ref: 'another' }, { ...binding, scope: 'another' }]) {
        assert.throws(() => s.open(blob, b), { code: 'credential_corrupt' });
    }
    for (const value of [Buffer.from('not ciphertext'), backend.encryptString(JSON.stringify({ ...binding, formatVersion: 99, value: 'synthetic-secret' }))]) {
        assert.throws(() => s.open(value, binding));
        assert.deepEqual(s.status({ ...binding, ciphertext: value }), { hasKey: true, status: 'locked' });
    }
    assert.deepEqual(s.status(null), { hasKey: false, status: 'missing' });
    assert.deepEqual(s.status({ api_key: 'legacy-synthetic' }), { hasKey: true, status: 'migration_required' });
});
test('unavailable, not-ready and insecure Linux backends cannot seal or open', () => {
    for (const options of [
        { isReady: () => false },
        { codec: { isEncryptionAvailable: () => false } },
        ...['basic_text', 'unknown', undefined].map(backend => ({ platform: 'linux', codec: { ...codec(), getSelectedStorageBackend: () => backend } })),
    ]) {
        const s = store(options);
        assert.throws(() => s.seal('synthetic-secret', binding), { code: 'vault_unavailable' });
        assert.throws(() => s.open(Buffer.from('synthetic'), binding), { code: 'vault_unavailable' });
    }
});
test('registration precedes codec use and failures contain only stable codes', () => {
    const order = [], backend = codec();
    backend.encryptString = () => { order.push('encrypt'); throw Error('synthetic-secret'); };
    const s = store({ codec: backend, registerSecrets: values => { assert.deepEqual(values, ['synthetic-secret']); order.push('register'); } });
    assert.throws(() => s.seal('synthetic-secret', binding), { message: 'storage_write_failed', code: 'storage_write_failed' });
    assert.deepEqual(order, ['register', 'encrypt']);
});
test('main redactor retains late rotated secrets, handles Errors and fails closed at capacity', () => {
    assert.equal(typeof createSecretRedactor, 'function');
    const r = createSecretRedactor({ capacity: 2 }), redact = r.redact;
    r.registerSecrets(['fixture-old']); r.registerSecrets(['fixture-new']);
    assert.equal(redact('fixture-old fixture-new'), '[REDACTED] [REDACTED]');
    assert.deepEqual(redact(new Error('fixture-old')), { code: 'operation_failed' });
    assert.deepEqual(redact({ TWIN_CONTROL_TOKEN: 'unregistered' }), { TWIN_CONTROL_TOKEN: '[REDACTED]' });
    assert.throws(() => r.registerSecrets(['fixture-third']), { code: 'redaction_capacity' });
    assert.throws(() => r.registerSecrets(['x'.repeat(8193)]), { code: 'redaction_capacity' });
    assert.equal(redact('fixture-old'), '[REDACTED]');
});
test('encrypted recovery envelopes preserve a maximum-size key plus source metadata', () => {
    const s = store(), value = JSON.stringify({ api_key: 's'.repeat(8192), original_field: 'preserved' });
    assert.equal(typeof s.sealArchive, 'function');
    const blob = s.sealArchive(value, binding);
    assert.equal(s.openArchive(blob, binding), value);
    assert.throws(() => s.openArchive(blob, { ...binding, ref: 'swapped' }), { code: 'credential_corrupt' });
});
