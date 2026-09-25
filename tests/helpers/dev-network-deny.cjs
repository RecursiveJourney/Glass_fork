// Test-only transport firewall and metadata recorder. Never used by operator launches.
const fs = require('node:fs');
const net = require('node:net');
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function record(row) { if (process.env.ISOLATION_TRACE) fs.appendFileSync(process.env.ISOLATION_TRACE, JSON.stringify(row) + '\n'); }
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
    let opts = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof opts === 'number') opts = { port: opts, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (opts && typeof opts === 'object' && !opts.path) {
        const host = opts.host || opts.hostname || 'localhost';
        if (!allowed.has(host)) { record({ kind: 'denied', transport: 'socket' }); throw Error('test_external_network_forbidden'); }
    }
    return connect.apply(this, args);
};
for (const name of ['node:http', 'node:https']) {
    const api = require(name), request = api.request;
    api.request = function(input, ...rest) {
        const opts = typeof input === 'string' || input instanceof URL ? new URL(input) : input;
        const host = opts.hostname || opts.host || 'localhost';
        if (!allowed.has(host)) { record({ kind: 'denied', transport: name }); throw Error('test_external_network_forbidden'); }
        const port = Number(opts.port || (name === 'node:https' ? 443 : 80));
        record({ kind: 'request', port, path: String(opts.pathname || opts.path || '/').split('?')[0] });
        return request.call(this, input, ...rest);
    };
}
const http = require('node:http'), emit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, ...args) {
    if (event === 'request') record({ kind: 'received', port: args[0].socket.localPort, path: args[0].url.split('?')[0], method: args[0].method });
    return emit.call(this, event, ...args);
};
