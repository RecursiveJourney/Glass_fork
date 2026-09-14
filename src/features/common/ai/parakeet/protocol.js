const PROTOCOL_VERSION = 1;
const LIMITS = Object.freeze({ maxIdLength: 128, maxAudioSamples: 600000, maxTextLength: 16384, maxWords: 2048, maxSpans: 2048, maxRemoveSpanIds: 2048, maxPathLength: 4096 });
const ENVELOPE = ['protocolVersion', 'type', 'workerGeneration', 'requestId'];
const SESSION = ['sessionId', 'channel', 'sequence'];
const TIMING = ['firstSample', 'sampleCount'];
const SPAN_FIELDS = ['spanId', 'revision', 'sourceStart', 'sourceEnd', 'start', 'end', 'text', 'provisional', 'uncertain'];
const commandFields = {
    init: ['modelId', 'manifestId', 'paths'], openSession: ['config'],
    audio: [...TIMING, 'sampleRate', 'format', 'bytes'], silence: [...TIMING, 'sampleRate', 'format'],
    flush: ['reason'], closeSession: ['cancelled'], shutdown: [],
};
const replyFields = {
    ready: [], sessionReady: [], ack: ['acceptedThrough', 'backlogSamples'],
    result: ['resultId', ...TIMING, 'text', 'words', 'committedThrough', 'boundaryReason', 'uncertain'],
    spanUpdate: ['sampleRate', 'sourceClock', 'spans', 'removeSpanIds'],
    telemetry: [...TIMING, 'rmsDbfs', 'zeroCount', 'exactZero', 'decodeMs', 'queueDelayMs', 'emitted', 'boundaryReason'],
    error: ['code', 'recoverable'], closed: [], shutdownComplete: [],
};
const sessionTypes = new Set(['openSession', 'audio', 'silence', 'flush', 'closeSession', 'sessionReady', 'ack', 'result', 'spanUpdate', 'telemetry', 'closed']);
const reasons = ['silence', 'preferred-silence', 'forced', 'flush', 'stop', 'end', 'renewal', 'reset', 'cancelled'];
function requireValue(condition, name) { if (!condition) throw new TypeError('Invalid ' + name); }
function object(value, name) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), name); }
function keys(value, allowed) { for (const key of Object.keys(value)) requireValue(allowed.includes(key), key); }
function integer(value, name, max = Number.MAX_SAFE_INTEGER) { requireValue(Number.isSafeInteger(value) && value >= 0 && value <= max, name); }
function string(value, name, max = LIMITS.maxIdLength, empty = false) {
    requireValue(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !value.includes('\0'), name);
}
function boolean(value, name) { requireValue(typeof value === 'boolean', name); }
function range(value, max = LIMITS.maxAudioSamples) {
    integer(value.firstSample, 'firstSample'); integer(value.sampleCount, 'sampleCount', max);
    integer(value.firstSample + value.sampleCount, 'sample range');
}
function validate(message, schemas, expected = {}) {
    object(message, 'message');
    requireValue(Object.hasOwn(schemas, message.type), 'type');
    requireValue(message.protocolVersion === PROTOCOL_VERSION, 'protocolVersion');
    integer(message.workerGeneration, 'workerGeneration'); string(message.requestId, 'requestId');
    const hasSession = sessionTypes.has(message.type) || (message.type === 'error' && SESSION.some(key => Object.hasOwn(message, key)));
    keys(message, [...ENVELOPE, ...(hasSession ? SESSION : []), ...schemas[message.type]]);
    if (hasSession) {
        string(message.sessionId, 'sessionId'); requireValue(['my', 'their'].includes(message.channel), 'channel'); integer(message.sequence, 'sequence');
    }
    for (const key of ['workerGeneration', 'requestId', ...SESSION]) {
        if (expected[key] !== undefined) requireValue(message[key] === expected[key], 'stale ' + key);
    }
    switch (message.type) {
        case 'init':
            string(message.modelId, 'modelId'); string(message.manifestId, 'manifestId'); object(message.paths, 'paths');
            keys(message.paths, ['encoder', 'decoder', 'joiner', 'tokens', 'vad']);
            requireValue(Object.keys(message.paths).length === 5, 'paths (five assets required)');
            for (const value of Object.values(message.paths)) string(value, 'path', LIMITS.maxPathLength);
            break;
        case 'openSession': {
            const config = message.config; object(config, 'config');
            keys(config, ['modelWindow', 'feedSamples']);
            requireValue(config.modelWindow === 512, 'modelWindow (must be 512)');
            requireValue([480, 512].includes(config.feedSamples), 'feedSamples');
            break;
        }
        case 'audio': case 'silence':
            range(message); requireValue(message.sampleCount > 0, 'sampleCount');
            requireValue(message.sampleRate === 24000, 'sampleRate'); requireValue(message.format === 'pcm16le', 'format');
            if (message.type === 'audio') requireValue(message.bytes instanceof Uint8Array && message.bytes.byteLength === message.sampleCount * 2, 'bytes');
            break;
        case 'flush': requireValue(reasons.includes(message.reason), 'reason'); break;
        case 'closeSession': boolean(message.cancelled, 'cancelled'); break;
        case 'ack': integer(message.acceptedThrough, 'acceptedThrough'); integer(message.backlogSamples, 'backlogSamples', LIMITS.maxAudioSamples); break;
        case 'result':
            range(message); string(message.resultId, 'resultId'); string(message.text, 'text', LIMITS.maxTextLength, true);
            integer(message.committedThrough, 'committedThrough', message.firstSample + message.sampleCount);
            requireValue(message.committedThrough >= message.firstSample, 'committedThrough');
            requireValue(reasons.includes(message.boundaryReason), 'boundaryReason'); boolean(message.uncertain, 'uncertain');
            requireValue(Array.isArray(message.words) && message.words.length <= LIMITS.maxWords, 'words');
            {
                let previous = message.firstSample;
                for (const word of message.words) {
                    object(word, 'word'); keys(word, ['text', ...TIMING]); string(word.text, 'word text', 256); range(word);
                    requireValue(word.firstSample >= previous && word.firstSample + word.sampleCount <= message.firstSample + message.sampleCount, 'word range');
                    previous = word.firstSample;
                }
            }
            break;
        case 'spanUpdate': {
            requireValue(message.sampleRate === 16000, 'sampleRate'); integer(message.sourceClock, 'sourceClock');
            requireValue(Array.isArray(message.spans) && message.spans.length <= LIMITS.maxSpans, 'spans');
            requireValue(Array.isArray(message.removeSpanIds) && message.removeSpanIds.length <= LIMITS.maxRemoveSpanIds, 'removeSpanIds');
            const ids = new Set();
            for (const span of message.spans) {
                object(span, 'span'); keys(span, SPAN_FIELDS); string(span.spanId, 'spanId'); integer(span.revision, 'revision');
                for (const key of ['sourceStart', 'sourceEnd', 'start', 'end']) integer(span[key], key, message.sourceClock);
                requireValue(span.sourceStart <= span.sourceEnd && span.start <= span.end, 'span range');
                string(span.text, 'span text', LIMITS.maxTextLength); boolean(span.provisional, 'provisional'); boolean(span.uncertain, 'uncertain');
                requireValue(!ids.has(span.spanId), 'duplicate spanId'); ids.add(span.spanId);
            }
            for (const id of message.removeSpanIds) {
                string(id, 'removeSpanId'); requireValue(!ids.has(id), 'duplicate or conflicting removeSpanId'); ids.add(id);
            }
            break;
        }
        case 'telemetry':
            range(message); requireValue(message.sampleCount > 0, 'sampleCount'); integer(message.zeroCount, 'zeroCount', message.sampleCount);
            requireValue(message.rmsDbfs === -Infinity || (Number.isFinite(message.rmsDbfs) && message.rmsDbfs <= 0), 'rmsDbfs');
            boolean(message.exactZero, 'exactZero'); requireValue(message.exactZero === (message.zeroCount === message.sampleCount), 'exactZero');
            requireValue((message.rmsDbfs === -Infinity) === message.exactZero, 'rmsDbfs');
            for (const key of ['decodeMs', 'queueDelayMs']) if (message[key] !== undefined) requireValue(Number.isFinite(message[key]) && message[key] >= 0 && message[key] <= 3600000, key);
            if (message.emitted !== undefined) boolean(message.emitted, 'emitted');
            if (message.boundaryReason !== undefined) requireValue(reasons.includes(message.boundaryReason), 'boundaryReason');
            break;
        case 'error': string(message.code, 'code'); boolean(message.recoverable, 'recoverable'); break;
    }
    return message;
}
/** Validate a v1 command/reply without mutation; optional expected identity rejects stale messages.
 * Legacy source ranges are half-open 24 kHz sample intervals. spanUpdate explicitly
 * uses absolute 16 kHz sample positions for sourceClock and all four span bounds.
 * Callers enforce sequence progression and keep reducer state scoped to a session.
 */
