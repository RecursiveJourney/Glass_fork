const test = require('node:test'), assert = require('node:assert/strict');
let TwinSettingsService;
try { ({ TwinSettingsService } = require('../src/features/settings/twinSettingsService')); } catch {}
function fixture() {
    assert.equal(typeof TwinSettingsService, 'function');
    let row = { installation_id: 'fixture-installation', desired_revision: 0, fireflies_enabled: 0, normalized_meeting_link: null, meeting_intent_id: null }, key = null, outbox = null;
    const calls = [], registry = [], commits = [];
    let server = { component: 'digital-twin', protocolVersion: 1, instanceId: 'fixture-server', appliedRevision: 0, operationId: null, operationState: 'unconfigured' };
    const repo = { read: () => ({ ...row, outbox }), resolveCredential: () => key,
        commit(next) { assert.equal(next.expectedRevision, row.desired_revision); row = { ...row, ...next.settings }; key = next.key; outbox = { ...next.outbox }; commits.push(next); },
        acknowledge(revision, instanceId) { if (revision === row.desired_revision) outbox = { ...outbox, applied_revision: revision, server_instance: instanceId, state: 'applied', last_error_code: null }; },
        pending(code) { if (outbox) outbox = { ...outbox, state: 'pending', last_error_code: code }; } };
    const client = { getState: async () => server, apply: async payload => {
        assert.ok(!payload.credential.value || registry.includes(payload.credential.value)); calls.push(payload);
        server = { ...server, appliedRevision: payload.desiredRevision, operationId: payload.operationId, operationState: 'waiting' }; return server;
    } };
    const service = new TwinSettingsService({ repository: repo, client, registerSecrets: values => registry.push(...values) });
    return { service, calls, commits, repo, client, registry, restart() { server = { ...server, instanceId: 'restarted', appliedRevision: 0, operationId: null }; } };
}
const save = extra => ({ expectedRevision: 0, enabled: true, meetingLink: 'https://meet.google.com/abc-defg-hij', credential: { action: 'set', value: 'synthetic-fireflies' }, ...extra });
test('save commits and applies, duplicate clicks are a no-op and rotation preserves meeting intent', async () => {
    const f = fixture(); const first = await f.service.save(save());
    assert.equal(first.savedRevision, 1); assert.equal(first.appliedRevision, 1); assert.equal(first.state, 'applied');
    assert.equal(f.calls[0].meetingAction, 'join');
    await f.service.save(save()); assert.equal(f.commits.length, 1);
    await f.service.save(save({ expectedRevision: 1, credential: { action: 'set', value: 'synthetic-rotated' } }));
    assert.equal(f.calls[1].meetingIntentId, f.calls[0].meetingIntentId); assert.equal(f.calls[1].meetingAction, 'preserve');
    f.restart(); await f.service.reconcile(); assert.equal(f.calls.at(-1).meetingAction, 'preserve');
    assert.equal(JSON.stringify(f.service.getState()).includes('synthetic-'), false);
    assert.equal(f.service.getState().installationId, undefined);
});
test('offline save stays durable pending, newest save supersedes it and clear never sends an old key', async () => {
    const f = fixture(), connected = f.client.getState; f.client.getState = async () => { throw Error('synthetic-secret'); };
    const pending = await f.service.save(save()); assert.equal(pending.state, 'pending'); assert.equal(f.repo.read().desired_revision, 1);
    await f.service.save(save({ expectedRevision: 1, enabled: false, credential: { action: 'clear' } }));
    f.client.getState = connected; await f.service.reconcile();
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].credential, { action: 'clear' });
    assert.equal(f.service.getState().hasKey, false);
});
test('stale edits fail without writing and lost acknowledgements reconcile by operation id', async () => {
    const f = fixture(), apply = f.client.apply;
    f.client.apply = async payload => { await apply(payload); throw Error('ack_lost'); };
    await f.service.save(save()); await f.service.reconcile();
    assert.equal(f.calls.length, 1); assert.equal(f.service.getState().state, 'applied');
    await assert.rejects(f.service.save(save({ meetingLink: 'https://meet.google.com/xyz-abcd-efg' })), { code: 'revision_conflict' });
    assert.equal(f.commits.length, 1);
});
test('explicit replacement and clear can recover a locked prior credential', async () => {
    for (const credential of [{ action: 'set', value: 'synthetic-recovery' }, { action: 'clear' }]) {
        const f = fixture(), resolve = f.repo.resolveCredential;
        f.repo.resolveCredential = () => { if (!f.commits.length) throw Object.assign(Error('credential_locked'), { code: 'credential_locked' }); return resolve(); };
        const result = await f.service.save(save({ credential }));
        assert.equal(result.savedRevision, 1); assert.equal(result.credentialStatus, credential.action === 'clear' ? 'missing' : 'stored');
    }
});
