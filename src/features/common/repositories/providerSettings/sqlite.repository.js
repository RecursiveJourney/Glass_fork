const { randomUUID } = require('crypto');
const { SecretStore, credentialScope } = require('../../services/secretStore');
const { registerSecrets } = require('../../services/secretRedactor');
const fail = code => Object.assign(new Error(code), { code });

function createProviderRepository({ getDb = () => require('../../services/sqliteClient').getDb(), store = new SecretStore(), scope, getOwner = () => require('../../services/authService').getCurrentUserId() } = {}) {
    const bindingScope = () => scope || getDb().prepare('SELECT installation_id FROM twin_settings WHERE id=1').get()?.installation_id;
    const raw = provider => getDb().prepare('SELECT * FROM provider_settings WHERE provider=?').get(provider);
    const owned = row => row.provider !== 'openai-glass' || row.owner_scope === getOwner();
    function credential(row) {
        if (!row?.credential_ref || !owned(row)) return null;
        const record = getDb().prepare('SELECT ciphertext FROM secret_records WHERE ref=?').get(row.credential_ref);
        if (!record) throw fail('credential_locked');
        return store.open(record.ciphertext, { ref: row.credential_ref, scope: credentialScope(bindingScope(), row.provider, row.provider === 'openai-glass' ? getOwner() : '') });
    }
    function metadata(row) {
        if (!row) return null;
        let status = row.credential_status || 'missing', hasKey = !!row.credential_ref;
        if (row.api_key || status === 'migration_required') { status = 'migration_required'; hasKey = true; }
        else if (row.credential_ref) {
            try { status = credential(row) ? 'stored' : 'missing'; hasKey = status === 'stored'; }
            catch { status = 'locked'; }
        }
        return { provider: row.provider, hasKey, status, enabled: !!row.enabled,
            selected_llm_model: row.selected_llm_model, selected_stt_model: row.selected_stt_model,
            is_active_llm: row.is_active_llm, is_active_stt: row.is_active_stt,
            created_at: row.created_at, updated_at: row.updated_at };
    }
    function upsert(provider, settings) {
        if (Object.hasOwn(settings, 'api_key') && settings.api_key != null) registerSecrets([settings.api_key]);
        if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw fail('invalid_provider');
        const db = getDb();
        return db.transaction(() => {
            const previous = raw(provider) || {}, now = Date.now();
            db.prepare('INSERT OR IGNORE INTO provider_settings(provider,created_at,updated_at) VALUES (?,?,?)').run(provider, now, now);
            if (Object.hasOwn(settings, 'api_key')) {
                let ref = null, status = 'missing', enabled = 0;
                if (['ollama', 'whisper'].includes(provider)) enabled = settings.api_key ? 1 : 0;
                else if (settings.api_key) {
                    ref = randomUUID();
                    const scopeValue = credentialScope(bindingScope(), provider, provider === 'openai-glass' ? getOwner() : ''), ciphertext = store.seal(settings.api_key, { ref, scope: scopeValue });
                    if (store.open(ciphertext, { ref, scope: scopeValue }) !== settings.api_key) throw fail('storage_write_failed');
                    db.prepare('INSERT INTO secret_records VALUES (?,?,1,?,?,?)').run(ref, scopeValue, ciphertext, now, now);
                    status = 'stored';
                }
                db.prepare('UPDATE provider_settings SET api_key=NULL,credential_ref=?,credential_status=?,enabled=?,owner_scope=? WHERE provider=?').run(ref, status, enabled, provider === 'openai-glass' ? getOwner() : null, provider);
                if (previous.credential_ref) db.prepare('DELETE FROM secret_records WHERE ref=?').run(previous.credential_ref);
            }
            for (const field of ['selected_llm_model', 'selected_stt_model']) {
                if (Object.hasOwn(settings, field)) db.prepare(`UPDATE provider_settings SET ${field}=? WHERE provider=?`).run(settings[field] || null, provider);
            }
            db.prepare('UPDATE provider_settings SET updated_at=? WHERE provider=?').run(now, provider);
            return { changes: 1 };
        })();
    }
    function setActiveProvider(provider, type) {
        if (!['llm', 'stt'].includes(type)) throw fail('invalid_model_type');
        const db = getDb(), column = `is_active_${type}`;
        db.transaction(() => {
            if (provider && !raw(provider)) throw fail('provider_missing');
            db.prepare(`UPDATE provider_settings SET ${column}=0`).run();
            if (provider) db.prepare(`UPDATE provider_settings SET ${column}=1 WHERE provider=?`).run(provider);
        })();
        return { success: true };
    }
    const getAll = () => getDb().prepare('SELECT * FROM provider_settings ORDER BY provider').all().map(metadata);
    function remove(provider) { return upsert(provider, { api_key: null }); }
    function getActiveProvider(type) {
        if (!['llm', 'stt'].includes(type)) throw fail('invalid_model_type');
        return metadata(getDb().prepare(`SELECT * FROM provider_settings WHERE is_active_${type}=1`).get());
    }
    return { getByProvider: provider => metadata(raw(provider)), getAll, upsert, remove,
        removeAll: () => getDb().transaction(() => { for (const row of getAll()) remove(row.provider); })(),
        resolveCredential: provider => credential(raw(provider)),
        getActiveProvider, setActiveProvider, getActiveSettings: () => ({ llm: getActiveProvider('llm'), stt: getActiveProvider('stt') }) };
}
module.exports = { createProviderRepository, ...createProviderRepository() };
