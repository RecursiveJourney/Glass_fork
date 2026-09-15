const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');

const FRAME_LIMIT = 1024 * 1024;
const HISTORY_LIMIT = 20;
// This sink deliberately captures neither a service nor its private configuration.
const ignoreTransportError = () => {};
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => Number.isFinite(value) && value >= 0;
const string = value => typeof value === 'string';
const identity = value => string(value) && value.length > 0 && value.length <= 512;
const timestamp = value => string(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
function requireValid(condition) { if (!condition) throw new Error('invalid-feed-payload'); }
function envelope(data) {
    requireValid(object(data) && identity(data.instanceId) && identity(data.transcriptId) && integer(data.sequence));
    return { instanceId: data.instanceId, sequence: data.sequence, transcriptId: data.transcriptId };
}
function chunks(data) {
    requireValid(Array.isArray(data));
    const ids = new Set();
    return data.map(row => {
        requireValid(object(row) && identity(row.chunk_id) && !ids.has(row.chunk_id) && string(row.speaker_name) && string(row.text) && finite(row.start_time) && finite(row.end_time) && row.end_time >= row.start_time);
        ids.add(row.chunk_id);
        return { chunk_id: row.chunk_id, speaker_name: row.speaker_name, text: row.text, start_time: row.start_time, end_time: row.end_time };
    });
}
function attempt(data) {
    requireValid(object(data) && identity(data.attemptId) && integer(data.revision));
    return { attemptId: data.attemptId, revision: data.revision };
}
function started(data) {
    const projected = attempt(data); requireValid(timestamp(data.startedAt));
    return { ...projected, startedAt: data.startedAt };
}
function result(data) {
    const projected = attempt(data);
    requireValid(string(data.text) && typeof data.noSuggestion === 'boolean' && timestamp(data.completedAt));
    return { ...projected, text: data.text, noSuggestion: data.noSuggestion, completedAt: data.completedAt };
}
function status(data) {
    requireValid(['connecting', 'connected', 'disconnected'].includes(data.connectionState) &&
        ['empty', 'available', 'stale', 'disconnected'].includes(data.availability) && (data.ageMs === null || finite(data.ageMs)) &&
        (data.closed === undefined || typeof data.closed === 'boolean'));
    return { connectionState: data.connectionState, availability: data.availability, ageMs: data.ageMs,
        ...(data.closed === true ? { closed: true } : {}) };
}
function bootstrap(data) {
    const base = envelope(data);
    requireValid(integer(data.revision) && data.suggestionHistoryLimit === HISTORY_LIMIT && Array.isArray(data.suggestions) && data.suggestions.length <= HISTORY_LIMIT && object(data.generation));
    requireValid(['idle', 'running'].includes(data.generation.state));
    const suggestions = data.suggestions.map(result);
    requireValid(new Set(suggestions.map(item => item.attemptId)).size === suggestions.length);
    return { ...base, revision: data.revision, chunks: chunks(data.chunks), suggestions, suggestionHistoryLimit: HISTORY_LIMIT,
        ...status(data), generation: data.generation.state === 'idle' ? { state: 'idle' } : { state: 'running', ...started(data.generation) } };
}

// Main-process subscription only. Capture and automatic generation belong to the feed server.
class MeetingFeedService {
    #url; #token; #requestImpl; #now; #setTimeout; #clearTimeout; #random;
    #listeners = new Set();
    #state = { connectionStatus: 'idle', snapshot: null, error: null, nextRetryAt: null };
    #generation = 0; #failures = 0; #request = null; #response = null;
    #retryTimer = null; #livenessTimer = null; #healthyTimer = null;
    #transportCleanups = new Set();

    constructor({ url = 'http://localhost:11434/v1/live/events', wrapperToken = process.env.WRAPPER_TOKEN,
        requestImpl = http.request, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, random = Math.random } = {}) {
        try {
            requireValid(string(url));
            const parsed = new URL(url);
            requireValid(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
                !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/v1/live/events');
            requireValid(wrapperToken === undefined || (string(wrapperToken) && !/[\x00-\x20\x7f-\uffff]/.test(wrapperToken)));
            requireValid([requestImpl, now, setTimeoutImpl, clearTimeoutImpl, random].every(value => typeof value === 'function'));
            this.#url = parsed.href; this.#token = wrapperToken || '';
        } catch { throw new Error('invalid-feed-config'); }
        this.#requestImpl = requestImpl; this.#now = now; this.#setTimeout = setTimeoutImpl;
        this.#clearTimeout = clearTimeoutImpl; this.#random = random;
    }

    getState() { return copy(this.#state); }

    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('invalid-feed-listener');
        this.#listeners.add(listener);
        try { listener(this.getState()); } catch { /* One observer cannot break another. */ }
        return () => this.#listeners.delete(listener);
    }

    start() {
        if (['connecting', 'connected', 'reconnecting'].includes(this.#state.connectionStatus)) return this.getState();
        this.#failures = 0;
        this.#open();
        return this.getState();
    }

    stop() {
        this.#dispose();
        this.#update({ connectionStatus: 'stopped', error: null, nextRetryAt: null });
        return this.getState();
    }

    #update(changes) {
        this.#state = { ...this.#state, ...changes };
        const current = this.#state;
        for (const listener of this.#listeners) {
            if (this.#state !== current) break; // A reentrant Stop takes precedence.
            try { listener(copy(current)); } catch { /* Isolated output sink. */ }
        }
    }

    #safe(value) {
        if (string(value)) return this.#token ? value.split(this.#token).join('[REDACTED]') : value;
        if (Array.isArray(value)) return value.map(item => this.#safe(item));
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#safe(item)]));
        return value;
    }

    #clearTimer(name) {
        const timer = name === 'retry' ? this.#retryTimer : name === 'liveness' ? this.#livenessTimer : this.#healthyTimer;
        if (timer !== null) this.#clearTimeout(timer);
        if (name === 'retry') this.#retryTimer = null;
        else if (name === 'liveness') this.#livenessTimer = null;
        else this.#healthyTimer = null;
    }

    #dispose() {
        ++this.#generation; // Invalidate callbacks before destroy can emit synchronously.
        this.#clearTimer('retry'); this.#clearTimer('liveness'); this.#clearTimer('healthy');
        for (const cleanup of this.#transportCleanups) cleanup();
        this.#transportCleanups.clear();
        const request = this.#request, response = this.#response;
        this.#request = null; this.#response = null;
        try { response?.destroy(); } catch { /* Never publish raw transport errors. */ }
        try { request?.destroy(); } catch { /* Never publish raw transport errors. */ }
    }

    #listen(transport, event, listener) {
        transport.on(event, listener);
        this.#transportCleanups.add(() => transport.removeListener(event, listener));
    }

    #liveness(generation) {
        this.#clearTimer('liveness');
        this.#livenessTimer = this.#setTimeout(() => {
            if (generation !== this.#generation) return;
            this.#fail(generation, 'feed-timeout');
        }, 45000);
    }

    #fail(generation, error) {
        if (generation !== this.#generation) return;
        this.#dispose();
        const cap = Math.min(30000, 1000 * 2 ** Math.min(this.#failures++, 5));
        const sample = this.#random();
        const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
        const delay = cap / 2 + jitter * cap / 2;
        const retryGeneration = this.#generation;
        this.#retryTimer = this.#setTimeout(() => {
            if (retryGeneration !== this.#generation) return;
            this.#retryTimer = null; this.#open();
        }, delay);
        this.#update({ connectionStatus: 'reconnecting', error, nextRetryAt: this.#now() + delay });
    }

    #open() {
        this.#dispose();
        const generation = this.#generation;
        this.#liveness(generation); // Includes DNS/connect/header/bootstrap hangs.
        this.#update({ connectionStatus: 'connecting', error: null, nextRetryAt: null });
        if (generation !== this.#generation) return;
        const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
        if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
        // The server always sends a current snapshot; no cursor is needed or echoed.
        try {
            const onResponse = response => this.#onResponse(generation, response);
            const request = this.#requestImpl(this.#url, { method: 'GET', headers }, onResponse);
            request.on('error', ignoreTransportError);
            if (generation !== this.#generation) { request.removeListener('response', onResponse); request.destroy(); return; }
            this.#transportCleanups.add(() => request.removeListener('response', onResponse));
            this.#listen(request, 'error', () => this.#fail(generation, 'feed-network-error'));
            this.#listen(request, 'close', () => this.#fail(generation, 'feed-disconnected'));
            this.#request = request; request.end();
        } catch { this.#fail(generation, 'feed-network-error'); }
    }

    #onResponse(generation, response) {
        // Keep error sinks on cancelled streams: late EventEmitter errors must be harmless.
        response.on('error', ignoreTransportError);
        if (generation !== this.#generation) { response.destroy(); return; }
        this.#listen(response, 'error', () => this.#fail(generation, 'feed-network-error'));
        this.#response = response;
        if (response.statusCode === 401) {
            this.#dispose(); this.#update({ connectionStatus: 'auth-required', error: 'feed-auth-required', nextRetryAt: null }); return;
        }
        if (response.statusCode !== 200) { this.#fail(generation, 'feed-unavailable'); return; }
        if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers?.['content-type'] || '')) {
            this.#fail(generation, 'invalid-feed-response'); return;
        }
        const decoder = new StringDecoder('utf8');
        let pending = '', eventType = '', data = [], frameBytes = 0, comment = false, bootstrapped = false, swallowLF = false;
        const reset = () => { eventType = ''; data = []; frameBytes = 0; comment = false; };
        const line = value => {
            if (value === '') {
                if (data.length || comment) this.#liveness(generation);
                if (data.length) {
                    const parsed = JSON.parse(data.join('\n'));
                    bootstrapped = this.#apply(generation, eventType || 'message', parsed, bootstrapped);
                }
                reset(); return;
            }
            frameBytes += Buffer.byteLength(value, 'utf8') + 2;
            requireValid(frameBytes <= FRAME_LIMIT);
            if (value.startsWith(':')) { comment = true; return; }
            const colon = value.indexOf(':');
            const field = colon < 0 ? value : value.slice(0, colon);
            let content = colon < 0 ? '' : value.slice(colon + 1);
            if (content.startsWith(' ')) content = content.slice(1);
            if (field === 'event') eventType = content;
            else if (field === 'data') data.push(content);
        };
        this.#listen(response, 'data', bytes => {
            if (generation !== this.#generation) return;
            try {
                pending += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
                let offset = 0;
                for (let i = 0; i < pending.length; i++) {
                    const char = pending[i];
                    if (swallowLF) {
                        swallowLF = false;
                        if (char === '\n') { offset = i + 1; continue; }
                    }
                    if (char !== '\n' && char !== '\r') continue;
                    line(pending.slice(offset, i));
                    if (generation !== this.#generation) return;
                    // CR is a complete line ending, including at EOF. Only its optional LF waits.
                    swallowLF = char === '\r';
                    offset = i + 1;
                }
                pending = pending.slice(offset);
                requireValid(frameBytes + Buffer.byteLength(pending, 'utf8') <= FRAME_LIMIT);
            } catch { this.#fail(generation, 'invalid-feed-payload'); }
        });
        for (const event of ['end', 'close', 'aborted']) this.#listen(response, event, () => this.#fail(generation, 'feed-disconnected'));
    }

    #apply(generation, type, raw, bootstrapped) {
        let snapshot, error = null;
        if (type === 'runtime.status') {
            requireValid(object(raw) && identity(raw.instanceId) && integer(raw.sequence) && integer(raw.appliedRevision) &&
                ['unconfigured', 'applying', 'joining', 'waiting', 'failed', 'rate_limited', 'auth_failed', 'uncertain', 'disabled', 'credential_missing', 'meeting_missing'].includes(raw.operationState) &&
                (raw.errorCode === null || typeof raw.errorCode === 'string' && /^[a-z_]{1,64}$/.test(raw.errorCode)));
            const runtime = { instanceId: raw.instanceId, sequence: raw.sequence, appliedRevision: raw.appliedRevision, operationState: raw.operationState, errorCode: raw.errorCode };
            this.#update({ connectionStatus: 'connected', snapshot: null, runtime, error: null, nextRetryAt: null });
            return false;
        }
        if (type === 'snapshot') {
            requireValid(!bootstrapped);
            snapshot = this.#safe(bootstrap(raw));
        } else {
            requireValid(bootstrapped);
            const incoming = this.#safe(envelope(raw));
            const current = this.#state.snapshot;
            requireValid(incoming.instanceId === current.instanceId && incoming.transcriptId === current.transcriptId);
            if (incoming.sequence <= current.sequence) return true;
            requireValid(incoming.sequence === current.sequence + 1);
            snapshot = copy(current); snapshot.sequence = incoming.sequence;
            if (type === 'transcript.snapshot') {
                requireValid(integer(raw.revision));
                snapshot.revision = raw.revision; snapshot.chunks = this.#safe(chunks(raw.chunks));
            } else if (type === 'suggestion.started') {
                snapshot.generation = { state: 'running', ...this.#safe(started(raw)) };
            } else if (type === 'suggestion.result') {
                const completed = this.#safe(result(raw));
                const index = snapshot.suggestions.findIndex(item => item.attemptId === completed.attemptId);
                if (index < 0) snapshot.suggestions.push(completed);
                else snapshot.suggestions[index] = completed;
                snapshot.suggestions = snapshot.suggestions.slice(-HISTORY_LIMIT);
                if (snapshot.generation.state === 'idle' || snapshot.generation.attemptId === completed.attemptId) snapshot.generation = { state: 'idle' };
            } else if (type === 'suggestion.error') {
                const failed = this.#safe(attempt(raw));
                requireValid(string(raw.message) && timestamp(raw.completedAt));
                if (snapshot.generation.state === 'idle' || snapshot.generation.attemptId === failed.attemptId) snapshot.generation = { state: 'idle' };
                error = 'suggestion-failed';
            } else if (type === 'status') Object.assign(snapshot, status(raw));
            else throw new Error('invalid-feed-payload');
        }
        if (snapshot.closed) {
            snapshot.generation = { state: 'idle' };
            this.#dispose(); this.#update({ connectionStatus: 'closed', snapshot, error, nextRetryAt: null });
            return true;
        }
        if (!bootstrapped) {
            this.#healthyTimer = this.#setTimeout(() => {
                if (generation !== this.#generation) return;
                this.#healthyTimer = null; this.#failures = 0;
            }, 30000);
        }
        this.#update({ connectionStatus: 'connected', snapshot, ...(this.#state.runtime ? { runtime: null } : {}), error, nextRetryAt: null });
        return true;
    }
}

module.exports = MeetingFeedService;
