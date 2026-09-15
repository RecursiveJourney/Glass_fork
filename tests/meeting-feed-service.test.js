const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const filename = path.join(__dirname, '../src/features/listen/meeting/meetingFeedService.js');
function load() {
    assert.ok(fs.existsSync(filename), 'MeetingFeedService must implement the approved subscriber contract');
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
        id => {
            assert.ok(['node:http', 'node:string_decoder'].includes(id), 'Subscriber must not import capture, generation, or provider dependencies: ' + id);
            return require(id);
        }, module, module.exports);
    return module.exports;
}
const envelope = (sequence, instanceId = 'instance-a') => ({ instanceId, sequence, transcriptId: 'meeting' });
const chunk = (id = 'a', text = 'Hello 🌎') => ({ chunk_id: id, speaker_name: 'Client', text, start_time: 1, end_time: 2 });
const result = (attemptId, extra = {}) => ({ attemptId, revision: 1, text: 'same text', noSuggestion: false, completedAt: '2026-09-14T10:00:00.000Z', ...extra });
const snapshot = (sequence = 0, extra = {}) => ({ ...envelope(sequence), revision: 1, chunks: [chunk()], suggestions: [], suggestionHistoryLimit: 20,
    connectionState: 'connected', availability: 'available', ageMs: 0, generation: { state: 'idle' }, ...extra });
