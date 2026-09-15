const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
let TwinRuntimeClient;
try { ({ TwinRuntimeClient } = require('../src/features/common/services/twinRuntimeClient')); } catch {}
test('main-only client authenticates to actual runtime HTTP and rejects credential-bearing response fields', async t => {
    assert.equal(typeof TwinRuntimeClient, 'function');
    const { startHttpServer } = await import('../../realtime_listener/lib/http-server.js');
    const { createRuntimeConfig } = await import('../../realtime_listener/lib/runtime-config.js');
    const token = 'synthetic-control-token-32-characters';
    const runtime = createRuntimeConfig();
    const server = await startHttpServer({ port: 0, controlToken: token, runtimeConfig: runtime, suggest: async () => ({ text: 'unused' }) }); t.after(() => server.close());
    const client = new TwinRuntimeClient({ url: 'http://127.0.0.1:' + server.port, token });
    const state = await client.getState(); assert.equal(state.component, 'digital-twin');
    assert.equal(JSON.stringify(client).includes(token), false);
    assert.throws(() => new TwinRuntimeClient({ url: 'https://example.invalid', token }));
    const wrong = new TwinRuntimeClient({ url: 'http://127.0.0.1:' + server.port, token: token + '-wrong' });
    await assert.rejects(wrong.getState(), { code: 'runtime_unauthorized' });
});
test('runtime client rejects injected credential fields and malformed public status values', async t => {
    assert.equal(typeof TwinRuntimeClient, 'function');
    let privateFields = { apiKey: 'synthetic-private' };
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ component: 'digital-twin', protocolVersion: 1, instanceId: 'fixture', appliedRevision: 1, ...privateFields })));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const client = new TwinRuntimeClient({ url: 'http://127.0.0.1:' + server.address().port, token: 'synthetic-control-token-32-characters' });
    await assert.rejects(client.getState(), { code: 'runtime_invalid_response' });
    privateFields = { operationState: { apiKey: 'synthetic-private' } };
    await assert.rejects(client.getState(), { code: 'runtime_invalid_response' });
});
