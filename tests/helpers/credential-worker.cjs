const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createTable, syntheticCodec } = require('./credential-fixtures.cjs');
const { SecretStore } = require('../../src/features/common/services/secretStore');
const dir = mkdtempSync(path.join(tmpdir(), 'glass-credentials-'));
const dbPath = path.join(dir, 'synthetic.db');
let db = new Database(dbPath);
db.pragma('journal_mode=WAL');
const store = new SecretStore({ codec: syntheticCodec(), isReady: () => true, platform: 'win32' });
const scope = 'fixture-installation';
async function main() {
    let migrateSettings;
    try { ({ migrateSettings } = require('../../src/features/common/services/settingsMigrationService')); } catch {}
    assert.equal(typeof migrateSettings, 'function', 'recovery-first migration available');
    const scenario = process.argv[2];
    const options = { db, store, scope, owner: 'alice', readLegacy: async () => { throw Error('credential_locked'); } };
    const run = extra => migrateSettings({ ...options, db, ...extra });
    const current = () => {
        createTable(db, 'provider_settings');
        db.prepare('INSERT INTO provider_settings(provider,api_key,selected_llm_model,is_active_llm) VALUES (?,?,?,1)').run('openai', 'synthetic-plaintext-marker', 'saved-model');
    };
    const owners = () => db.exec('CREATE TABLE provider_settings (uid TEXT, provider TEXT, api_key TEXT, selected_llm_model TEXT, updated_at INTEGER)');
    if (['mixed-local', 'schema-failure'].includes(scenario)) current();
    if (scenario === 'mixed-local') {
        for (const provider of ['ollama', 'whisper']) db.prepare('INSERT INTO provider_settings(provider,api_key) VALUES (?,?)').run(provider, 'local');
    }
    if (['legacy-aes', 'source-race'].includes(scenario)) {
        const crypto = require('node:crypto'), key = Buffer.alloc(32, 9), iv = Buffer.alloc(16, 4);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update('synthetic-decrypted-key'), cipher.final()]);
        const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        owners(); db.prepare('INSERT INTO provider_settings VALUES (?,?,?,?,?)').run('alice', 'openai', ciphertext, 'saved-model', 1);
        options.readLegacy = async (value, owner) => {
            assert.equal(owner, 'alice');
            const blob = Buffer.from(value, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 16));
            decipher.setAuthTag(blob.subarray(16, 32));
            if (scenario === 'source-race') db.prepare('UPDATE provider_settings SET selected_llm_model=?').run('newer-model');
            return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8');
        };
        if (scenario === 'source-race') {
            await assert.rejects(run(), { code: 'migration_conflict' });
            assert.equal(db.prepare('SELECT selected_llm_model FROM provider_settings').get().selected_llm_model, 'newer-model');
            assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, ciphertext);
            return;
        }
    }
    if (scenario === 'schema-failure') {
        // Real SQLite constraint failure after archive insertion rolls back all migration writes.
        createTable(db, 'settings_recovery_records');
        db.exec("CREATE TRIGGER deny_archive BEFORE INSERT ON settings_recovery_records BEGIN SELECT RAISE(ABORT, 'synthetic-read-only'); END");
        await assert.rejects(run());
        assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, 'synthetic-plaintext-marker');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n, 0);
        db.exec('DROP TRIGGER deny_archive');
    }
    if (['plaintext', 'rollback', 'restart', 'selection', 'repository', 'vault-unavailable'].includes(scenario)) current();
    if (scenario === 'owners') {
        owners();
        db.prepare('INSERT INTO provider_settings VALUES (?,?,?,?,?)').run('alice', 'openai', 'synthetic-alice', 'alice-model', 1);
        db.prepare('INSERT INTO provider_settings VALUES (?,?,?,?,?)').run('bob', 'openai', 'synthetic-bob', 'bob-model', 9);
        db.prepare('INSERT INTO provider_settings VALUES (?,?,?,?,?)').run('default_user', 'anthropic', 'synthetic-default', null, 0);
    }
    if (scenario === 'ambiguous') {
        owners();
        for (const key of ['synthetic-one', 'synthetic-two']) db.prepare('INSERT INTO provider_settings VALUES (?,?,?,?,?)').run('alice', 'openai', key, 'saved-model', 1);
    }
    if (scenario === 'missing-provider') db.exec("CREATE TABLE provider_settings (api_key TEXT); INSERT INTO provider_settings VALUES ('synthetic-orphan')");
    if (scenario === 'stale-old') {
        current();
        db.exec("CREATE TABLE provider_settings_old (uid TEXT, provider TEXT, api_key TEXT); INSERT INTO provider_settings_old VALUES ('alice','openai','synthetic-old')");
    }
    if (scenario === 'locked') {
        createTable(db, 'provider_settings');
        db.prepare('INSERT INTO provider_settings(provider,api_key) VALUES (?,?)').run('openai', Buffer.alloc(64, 5).toString('base64'));
    }
    if (scenario === 'selection') {
        db.exec("CREATE TABLE user_model_selections (uid TEXT, llm_model TEXT, stt_model TEXT); INSERT INTO user_model_selections VALUES ('alice','new-model',NULL),('bob','other-model','other-stt')");
        options.getProviderForModel = () => 'openai';
    }
    if (scenario === 'vault-unavailable') {
        await assert.rejects(run({ store: new SecretStore({ codec: { isEncryptionAvailable: () => false }, isReady: () => true }) }));
        assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, 'synthetic-plaintext-marker');
        return;
    }
    if (scenario === 'rollback') {
        await assert.rejects(run({ beforeCommit: () => { throw Error('synthetic-disk-failure'); } }));
        assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, 'synthetic-plaintext-marker');
    }
    const result = await run();
    assert.ok(['ready', 'recovery_required'].includes(result.status));
    if (scenario === 'mixed-local') {
        for (const provider of ['ollama', 'whisper']) {
            const row = db.prepare('SELECT * FROM provider_settings WHERE provider=?').get(provider);
            assert.equal(row.enabled, 1); assert.equal(row.credential_ref, null); assert.equal(row.api_key, null);
        }
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secret_records').get().n, 1);
    }
    if (scenario === 'legacy-aes') {
        db.close(); db = new Database(dbPath);
        const row = db.prepare('SELECT * FROM provider_settings').get();
        const secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(row.credential_ref);
        assert.equal(store.open(secret.ciphertext, secret), 'synthetic-decrypted-key');
        assert.equal(row.selected_llm_model, 'saved-model'); assert.equal(row.api_key, null);
    }
    if (scenario === 'twin-http') {
        const { createTwinRepository } = require('../../src/features/settings/repositories/twin.sqlite.repository');
        const { TwinSettingsService } = require('../../src/features/settings/twinSettingsService');
        const { TwinRuntimeClient } = require('../../src/features/common/services/twinRuntimeClient');
        const { startHttpServer } = await import('../../../realtime_listener/lib/http-server.js');
        const { createRuntimeConfig } = await import('../../../realtime_listener/lib/runtime-config.js');
        const applied = [], token = 'synthetic-control-token-32-characters';
        const runtimeConfig = createRuntimeConfig({ onApply: change => applied.push(change) });
        const server = await startHttpServer({ port: 0, runtimeConfig, controlToken: token, suggest: async () => ({ text: 'unused' }) });
        try {
            const service = new TwinSettingsService({ repository: createTwinRepository({ getDb: () => db, store }), client: new TwinRuntimeClient({ url: 'http://127.0.0.1:' + server.port, token }) });
            const input = { expectedRevision: 0, enabled: true, meetingLink: 'https://meet.google.com/abc-defg-hij', credential: { action: 'set', value: 'synthetic-http-key' } };
            const started = performance.now(), state = await service.save(input);
            assert.equal(state.state, 'applied'); assert.equal(state.savedRevision, 1); assert.equal(state.appliedRevision, 1);
            assert.ok(performance.now() - started < 1000, 'normal local Save applies in less than one second');
            await service.save(input); assert.equal(applied.length, 1);
            await service.save({ ...input, expectedRevision: 1, credential: { action: 'set', value: 'synthetic-http-rotation' } });
            assert.equal(applied.at(-1).mayInvite, false); assert.equal(applied[0].meetingIntentId, applied[1].meetingIntentId);
            assert.equal(JSON.stringify(service.getState()).includes('synthetic-http'), false);
        } finally { await server.close(); }
    }
    if (scenario === 'twin') {
        const { createTwinRepository } = require('../../src/features/settings/repositories/twin.sqlite.repository');
        let failWrite = true;
        const repo = createTwinRepository({ getDb: () => db, store, beforeCommit: () => { if (failWrite) throw Error('synthetic-write-failure'); } });
        const next = { expectedRevision: 0, key: 'synthetic-twin-key', settings: { desired_revision: 1, fireflies_enabled: 1, normalized_meeting_link: 'https://meet.google.com/abc-defg-hij', meeting_intent_id: 'intent' }, outbox: { desired_revision: 1, operation_id: 'operation', action: 'join' } };
        assert.throws(() => repo.commit(next));
        assert.equal(repo.read().desired_revision, 0); assert.equal(repo.read().outbox, null); assert.equal(repo.resolveCredential(), null);
        failWrite = false; repo.commit(next); db.close(); db = new Database(dbPath);
        assert.equal(repo.read().desired_revision, 1); assert.equal(repo.read().outbox.operation_id, 'operation'); assert.equal(repo.resolveCredential(), 'synthetic-twin-key');
        db.prepare('UPDATE secret_records SET ciphertext=?').run(Buffer.from('corrupt-fixture'));
        repo.commit({ ...next, expectedRevision: 1, key: 'synthetic-recovered', settings: { ...next.settings, desired_revision: 2 }, outbox: { ...next.outbox, desired_revision: 2 } });
        assert.equal(repo.resolveCredential(), 'synthetic-recovered');
    }
    if (['legacy-store', 'legacy-cleanup-failure'].includes(scenario)) {
        const { importLegacyStore } = require('../../src/features/common/services/settingsMigrationService');
        assert.equal(typeof importLegacyStore, 'function');
        let users = { alice: { apiKeys: { openai: 'synthetic-offline-key' }, selectedModels: { llm: 'saved-model' }, untouched: 'keep' }, bob: { apiKeys: { openai: 'synthetic-bob-key' } } };
        let failCleanup = scenario === 'legacy-cleanup-failure';
        const legacyStore = { get: () => structuredClone(users), set: (_key, value) => { if (failCleanup) throw Error('synthetic-io'); users = value; } };
        const imported = await importLegacyStore({ ...options, legacyStore, getProviderForModel: () => 'openai' });
        assert.equal(imported.status, failCleanup ? 'cleanup_pending' : 'ready');
        const row = db.prepare('SELECT * FROM provider_settings WHERE provider=?').get('openai');
        const secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(row.credential_ref);
        assert.equal(store.open(secret.ciphertext, secret), 'synthetic-offline-key');
        assert.equal(row.selected_llm_model, 'saved-model');
        if (failCleanup) { assert.equal(users.alice.apiKeys.openai, 'synthetic-offline-key'); failCleanup = false; }
        await importLegacyStore({ ...options, legacyStore, getProviderForModel: () => 'openai' });
        assert.equal(users.alice.apiKeys.openai, undefined);
        assert.equal(users.alice.untouched, 'keep');
        assert.equal(users.bob.apiKeys.openai, 'synthetic-bob-key');
    }
    if (scenario === 'owners') {
        const r = db.prepare('SELECT * FROM provider_settings WHERE provider=?').get('openai');
        const secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(r.credential_ref);
        assert.equal(store.open(secret.ciphertext, secret), 'synthetic-alice');
        assert.equal(r.selected_llm_model, 'alice-model');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n, 3);
    }
    if (['ambiguous', 'missing-provider', 'locked'].includes(scenario)) {
        assert.equal(result.status, 'recovery_required');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secret_records').get().n, 0);
        assert.ok(db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n > 0);
    }
    if (scenario === 'stale-old') {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n, 2);
        assert.ok(db.prepare("SELECT credential_ref FROM provider_settings WHERE provider='openai'").get().credential_ref, 'current settings win over stale migration input');
    }
    if (scenario === 'selection') {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings_recovery_records WHERE source_kind='user_model_selections'").get().n, 2);
        db.close(); db = new Database(dbPath); await run();
        assert.equal(db.prepare("SELECT selected_llm_model FROM provider_settings WHERE provider='openai'").get().selected_llm_model, 'new-model', 'selection is committed before restart');
    }
    if (['plaintext', 'rollback', 'restart', 'repository'].includes(scenario)) {
        const r = db.prepare('SELECT * FROM provider_settings WHERE provider=?').get('openai');
        assert.equal(r.api_key, null); assert.equal(r.selected_llm_model, 'saved-model'); assert.equal(r.is_active_llm, 1);
        let secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(r.credential_ref);
        assert.equal(store.open(secret.ciphertext, secret), 'synthetic-plaintext-marker');
        const before = db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n;
        db.close(); db = new Database(dbPath);
        await run();
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings_recovery_records').get().n, before);
        secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(r.credential_ref);
        assert.equal(store.open(secret.ciphertext, secret), 'synthetic-plaintext-marker');
        if (scenario === 'repository') {
            const { createProviderRepository } = require('../../src/features/common/repositories/providerSettings/sqlite.repository');
            const repo = createProviderRepository({ getDb: () => db, store, scope });
            repo.upsert('openai', { api_key: 'synthetic-replacement' });
            assert.equal(repo.getByProvider('openai').selected_llm_model, 'saved-model');
            assert.equal(repo.getByProvider('openai').api_key, undefined);
            assert.equal(repo.resolveCredential('openai'), 'synthetic-replacement');
            repo.upsert('anthropic', { api_key: 'synthetic-other-provider' });
            const originalRef = db.prepare('SELECT credential_ref FROM provider_settings WHERE provider=?').get('openai').credential_ref;
            const otherRef = db.prepare('SELECT credential_ref FROM provider_settings WHERE provider=?').get('anthropic').credential_ref;
            db.prepare('UPDATE provider_settings SET credential_ref=? WHERE provider=?').run(otherRef, 'openai');
            assert.throws(() => repo.resolveCredential('openai'), { code: 'credential_corrupt' });
            db.prepare('UPDATE provider_settings SET credential_ref=? WHERE provider=?').run(originalRef, 'openai');
            assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, null);
            assert.throws(() => repo.setActiveProvider('absent', 'llm'));
            assert.equal(repo.getActiveProvider('llm').provider, 'openai');
        }
        db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)');
        assert.equal(readFileSync(dbPath).includes(Buffer.from('synthetic-plaintext-marker')), false);
    }
    // Every archive is verifiably readable without printing its contents.
    for (const row of db.prepare('SELECT * FROM settings_recovery_records').all()) {
        assert.doesNotThrow(() => JSON.parse(store.openArchive(row.ciphertext, { ref: row.id, scope })));
    }
}
main().then(() => process.stdout.write('CREDENTIAL_FIXTURE:' + JSON.stringify({ passed: true }) + '\n')).catch(error => {
    process.stdout.write('CREDENTIAL_FIXTURE:' + JSON.stringify({ passed: false, failure: error.code || error.message }) + '\n');
}).finally(() => { db.close(); rmSync(dir, { recursive: true }); });
