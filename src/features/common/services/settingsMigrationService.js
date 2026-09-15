const { randomUUID, createHash } = require('crypto');
const schema = require('../config/schema');
const { SecretStore, credentialScope } = require('./secretStore');
const { registerSecrets } = require('./secretRedactor');
const TABLES = ['secret_records', 'settings_migrations', 'settings_recovery_records', 'twin_settings', 'twin_apply_outbox'];
const SOURCES = ['provider_settings', 'provider_settings_old', 'user_model_selections'];
const failure = code => Object.assign(new Error(code), { code });
function createTable(db, name) {
    const spec = schema[name];
    db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${spec.columns.map(c => `"${c.name}" ${c.type}`).join(',')}${spec.constraints?.length ? ',' + spec.constraints.join(',') : ''})`);
}
function exists(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function readSources(db) { return SOURCES.filter(name => exists(db, name)).map(name => ({ name, rows: db.prepare(`SELECT * FROM "${name}"`).all(), columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name) })); }
function digest(sources) { return createHash('sha256').update(JSON.stringify(sources)).digest('hex'); }
function looksLegacy(value) { return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length >= 32; }
function choose(rows, owner) {
    const own = rows.filter(r => !r.uid || r.uid === owner);
    if (own.length) return own.length === 1 ? own[0] : null;
    const defaults = rows.filter(r => r.uid === 'default_user');
    return defaults.length === 1 ? defaults[0] : null;
}

async function migrateSettings({ db, store = new SecretStore(), scope, owner = 'default_user', readLegacy = async () => { throw failure('credential_locked'); }, getProviderForModel = () => null, beforeCommit = () => {} }) {
    const sources = readSources(db), originalDigest = digest(sources);
    const previous = exists(db, 'settings_migrations') ? db.prepare("SELECT * FROM settings_migrations WHERE id='credentials-v1'").get() : null;
    const settings = exists(db, 'twin_settings') ? db.prepare('SELECT * FROM twin_settings WHERE id=1').get() : null;
    const installation = settings?.installation_id || scope || randomUUID();
    scope ||= installation;
    const current = sources.find(s => s.name === 'provider_settings');
    const needsMigration = !current || !current.columns.includes('credential_ref') || current.columns.includes('uid') || current.rows.some(r => r.api_key) || sources.some(s => s.name !== 'provider_settings');
    if (!needsMigration && previous) return { status: previous.result_code, scope, installationId: installation };
    // Vault readiness is checked before any persistent mutation, including an empty DB.
    store.backend();
    const recovery = [], secrets = [], providers = [];
    let recoveryRequired = false;
    const aliases = new Map();
    for (const source of sources) {
        for (const row of source.rows) {
            if (typeof row.api_key === 'string') registerSecrets([row.api_key]);
            const id = randomUUID();
            const ciphertext = store.sealArchive(JSON.stringify(row), { ref: id, scope });
            // Verify archive before the original can be changed.
            if (store.openArchive(ciphertext, { ref: id, scope }) !== JSON.stringify(row)) throw failure('storage_write_failed');
            const ownerKey = row.uid || 'device';
            if (!aliases.has(ownerKey)) aliases.set(ownerKey, `owner-${aliases.size + 1}`);
            recovery.push({ id, source_kind: source.name, owner_alias: aliases.get(ownerKey), provider: typeof row.provider === 'string' ? row.provider : null, ciphertext });
        }
    }
    const providerRows = sources.filter(s => s.name.startsWith('provider_settings')).flatMap(s => s.rows);
    const names = [...new Set(providerRows.map(r => r.provider).filter(v => typeof v === 'string' && v.length))];
    if (providerRows.some(r => !r.provider)) recoveryRequired = true;
    for (const provider of names) {
        const candidates = providerRows.filter(r => r.provider === provider);
        const currentCandidates = current && !current.columns.includes('uid') ? current.rows.filter(r => r.provider === provider) : [];
        const row = currentCandidates.length === 1 ? currentCandidates[0] : choose(candidates, owner);
        if (!row) { recoveryRequired = true; providers.push({ provider, credential_status: 'migration_required' }); continue; }
        const out = Object.fromEntries(schema.provider_settings.columns.map(c => [c.name, row[c.name] ?? null]));
        out.enabled ||= 0; out.is_active_llm ||= 0; out.is_active_stt ||= 0;
        out.api_key = null;
        if (['ollama', 'whisper'].includes(provider)) {
            out.enabled = row.enabled || (row.api_key ? 1 : 0); out.credential_ref = null; out.credential_status = 'missing';
        } else if (row.api_key) {
            let value = row.api_key;
            if (looksLegacy(value)) {
                try { value = await readLegacy(value, row.uid || owner); }
                catch { value = null; }
            }
            if (typeof value !== 'string' || !value) { out.credential_status = 'migration_required'; out.credential_ref = null; recoveryRequired = true; }
            else {
                registerSecrets([value]);
                const ref = randomUUID(), binding = { ref, scope: credentialScope(scope, provider, row.uid || owner) };
                const ciphertext = store.seal(value, binding);
                if (store.open(ciphertext, binding) !== value) throw failure('storage_write_failed');
                secrets.push({ ...binding, ciphertext }); out.credential_ref = ref; out.credential_status = 'stored';
            }
        } else out.credential_status ||= out.credential_ref ? 'stored' : 'missing';
        if (provider === 'openai-glass') out.owner_scope = row.uid || owner;
        providers.push(out);
    }
    const selectionRows = sources.find(s => s.name === 'user_model_selections')?.rows || [];
    const selections = choose(selectionRows, owner);
    if (selectionRows.length && !selections) recoveryRequired = true;
    if (selections) {
        for (const type of ['llm', 'stt']) {
            const model = selections[`${type}_model`] || selections[`selected_${type}_model`];
            if (!model) continue;
            const provider = getProviderForModel(model, type) || providers.find(p => p[`selected_${type}_model`] === model)?.provider;
            if (!provider) { recoveryRequired = true; continue; }
            let target = providers.find(p => p.provider === provider);
            if (!target) { target = { provider, credential_status: 'missing', enabled: 0 }; providers.push(target); }
            for (const row of providers) row[`is_active_${type}`] = row === target ? 1 : 0;
            target[`selected_${type}_model`] = model;
        }
    }
    const now = Date.now(), status = recoveryRequired ? 'recovery_required' : 'ready';
    db.transaction(() => {
        if (digest(readSources(db)) !== originalDigest) throw failure('migration_conflict');
        for (const table of TABLES) createTable(db, table);
        for (const row of recovery) db.prepare('INSERT INTO settings_recovery_records(id,source_kind,owner_alias,provider,ciphertext,format_version,resolved) VALUES (@id,@source_kind,@owner_alias,@provider,@ciphertext,1,0)').run(row);
        for (const row of secrets) db.prepare('INSERT INTO secret_records(ref,scope,format_version,ciphertext,created_at,updated_at) VALUES (@ref,@scope,1,@ciphertext,@now,@now)').run({ ...row, now });
        for (const source of sources) db.exec(`DROP TABLE "${source.name}"`);
        createTable(db, 'provider_settings');
        const columns = schema.provider_settings.columns.map(c => c.name);
        const insert = db.prepare(`INSERT INTO provider_settings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of providers) insert.run(...columns.map(c => row[c] ?? (c === 'credential_status' ? 'missing' : null)));
        db.prepare('INSERT OR IGNORE INTO twin_settings(id,installation_id) VALUES (1,?)').run(installation);
        db.prepare("INSERT OR REPLACE INTO settings_migrations(id,version,stage,result_code,updated_at) VALUES ('credentials-v1',1,'committed',?,?)").run(status, now);
        // Read the actual persisted archive and credential BLOBs before COMMIT.
        for (const row of recovery) {
            const saved = db.prepare('SELECT ciphertext FROM settings_recovery_records WHERE id=?').get(row.id);
            if (!saved || !saved.ciphertext.equals(row.ciphertext)) throw failure('storage_write_failed');
        }
        beforeCommit();
    })();
    return { status, scope, installationId: installation, selections, converted: recovery.length > 0 };
}
async function importLegacyStore({ db, store = new SecretStore(), scope, owner, legacyStore, readLegacy = async () => { throw failure('credential_locked'); }, getProviderForModel = () => null }) {
    const users = legacyStore.get('users', {});
    if (!users || typeof users !== 'object' || Array.isArray(users)) throw failure('legacy_store_invalid');
    const sourceOwner = users[owner] ? owner : users.default_user ? 'default_user' : null;
    if (!sourceOwner) return { status: 'ready' };
    const source = users[sourceOwner];
    if (!source || typeof source !== 'object') throw failure('legacy_store_invalid');
    const id = 'legacy-store-' + createHash('sha256').update(sourceOwner).digest('hex');
    const existing = db.prepare('SELECT ciphertext FROM settings_recovery_records WHERE id=?').get(id);
    let archive;
    if (existing) archive = JSON.parse(store.openArchive(existing.ciphertext, { ref: id, scope }));
    else {
        const { createProviderRepository } = require('../repositories/providerSettings/sqlite.repository');
        const repo = createProviderRepository({ getDb: () => db, store, scope, getOwner: () => owner });
        const prepared = [];
        archive = { source, importedProviders: [], importedModels: {} };
        for (const [provider, original] of Object.entries(source.apiKeys || {})) {
            if (typeof original !== 'string' || !original) continue;
            registerSecrets([original]);
            const current = repo.getByProvider(provider);
            if (current?.hasKey || current?.enabled) continue;
            let value = original;
            if (looksLegacy(value)) { try { value = await readLegacy(value, sourceOwner); } catch { continue; } }
            if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) continue;
            prepared.push({ provider, value }); archive.importedProviders.push(provider);
        }
        for (const type of ['llm', 'stt']) {
            const model = source.selectedModels?.[type], provider = model && getProviderForModel(model, type);
            if (provider && !repo.getActiveProvider(type)) archive.importedModels[type] = { provider, model };
        }
        const ciphertext = store.sealArchive(JSON.stringify(archive), { ref: id, scope });
        store.openArchive(ciphertext, { ref: id, scope });
        db.transaction(() => {
            if (JSON.stringify(legacyStore.get('users', {})[sourceOwner]) !== JSON.stringify(source)) throw failure('migration_conflict');
            db.prepare('INSERT INTO settings_recovery_records VALUES (?, ?, ?, NULL, ?, 1, 0)').run(id, 'electron_store', 'active-owner', ciphertext);
            for (const row of prepared) repo.upsert(row.provider, { api_key: row.value });
            for (const [type, selected] of Object.entries(archive.importedModels)) {
                repo.upsert(selected.provider, { [`selected_${type}_model`]: selected.model });
                repo.setActiveProvider(selected.provider, type);
            }
            db.prepare('INSERT OR REPLACE INTO settings_migrations VALUES (?,1,?,?,?)').run(id, 'committed', 'cleanup_pending', Date.now());
        })();
    }
    // Verify using a second connection after COMMIT before touching the separate JSON file.
    const reopened = new db.constructor(db.name, { readonly: true });
    try {
        const record = reopened.prepare('SELECT ciphertext FROM settings_recovery_records WHERE id=?').get(id);
        if (store.openArchive(record.ciphertext, { ref: id, scope }) !== JSON.stringify(archive)) throw failure('storage_write_failed');
        for (const provider of archive.importedProviders) {
            const row = reopened.prepare('SELECT * FROM provider_settings WHERE provider=?').get(provider);
            if (!row || (!row.enabled && !row.credential_ref)) throw failure('storage_write_failed');
            if (row.credential_ref) {
                const secret = reopened.prepare('SELECT ciphertext FROM secret_records WHERE ref=?').get(row.credential_ref);
                store.open(secret.ciphertext, { ref: row.credential_ref, scope: credentialScope(scope, provider, owner) });
            }
        }
    } finally { reopened.close(); }
    const latest = legacyStore.get('users', {}), next = JSON.parse(JSON.stringify(latest));
    for (const provider of archive.importedProviders) {
        if (next[sourceOwner]?.apiKeys?.[provider] === archive.source.apiKeys[provider]) delete next[sourceOwner].apiKeys[provider];
    }
    for (const [type, selected] of Object.entries(archive.importedModels)) {
        if (next[sourceOwner]?.selectedModels?.[type] === selected.model) delete next[sourceOwner].selectedModels[type];
    }
    try {
        if (JSON.stringify(next) !== JSON.stringify(latest)) legacyStore.set('users', next);
        db.prepare('UPDATE settings_migrations SET stage=?,result_code=? WHERE id=?').run('cleanup_complete', 'ready', id);
    } catch { return { status: 'cleanup_pending' }; }
    const unresolved = Object.values(next[sourceOwner]?.apiKeys || {}).some(Boolean);
    return { status: unresolved ? 'recovery_required' : 'ready' };
}
function compactCredentialStorage(db) {
    try {
        const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
        if (checkpoint.some(row => row.busy)) return { status: 'compaction_pending', code: 'database_busy' };
        db.exec('VACUUM');
        const final = db.pragma('wal_checkpoint(TRUNCATE)');
        return final.some(row => row.busy) ? { status: 'compaction_pending', code: 'database_busy' } : { status: 'complete' };
    } catch { return { status: 'compaction_pending', code: 'compaction_failed' }; }
}
module.exports = { migrateSettings, importLegacyStore, compactCredentialStorage, createTable };
