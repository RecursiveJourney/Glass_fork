const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/features/common/ai/parakeet/protocol');
const { createReply, validateReply, createSpanUpdate, applySpanUpdate, LIMITS } = protocol;
const identity = { workerGeneration: 2, requestId: 'request-1', sessionId: 'session-1', channel: 'my', sequence: 0 };
const span = (patch = {}) => ({ spanId: 'span-1', revision: 1, sourceStart: 16000, sourceEnd: 24000, start: 16100, end: 23900, text: 'hello', provisional: true, uncertain: false, ...patch });
const message = (spans = [span()], removeSpanIds = [], patch = {}) => ({ protocolVersion: 1, type: 'spanUpdate', ...identity, sampleRate: 16000, sourceClock: 32000, spans, removeSpanIds, ...patch });

test('exports span constructors and a pure transactional reducer', () => {
    assert.equal(typeof createSpanUpdate, 'function');
    assert.equal(typeof applySpanUpdate, 'function');
});

test('v1 span updates carry explicit 16 kHz source positions and provisional/final flags', () => {
    const value = message([span(), span({ spanId: 'span-2', provisional: false, uncertain: true })]);
    assert.equal(validateReply(value), value);
    assert.deepEqual(createReply('spanUpdate', { ...identity, sampleRate: 16000, sourceClock: 32000, spans: value.spans, removeSpanIds: [] }), value);
});

test('constructors copy span values and removal arrays', () => {
    const spans = [span()]; const removeSpanIds = ['old'];
    const value = createReply('spanUpdate', { ...identity, sampleRate: 16000, sourceClock: 32000, spans, removeSpanIds });
    spans[0].text = 'changed'; spans.push(span()); removeSpanIds.push('another');
    assert.equal(value.spans.length, 1); assert.equal(value.spans[0].text, 'hello');
    assert.deepEqual(value.removeSpanIds, ['old']);
});

test('emission projection strips internal evidence and keeps absolute 16 kHz samples unchanged', () => {
    const commits = [span({ decodeId: 'private-evidence', edgeDistance: 42, removeSpanIds: ['old'] })];
    const emission = { commits, removeSpanIds: ['old'], alternatives: ['internal'] };
    const result = createSpanUpdate(identity, emission, 32000);
    assert.deepEqual(result, message([span()], ['old']));
    commits[0].text = 'changed'; emission.removeSpanIds.push('another');
    assert.equal(result.spans[0].text, 'hello'); assert.deepEqual(result.removeSpanIds, ['old']);
    assert.deepEqual(createSpanUpdate(identity, { commits: [] }, 0), message([], [], { sourceClock: 0 }));
});

test('span updates enforce bounded collections and text', () => {
    assert.equal(LIMITS.maxSpans, 2048); assert.equal(LIMITS.maxRemoveSpanIds, 2048);
    for (const value of [message(null), message([], null), message(Array.from({ length: 2049 }, (_, i) => span({ spanId: String(i) }))), message([], Array.from({ length: 2049 }, (_, i) => String(i))), message([span({ text: 'x'.repeat(LIMITS.maxTextLength + 1) })]), message([span({ text: '' })])]) assert.throws(() => validateReply(value));
});

