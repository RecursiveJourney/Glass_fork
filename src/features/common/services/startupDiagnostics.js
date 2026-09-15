const fs = require('fs');
const path = require('path');
const registry = require('./secretRedactor');
const allowed = new Set(['status', 'code', 'providerCount', 'recoveryCount', 'credentialCount', 'dataPathAlias', 'bootId', 'existed', 'schemaVersion', 'durationMs', 'installationId', 'profileAlias']);
function createStartupDiagnostics({ file, output } = {}) {
    function record(event, fields = {}) {
        if (!/^[a-z_-]{1,48}$/.test(event)) return;
        const row = registry.redact({ at: new Date().toISOString(), event, ...Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value))) });
        if (output) output(row);
        if (file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (fs.existsSync(file) && fs.statSync(file).size > 262144) fs.renameSync(file, file + '.previous');
            fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
        }
        return row;
    }
    return { record };
}
function installConsoleRedaction(target = console) {
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = target[method].bind(target);
        target[method] = (...args) => original(...args.map(arg => registry.redact(arg)));
    }
}
module.exports = { createStartupDiagnostics, installConsoleRedaction };
