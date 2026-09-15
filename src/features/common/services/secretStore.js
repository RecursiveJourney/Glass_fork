const redactor = require('./secretRedactor');
function fail(code) { return Object.assign(new Error(code), { code }); }

class SecretStore {
    constructor({ codec, isReady, platform = process.platform, registerSecrets = redactor.registerSecrets } = {}) {
        // Lazy loading keeps module import independent from Electron readiness.
        this.codec = codec;
        this.isReady = isReady;
        this.platform = platform;
        this.registerSecrets = registerSecrets;
    }
    backend() {
        const codec = this.codec || require('electron').safeStorage;
        const ready = this.isReady || (() => require('electron').app.isReady());
        try {
            if (!ready() || !codec.isEncryptionAvailable()) throw fail('vault_unavailable');
            if (this.platform === 'linux' && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(codec.getSelectedStorageBackend?.())) throw fail('vault_unavailable');
        } catch { throw fail('vault_unavailable'); }
        return codec;
    }
    validateBinding(binding) {
        if (!binding || typeof binding.ref !== 'string' || !binding.ref || binding.ref.length > 256 || typeof binding.scope !== 'string' || !binding.scope || binding.scope.length > 512) throw fail('credential_corrupt');
    }
    seal(value, binding) {
        this.registerSecrets([value]);
        return this._seal(value, binding);
    }
    sealArchive(value, binding) {
        if (typeof value !== 'string' || Buffer.byteLength(value) > 4 * 1024 * 1024) throw fail('recovery_record_too_large');
        return this._seal(value, binding);
    }
    _seal(value, binding) {
        this.validateBinding(binding);
        if (!value) throw fail('credential_missing');
        const codec = this.backend();
        try {
            const blob = codec.encryptString(JSON.stringify({ formatVersion: 1, ref: binding.ref, scope: binding.scope, value }));
            if (!Buffer.isBuffer(blob) || !blob.length) throw fail('storage_write_failed');
            return blob;
        } catch { throw fail('storage_write_failed'); }
    }
    open(blob, binding) {
        const value = this._open(blob, binding);
        this.registerSecrets([value]);
        return value;
    }
    openArchive(blob, binding) { return this._open(blob, binding); }
    _open(blob, binding) {
        this.validateBinding(binding);
        const codec = this.backend();
        if (!Buffer.isBuffer(blob) || !blob.length) throw fail('credential_corrupt');
        let envelope;
        try { envelope = JSON.parse(codec.decryptString(blob)); }
        catch { throw fail('credential_locked'); }
        if (envelope?.formatVersion !== 1 || envelope.ref !== binding.ref || envelope.scope !== binding.scope || typeof envelope.value !== 'string' || !envelope.value) throw fail('credential_corrupt');
        return envelope.value;
    }
    status(record) {
        if (!record) return { hasKey: false, status: 'missing' };
        if (record.api_key && !record.ciphertext) return { hasKey: true, status: 'migration_required' };
        if (!record.ciphertext) return { hasKey: false, status: 'missing' };
        try { this.open(record.ciphertext, record); return { hasKey: true, status: 'stored' }; }
        catch { return { hasKey: true, status: 'locked' }; }
    }
}
function credentialScope(installation, provider, owner = '') {
    return `${installation}/provider/${provider}${provider === 'openai-glass' ? '/owner/' + owner : ''}`;
}
module.exports = { SecretStore, credentialScope };
