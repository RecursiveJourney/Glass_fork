const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const redactor = require('../common/services/secretRedactor');
const { TwinRuntimeClient } = require('../common/services/twinRuntimeClient');
const { createTwinRepository } = require('./repositories/twin.sqlite.repository');
const fail = code => Object.assign(new Error(code), { code });
function normalizeLink(value) {
    if (value === '' || value === null) return null;
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) throw fail('invalid_meeting_link');
    let url; try { url = new URL(value.trim()); } catch { throw fail('invalid_meeting_link'); }
    if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) throw fail('invalid_meeting_link');
    return 'https://meet.google.com' + url.pathname.replace(/\/$/, '');
}
class TwinSettingsService extends EventEmitter {
    #repo; #client; #register; #queue = Promise.resolve(); #reconciling; #timer; #runtime = null;
    constructor({ repository = createTwinRepository(), client = new TwinRuntimeClient(), registerSecrets = redactor.registerSecrets } = {}) {
        super(); this.#repo = repository; this.#client = client; this.#register = registerSecrets;
    }
    getState() {
        const row = this.#repo.read(), outbox = row.outbox;
        let hasKey = false, credentialStatus = 'missing';
        try { hasKey = !!this.#repo.resolveCredential(); credentialStatus = hasKey ? 'stored' : 'missing'; }
        catch { hasKey = true; credentialStatus = 'locked'; }
        return { savedRevision: row.desired_revision, appliedRevision: outbox?.applied_revision || 0,
            state: outbox?.state || 'applied', enabled: !!row.fireflies_enabled, hasKey, credentialStatus,
            meetingLink: row.normalized_meeting_link || '', operationState: this.#runtime?.operationState || 'unconfigured',
            errorCode: outbox?.last_error_code || this.#runtime?.errorCode || null };
    }
    #emit() { this.emit('updated', this.getState()); }
    save(input, retry = false) {
        if (typeof input?.credential?.value === 'string') this.#register([input.credential.value]);
        const action = async () => {
            if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['expectedRevision', 'enabled', 'meetingLink', 'credential'].includes(k)) || !Number.isSafeInteger(input.expectedRevision) || typeof input.enabled !== 'boolean') throw fail('invalid_settings');
            const credential = input.credential;
            if (!credential || !['set', 'keep', 'clear'].includes(credential.action) || Object.keys(credential).some(k => !['action', 'value'].includes(k)) || (credential.action === 'set' ? typeof credential.value !== 'string' || !credential.value.trim() || Buffer.byteLength(credential.value) > 8192 : Object.hasOwn(credential, 'value'))) throw fail('invalid_credential_action');
            const row = this.#repo.read();
            let previousKey;
            try { previousKey = this.#repo.resolveCredential(); }
            catch (error) { if (credential.action === 'keep') throw error; previousKey = undefined; }
            const key = credential.action === 'set' ? credential.value : credential.action === 'clear' ? null : previousKey;
            const enabled = !!key && credential.action !== 'clear' && input.enabled;
            const link = normalizeLink(input.meetingLink), changedLink = link !== row.normalized_meeting_link;
            if (!retry && key === previousKey && enabled === !!row.fireflies_enabled && !changedLink) return this.reconcile();
            if (input.expectedRevision !== row.desired_revision) throw fail('revision_conflict');
            if (retry && (!link || !['waiting', 'failed', 'rate_limited', 'auth_failed', 'uncertain'].includes(this.#runtime?.operationState))) throw fail('retry_not_available');
            const revision = row.desired_revision + 1;
            this.#repo.commit({ expectedRevision: row.desired_revision, key,
                settings: { desired_revision: revision, fireflies_enabled: enabled ? 1 : 0, normalized_meeting_link: link, meeting_intent_id: link ? (changedLink || retry ? randomUUID() : row.meeting_intent_id) : null },
                outbox: { desired_revision: revision, operation_id: randomUUID(), action: retry ? 'retry' : changedLink ? 'join' : 'preserve', state: 'pending' } });
            this.#emit();
            let timer;
            try { return await Promise.race([this.reconcile(), new Promise(resolve => { timer = setTimeout(() => resolve(this.getState()), 800); })]); }
            finally { clearTimeout(timer); }
        };
        const next = this.#queue.then(action); this.#queue = next.catch(() => {}); return next;
    }
    retryJoin(input) { return this.save(input, true); }
    reconcile() {
        if (this.#reconciling) return this.#reconciling;
        this.#reconciling = (async () => {
            // Each iteration re-reads the latest outbox; old acknowledgements never mark a newer save applied.
            for (let n = 0; n < 8; n++) {
                const before = this.#repo.read(); if (!before.outbox) return this.getState();
                try {
                    const server = await this.#client.getState(); this.#runtime = server;
                    const row = this.#repo.read(), outbox = row.outbox;
                    if (server.appliedRevision === row.desired_revision && server.operationId === outbox.operation_id) {
                        this.#repo.acknowledge(row.desired_revision, server.instanceId); this.#emit(); return this.getState();
                    }
                    if (server.appliedRevision >= row.desired_revision) throw fail('runtime_revision_conflict');
                    const key = this.#repo.resolveCredential(); if (key) this.#register([key]);
                    const payload = { installationId: row.installation_id, expectedInstanceId: server.instanceId, expectedRevision: server.appliedRevision,
                        desiredRevision: row.desired_revision, operationId: outbox.operation_id, enabled: !!row.fireflies_enabled,
                        meetingLink: row.normalized_meeting_link, meetingIntentId: row.meeting_intent_id,
                        meetingAction: outbox.action === 'preserve' ? 'preserve' : 'join', credential: key ? { action: 'set', value: key } : { action: 'clear' } };
                    const retry = outbox.action === 'retry' && server.appliedRevision > 0;
                    if (retry) payload.credential = { action: 'keep' };
                    const applied = await this.#client.apply(payload, { retry }); this.#runtime = applied;
                    if (applied.appliedRevision !== row.desired_revision || applied.operationId !== outbox.operation_id) throw fail('runtime_invalid_response');
                    this.#repo.acknowledge(row.desired_revision, applied.instanceId);
                    if (this.#repo.read().desired_revision === row.desired_revision) { this.#emit(); return this.getState(); }
                } catch (error) { this.#repo.pending(/^[a-z_]{1,64}$/.test(error.code) ? error.code : 'runtime_unavailable'); this.#emit(); return this.getState(); }
            }
            return this.getState();
        })().finally(() => { this.#reconciling = null; });
        return this.#reconciling;
    }
    async ensureApplied() { const state = await this.reconcile(); return { success: state.savedRevision === 0 || state.state === 'applied', ...state }; }
    start() { if (this.#timer) return; this.#timer = setInterval(() => this.reconcile().catch(() => {}), 2000); this.#timer.unref?.(); this.reconcile().catch(() => {}); }
    stop() { clearInterval(this.#timer); this.#timer = null; }
}
let singleton;
function getTwinSettingsService() { return singleton ||= new TwinSettingsService(); }
module.exports = { TwinSettingsService, getTwinSettingsService, normalizeLink };
