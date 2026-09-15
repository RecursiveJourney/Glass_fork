const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('rapid Listen requests then Stop and Done publish idle for Local and Meeting headers',async()=>{
 for(const source of ['local','meeting']){
  const h=harness();await h.service.selectSource(source);
  for(let round=0;round<3;round++){
   await Promise.all(Array.from({length:4},()=>h.service.handleListenRequest('Listen')));
   await h.service.handleListenRequest('Stop');
  }
  assert.equal(h.service.state.phase,'stopped');const stoppedVersion=h.service.state.version;
  const done=await h.service.handleListenRequest('Done');
  assert.equal(done.success,true);assert.equal(done.state.phase,'idle');assert.ok(done.state.version>stoppedVersion);
  assert.equal(h.sent.filter(e=>e.channel==='listen:state'&&e.header).at(-1).data.phase,'idle');
 }
});

test('Done preserves cleanup failures and cannot reset a newer lifecycle',async()=>{
 const failed=harness({closeThrows:true});await failed.service.handleListenRequest('Listen');
 const result=await failed.service.handleListenRequest('Done');assert.equal(result.success,false);
 assert.equal(result.state.phase,'stopped');assert.equal(result.state.error,'local_cleanup_failed');
 const h=harness(),gate=deferred();h.service.publish({phase:'stopped'});
 const old=h.service.result(true);h.service.closeSession=()=>gate.promise;
 const done=h.service.handleListenRequest('Done');h.service.publish({phase:'active',lifecycleId:10});
 gate.resolve(old);await done;assert.equal(h.service.state.phase,'active');
});

