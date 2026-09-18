const test = require('node:test'), assert = require('node:assert/strict');
let config;
try { config = require('../src/features/common/services/mcpConfig'); } catch {}
const connection = () => ({ id: 'f10eeb54-5819-4e36-900e-289268ef1101', name: 'Fixture', enabled: false, transport: 'streamable-http', http: { url: 'http://127.0.0.1:8765/mcp' }, credentialBindings: [], allowedTools: [], knowledgeApproval: null, limits: { connectMs: 5000, callMs: 5000, resultBytes: 16384, maxCalls: 4 } });
const doc = c => ({ schemaVersion: 1, revision: 0, connections: [c || connection()] });
test('MCP v1 canonical document roundtrips without retaining caller-owned objects', () => {
  assert.equal(typeof config?.validateConfig, 'function'); const input = doc(), result = config.validateConfig(input);
  assert.deepEqual(result, input); input.connections[0].name = 'changed'; assert.equal(result.connections[0].name, 'Fixture');
});
for (const [label, mutate] of [
  ['unknown version', d => d.schemaVersion = 2], ['unknown root', d => d.secrets = {}],
  ['duplicate id', d => d.connections.push(structuredClone(d.connections[0]))],
  ['wildcard approval', d => d.connections[0].allowedTools = ['*']],
  ['missing digest', d => d.connections[0].allowedTools = [{ name: 'lookup', approvedReadOnly: true }]],
  ['excess limits', d => d.connections[0].limits.callMs = 10001],
  ['query token', d => d.connections[0].http.url += '?token=synthetic'],
  ['URL userinfo', d => d.connections[0].http.url = 'https://user:synthetic@example.com/mcp'],
  ['remote HTTP', d => d.connections[0].http.url = 'http://example.com/mcp'],
  ['metadata address', d => d.connections[0].http.url = 'https://169.254.169.254/mcp'],
  ['mixed transport', d => d.connections[0].stdio = {}],
  ['raw credential', d => d.connections[0].credentialBindings = [{ slot: 'token', target: { kind: 'bearer' }, ref: 'r', value: 'synthetic' }]],
  ['self-approved arbitrary source', d => d.connections[0].knowledgeApproval = { approved: true }],
]) test('MCP rejects ' + label, () => { assert.ok(config); const input = doc(); mutate(input); assert.throws(() => config.validateConfig(input), e => typeof e.code === 'string' && !e.message.includes('synthetic')); });
test('destination identity excludes display name but includes arguments, credential targets and URL', () => {
  assert.ok(config); const c = connection(), initial = config.endpointDigest(c); c.name = 'renamed'; assert.equal(config.endpointDigest(c), initial);
  c.http.url += '/new'; assert.notEqual(config.endpointDigest(c), initial);
});
for (const name of ['GEMINI_API_KEY', 'fireflies_api_key', 'TWIN_CONTROL_TOKEN', 'WRAPPER_TOKEN', 'NODE_OPTIONS', 'PATH', 'HTTPS_PROXY']) test('MCP forbids child env target ' + name, () => {
  assert.ok(config); const c = connection(); delete c.http; c.transport = 'stdio'; c.stdio = { executable: process.execPath, args: [], cwd: process.cwd() };
  c.credentialBindings = [{ slot: 'token', target: { kind: 'env', name }, ref: 'f10eeb54-5819-4e36-900e-289268ef1102' }];
  assert.throws(() => config.validateConfig(doc(c)), { code: 'invalid_mcp_config' });
});
module.exports = { connection, doc };
