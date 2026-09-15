const { randomUUID } = require('crypto');
const { SecretStore, credentialScope } = require('../../common/services/secretStore');
const fail = code => Object.assign(new Error(code), { code });
function createTwinRepository({ getDb = () => require('../../common/services/sqliteClient').getDb(), store = new SecretStore(), beforeCommit = () => {} } = {}) {
    function read() {
        const db = getDb(), row = db.prepare('SELECT * FROM twin_settings WHERE id=1').get();
        if (!row) throw fail('settings_not_initialized');
        return { ...row, outbox: db.prepare('SELECT * FROM twin_apply_outbox WHERE id=1').get() || null };
    }
    function resolveCredential() {
        const row = read(); if (!row.fireflies_credential_ref) return null;
        const secret = getDb().prepare('SELECT ciphertext FROM secret_records WHERE ref=?').get(row.fireflies_credential_ref);
        if (!secret) throw fail('credential_locked');
        return store.open(secret.ciphertext, { ref: row.fireflies_credential_ref, scope: credentialScope(row.installation_id, 'fireflies') });
    }
    function commit({ expectedRevision, settings, key, outbox }) {
        const db = getDb();
        db.transaction(() => {
            const previous = read();
            if (previous.desired_revision !== expectedRevision) throw fail('revision_conflict');
            let ref = previous.fireflies_credential_ref;
            let previousKey;
            try { previousKey = resolveCredential(); } catch { previousKey = undefined; }
            if (key !== previousKey) {
                ref = null;
                if (key) {
                    ref = randomUUID(); const scope = credentialScope(previous.installation_id, 'fireflies'), ciphertext = store.seal(key, { ref, scope });
                    if (store.open(ciphertext, { ref, scope }) !== key) throw fail('storage_write_failed');
                    db.prepare('INSERT INTO secret_records VALUES (?,?,1,?,?,?)').run(ref, scope, ciphertext, Date.now(), Date.now());
                }
            }
            db.prepare('UPDATE twin_settings SET desired_revision=?,fireflies_enabled=?,fireflies_credential_ref=?,normalized_meeting_link=?,meeting_intent_id=?,updated_at=? WHERE id=1').run(settings.desired_revision, settings.fireflies_enabled, ref, settings.normalized_meeting_link, settings.meeting_intent_id, Date.now());
            db.prepare('INSERT OR REPLACE INTO twin_apply_outbox(id,desired_revision,operation_id,action,state,last_error_code,applied_revision,server_instance) VALUES (1,?,?,?,?,NULL,0,NULL)').run(outbox.desired_revision, outbox.operation_id, outbox.action, 'pending');
            if (previous.fireflies_credential_ref && previous.fireflies_credential_ref !== ref) db.prepare('DELETE FROM secret_records WHERE ref=?').run(previous.fireflies_credential_ref);
            beforeCommit();
        })();
    }
    function acknowledge(revision, instanceId) { getDb().prepare("UPDATE twin_apply_outbox SET applied_revision=?,server_instance=?,state='applied',last_error_code=NULL WHERE id=1 AND desired_revision=?").run(revision, instanceId, revision); }
    function pending(code) { getDb().prepare("UPDATE twin_apply_outbox SET state='pending',last_error_code=? WHERE id=1").run(/^[a-z_]{1,64}$/.test(code) ? code : 'runtime_unavailable'); }
    return { read, resolveCredential, commit, acknowledge, pending };
}
module.exports = { createTwinRepository };