function validateCommand(message, expected) { return validate(message, commandFields, expected); }
function validateReply(message, expected) { return validate(message, replyFields, expected); }
function create(type, fields, validator) {
    const message = { ...fields, type, protocolVersion: PROTOCOL_VERSION };
    validator(message);
    // Explicit copies avoid sharing backing memory with capture, native code or caller mutation.
    if (message.bytes) message.bytes = Buffer.from(message.bytes);
    if (message.paths) message.paths = { ...message.paths };
    if (message.config) message.config = { ...message.config };
    if (message.words) message.words = message.words.map(word => ({ ...word }));
    if (message.spans) message.spans = message.spans.map(span => ({ ...span }));
    if (message.removeSpanIds) message.removeSpanIds = [...message.removeSpanIds];
    return message;
}
function createCommand(type, fields) { return create(type, fields, validateCommand); }
function createReply(type, fields) { return create(type, fields, validateReply); }
/** Project stitcher evidence onto the public span schema without converting sample units. */
function createSpanUpdate(envelope, emission, sourceClock) {
    object(emission, 'emission');
    requireValue(Array.isArray(emission.commits) && emission.commits.length <= LIMITS.maxSpans, 'commits');
    const spans = emission.commits.map(span => {
        object(span, 'span');
        return Object.fromEntries(SPAN_FIELDS.map(key => [key, span[key]]));
    });
    return createReply('spanUpdate', { ...envelope, sampleRate: 16000, sourceClock, spans, removeSpanIds: emission.removeSpanIds ?? [] });
}
/** Apply one validated transaction to an owned copy. Final spans are immutable;
 * lower revisions and exact replay are harmless. A conflicting revision is invalid.
 * The stitcher owns the 25-second finalization policy; the receiver enforces finality.
 */
function applySpanUpdate(state, message, expectedIdentity) {
    requireValue(state instanceof Map, 'state Map');
    validateReply(message, expectedIdentity); requireValue(message.type === 'spanUpdate', 'spanUpdate type');
    for (const id of message.removeSpanIds) requireValue(state.get(id)?.provisional !== false, 'final span removal');
    for (const span of message.spans) {
        const previous = state.get(span.spanId);
        if (!previous || span.revision < previous.revision) continue;
        if (span.revision === previous.revision) {
            requireValue(SPAN_FIELDS.every(key => span[key] === previous[key]), 'conflicting span revision');
        } else {
            requireValue(previous.provisional !== false, 'final span modification');
        }
    }
    const next = new Map([...state].map(([id, span]) => [id, { ...span }]));
    for (const id of message.removeSpanIds) next.delete(id);
    for (const span of message.spans) {
        const previous = next.get(span.spanId);
        if (!previous || span.revision > previous.revision) next.set(span.spanId, { ...span });
    }
    return next;
}
module.exports = { PROTOCOL_VERSION, VERSION: PROTOCOL_VERSION, LIMITS, createCommand, createReply, validateCommand, validateReply, createSpanUpdate, applySpanUpdate };


