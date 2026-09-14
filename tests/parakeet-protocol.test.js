const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const modulePath = '../src/features/common/ai/parakeet/protocol';
const protocol = fs.existsSync(require('node:path').join(__dirname, modulePath + '.js')) ? require(modulePath) : {};
const { createCommand, createReply, validateCommand, validateReply, LIMITS } = protocol;
const identity = { workerGeneration: 2, requestId: 'request-1' };
const session = { ...identity, sessionId: 'session-1', channel: 'my', sequence: 0 };
const audio = { ...session, firstSample: 0, sampleCount: 3, sampleRate: 24000, format: 'pcm16le', bytes: Buffer.from([1, 0, 2, 0, 3, 0]) };

test('exports pure constructors and validators', () => {
    for (const name of ['createCommand', 'createReply', 'validateCommand', 'validateReply']) assert.equal(typeof protocol[name], 'function');
});
test('audio construction owns copied bytes including a Uint8Array view', () => {
    const backing = Uint8Array.from([99, 1, 0, 2, 0, 3, 0, 99]);
    const message = createCommand('audio', { ...audio, bytes: backing.subarray(1, 7) });
    backing.fill(0);
    assert.deepEqual([...message.bytes], [1, 0, 2, 0, 3, 0]);
    assert.equal(message.protocolVersion, 1);
    assert.equal(validateCommand(message), message);
});
test('accepts silence without allocating audio and rejects attached bytes', () => {
    const { bytes, ...timing } = audio;
    const message = createCommand('silence', timing);
    assert.equal(Object.hasOwn(message, 'bytes'), false);
    assert.throws(() => createCommand('silence', audio), /bytes/);
});
test('rejects malformed identities, version and stale expected identity', () => {
    const message = createCommand('audio', audio);
    for (const patch of [{ protocolVersion: 2 }, { workerGeneration: -1 }, { requestId: '' }, { requestId: 'x'.repeat(129) }, { sessionId: '' }, { channel: 'other' }, { sequence: 0.5 }]) {
        assert.throws(() => validateCommand({ ...message, ...patch }));
    }
    assert.throws(() => validateCommand(message, { workerGeneration: 3 }), /stale/);
    assert.throws(() => validateCommand(message, { sessionId: 'old' }), /stale/);
    assert.equal(validateCommand(message, { workerGeneration: 2, channel: 'my' }), message);
});
test('rejects invalid PCM sizing, timing and unsafe sample ranges', () => {
    for (const patch of [{ sampleRate: 16000 }, { format: 'float32' }, { bytes: Buffer.alloc(5) }, { sampleCount: 2 }, { sampleCount: LIMITS.maxAudioSamples + 1 }, { firstSample: -1 }, { firstSample: Number.MAX_SAFE_INTEGER }, { bytes: [1, 0, 2, 0, 3, 0] }]) {
        assert.throws(() => createCommand('audio', { ...audio, ...patch }));
    }
});
test('only model window 512 is accepted; transport feed 480 and 512 both work', () => {
    for (const feedSamples of [480, 512]) assert.equal(createCommand('openSession', { ...session, config: { modelWindow: 512, feedSamples } }).config.feedSamples, feedSamples);
    assert.throws(() => createCommand('openSession', { ...session, config: { modelWindow: 480, feedSamples: 480 } }), /modelWindow/);
    assert.throws(() => createCommand('openSession', { ...session, config: { modelWindow: 512, feedSamples: 123 } }), /feedSamples/);
});
test('all commands and reply types have bounded validated envelopes', () => {
    createCommand('init', { ...identity, modelId: 'model', manifestId: 'manifest', paths: { encoder: 'C:/models/encoder.onnx', decoder: 'C:/models/decoder.onnx', joiner: 'C:/models/joiner.onnx', tokens: 'C:/models/tokens.txt', vad: 'C:/models/vad.onnx' } });
    createCommand('flush', { ...session, reason: 'stop' });
    createCommand('closeSession', { ...session, cancelled: false });
    createCommand('shutdown', identity);
    for (const type of ['ready', 'shutdownComplete']) validateReply(createReply(type, identity));
    for (const type of ['sessionReady', 'closed']) validateReply(createReply(type, session));
    validateReply(createReply('ack', { ...session, acceptedThrough: 3, backlogSamples: 3 }));
    validateReply(createReply('error', { ...identity, code: 'DECODE_TIMEOUT', recoverable: true }));
    assert.throws(() => createCommand('unknown', identity));
    assert.throws(() => createReply('audio', audio));
    assert.throws(() => createCommand('shutdown', { ...identity, unexpected: 'payload' }));
});
test('result ranges, timings, text bounds and commitment watermark are validated', () => {
    const result = { ...session, resultId: 'result-1', firstSample: 0, sampleCount: 24000, text: 'hello', words: [{ text: 'hello', firstSample: 10, sampleCount: 100 }], committedThrough: 24000, boundaryReason: 'silence', uncertain: false };
    validateReply(createReply('result', result));
    for (const patch of [{ text: 'a'.repeat(LIMITS.maxTextLength + 1) }, { words: [{ text: 'bad', firstSample: 23999, sampleCount: 2 }] }, { committedThrough: 24001 }, { uncertain: 'yes' }]) assert.throws(() => createReply('result', { ...result, ...patch }));
});
test('telemetry is compact metadata with no transcript or raw audio', () => {
    const data = { ...session, firstSample: 0, sampleCount: 36000, rmsDbfs: -Infinity, zeroCount: 36000, exactZero: true };
    validateReply(createReply('telemetry', data));
    assert.throws(() => createReply('telemetry', { ...data, text: 'secret' }));
    assert.throws(() => createReply('telemetry', { ...data, bytes: Buffer.alloc(2) }));
    assert.throws(() => createReply('telemetry', { ...data, rmsDbfs: NaN }));
});
test('init requires all five model paths and rejects missing or oversized paths', () => {
    const paths = { encoder: 'C:/model/encoder.onnx', decoder: 'C:/model/decoder.onnx', joiner: 'C:/model/joiner.onnx', tokens: 'C:/model/tokens.txt', vad: 'C:/model/silero.onnx' };
    createCommand('init', { ...identity, modelId: 'model', manifestId: 'manifest', paths });
    for (const name of Object.keys(paths)) {
        const incomplete = { ...paths }; delete incomplete[name];
        assert.throws(() => createCommand('init', { ...identity, modelId: 'model', manifestId: 'manifest', paths: incomplete }), /paths/);
    }
    assert.throws(() => createCommand('init', { ...identity, modelId: 'model', manifestId: 'manifest', paths: { ...paths, encoder: 'x'.repeat(4097) } }), /path/);
});

for (const boundaryReason of ['preferred-silence', 'flush']) {
    test(`planner boundary ${boundaryReason} is valid in result and telemetry replies`, () => {
        const envelope = { protocolVersion: 1, ...session, firstSample: 0, sampleCount: 24000, boundaryReason };
        const result = { ...envelope, type: 'result', resultId: 'result-boundary', text: 'hello', words: [], committedThrough: 24000, uncertain: false };
        const telemetry = { ...envelope, type: 'telemetry', rmsDbfs: -Infinity, zeroCount: 24000, exactZero: true };
        assert.equal(validateReply(result), result);
        assert.equal(validateReply(telemetry), telemetry);
    });
}