test('span fields reject unsafe integers, invalid ranges, flags, and source clocks', () => {
    validateReply(message());
    for (const patch of [{ revision: -1 }, { revision: 0.5 }, { sourceStart: -1 }, { sourceStart: 25000 }, { sourceEnd: 32001 }, { start: 24000 }, { end: 32001 }, { end: Infinity }, { start: 0.5 }, { sourceStart: Number.MAX_SAFE_INTEGER + 1 }, { provisional: 'yes' }, { uncertain: null }, { spanId: '' }, { spanId: 'x'.repeat(129) }]) assert.throws(() => validateReply(message([span(patch)])), JSON.stringify(patch));
    for (const patch of [{ sampleRate: 24000 }, { sampleRate: undefined }, { sourceClock: -1 }, { sourceClock: 1.1 }, { sourceClock: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => validateReply(message([], [], patch)));
});

test('span IDs are unique and disjoint from removal IDs', () => {
    validateReply(message());
    for (const value of [message([span(), span()]), message([], ['old', 'old']), message([span()], ['span-1']), message([], ['']), message([], [4])]) assert.throws(() => validateReply(value));
});

test('closed wire schema rejects audio, credentials, and internal span metadata', () => {
    validateReply(message());
    for (const patch of [{ bytes: [1, 2] }, { audio: 'base64' }, { apiKey: 'secret' }, { text: 'extra' }]) assert.throws(() => validateReply(message([], [], patch)));
    for (const patch of [{ bytes: [1] }, { decodeId: 'internal' }, { final: true }]) assert.throws(() => validateReply(message([span(patch)])));
});

test('span updates retain expected session and generation checks', () => {
    const value = message();
    assert.equal(validateReply(value, identity), value);
    for (const key of ['workerGeneration', 'requestId', 'sessionId', 'channel', 'sequence']) assert.throws(() => applySpanUpdate(new Map(), value, { [key]: 'stale' }), /stale/);
});

test('provisional revisions and merge removals produce an owned map', () => {
    const initial = applySpanUpdate(new Map(), message([span(), span({ spanId: 'span-2' })]));
    const update = message([span({ revision: 2, text: 'hello world' })], ['span-2']);
    const next = applySpanUpdate(initial, update);
    assert.notEqual(next, initial); assert.equal(next.size, 1); assert.equal(next.get('span-1').text, 'hello world');
    assert.equal(initial.size, 2); assert.equal(initial.get('span-1').revision, 1);
    update.spans[0].text = 'mutated'; assert.equal(next.get('span-1').text, 'hello world');
    const clone = applySpanUpdate(initial, message([]));
    clone.get('span-2').text = 'mutated'; assert.equal(initial.get('span-2').text, 'hello');
});

test('stale revisions and duplicate delivery are idempotent', () => {
    const value = message([span({ revision: 2 })]);
    const initial = applySpanUpdate(new Map(), value);
    assert.deepEqual(applySpanUpdate(initial, value), initial);
    assert.deepEqual(applySpanUpdate(initial, message([span({ revision: 1, text: 'stale' })])), initial);
    assert.throws(() => applySpanUpdate(initial, message([span({ revision: 2, text: 'conflict' })])), /revision/);
    assert.deepEqual(applySpanUpdate(initial, message([], ['unknown'])), initial);
});

test('finalization uses a new revision and final spans cannot be revised or removed', () => {
    const provisional = applySpanUpdate(new Map(), message());
    const finalMessage = message([span({ revision: 2, provisional: false })]);
    const finalized = applySpanUpdate(provisional, finalMessage);
    assert.equal(finalized.get('span-1').provisional, false);
    assert.deepEqual(applySpanUpdate(finalized, finalMessage), finalized);
    assert.deepEqual(applySpanUpdate(finalized, message()), finalized);
    for (const value of [message([span({ revision: 3, text: 'changed', provisional: false })]), message([span({ revision: 3 })]), message([], ['span-1'])]) assert.throws(() => applySpanUpdate(finalized, value), /final/);
});

test('invalid multi-span transactions leave every input value unchanged', () => {
    const initial = applySpanUpdate(new Map(), message([span(), span({ spanId: 'final', provisional: false })]));
    const before = structuredClone(initial);
    assert.throws(() => applySpanUpdate(initial, message([span({ revision: 2, text: 'changed' })], ['final'])), /final/);
    assert.deepEqual(initial, before);
    assert.throws(() => applySpanUpdate(initial, message([span({ revision: 2 }), span({ spanId: 'bad', end: 40000 })])));
    assert.deepEqual(initial, before);
    assert.throws(() => applySpanUpdate({}, message()), /Map/);
});
