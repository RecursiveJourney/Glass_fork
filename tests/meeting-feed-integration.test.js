const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const listenerModule = file => import(pathToFileURL(path.resolve(__dirname, '../../realtime_listener/lib', file)).href);
async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'subscriber state reached before deadline');
}

test('Glass subscribers consume the committed live session over both authenticated loopbacks without owning work', { timeout: 10000 }, async t => {
    const [{ startHttpServer }, { startLiveSession }] = await Promise.all([
        listenerModule('http-server.js'), listenerModule('live-session.js'),
    ]);
    const MeetingFeedService = require('../src/features/listen/meeting/meetingFeedService');
    let transport, tick, now = 0, connections = 0, loops = 0, generations = 0;
    const session = await startLiveSession({ config: { triggerSeconds: 1, bufferSeconds: 3 },
        clock: () => now, discoverMeeting: async () => 'meeting',
        connectRealtime: callbacks => {
            connections++; transport = callbacks; callbacks.onStateChange('connected'); return { close() {} };
        },
        setIntervalImpl: callback => { loops++; tick = callback; return 1; }, clearIntervalImpl() {},
        suggest: async () => { generations++; return 'Automatic suggestion'; },
    });
    t.after(() => session.close());
    const server = await startHttpServer({ port: 0, wrapperToken: 'synthetic-integration-token',
        subscribeLiveEvents: session.subscribeLiveEvents,
        suggest: () => assert.fail('Subscribers must not request Ask generation'),
    });
    t.after(() => server.close());
    const clients = ['127.0.0.1', '[::1]'].map(host => new MeetingFeedService({
        url: `http://${host}:${server.port}/v1/live/events`, wrapperToken: 'synthetic-integration-token',
    }));
    t.after(() => clients.forEach(client => client.stop()));
    for (const client of clients) client.start();
    await until(() => clients.every(client => client.getState().connectionStatus === 'connected'));
    assert.deepEqual([connections, loops, generations], [1, 1, 0]);

    transport.onChunk({ transcript_id: 'meeting', chunk_id: 'one', speaker_name: 'Client',
        text: 'Question 🌎', start_time: 0, end_time: 1 });
    now = 1000; await tick();
    await until(() => clients.every(client => client.getState().snapshot.suggestions.length === 1));
    const attemptId = clients[0].getState().snapshot.suggestions[0].attemptId;
    assert.equal(clients[1].getState().snapshot.suggestions[0].attemptId, attemptId);

    // A corrected chunk replaces a row while retained results survive a reconnect.
    transport.onChunk({ transcript_id: 'meeting', chunk_id: 'one', speaker_name: 'Client',
        text: 'Corrected question', start_time: 0, end_time: 1 });
    clients[0].stop(); clients[0].start();
    await until(() => clients.every(client => client.getState().connectionStatus === 'connected' &&
        client.getState().snapshot.chunks[0]?.text === 'Corrected question'));
    for (const client of clients) {
        assert.equal(client.getState().snapshot.chunks.length, 1);
        assert.deepEqual(client.getState().snapshot.suggestions.map(result => result.attemptId), [attemptId]);
    }
    assert.deepEqual([connections, loops, generations], [1, 1, 1]);

    await session.close();
    await until(() => clients.every(client => client.getState().connectionStatus === 'closed'));
    for (const client of clients) {
        assert.equal(client.getState().snapshot.closed, true);
        assert.equal(client.getState().nextRetryAt, null);
        assert.equal(client.getState().snapshot.chunks[0].text, 'Corrected question');
    }
});
