const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Run the actual registered IPC handler and STT forwarder without Electron or audio I/O.
function load(relative, stubs) {
    const filename = path.join(__dirname, '../src', relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, Buffer, process: { env: {} },
        console: { log() {}, warn() {}, error() {} },
        require: id => {
            if (!Object.hasOwn(stubs, id)) throw new Error('Unexpected dependency: ' + id);
            return stubs[id];
        }
    }, { filename });
    return module.exports;
}

function harness(provider = 'whisper') {
    const handlers = new Map(), events = [], inputs = [];
    const modelState = new EventEmitter();
    modelState.getCurrentModelInfo = async () => null;
    const SttService = load('features/listen/stt/sttService.js', {
        electron: {}, child_process: {},
        '../../common/ai/factory': {},
        '../../common/services/modelStateService': modelState
    });
    const stt = new SttService();
    stt.modelInfo = { provider };
    stt.theirSttSession = { sendRealtimeInput: async payload => { inputs.push(payload); } };
    const stubs = {
        electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
        '../features/listen/listenService': {
            sttService: stt,
            sendToRenderer: (channel, payload) => events.push({ channel, payload })
        },
        '../features/common/services/modelStateService': modelState
    };
    for (const id of [
        '../features/settings/settingsService',
        '../features/common/services/authService',
        '../features/common/services/whisperService',
        '../features/common/services/ollamaService',
        '../features/shortcuts/shortcutsService',
        '../features/common/repositories/preset',
        '../features/common/services/localAIManager',
        '../features/ask/askService',
        '../features/common/services/permissionService',
        '../features/common/services/encryptionService'
    ]) stubs[id] = new EventEmitter();
    stubs['../features/common/services/localAIManager'].startPeriodicSync = () => {};
    load('bridge/featureBridge.js', stubs).initialize();
    return {
        stt, events, inputs,
        invoke: (data = 'AQIDBA==', mimeType = 'audio/pcm;rate=24000') =>
            handlers.get('listen:sendSystemAudio')({}, { data, mimeType })
    };
}

test('system-audio success waits for provider forwarding before the IPC reference event', async () => {
    const h = harness();
    let release;
    h.stt.theirSttSession.sendRealtimeInput = () => new Promise(resolve => { release = resolve; });
    const pending = h.invoke();
    assert.equal(h.events.length, 0);
    release();
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].channel, 'system-audio-data');
    assert.equal(h.events[0].payload.data, 'AQIDBA==');
});

for (const provider of ['whisper', 'gemini', 'deepgram']) {
    test(provider + ' system audio retains provider payload and emits exactly one AEC reference', async () => {
        const h = harness(provider);
        const result = await h.invoke();
        assert.equal(result.success, true);
        assert.equal(h.inputs.length, 1);
        if (provider === 'gemini') {
            assert.equal(h.inputs[0].audio.data, 'AQIDBA==');
            assert.equal(h.inputs[0].audio.mimeType, 'audio/pcm;rate=24000');
        } else if (provider === 'deepgram') {
            assert.deepEqual(h.inputs[0], Buffer.from([1, 2, 3, 4]));
        } else assert.equal(h.inputs[0], 'AQIDBA==');
        assert.equal(h.events.length, 1);
        assert.equal(h.events[0].channel, 'system-audio-data');
        assert.equal(h.events[0].payload.data, 'AQIDBA==');
    });
}

test('provider rejection propagates without a success result or AEC reference', async () => {
    const h = harness();
    h.stt.theirSttSession.sendRealtimeInput = async () => { throw new Error('Provider write failed'); };
    await assert.rejects(h.invoke(), /Provider write failed/);
    assert.equal(h.events.length, 0);
});

test('inactive STT session rejects without emitting an AEC reference', async () => {
    const h = harness();
    h.stt.theirSttSession = null;
    await assert.rejects(h.invoke(), /Their STT session not active/);
    assert.equal(h.events.length, 0);
});

test('missing model information rejects without forwarding or an AEC reference', async () => {
    const h = harness();
    h.stt.modelInfo = null;
    await assert.rejects(h.invoke(), /STT model info could not be retrieved/);
    assert.equal(h.inputs.length, 0);
    assert.equal(h.events.length, 0);
});

