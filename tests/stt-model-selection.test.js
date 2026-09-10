const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise real STT initialization/renewal; isolate Electron, provider I/O and timers.
function harness(model, provider = 'whisper') {
    let selected = { provider, model, apiKey: 'test-placeholder' };
    const calls = [];
    const timers = new Map();
    let nextTimer = 0;
    const schedule = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
    };
    const stubs = {
        electron: {},
        child_process: {},
        '../../common/services/modelStateService': {
            getCurrentModelInfo: async type => {
                assert.equal(type, 'stt');
                return { ...selected };
            }
        },
        '../../common/ai/factory': {
            createSTT: async (name, options) => {
                const session = { closed: false, close() { this.closed = true; } };
                calls.push({ provider: name, options, session });
                return session;
            }
        }
    };
    const module = { exports: {} };
    const filename = path.join(__dirname, '../src/features/listen/stt/sttService.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports,
        require: id => {
            if (!Object.hasOwn(stubs, id)) throw new Error('Unexpected dependency: ' + id);
            return stubs[id];
        },
        process: { env: {} }, Buffer,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: schedule, setInterval: schedule,
        clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id)
    }, { filename });
    return {
        service: new module.exports(), calls, timers,
        select(nextModel) { selected = { ...selected, model: nextModel }; }
    };
}

function assertPair(calls, model) {
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.options.sessionType), ['my', 'their']);
    for (const call of calls) {
        assert.equal(call.provider, 'whisper');
        assert.equal(call.options.model, model);
        assert.equal(call.options.language, 'en');
        assert.equal(typeof call.options.callbacks.onmessage, 'function');
    }
}

for (const model of ['whisper-tiny', 'whisper-medium']) {
    test(model + ' selection reaches both STT provider sessions', async () => {
        const h = harness(model);
        await h.service.initializeSttSessions();
        assertPair(h.calls, model);
        assert.equal(h.service.mySttSession, h.calls[0].session);
        assert.equal(h.service.theirSttSession, h.calls[1].session);
        await h.service.closeSessions();
    });

    test(model + ' selection survives scheduled session renewal', async () => {
        const h = harness(model);
        await h.service.initializeSttSessions();
        const oldSessions = h.calls.map(call => call.session);
        const renewal = [...h.timers.values()].find(timer => timer.delay === 20 * 60 * 1000);
        assert.ok(renewal, 'automatic renewal is scheduled');
        await renewal.callback();
        assertPair(h.calls.slice(2), model);
        assert.equal(h.service.mySttSession, h.calls[2].session);
        assert.equal(h.service.theirSttSession, h.calls[3].session);
        assert.ok(oldSessions.every(session => !session.closed));
        const overlap = [...h.timers.values()].find(timer => timer.delay === 2000);
        assert.ok(overlap, 'old sessions retain the overlap period');
        overlap.callback();
        assert.ok(oldSessions.every(session => session.closed));
        await h.service.closeSessions();
    });
}

test('renewal reads an updated Tiny-to-Medium selection for both sessions', async () => {
    const h = harness('whisper-tiny');
    await h.service.initializeSttSessions();
    h.select('whisper-medium');
    await h.service.renewSessions();
    assertPair(h.calls.slice(2), 'whisper-medium');
    await h.service.closeSessions();
});

test('cloud provider options remain unchanged by Whisper model pass-through', async () => {
    const h = harness('cloud-model', 'openai');
    await h.service.initializeSttSessions('fr');
    for (const call of h.calls) {
        assert.equal(call.provider, 'openai');
        assert.equal(Object.hasOwn(call.options, 'model'), false);
        assert.equal(call.options.language, 'fr');
        assert.equal(call.options.usePortkey, false);
    }
    await h.service.closeSessions();
});