test('transcription status reports actual loaded provider and excludes its credential', () => {
    const { service } = harness();
    service.state = { ...service.state, source: 'local', phase: 'active' };
    service.sttService.modelInfo = { provider: 'whisper', model: 'whisper-base', apiKey: 'synthetic-private' };
    service.sttService.mySttSession = {};
    assert.equal(typeof service.getTranscriptionStatus, 'function');
    assert.deepEqual({ ...service.getTranscriptionStatus() }, { source: 'local', phase: 'active', state: 'loaded', provider: 'whisper', model: 'whisper-base' });
    service.sttService.modelInfo = null;
    assert.equal(service.getTranscriptionStatus().state, 'idle');
});
function harness(options = {}) {
    const calls = [], layoutEvents = [], sent = [], subscribers = new Set(), captureTimers = new Map();
    let nextTimer = 0;
    let feed = { connectionStatus: 'idle', snapshot: null, error: null, nextRetryAt: null }, service;
    class Stt {
        setCallbacks(value) { this.callbacks = value; }
        async initializeSttSessions() { calls.push('stt.start'); if (options.sttGate) await options.sttGate.promise; }
        async closeSessions() { calls.push('stt.close'); if (options.closeThrows) throw new Error('private'); }
        stopMacOSAudioCapture() { calls.push('mac.stop'); return options.macStopGate?.promise; }
        isSessionActive() { return !!options.sttActive; }
        async sendSystemAudioContent() { calls.push('system.send'); if (options.audioGate) await options.audioGate.promise; return { success: true }; }
    }
    class Summary {
        setCallbacks() {} setSessionId(id) { this.id = id; }
        resetConversationHistory() { calls.push('summary.reset'); this.id = null; if (options.resetThrows && calls.includes('stt.start')) throw new Error('private'); }
        addConversationTurn() { calls.push('summary.add'); }
    }
    class Feed {
        subscribe(cb) { subscribers.add(cb); cb(feed); return () => subscribers.delete(cb); }
        start() { calls.push('feed.start'); feed = { ...feed, connectionStatus: 'connecting' }; this.emit(); return feed; }
        stop() { calls.push('feed.stop'); feed = { ...feed, connectionStatus: 'stopped' }; this.emit(); return feed; }
        emit() { for (const cb of subscribers) cb(feed); }
        getState() { return feed; }
    }
    const wc = { send(channel, data) {
        sent.push({ channel, data });
        if (channel === 'change-listen-capture-state' && options.ack !== false)
            queueMicrotask(() => service.acknowledgeCapture?.({ ...data, success: true }, wc));
    } };
    const windowPool = new Map(['listen', 'header'].map(name => [name, { isDestroyed: () => false, webContents: name === 'listen' ? wc : { send: (channel, data) => sent.push({ channel, data, header: true }) } }]));
    const stubs = {
        electron: {}, './stt/sttService': Stt, './summary/summaryService': Summary,
        './meeting/meetingFeedService': Feed, '../../window/windowManager': { windowPool },
        '../../bridge/internalBridge': { emit(type, data) { if(type==='listen:source-changed') layoutEvents.push(data); } },
        '../common/services/authService': { getCurrentUser: () => ({}) },
        '../common/services/modelStateService': { areProvidersConfigured: async () => { if (options.configGate) await options.configGate.promise; return options.configured !== false; } },
        '../common/services/permissionService': { checkSystemPermissions: async () => { calls.push('permissions.read'); return options.permissions ?? { microphone: 'granted', screen: 'granted', keychain: 'granted', needsSetup: false }; } },
        '../common/repositories/session': {
            async getOrCreateActive() { calls.push('db.create'); if (options.dbFails) throw new Error('private'); return 'local-session'; },
            async touch() { calls.push('db.touch'); if (options.touchGate) await options.touchGate.promise; },
            async end() { calls.push('db.end'); if (options.endThrows) throw new Error('private'); },
        }, './stt/repositories': { async addTranscript() { calls.push('db.transcript'); } },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/features/listen/listenService.js'), 'utf8'), {
        module, exports: module.exports, require(id) { if (!(id in stubs)) throw new Error(id); return stubs[id]; },
        console: { log() {}, warn() {}, error() {} }, process: { platform: 'win32' },
        setTimeout: options.fakeTimers ? (fn, delay) => { captureTimers.set(++nextTimer, { fn, delay }); return nextTimer; } : setTimeout,
        clearTimeout: options.fakeTimers ? id => captureTimers.delete(id) : clearTimeout,
    });
    service = module.exports;
    return { service, calls, layoutEvents, sent, wc, captureTimers, emit(state) { feed = { ...feed, ...state }; for (const cb of subscribers) cb(feed); } };
}
test('failed database initialization never starts capture', async () => {
    const h = harness({ dbFails: true });
    assert.equal(await h.service.initializeSession(), false);
    assert.equal(h.sent.some(e => e.channel === 'change-listen-capture-state' && e.data.status === 'start'), false);
});
test('next Meeting Listen waits for the latest runtime revision and Stop cancels that wait', async () => {
    const gate = deferred(), h = harness();
    await h.service.selectSource('meeting');
    h.service.setRuntimeSettingsService({ ensureApplied: () => gate.promise });
    const start = h.service.handleListenRequest('Listen');
    assert.equal(h.calls.includes('feed.start'), false);
    await h.service.handleListenRequest('Stop'); gate.resolve({ success: true });
    assert.equal((await start).success, false); assert.equal(h.calls.includes('feed.start'), false);
});
test('Stop while local initialization is pending prevents late capture start', async () => {
    const gate = deferred(), h = harness({ sttGate: gate });
    const start = h.service.handleListenRequest('Listen');
    while (!h.calls.includes('stt.start')) await new Promise(r => setImmediate(r));
    const stop = h.service.handleListenRequest('Stop'); gate.resolve();
    await Promise.all([start, stop]);
    assert.equal(h.sent.some(e => e.channel === 'change-listen-capture-state' && e.data.status === 'start'), false);
});
test('Meeting lifecycle never calls local capture, database or summary; reconnect remains active', async () => {
    const h = harness();
    assert.equal((await h.service.selectSource('meeting')).success, true);
    assert.equal((await h.service.handleListenRequest('Listen')).state.phase, 'active');
    assert.equal((await h.service.selectSource('local')).success, false);
    h.emit({ connectionStatus: 'reconnecting' });
    assert.equal(h.service.getListenState().phase, 'active');
    await h.service.handleTranscriptionComplete('Them', 'late local callback', 0);
    await h.service.handleListenRequest('Stop'); await h.service.closeSession();
    assert.ok(h.calls.every(call => call.startsWith('feed.')));
    assert.equal(h.sent.some(e => e.channel === 'change-listen-capture-state'), false);
});
test('Local stop performs all cleanup even when STT close fails', async () => {
    const h = harness({ closeThrows: true });
    await h.service.handleListenRequest('Listen');
    const result = await h.service.handleListenRequest('Stop');
    assert.equal(result.success, false);
    assert.ok(h.calls.includes('mac.stop')); assert.ok(h.calls.includes('db.end'));
    assert.equal(h.service.currentSessionId, null); assert.equal(h.service.summaryService.id, null);
    assert.equal((await h.service.selectSource('meeting')).success, false);
});
test('transcription pending database touch cannot persist or summarize after Stop', async () => {
    const gate = deferred(), h = harness({ touchGate: gate });
    await h.service.handleListenRequest('Listen');
    const turn = h.service.handleTranscriptionComplete('Me', 'old transcript');
    while (!h.calls.includes('db.touch')) await new Promise(r => setImmediate(r));
    await h.service.handleListenRequest('Stop'); gate.resolve(); await turn;
    assert.equal(h.calls.includes('db.transcript'), false); assert.equal(h.calls.includes('summary.add'), false);
});
test('default source initializes once from provider configuration and state publishes to both windows', async () => {
    const h = harness({ configured: false });
    assert.equal((await h.service.getListenCapabilities()).localListen, false);
    assert.equal(h.calls.includes('permissions.read'), false);
    assert.equal(h.service.getListenState().source, 'meeting');
    const states = h.sent.filter(e => e.channel === 'listen:state');
    assert.ok(states.some(e => e.header)); assert.ok(states.some(e => !e.header));
    assert.equal((await h.service.getListenCapabilities()).ask, true);
});
test('Local remains unavailable when existing permissions still require keychain setup', async () => {
    const h = harness({ permissions: { microphone: 'granted', screen: 'granted', keychain: 'unknown', needsSetup: true } });
    const capabilities = await h.service.getListenCapabilities();
    assert.equal(capabilities.localListen, false);
    assert.equal(capabilities.meeting, true);
    assert.equal((await h.service.handleListenRequest('Listen')).error, 'local_setup_required');
    assert.equal(h.calls.includes('db.create'), false); assert.equal(h.calls.includes('stt.start'), false);
});
test('failed database end is retried and cannot falsely unlock Meeting', async () => {
    const h = harness({ endThrows: true }); await h.service.handleListenRequest('Listen');
    assert.equal((await h.service.closeSession()).success, false);
    assert.equal((await h.service.closeSession()).success, false);
    assert.equal(h.calls.filter(call => call === 'db.end').length, 2);
    assert.equal((await h.service.selectSource('meeting')).success, false);
});
test('a terminal Meeting feed stops the lifecycle and can restart without retaining the old terminal state', async () => {
    const h = harness(); await h.service.selectSource('meeting'); await h.service.handleListenRequest('Listen');
    h.emit({ connectionStatus: 'closed', snapshot: { closed: true } });
    assert.equal(h.service.getListenState().phase, 'stopped');
    await h.service.handleListenRequest('Listen');
    assert.equal(h.service.getListenState().phase, 'active');
    await h.service.closeSession();
});
test('source locks and Stop cancels Listen while initial capability read is pending', async () => {
    const gate = deferred(), h = harness({ configGate: gate });
    const start = h.service.handleListenRequest('Listen');
    assert.equal((await h.service.selectSource('meeting')).success, false);
    await h.service.handleListenRequest('Stop'); gate.resolve(); await start;
    assert.equal(h.calls.includes('stt.start'), false); assert.equal(h.calls.includes('db.create'), false);
    assert.equal(h.service.getListenState().phase, 'stopped');
});
test('unconfigured Local request cannot create a session or start STT', async () => {
    const h = harness({ configured: false }); await h.service.selectSource('local');
    const result = await h.service.handleListenRequest('Listen');
    assert.equal(result.success, false); assert.equal(result.error, 'local_setup_required');
    assert.equal(h.calls.includes('db.create'), false); assert.equal(h.calls.includes('stt.start'), false);
});
test('capture readiness is local STT readiness during starting and stays false for Meeting', async () => {
    const h = harness({ sttActive: true, ack: false });
    await h.service.selectSource('meeting'); await h.service.handleListenRequest('Listen');
    assert.equal(h.service.isSessionActive(), false); await h.service.closeSession();
    await h.service.selectSource('local'); const pending = h.service.handleListenRequest('Listen');
    while (!h.sent.some(e => e.channel === 'change-listen-capture-state')) await new Promise(r => setImmediate(r));
    assert.equal(h.service.isSessionActive(), true);
    const request = h.sent.find(e => e.channel === 'change-listen-capture-state').data;
    h.service.acknowledgeCapture({ ...request, success: true }, h.wc); await pending;
    const stop = h.service.closeSession();
    while (h.sent.filter(e => e.channel === 'change-listen-capture-state').length < 2) await new Promise(r => setImmediate(r));
    const last = h.sent.filter(e => e.channel === 'change-listen-capture-state')[1].data;
    h.service.acknowledgeCapture({ ...last, success: true }, h.wc); await stop;
});
test('system audio result arriving after Stop is rejected before the bridge can render AEC', async () => {
    const gate = deferred(), h = harness({ audioGate: gate }); await h.service.handleListenRequest('Listen');
    const pending = h.service.sendSystemAudioContent('synthetic', 'audio/pcm');
    await h.service.closeSession(); gate.resolve();
    assert.equal((await pending).success, false);
});
test('stopMacOSAudioCapture waits until the capture process has stopped', async () => {
    const gate = deferred(), h = harness({ macStopGate: gate }); let done = false;
    const pending = h.service.stopMacOSAudioCapture().then(() => { done = true; });
    await new Promise(r => setImmediate(r)); assert.equal(done, false);
    gate.resolve(); await pending; assert.equal(done, true);
});
test('summary reset failure cannot block capture stop, STT cleanup or session end', async () => {
    const h = harness({ resetThrows: true }); await h.service.handleListenRequest('Listen');
    const result = await h.service.handleListenRequest('Stop');
    assert.equal(result.success, false);
    assert.ok(h.calls.includes('stt.close')); assert.ok(h.calls.includes('db.end'));
    assert.ok(h.sent.some(e => e.channel === 'change-listen-capture-state' && e.data.status === 'stop'));
});
test('capture acknowledgement requires matching actual sender and lifecycle', async () => {
    const h = harness({ ack: false }), start = h.service.handleListenRequest('Listen');
    while (!h.sent.some(e => e.channel === 'change-listen-capture-state')) await new Promise(r => setImmediate(r));
    const request = h.sent.find(e => e.channel === 'change-listen-capture-state').data;
    assert.equal(h.service.getListenState().phase, 'starting');
    assert.equal(h.service.acknowledgeCapture({ ...request, success: true }, {}).success, false);
    assert.equal(h.service.acknowledgeCapture({ ...request, lifecycleId: request.lifecycleId + 1, success: true }, h.wc).success, false);
    assert.equal(h.service.acknowledgeCapture({ ...request, success: true }, h.wc).success, true);
    await start; assert.equal(h.service.getListenState().phase, 'active');
    const stop = h.service.closeSession();
    while (h.sent.filter(e => e.channel === 'change-listen-capture-state').length < 2) await new Promise(r => setImmediate(r));
    const stopRequest = h.sent.filter(e => e.channel === 'change-listen-capture-state')[1].data;
    h.service.acknowledgeCapture({ ...stopRequest, success: true }, h.wc); await stop;
});
test('missing capture acknowledgements time out and prevent Meeting after uncertain cleanup', async () => {
    const h = harness({ ack: false, fakeTimers: true }), pending = h.service.handleListenRequest('Listen');
    while (!h.captureTimers.size) await new Promise(r => setImmediate(r));
    const startTimer = [...h.captureTimers.values()][0]; assert.equal(startTimer.delay, 5000); startTimer.fn();
    while (!h.captureTimers.size) await new Promise(r => setImmediate(r));
    const stopTimer = [...h.captureTimers.values()][0]; assert.equal(stopTimer.delay, 5000); stopTimer.fn();
    const result = await pending;
    assert.equal(result.success, false); assert.equal(result.state.phase, 'stopped');
    assert.equal((await h.service.selectSource('meeting')).success, false);
    assert.equal(h.calls.includes('feed.start'), false); assert.equal(h.captureTimers.size, 0);
});

