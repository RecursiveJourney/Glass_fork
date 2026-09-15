const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createTable, syntheticCodec } = require('./credential-fixtures.cjs');
const { SecretStore } = require('../../src/features/common/services/secretStore');
const { migrateSettings, importLegacyStore } = require('../../src/features/common/services/settingsMigrationService');
const [directory, boundary, phase] = process.argv.slice(2);
const db = new Database(path.join(directory, 'synthetic.db'));
db.pragma('journal_mode=WAL');
const file = path.join(directory, 'legacy.json');
const store = new SecretStore({ codec: syntheticCodec(), isReady: () => true, platform: 'win32' });
const options = { db, store, scope: 'crash-fixture', owner: 'alice', getProviderForModel: () => 'openai' };
const source = { alice: { apiKeys: { openai: 'synthetic-crash-key' }, selectedModels: { llm: 'saved-model' }, unrelated: true }, bob: { apiKeys: { openai: 'synthetic-other-owner' } } };
const legacyStore = {
    get: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set(_name, value) {
        if (phase === 'crash' && boundary === 'before-cleanup') process.exit(71);
        fs.writeFileSync(file, JSON.stringify(value));
        if (phase === 'crash' && boundary === 'after-cleanup') process.exit(71);
    },
};
async function main() {
    if (phase === 'seed') {
        if (boundary === 'before-commit') {
            createTable(db, 'provider_settings');
            db.prepare('INSERT INTO provider_settings(provider,api_key,selected_llm_model,is_active_llm) VALUES (?,?,?,1)').run('openai', 'synthetic-crash-key', 'saved-model');
        } else {
            await migrateSettings(options);
            fs.writeFileSync(file, JSON.stringify(source));
        }
        return;
    }
    if (phase === 'crash') {
        if (boundary === 'before-commit') await migrateSettings({ ...options, beforeCommit: () => process.exit(71) });
        else await importLegacyStore({ ...options, legacyStore });
        throw Error('crash_boundary_not_reached');
    }
    if (boundary === 'before-commit') {
        assert.equal(db.prepare('SELECT api_key FROM provider_settings').get().api_key, 'synthetic-crash-key');
        await migrateSettings(options);
    } else {
        const before = legacyStore.get();
        assert.equal(!!before.alice.apiKeys.openai, boundary === 'before-cleanup');
        await importLegacyStore({ ...options, legacyStore });
        assert.equal(legacyStore.get().alice.apiKeys.openai, undefined);
        assert.equal(legacyStore.get().alice.unrelated, true);
        assert.equal(legacyStore.get().bob.apiKeys.openai, 'synthetic-other-owner');
    }
    const row = db.prepare("SELECT * FROM provider_settings WHERE provider='openai'").get();
    const secret = db.prepare('SELECT * FROM secret_records WHERE ref=?').get(row.credential_ref);
    assert.equal(store.open(secret.ciphertext, secret), 'synthetic-crash-key');
    assert.equal(row.api_key, null); assert.equal(row.selected_llm_model, 'saved-model');
    const counts = () => ['secret_records', 'settings_recovery_records'].map(table => db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);
    const before = counts();
    if (boundary === 'before-commit') await migrateSettings(options);
    else await importLegacyStore({ ...options, legacyStore });
    assert.deepEqual(counts(), before);
}
main().then(() => { db.close(); process.stdout.write('CREDENTIAL_CRASH_OK\n'); }).catch(() => { process.stderr.write('credential_crash_fixture_failed\n'); process.exitCode = 1; });
