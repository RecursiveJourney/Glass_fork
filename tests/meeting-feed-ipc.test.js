const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const plain = value => JSON.parse(JSON.stringify(value));
function load(relative, stubs) {
    const filename = path.join(__dirname, '../src', relative), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, process: { env: {}, platform: 'win32' }, Buffer,
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        require: id => {
            if (!Object.hasOwn(stubs, id)) throw new Error('Unexpected dependency: ' + id);
            return stubs[id];
        },
    }, { filename });
    return module.exports;
}

function harness() {
    const counts = { constructed: 0, start: 0, stop: 0, local: 0 }, callbacks = new Set(), sent = [];
    let state = { connectionStatus: 'idle', snapshot: null, error: null, nextRetryAt: null };
    class Feed {
        constructor(...args) { counts.constructed++; assert.equal(args.length, 0, 'configuration stays in main-process service'); }
        start() { counts.start++; state = { ...state, connectionStatus: 'connecting' }; this.emit(); return this.getState(); }
        stop() { counts.stop++; state = { ...state, connectionStatus: 'stopped' }; this.emit(); return this.getState(); }
        getState() { return structuredClone(state); }
        subscribe(callback) { callbacks.add(callback); callback(this.getState()); return () => callbacks.delete(callback); }
        emit() { for (const cb of callbacks) cb(this.getState()); }
    }
    class Stt {
        setCallbacks() {}
        initializeSttSessions() { counts.local++; }
        isSessionActive() { return false; }
        async closeSessions() { counts.local++; }
        stopMacOSAudioCapture() { counts.local++; }
    }
    class Summary {
        setCallbacks() {}
        addConversationTurn() { counts.local++; }
        resetConversationHistory() { counts.local++; }
    }
    const listen = load('features/listen/listenService.js', {
        electron: {}, './stt/sttService': Stt, './summary/summaryService': Summary,
        './meeting/meetingFeedService': Feed,
        '../common/services/authService': {}, '../common/repositories/session': {}, './stt/repositories': {},
        '../../bridge/internalBridge': new EventEmitter(),
        '../../window/windowManager': { windowPool: new Map([['listen', {
            isDestroyed: () => false, webContents: { send: (channel, value) => sent.push({ channel, value: plain(value) }) },
        }]]) },
    });
    return { listen, counts, callbacks, sent };
}

test('Listen service exposes an idle meeting state without constructing or starting a subscriber', () => {
    const h = harness();
    assert.equal(typeof h.listen.getMeetingFeedState, 'function');
    assert.equal(h.listen.getMeetingFeedState().connectionStatus, 'idle');
    assert.deepEqual(h.counts, { constructed: 0, start: 0, stop: 0, local: 0 });
    assert.equal(h.sent.length, 0);
});

test('meeting start/stop/restart forwards state and cleans listeners without local STT, database or generation', () => {
    const h = harness();
    assert.equal(typeof h.listen.startMeetingFeed, 'function');
    assert.equal(h.listen.startMeetingFeed().success, true);
    assert.equal(h.listen.getMeetingFeedState().connectionStatus, 'connecting');
    assert.equal(h.callbacks.size, 1);
    assert.ok(h.sent.every(event => ['meeting-feed:state', 'listen:state'].includes(event.channel)));
    assert.equal(h.listen.stopMeetingFeed().state.connectionStatus, 'stopped');
    assert.equal(h.callbacks.size, 0);
    h.listen.startMeetingFeed(); assert.equal(h.callbacks.size, 1);
    h.listen.stopMeetingFeed(); assert.equal(h.callbacks.size, 0);
    assert.equal(h.counts.local, 0);
    assert.equal(h.listen.currentSessionId, null);
});

test('existing app cleanup closes the meeting subscription through closeSession', async () => {
    const h = harness();
    assert.equal(typeof h.listen.startMeetingFeed, 'function');
    h.listen.startMeetingFeed();
    await h.listen.closeSession();
    assert.equal(h.counts.stop, 1); assert.equal(h.callbacks.size, 0);
});

function bridge(listen, ask) {
    const handlers = new Map();
    const stubs = {
        electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
        '../features/listen/listenService': listen,
    };
    for (const name of [
        '../features/settings/settingsService', '../features/common/services/authService',
        '../features/common/services/whisperService', '../features/common/services/ollamaService',
        '../features/common/services/modelStateService', '../features/shortcuts/shortcutsService',
        '../features/common/repositories/preset', '../features/common/services/localAIManager',
        '../features/ask/askService', '../features/common/services/permissionService',
        '../features/common/services/encryptionService',
    ]) stubs[name] = new EventEmitter();
    stubs['../features/common/services/localAIManager'].startPeriodicSync = () => {};
    if (ask) stubs['../features/ask/askService'] = ask;
    load('bridge/featureBridge.js', stubs).initialize();
    return handlers;
}

