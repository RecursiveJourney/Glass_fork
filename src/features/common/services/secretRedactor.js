function failure(code) { return Object.assign(new Error(code), { code }); }

function createSecretRedactor({ capacity = 4096 } = {}) {
    const values = new Set();
    let ordered = [];
    function registerSecrets(candidates) {
        if (!Array.isArray(candidates) || candidates.some(v => typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > 8192)) {
            throw failure('redaction_capacity');
        }
        const next = new Set([...values, ...candidates.filter(Boolean)]);
        if (next.size > capacity) throw failure('redaction_capacity');
        for (const value of next) values.add(value);
        ordered = [...values].sort((a, b) => b.length - a.length);
    }
    function redact(value, seen = new WeakSet()) {
        if (typeof value === 'string') {
            for (const secret of ordered) value = value.split(secret).join('[REDACTED]');
            return value;
        }
        if (value instanceof Error) return { code: 'operation_failed' };
        if (Buffer.isBuffer(value)) return '[BINARY]';
        if (value && typeof value === 'object') {
            if (seen.has(value)) return '[CIRCULAR]';
            seen.add(value);
            const result = Array.isArray(value) ? value.map(v => redact(v, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) =>
                [redact(key), /^(authorization|token|apiKey|api_key|.*_API_KEY|.*_TOKEN|ciphertext|credential_ref|value)$/i.test(key) ? '[REDACTED]' : redact(item, seen)]));
            seen.delete(value);
            return result;
        }
        return value;
    }
    return { registerSecrets, redact };
}

const registry = createSecretRedactor();
module.exports = { createSecretRedactor, ...registry };