function sttHarness(options = {}) {
    const providers = [], sent = [], timers = new Map(); let next = 0;
    const stubs = {
        electron: {}, child_process: {},
        '../../common/services/modelStateService': { getCurrentModelInfo: async () => { if (options.modelFails) throw new Error('private'); return { provider: 'whisper', model: 'tiny', apiKey: 'synthetic' }; } },
        '../../common/ai/factory': { async createSTT(provider, config) {
            const session = { closed: false, close() { this.closed = true; if (options.closeThrows && config.sessionType === 'my') throw new Error('private'); } };
            providers.push({ config, session });
            if (options.gate) await options.gate.promise;
            return session;
        } },
        '../../../window/windowManager': { windowPool: new Map([['listen', { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }]]) },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/features/listen/stt/sttService.js'), 'utf8'), {
        module, require: id => stubs[id], process: { env: {}, platform: 'win32' }, Buffer,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: fn => { timers.set(++next, fn); return next; }, setInterval: fn => { timers.set(++next, fn); return next; },
        clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    });
    return { service: new module.exports(), providers, sent, timers };
}
test('old STT provider callbacks cannot render into a restarted local lifecycle', async () => {
    const h = sttHarness(); await h.service.initializeSttSessions();
    const old = h.providers[0].config.callbacks;
    await h.service.closeSessions(); await h.service.initializeSttSessions();
    old.onmessage({ text: 'stale transcript' });
    assert.equal(h.sent.length, 0);
    await h.service.closeSessions();
});
test('STT initialization resolving after close disposes sessions without timers or renderer output', async () => {
    const gate = deferred(), h = sttHarness({ gate });
    const pending = h.service.initializeSttSessions();
    while (h.providers.length < 2) await new Promise(r => setImmediate(r));
    const close = h.service.closeSessions(); gate.resolve(); await Promise.all([pending, close]);
    assert.equal(h.service.isSessionActive(), false);
    assert.ok(h.providers.every(item => item.session.closed)); assert.equal(h.timers.size, 0);
});
test('STT cleanup resets identity and closes each socket even if the first close throws', async () => {
    const h = sttHarness({ closeThrows: true }); await h.service.initializeSttSessions();
    await h.service.closeSessions().catch(() => {});
    assert.ok(h.providers.every(item => item.session.closed));
    assert.equal(h.service.isSessionActive(), false); assert.equal(h.service.modelInfo, null);
});
test('failed STT socket cleanup remains failed on retry while the socket still refuses close', async () => {
    const h = sttHarness({ closeThrows: true }); await h.service.initializeSttSessions();
    await assert.rejects(h.service.closeSessions());
    await assert.rejects(h.service.closeSessions());
});
test('Stop closes old overlap sockets immediately after STT renewal', async () => {
    const h = sttHarness(); await h.service.initializeSttSessions(); await h.service.renewSessions();
    await h.service.closeSessions();
    assert.ok(h.providers.every(item => item.session.closed));
});
test('cancelled STT initialization preserves failed socket cleanup for retry', async () => {
    const gate = deferred(), h = sttHarness({ gate, closeThrows: true });
    const pending = h.service.initializeSttSessions();
    while (h.providers.length < 2) await new Promise(r => setImmediate(r));
    const close = h.service.closeSessions(); gate.resolve();
    await Promise.allSettled([pending, close]);
    await assert.rejects(h.service.closeSessions());
});
test('failed renewal preserves current provider callbacks', async () => {
    const options = {}, h = sttHarness(options); await h.service.initializeSttSessions();
    options.modelFails = true; await assert.rejects(h.service.renewSessions());
    h.providers[0].config.callbacks.onmessage({ text: 'current transcript' });
    assert.equal(h.sent.length, 1); await h.service.closeSessions();
});
test('macOS capture stop waits for process close instead of treating a signal as completion', async () => {
    const h = sttHarness(), proc = new EventEmitter();
    proc.kill = () => true; h.service.systemAudioProc = proc;
    let stopped = false;
    const pending = Promise.resolve(h.service.stopMacOSAudioCapture()).then(() => { stopped = true; });
    await new Promise(r => setImmediate(r)); assert.equal(stopped, false);
    proc.emit('close', 0); await pending;
    assert.equal(h.service.systemAudioProc, null);
});

test('source changes publish only source identity to window layout',async()=>{
 const h=harness();
 await h.service.selectSource('meeting');
 assert.equal(h.layoutEvents.length,1);
 assert.deepEqual(Object.keys(h.layoutEvents[0]),['source']);
 assert.equal(h.layoutEvents[0].source,'meeting');
 h.service.publish({phase:'active'});
 assert.equal(h.layoutEvents.length,1,'feed/lifecycle updates do not leak snapshot rows into geometry');
});
