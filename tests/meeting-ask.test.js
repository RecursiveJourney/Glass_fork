const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function load(relative, stubs) {
    const module = { exports: {} }, filename = path.join(__dirname, '../src', relative);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, Buffer, AbortController, TextDecoder,
        setTimeout, clearTimeout,
        process: { platform: 'win32', env: {} }, console: { log() {}, warn() {}, error() {} },
        require(id) {
            if (Object.hasOwn(stubs, id)) return stubs[id];
            if (['crypto', 'node:path', 'node:fs', 'os', 'util', 'child_process'].includes(id)) return require(id);
            throw new Error('Unexpected dependency: ' + id);
        },
    }, { filename });
    return module.exports;
}

test('SQLite Ask requests touch an Ask row without promotion; only explicit Listen requests promote', () => {
    const writes = []; let active = { id: 'ask-owned', session_type: 'ask' };
    const repo = load('features/common/repositories/session/sqlite.repository.js', {
        '../../services/sqliteClient': { getDb: () => ({ prepare: sql => ({ get: () => active, run: (...args) => { writes.push({ sql, args }); return { changes: 1 }; } }) }) },
    });
    assert.equal(repo.getOrCreateActive('synthetic-user', 'ask'), 'ask-owned');
    assert.equal(writes.length, 1); assert.match(writes[0].sql, /SET updated_at/);
    assert.equal(writes.some(w => /SET session_type/.test(w.sql)), false);
    repo.getOrCreateActive('synthetic-user', 'listen');
    assert.equal(writes.filter(w => /SET session_type/.test(w.sql)).length, 1);
    writes.length = 0; active = null; repo.getOrCreateActive('synthetic-user', 'ask');
    assert.match(writes[0].sql, /INSERT INTO sessions/); assert.equal(writes[0].args[3], 'ask');
});

test('Firebase Ask requests touch an Ask row without promotion; only explicit Listen requests promote', async () => {
    const writes = [], added = []; let active = true;
    const repo = load('features/common/repositories/session/firebase.repository.js', {
        'firebase/firestore': {
            collection: () => ({ withConverter: () => ({}) }), doc: (_col, id) => id,
            query: (...args) => args, where: () => ({}), orderBy: () => ({}), limit: () => ({}),
            getDocs: async () => ({ empty: !active, docs: [{ id: 'ask-owned', data: () => ({ session_type: 'ask' }) }] }),
            updateDoc: async (id, value) => writes.push({ id, value }),
            addDoc: async (_col, value) => { added.push(value); return { id: 'new-ask' }; },
            Timestamp: { now: () => 1 },
        },
        '../../services/firebaseClient': { getFirestoreInstance: () => ({}) },
        '../firestoreConverter': { createEncryptedConverter: () => ({}) }, '../../services/encryptionService': {},
    });
    assert.equal(await repo.getOrCreateActive('synthetic-user', 'ask'), 'ask-owned');
    assert.deepEqual(Object.keys(writes[0].value), ['updated_at']);
    await repo.getOrCreateActive('synthetic-user', 'listen'); assert.equal(writes[1].value.session_type, 'listen');
    active = false; assert.equal(await repo.getOrCreateActive('synthetic-user', 'ask'), 'new-ask');
    assert.equal(added[0].session_type, 'ask');
});

test('Ask keeps screenshot, streaming persistence and screen-only shortcut while Meeting is selected', async () => {
    const calls = [], saved = [], prompts = [], states = [];
    let release;
    class Stt { setCallbacks() {} }
    class Summary { setCallbacks() {} }
    class Feed {
        getState() { return { connectionStatus: 'connected', snapshot: null }; }
        start() { return this.getState(); } stop() { return this.getState(); }
        subscribe(cb) { cb(this.getState()); return () => {}; }
    }
    const listen = load('features/listen/listenService.js', {
        './stt/sttService': Stt, './summary/summaryService': Summary, './meeting/meetingFeedService': Feed,
        '../common/services/authService': {}, '../common/repositories/session': {}, './stt/repositories': {},
        '../../bridge/internalBridge': new EventEmitter(), '../../window/windowManager': { windowPool: new Map() },
    });
    await listen.selectSource('meeting'); await listen.handleListenRequest('Listen');
    const askWindow = { isDestroyed: () => false, isVisible: () => true, webContents: { send: (channel, state) => states.push({ channel, state: { ...state } }) } };
    const ask = load('features/ask/askService.js', {
        electron: { desktopCapturer: { getSources: async () => { calls.push('screenshot'); return [{ thumbnail: { toJPEG: () => Buffer.from('synthetic image'), getSize: () => ({ width: 10, height: 10 }) } }]; } } },
        '../common/ai/factory': { createStreamingLLM: () => ({ streamChat: async messages => {
            prompts.push(messages); let sent = false;
            return { body: { getReader: () => ({ cancel: async () => calls.push('cancel'), read: async () => {
                if (sent) return { done: true }; sent = true;
                if (prompts.length === 1) await new Promise(resolve => { release = resolve; });
                return { done: false, value: Buffer.from('data: {"choices":[{"delta":{"content":"Twin reply"}}]}\ndata: [DONE]\n') };
            } }) } };
        } }) },
        '../../window/windowManager': { windowPool: new Map([['ask', askWindow]]) },
        '../../bridge/internalBridge': new EventEmitter(),
        '../common/repositories/session': { getOrCreateActive: async type => { calls.push(type); return 'independent-ask'; } },
        './repositories': { addAiMessage: async message => saved.push(message) },
        '../common/prompts/promptBuilder': { getSystemPrompt: (_name, context) => context },
        '../common/services/modelStateService': { getCurrentModelInfo: async () => ({ provider: 'ollama', model: 'synthetic', apiKey: 'synthetic' }) },
        // Any new Ask dependency on Listen/Meeting fails this strict loader.
    });
    const pendingAsk = ask.sendMessage('Help during the call');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await listen.handleListenRequest('Stop');
    await listen.selectSource('local'); await listen.selectSource('meeting');
    await listen.handleListenRequest('Listen');
    assert.equal(ask.abortController.signal.aborted, false);
    assert.equal(calls.includes('cancel'), false);
    release(); assert.equal((await pendingAsk).success, true);
    assert.deepEqual(calls, ['ask', 'screenshot']);
    assert.equal(saved.length, 2); assert.ok(saved.every(message => message.sessionId === 'independent-ask'));
    assert.equal(saved[1].content, 'Twin reply');
    assert.equal(prompts[0][1].content[1].type, 'image_url');
    assert.equal(prompts[0][0].content, 'No conversation history available.');
    ask.state.showTextInput = true; await ask.toggleAskButton(true);
    assert.equal(prompts.length, 2); assert.equal(calls.filter(c => c === 'screenshot').length, 2);
    assert.equal(calls.filter(c => c === 'cancel').length, 1, 'existing Ask-on-Ask cancellation remains unchanged');
    assert.ok(states.some(event => event.state.currentResponse === 'Twin reply'));
    await listen.closeSession();
});

test('Meeting source lifecycle and feed do not import or call Ask or provider mutation APIs', () => {
    for (const file of ['features/listen/listenService.js', 'features/listen/meeting/meetingFeedService.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
        assert.doesNotMatch(source, /askService|toggleAskButton|closeAskWindow|sendQuestionFromAsk|setApiKey|handleRemoveApiKey|handleSetSelectedModel/);
    }
});