const frame = (type, data) => `id: ${data.instanceId}:${data.sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function harness(options = {}) {
    let time = 0, nextId = 0;
    const timers = new Map(), requests = [];
    const setTimer = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: time + ms }); return id; };
    const advance = ms => {
        const end = time + ms;
        for (;;) {
            const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            time = next[1].at; timers.delete(next[0]); next[1].fn();
        }
        time = end;
    };
    const requestImpl = (url, config, onResponse) => {
        const req = new EventEmitter();
        req.url = String(url); req.config = config; req.destroyed = false;
        req.end = () => {};
        req.destroy = () => { req.destroyed = true; };
        req.respond = (statusCode = 200, headers = { 'content-type': 'text/event-stream; charset=utf-8' }) => {
            const res = new EventEmitter(); res.statusCode = statusCode; res.headers = headers; res.destroyed = false;
            res.destroy = () => { res.destroyed = true; }; req.response = res; onResponse(res); return res;
        };
        requests.push(req); return req;
    };
    const Service = load();
    const service = new Service({ wrapperToken: 'test-private-token', requestImpl, now: () => time,
        setTimeoutImpl: setTimer, clearTimeoutImpl: id => timers.delete(id), random: () => 0, ...options });
    return { service, requests, timers, advance, now: () => time,
        connect(data = snapshot()) { service.start(); const res = requests.at(-1).respond(); res.emit('data', Buffer.from(frame('snapshot', data))); return res; },
        send(res, type, data) { res.emit('data', Buffer.from(frame(type, data))); } };
}

test('public API isolates observers, cloned state, and private transport configuration', () => {
    const h = harness(); const seen = [];
    const unsubscribe = h.service.subscribe(state => { seen.push(state); if (state.snapshot) state.snapshot.chunks.length = 0; });
    h.service.subscribe(() => { throw new Error('broken renderer'); });
    assert.deepEqual(h.service.getState(), { connectionStatus: 'idle', snapshot: null, error: null, nextRetryAt: null });
    assert.equal(h.service.start().connectionStatus, 'connecting');
    assert.equal(h.service.start().connectionStatus, 'connecting'); assert.equal(h.requests.length, 1);
    const res = h.requests[0].respond(); assert.equal(h.service.getState().connectionStatus, 'connecting');
    h.send(res, 'snapshot', snapshot()); assert.equal(h.service.getState().connectionStatus, 'connected');
    assert.equal(h.service.getState().snapshot.chunks.length, 1);
    const copy = h.service.getState(); copy.snapshot.generation.state = 'tampered';
    assert.equal(h.service.getState().snapshot.generation.state, 'idle');
    assert.equal(JSON.stringify(h.service), '{}');
    unsubscribe(); const count = seen.length; h.service.stop(); assert.equal(seen.length, count);
    assert.equal(h.timers.size, 0); assert.ok(h.requests[0].destroyed && res.destroyed);
});
test('runtime waiting clears old meeting material and accepts the replacement snapshot on the same stream', () => {
    const h = harness(), res = h.connect();
    h.send(res, 'runtime.status', { instanceId: 'runtime', sequence: 1, appliedRevision: 2, operationState: 'waiting', errorCode: null });
    assert.equal(h.service.getState().snapshot, null); assert.equal(h.service.getState().connectionStatus, 'connected');
    assert.equal(h.service.getState().runtime.operationState, 'waiting');
    h.send(res, 'snapshot', snapshot(0, { instanceId: 'replacement', transcriptId: 'new-meeting' }));
    assert.equal(h.service.getState().snapshot.transcriptId, 'new-meeting'); assert.equal(h.requests.length, 1);
    h.service.stop();
});

test('SSE handles split UTF-8, CRLF, comments, ignored fields and multiline data atomically', () => {
    const h = harness(); h.service.start(); const res = h.requests[0].respond();
    const json = JSON.stringify(snapshot()); const split = json.indexOf(',') + 1;
    const bytes = Buffer.from(`: comment\r\n\r\nretry: 1\r\nevent: snapshot\r\ndata: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n`);
    for (let i = 0; i < bytes.length - 2; i++) res.emit('data', bytes.subarray(i, i + 1));
    assert.equal(h.service.getState().snapshot, null);
    res.emit('data', bytes.subarray(-2));
    assert.equal(h.service.getState().snapshot.chunks[0].text, 'Hello 🌎');
    h.service.stop();
});

test('CR-only terminal snapshot applies immediately before EOF and never schedules retry', () => {
    const h = harness(); h.service.start(); const res = h.requests[0].respond();
    res.emit('data', Buffer.from(frame('snapshot', snapshot(0, { closed: true })).replaceAll('\n', '\r')));
    assert.equal(h.service.getState().connectionStatus, 'closed');
    assert.equal(h.service.getState().snapshot.closed, true); assert.equal(h.timers.size, 0);
    res.emit('end'); h.advance(100000);
    assert.equal(h.service.getState().connectionStatus, 'closed'); assert.equal(h.requests.length, 1); h.service.stop();
});

test('CRLF split across chunks accepts CR immediately and swallows the later LF', () => {
    const h = harness(); h.service.start(); const res = h.requests[0].respond();
    const bootstrap = frame('snapshot', snapshot()).replaceAll('\n', '\r\n');
    res.emit('data', Buffer.from(bootstrap.slice(0, -1)));
    assert.equal(h.service.getState().connectionStatus, 'connected');
    const status = frame('status', { ...envelope(1), connectionState: 'disconnected', availability: 'disconnected', ageMs: 10 }).replaceAll('\n', '\r\n');
    const remainder = Buffer.from('\n' + status);
    for (const byte of remainder) res.emit('data', Buffer.from([byte]));
    assert.equal(h.service.getState().connectionStatus, 'connected');
    assert.equal(h.service.getState().snapshot.sequence, 1);
    assert.equal(h.service.getState().snapshot.connectionState, 'disconnected'); h.service.stop();
});

test('transcript windows replace atomically; duplicate and older sequence values are ignored', () => {
    const h = harness(); const res = h.connect(snapshot(10));
    h.send(res, 'transcript.snapshot', { ...envelope(11), revision: 2, chunks: [chunk('b')] });
    h.send(res, 'transcript.snapshot', { ...envelope(11), revision: 3, chunks: [chunk('bad')] });
    h.send(res, 'transcript.snapshot', { ...envelope(2), revision: 3, chunks: [chunk('bad')] });
    assert.deepEqual(h.service.getState().snapshot.chunks.map(c => c.chunk_id), ['b']);
    h.send(res, 'transcript.snapshot', { ...envelope(12), revision: 3, chunks: [] });
    assert.deepEqual(h.service.getState().snapshot.chunks, []); assert.equal(h.service.getState().snapshot.sequence, 12);
    h.service.stop();
});

test('attempt identity upserts, retains no-suggestion, and bounds all outcomes to 20', () => {
    const h = harness(); const res = h.connect();
    for (let i = 1; i <= 25; i++) h.send(res, 'suggestion.result', { ...envelope(i), ...result('attempt-' + i, i === 25 ? { noSuggestion: true, text: '[no suggestion]' } : {}) });
    let state = h.service.getState(); assert.equal(state.snapshot.suggestions.length, 20);
    assert.equal(state.snapshot.suggestions[0].attemptId, 'attempt-6'); assert.equal(state.snapshot.suggestions.at(-1).noSuggestion, true);
    h.send(res, 'suggestion.result', { ...envelope(26), ...result('attempt-25', { text: 'corrected' }) });
    state = h.service.getState(); assert.equal(state.snapshot.suggestions.length, 20); assert.equal(state.snapshot.suggestions.at(-1).text, 'corrected');
    h.service.stop();
});

test('reconnect replaces retained history and reconciles pending attempt without duplicate outcomes', () => {
    const h = harness(); const res = h.connect(snapshot(9, { suggestions: [result('old')] }));
    res.emit('end'); assert.equal(h.service.getState().connectionStatus, 'reconnecting'); h.advance(500);
    const res2 = h.requests[1].respond(); h.send(res2, 'snapshot', snapshot(30, { suggestions: [result('new'), result('latest')],
        generation: { state: 'running', attemptId: 'pending', revision: 2, startedAt: '2026-09-14T10:00:00.000Z' } }));
    h.send(res2, 'suggestion.result', { ...envelope(31), ...result('pending') });
    h.send(res2, 'suggestion.result', { ...envelope(31), ...result('pending') });
    assert.deepEqual(h.service.getState().snapshot.suggestions.map(s => s.attemptId), ['new', 'latest', 'pending']);
    assert.equal(h.service.getState().snapshot.generation.state, 'idle'); h.service.stop();
});

test('new instance snapshot resets transcript, sequence, history and pending state even for same meeting', () => {
    const h = harness(); const res = h.connect(snapshot(999, { suggestions: [result('reused')], generation: { state: 'running', attemptId: 'pending', revision: 1, startedAt: '2026-09-14T10:00:00.000Z' } }));
    res.emit('error', new Error('private details')); h.advance(500);
    const res2 = h.requests[1].respond(); h.send(res2, 'snapshot', snapshot(0, { instanceId: 'instance-b', chunks: [], suggestions: [] }));
    h.send(res2, 'suggestion.result', { ...envelope(1, 'instance-b'), ...result('reused') });
    const state = h.service.getState(); assert.equal(state.snapshot.instanceId, 'instance-b'); assert.equal(state.snapshot.sequence, 1);
    assert.deepEqual(state.snapshot.chunks, []); assert.equal(state.snapshot.suggestions.length, 1); assert.equal(state.snapshot.generation.state, 'idle'); h.service.stop();
});

for (const kind of ['gap', 'wrong-instance', 'before-bootstrap', 'duplicate-bootstrap', 'wrong-meeting']) {
    test(kind + ' invalidates the connection and requires a fresh authoritative snapshot', () => {
        const h = harness(); h.service.start(); const res = h.requests[0].respond();
        if (kind !== 'before-bootstrap') h.send(res, 'snapshot', snapshot(3));
        if (kind === 'duplicate-bootstrap') h.send(res, 'snapshot', snapshot(3));
        else h.send(res, 'status', { ...envelope(kind === 'gap' ? 5 : 4, kind === 'wrong-instance' ? 'instance-b' : 'instance-a'),
            transcriptId: kind === 'wrong-meeting' ? 'other-meeting' : 'meeting', connectionState: 'connected', availability: 'available', ageMs: 1 });
        assert.equal(h.service.getState().connectionStatus, 'reconnecting'); assert.ok(res.destroyed);
        h.advance(500); assert.equal(h.requests.length, 2); h.service.stop();
    });
}

test('stop during connection/backoff and all late old callbacks cannot mutate a later subscription', () => {
    const h = harness(); h.service.start(); const old = h.requests[0]; const staleTimers = [...h.timers.values()].map(t => t.fn);
    h.service.stop(); const late = old.respond(); assert.ok(late.destroyed);
    const current = h.connect(); const before = h.service.getState();
    old.emit('error', new Error('late')); late.emit('error', new Error('late')); late.emit('end');
    h.send(late, 'snapshot', snapshot(999)); staleTimers.forEach(fn => fn());
    assert.deepEqual(h.service.getState(), before); assert.equal(h.requests.length, 2);
    current.emit('end'); h.service.stop(); h.advance(100000); assert.equal(h.requests.length, 2); assert.equal(h.timers.size, 0);
});

test('request EOF before response retries immediately, and late request close is isolated', () => {
    const h = harness(); h.service.start(); const old = h.requests[0];
    old.emit('close');
    assert.equal(h.service.getState().connectionStatus, 'reconnecting');
    assert.equal(h.service.getState().nextRetryAt, 500);
    h.advance(500); const res = h.requests[1].respond(); h.send(res, 'snapshot', snapshot());
    old.emit('close'); assert.equal(h.service.getState().connectionStatus, 'connected'); h.service.stop();
});

test('owned transport listeners detach on Stop and retry while external listeners and safe error sinks survive', () => {
    for (const action of ['stop', 'retry']) {
        const h = harness(); const res = h.connect(); const req = h.requests[0];
        const oldDataHandler = res.listeners('data')[0]; const oldErrorHandler = res.listeners('error').at(-1);
        const externalData = () => {}; const externalClose = () => {};
        res.on('data', externalData); req.on('close', externalClose);
        if (action === 'stop') h.service.stop(); else res.emit('end');
        assert.deepEqual(res.listeners('data'), [externalData]);
        for (const event of ['end', 'close', 'aborted']) assert.equal(res.listenerCount(event), 0, event);
        assert.deepEqual(req.listeners('close'), [externalClose]);
        assert.equal(req.listenerCount('error'), 1); assert.equal(res.listenerCount('error'), 1);
        const before = h.service.getState();
        oldDataHandler(Buffer.from(frame('snapshot', snapshot(999)))); oldErrorHandler(new Error('old failure'));
        assert.deepEqual(h.service.getState(), before); assert.doesNotThrow(() => res.emit('error', new Error('late')));
        h.service.stop();
    }
});

test('snapshot pending attempt settles on error and a new attempt at the same revision completes independently', () => {
    const h = harness(); const res = h.connect(snapshot(0, { generation: { state: 'running', attemptId: 'pending', revision: 1, startedAt: '2026-09-14T10:00:00.000Z' } }));
    assert.equal(h.service.getState().snapshot.generation.attemptId, 'pending');
    h.send(res, 'suggestion.error', { ...envelope(1), attemptId: 'pending', revision: 1, message: 'sanitized failure', completedAt: '2026-09-14T10:00:00.000Z' });
    assert.equal(h.service.getState().snapshot.generation.state, 'idle'); assert.equal(h.service.getState().error, 'suggestion-failed');
    assert.deepEqual(h.service.getState().snapshot.suggestions, []);
    h.send(res, 'suggestion.started', { ...envelope(2), attemptId: 'retry', revision: 1, startedAt: '2026-09-14T10:00:01.000Z' });
    assert.equal(h.service.getState().snapshot.generation.attemptId, 'retry'); assert.equal(h.service.getState().error, null);
    h.send(res, 'suggestion.result', { ...envelope(3), ...result('retry') });
    assert.equal(h.service.getState().snapshot.generation.state, 'idle'); assert.deepEqual(h.service.getState().snapshot.suggestions.map(s => s.attemptId), ['retry']); h.service.stop();
});

test('malformed delta does not partially apply sequence or transcript changes', () => {
    const h = harness(); const res = h.connect(snapshot(10)); const before = h.service.getState().snapshot;
    h.send(res, 'transcript.snapshot', { ...envelope(11), revision: 4, chunks: [{ ...chunk(), end_time: -1 }] });
    assert.equal(h.service.getState().connectionStatus, 'reconnecting'); assert.deepEqual(h.service.getState().snapshot, before); h.service.stop();
});

test('liveness deadline includes hung request and response bootstrap, and partial bytes do not extend it', () => {
    for (const phase of ['request', 'headers', 'partial']) {
        const h = harness(); h.service.start(); const res = phase === 'request' ? null : h.requests[0].respond();
        h.advance(44000); if (phase === 'partial') res.emit('data', Buffer.from(': incomplete'));
        h.advance(1000); assert.equal(h.service.getState().connectionStatus, 'reconnecting', phase);
        assert.equal(h.service.getState().error, 'feed-timeout'); assert.ok(h.requests[0].destroyed); h.service.stop();
    }
});

test('complete heartbeats sustain liveness without pretending bootstrap is connected', () => {
    const h = harness(); h.service.start(); const res = h.requests[0].respond();
    for (let i = 0; i < 4; i++) { h.advance(15000); res.emit('data', Buffer.from(': heartbeat\n\n')); }
    assert.equal(h.service.getState().connectionStatus, 'connecting');
    h.send(res, 'snapshot', snapshot()); h.advance(44000); assert.equal(h.service.getState().connectionStatus, 'connected');
    h.advance(1000); assert.equal(h.service.getState().connectionStatus, 'reconnecting'); h.service.stop();
});

test('bounded exponential jitter resets only after 30 seconds following a valid snapshot', () => {
    const h = harness({ random: () => 1 }); h.service.start();
    for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        h.requests.at(-1).emit('error', new Error('failure')); assert.equal(h.service.getState().nextRetryAt - h.now(), expected); h.advance(expected);
    }
    const res = h.requests.at(-1).respond(); h.advance(15000); res.emit('data', Buffer.from(': heartbeat\n\n'));
    h.advance(15000); res.emit('data', Buffer.from(': heartbeat\n\n'));
    res.emit('end'); assert.equal(h.service.getState().nextRetryAt - h.now(), 30000); h.advance(30000);
    const res2 = h.requests.at(-1).respond(); h.send(res2, 'snapshot', snapshot());
    h.advance(29999); res2.emit('end'); assert.equal(h.service.getState().nextRetryAt - h.now(), 30000); h.advance(30000);
    const res3 = h.requests.at(-1).respond(); h.send(res3, 'snapshot', snapshot()); h.advance(30000);
    res3.emit('end'); assert.equal(h.service.getState().nextRetryAt - h.now(), 1000); h.service.stop();
});

test('jitter uses midpoint of uniform half-cap to cap interval', () => {
    const h = harness({ random: () => 0.5 }); h.service.start(); h.requests[0].emit('error', new Error('failed'));
    assert.equal(h.service.getState().nextRetryAt, 750); h.service.stop();
});

test('401 is terminal; 503 and redirected responses close and retry without credential forwarding', () => {
    for (const status of [401, 503, 302]) {
        const h = harness(); h.service.start(); const res = h.requests[0].respond(status, { location: 'http://external.example/' });
        assert.ok(res.destroyed); assert.equal(h.requests.length, 1);
        assert.equal(h.service.getState().connectionStatus, status === 401 ? 'auth-required' : 'reconnecting');
        if (status === 401) { h.advance(100000); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0); }
        h.service.stop();
    }
});

test('terminal bootstrap/status apply final state, cancel every timer, and allow only explicit restart', () => {
    for (const type of ['snapshot', 'status']) {
        const h = harness(); h.service.start(); const res = h.requests[0].respond();
        if (type === 'snapshot') h.send(res, type, snapshot(0, { closed: true }));
        else { h.send(res, 'snapshot', snapshot()); h.send(res, type, { ...envelope(1), connectionState: 'disconnected', availability: 'disconnected', ageMs: 10, closed: true }); }
        assert.equal(h.service.getState().snapshot.closed, true); assert.equal(h.service.getState().connectionStatus, 'closed');
        assert.equal(h.timers.size, 0); assert.ok(res.destroyed); res.emit('end'); res.emit('error', new Error('late'));
        h.advance(100000); assert.equal(h.requests.length, 1); h.service.start(); assert.equal(h.requests.length, 2); h.service.stop();
    }
});

test('private bearer is sent only in headers and reflected secret/extra payload fields never escape', () => {
    const secret = 'test-private-token'; const h = harness(); const states = []; h.service.subscribe(state => states.push(state));
    const res = h.connect(snapshot(0, { chunks: [chunk(secret, secret)], suggestions: [result('a', { text: secret, config: { wrapperToken: secret } })], extra: { token: secret } }));
    h.send(res, 'suggestion.error', { ...envelope(1), attemptId: 'a', revision: 1, message: secret, completedAt: '2026-09-14T10:00:00.000Z' });
    res.emit('error', new Error('Network leaked ' + secret));
    assert.equal(h.requests[0].config.headers.Authorization, 'Bearer ' + secret);
    assert.ok(!h.requests[0].url.includes(secret)); assert.ok(!JSON.stringify([h.service, states, h.service.getState()]).includes(secret));
    assert.equal(h.service.getState().snapshot.extra, undefined); assert.equal(h.service.getState().snapshot.suggestions[0].config, undefined); h.service.stop();
});

test('configuration rejects nonloopback, credentials, query strings and invalid bearer without making requests', () => {
    for (const url of ['https://localhost:11434/v1/live/events', 'http://external.example/v1/live/events', 'http://localhost.evil/v1/live/events',
        'http://secret@localhost/v1/live/events', 'http://localhost/v1/live/events?token=secret', 'http://localhost/v1/live/events#secret', 'http://127.0.0.2/v1/live/events']) {
        assert.throws(() => harness({ url }), /^Error: invalid-feed-config$/);
    }
    assert.throws(() => harness({ wrapperToken: 'injected\r\nHeader: x' }), /^Error: invalid-feed-config$/);
    for (const url of ['http://localhost:11434/v1/live/events', 'http://127.0.0.1:11434/v1/live/events', 'http://[::1]:11434/v1/live/events']) {
        const h = harness({ url, wrapperToken: '' }); h.service.start(); assert.equal(h.requests[0].config.headers.Authorization, undefined); h.service.stop();
    }
});

test('invalid payloads, unbounded frames, and incomplete multiline floods trigger bounded recovery', () => {
    const cases = [
        'event: snapshot\ndata: not json\n\n',
        frame('snapshot', snapshot(0, { chunks: [{ chunk_id: 'a', text: 42 }] })),
        frame('snapshot', snapshot(0, { sequence: -1 })),
        frame('snapshot', snapshot(0, { suggestions: Array.from({ length: 21 }, (_, i) => result('a' + i)) })),
        'data: ' + 'x'.repeat(1024 * 1024 + 1),
        ('data: ' + 'x'.repeat(1000) + '\n').repeat(1050),
    ];
    for (const payload of cases) {
        const h = harness(); h.service.start(); const res = h.requests[0].respond(); res.emit('data', Buffer.from(payload));
        assert.equal(h.service.getState().connectionStatus, 'reconnecting'); assert.equal(h.service.getState().snapshot, null); assert.ok(res.destroyed); h.service.stop();
    }
});

test('real native HTTP subscription reads authorized feed with no provider or capture imports', async () => {
    const Service = load(); let request;
    const server = http.createServer((req, res) => { request = req; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame('snapshot', snapshot())); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const service = new Service({ url: `http://127.0.0.1:${server.address().port}/v1/live/events`, wrapperToken: 'native-private' });
    try {
        const connected = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Local HTTP bootstrap timed out')), 3000);
            service.subscribe(state => { if (state.connectionStatus === 'connected') { clearTimeout(timeout); resolve(state); } });
        });
        service.start(); const state = await connected;
        assert.equal(request.url, '/v1/live/events'); assert.equal(request.headers.authorization, 'Bearer native-private');
        assert.equal(request.method, 'GET'); assert.equal(state.snapshot.chunks[0].text, 'Hello 🌎');
    } finally { service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('native request response callback is detached when Stop occurs before headers', async () => {
    const Service = load(); let request;
    const server = http.createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const service = new Service({ url: `http://127.0.0.1:${server.address().port}/v1/live/events`, wrapperToken: '',
        requestImpl: (...args) => { request = http.request(...args); return request; } });
    try {
        service.start(); assert.equal(request.listenerCount('response'), 1);
        service.stop(); assert.equal(request.listenerCount('response'), 0);
    } finally { service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