test('actual registered meeting IPC handlers ignore renderer config and stay separate from local Listen', async () => {
    const calls = [];
    let source = 'meeting';
    const listen = {
        getListenState: () => ({ source }),
        handleListenRequest: (...args) => calls.push({ method: 'lifecycle', args }),
        getMeetingFeedState: (...args) => calls.push({ method: 'state', args }),
    };
    const handlers = bridge(listen);
    assert.equal(typeof handlers.get('meeting-feed:start'), 'function');
    assert.equal(calls.length, 0, 'IPC surface is not automatically activated');
    for (const action of ['start', 'stop', 'get-state']) {
        await handlers.get('meeting-feed:' + action)({}, { url: 'https://example.invalid/', wrapperToken: 'SYNTHETIC' });
    }
    assert.deepEqual(calls, [{ method: 'lifecycle', args: ['Listen'] }, { method: 'lifecycle', args: ['Stop'] }, { method: 'state', args: [] }]);
    source = 'local';
    assert.equal((await handlers.get('meeting-feed:start')({})).error, 'meeting_source_required');
    assert.equal(calls.length, 3);
});

test('authoritative Listen IPC preserves result, capture sender and Ask independence', async () => {
    const calls = [], sender = {}, state = { source: 'meeting', phase: 'active' };
    const handlers = bridge({
        getListenState: () => state, getListenCapabilities: () => ({ meeting: true, ask: true }),
        selectSource: source => { calls.push(source); return { success: false, state }; },
        acknowledgeCapture: (payload, actualSender) => { assert.equal(actualSender, sender); return payload; },
        handleListenRequest: () => ({ success: false, state, error: 'listen_busy' }),
    }, { sendMessage: (...args) => { calls.push(args); return 'ask-response'; }, toggleAskButton: () => 'ask-open' });
    assert.equal((await handlers.get('listen:get-state')()).source, 'meeting');
    assert.equal((await handlers.get('listen:get-capabilities')()).ask, true);
    assert.equal((await handlers.get('listen:changeSession')({}, 'Listen')).success, false);
    assert.equal((await handlers.get('listen:select-source')({}, 'local')).success, false);
    assert.equal((await handlers.get('listen:capture-ack')({ sender }, { success: true })).success, true);
    assert.equal(await handlers.get('ask:sendQuestionFromAsk')({}, 'question'), 'ask-response');
    assert.equal(await handlers.get('ask:sendQuestionFromSummary')({}, 'follow-up'), 'ask-response');
    assert.equal(await handlers.get('ask:toggleAskButton')(), 'ask-open');
    assert.deepEqual(calls, ['local', ['question'], ['follow-up']]);
});

test('preload exposes no config setter or Electron event and returns per-listener cleanup', async () => {
    const ipc = new EventEmitter(), invokes = []; let api;
    ipc.invoke = async (...args) => { invokes.push(args); return {}; };
    load('preload.js', { electron: { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } } });
    assert.ok(api.meetingFeed);
    assert.deepEqual(Object.keys(api.listen).sort(), ['ackCapture', 'getCapabilities', 'getState', 'onState', 'selectSource']);
    assert.deepEqual(Object.keys(api.meetingFeed).sort(), ['getState', 'onState', 'start', 'stop']);
    await api.meetingFeed.start({ wrapperToken: 'SYNTHETIC' });
    await api.meetingFeed.stop(); await api.meetingFeed.getState();
    assert.deepEqual(invokes, [['meeting-feed:start'], ['meeting-feed:stop'], ['meeting-feed:get-state']]);
    const received = [];
    const off = api.meetingFeed.onState((...args) => received.push(args));
    const offOther = api.meetingFeed.onState(() => {});
    ipc.emit('meeting-feed:state', { sender: 'must not cross bridge' }, { connectionStatus: 'connected' });
    assert.deepEqual(plain(received), [[{ connectionStatus: 'connected' }]]);
    off(); off(); assert.equal(ipc.listenerCount('meeting-feed:state'), 1);
    offOther(); assert.equal(ipc.listenerCount('meeting-feed:state'), 0);
    const states = [], dispose = api.listen.onState(value => states.push(value));
    ipc.emit('listen:state', { privateEvent: true }, { source: 'meeting' });
    assert.deepEqual(plain(states), [{ source: 'meeting' }]);
    dispose(); dispose(); assert.equal(ipc.listenerCount('listen:state'), 0);
    await api.listen.ackCapture({ status: 'stop', lifecycleId: 2, success: true, extra: 'discard' });
    assert.deepEqual(plain(invokes.at(-1)), ['listen:capture-ack', { status: 'stop', lifecycleId: 2, success: true }]);
});
