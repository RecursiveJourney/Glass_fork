const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { SettingsInsightsService } = require('../src/features/settings/settingsInsightsService');
const { TwinRuntimeClient } = require('../src/features/common/services/twinRuntimeClient');
const status = () => ({ schemaVersion: 1, observedAt: 1000, gemini: { model: 'gemini-test', state: 'not_tested', observedAt: null, inFlight: 0, errorCode: null }, fireflies: { state: 'connected' } });
const knowledge = () => ({ schemaVersion: 1, dossier: { name: 'demo.txt', sha256: 'a'.repeat(64) }, prompt: { version: 'wire-1', sha256: 'b'.repeat(64) } });

test('status names reflect current source and cached Knowledge becomes explicitly stale on outage', async () => {
    let failed = false, source = 'meeting';
    const client = { getStatus: async () => { if (failed) throw Error('synthetic-private'); return status(); }, getKnowledge: async () => { if (failed) throw Error('synthetic-private'); return knowledge(); } };
    const listen = { getTranscriptionStatus: () => ({ source, state: source === 'local' ? 'loaded' : 'idle', provider: source === 'local' ? 'whisper' : null, model: source === 'local' ? 'whisper-base' : null, phase: 'active' }) };
    const service = new SettingsInsightsService({ client, listenService: listen, now: () => 1010 });
    let value = await service.read();
    assert.equal(value.server.state, 'reachable'); assert.equal(value.gemini.state, 'not_tested');
    assert.equal(value.transcription.provider, 'fireflies'); assert.equal(value.transcription.state, 'connected');
    assert.equal(value.knowledge.state, 'current');
    source = 'local'; value = await service.read(); assert.equal(value.transcription.provider, 'whisper'); assert.equal(value.transcription.model, 'whisper-base');
    failed = true; value = await service.read(); assert.equal(value.server.state, 'unavailable'); assert.equal(value.gemini.state, 'unavailable');
    assert.equal(value.knowledge.state, 'stale'); assert.equal(value.knowledge.data.dossier.name, 'demo.txt');
    assert.equal(JSON.stringify(value).includes('synthetic-private'), false);
});

test('main client authenticates insights and rejects nested private or malformed fields', async t => {
    let value = knowledge(), authorized = false;
    const token = 'synthetic-insights-control-token-32';
    const server = http.createServer((req, res) => { authorized = req.headers.authorization === 'Bearer ' + token; res.end(JSON.stringify(value)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const client = new TwinRuntimeClient({ url: 'http://127.0.0.1:' + server.address().port, token });
    assert.equal(typeof client.getKnowledge, 'function');
    assert.deepEqual(await client.getKnowledge(), knowledge()); assert.equal(authorized, true);
    value.dossier.secret = 'synthetic-private'; await assert.rejects(client.getKnowledge(), { code: 'runtime_invalid_response' });
    value = status(); assert.deepEqual(await client.getStatus(), status());
    value.gemini.state = 'ready-because-key-exists'; await assert.rejects(client.getStatus(), { code: 'runtime_invalid_response' });
    assert.equal(JSON.stringify(client).includes(token), false);
});
