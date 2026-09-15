const http = require('node:http');
const { registerSecrets, redact } = require('./secretRedactor');
const fail = code => Object.assign(new Error(code), { code });
class TwinRuntimeClient {
    #url; #token; #timeout;
    constructor({ url = process.env.TWIN_CONTROL_URL || 'http://localhost:11434', token = process.env.TWIN_CONTROL_TOKEN, timeoutMs = 800 } = {}) {
        if (token) registerSecrets([token]);
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw fail('invalid_runtime_url');
            this.#url = parsed.origin;
        } catch { throw fail('invalid_runtime_url'); }
        this.#token = token; this.#timeout = timeoutMs;
    }
    #request(method, path, body) {
        if (typeof this.#token !== 'string' || !/^[\x21-\x7e]{32,8192}$/.test(this.#token)) return Promise.reject(fail('runtime_token_missing'));
        return new Promise((resolve, reject) => {
            const data = body === undefined ? undefined : JSON.stringify(body);
            const req = http.request(this.#url + path, { method, headers: { Authorization: 'Bearer ' + this.#token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
                const chunks = []; let size = 0;
                res.on('data', chunk => { size += chunk.length; if (size > 16384) { req.destroy(); reject(fail('runtime_invalid_response')); } else chunks.push(chunk); });
                res.on('error', () => reject(fail('runtime_unavailable')));
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(fail(res.statusCode === 401 ? 'runtime_unauthorized' : res.statusCode === 409 ? 'runtime_conflict' : 'runtime_unavailable'));
                    try {
                        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (value.component !== 'digital-twin' || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' || !/^[\w-]{1,128}$/.test(value.instanceId) || !Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0) throw fail('runtime_invalid_response');
                        const allowed = ['component', 'protocolVersion', 'instanceId', 'appliedRevision', 'desiredRevision', 'operationId', 'enabled', 'hasKey', 'meetingLink', 'meetingIntentId', 'operationState', 'errorCode'];
                        if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('runtime_invalid_response');
                        const states = ['unconfigured', 'applying', 'joining', 'waiting', 'connected', 'disconnected', 'failed', 'rate_limited', 'auth_failed', 'uncertain', 'disabled', 'credential_missing', 'meeting_missing'];
                        const codes = ['runtime_apply_failed', 'meeting_connection_failed', 'meeting_wait_timeout', 'fireflies_session_failed', 'fireflies_rate_limited', 'invitation_rate_limited', 'fireflies_auth_failed', 'fireflies_unavailable', 'fireflies_query_failed', 'fireflies_invalid_response', 'invitation_uncertain', 'meeting_ambiguous', 'runtime_state_locked', 'runtime_state_corrupt', 'runtime_state_unavailable', 'runtime_state_write_failed', 'runtime_state_capacity'];
                        const identifier = input => input === null || typeof input === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input);
                        if (!states.includes(value.operationState) || value.errorCode !== null && !codes.includes(value.errorCode) ||
                            !identifier(value.operationId) || !identifier(value.meetingIntentId) || typeof value.enabled !== 'boolean' || typeof value.hasKey !== 'boolean' ||
                            !Number.isSafeInteger(value.desiredRevision) || value.desiredRevision !== value.appliedRevision ||
                            value.meetingLink !== null && (typeof value.meetingLink !== 'string' || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value.meetingLink))) throw fail('runtime_invalid_response');
                        resolve(redact(Object.fromEntries(allowed.map(key => [key, value[key]]))));
                    } catch { reject(fail('runtime_invalid_response')); }
                });
            });
            const timer = setTimeout(() => { req.destroy(); reject(fail('runtime_timeout')); }, this.#timeout);
            req.once('close', () => clearTimeout(timer)); req.on('error', () => reject(fail('runtime_unavailable')));
            req.end(data);
        });
    }
    getState() { return this.#request('GET', '/v1/runtime-config'); }
    apply(payload, { retry = false } = {}) { return this.#request(retry ? 'POST' : 'PATCH', '/v1/runtime-config' + (retry ? '/retry-join' : ''), payload); }
}
module.exports = { TwinRuntimeClient };
