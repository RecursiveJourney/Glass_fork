// Kept byte-identical to the listener's mcp-config.cjs; parity is tested.
const { createHash } = require('node:crypto');
const path = require('node:path');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const osEnv = ['APPDATA','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','PATH','PROCESSOR_ARCHITECTURE','SYSTEMDRIVE','SYSTEMROOT','TEMP','USERNAME','USERPROFILE','PROGRAMFILES','HOME','LOGNAME','SHELL','TERM','USER'];
const forbiddenEnv = new Set([...osEnv, 'GEMINI_API_KEY','GOOGLE_API_KEY','FIREFLIES_API_KEY','TWIN_CONTROL_TOKEN','WRAPPER_TOKEN','NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
const fail = (code = 'invalid_mcp_config') => Object.assign(new Error(code), { code, status: 400 });
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
function exact(x, keys) { if (!object(x) || Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x,k))) throw fail(); }
function text(x, max = 80) { return typeof x === 'string' && x.length > 0 && Buffer.byteLength(x) <= max && !/[\x00-\x1f\x7f]/.test(x); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function endpointDigest(c) { return sha256({ transport: c.transport, destination: c.transport === 'stdio' ? c.stdio : c.http, targets: c.credentialBindings.map(b => ({ slot: b.slot, target: b.target })).sort((a,b) => a.slot.localeCompare(b.slot)) }); }
function validateUrl(value) {
  if (!text(value, 2048)) throw fail();
  let u; try { u = new URL(value); } catch { throw fail(); }
  if (u.username || u.password || u.search || u.hash || !['https:','http:'].includes(u.protocol)) throw fail();
  const loopback = ['127.0.0.1','[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback || /^(?:169\.254\.|0\.|224\.|255\.)/.test(u.hostname) || /^\[(?:fe[89ab]|ff|::ffff:)/i.test(u.hostname) || u.hostname === '[::]') throw fail();
  // Reject alternate numeric representations that WHATWG URL silently maps to loopback.
  if (u.protocol === 'http:' && !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value)) throw fail();
  return u.href;
}
function validateConfig(input) {
  exact(input, ['schemaVersion','revision','connections']);
  if (input.schemaVersion !== 1) throw fail('unsupported_schema');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.connections) || input.connections.length > 8) throw fail();
  const seen = new Set();
  for (const c of input.connections) {
    exact(c, ['id','name','enabled','transport', c?.transport === 'stdio' ? 'stdio' : 'http','credentialBindings','allowedTools','knowledgeApproval','limits']);
    if (!uuid.test(c.id) || seen.has(c.id) || !text(c.name) || typeof c.enabled !== 'boolean') throw fail(); seen.add(c.id);
    if (c.transport === 'stdio') {
      exact(c.stdio, ['executable','args','cwd']);
      const { executable, args, cwd } = c.stdio;
      if (!text(executable,2048) || !text(cwd,2048) || !path.isAbsolute(executable) || !path.isAbsolute(cwd) || /\.(?:cmd|bat)$/i.test(executable) || /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript)(?:\.exe)?$/i.test(path.basename(executable))) throw fail();
      if (!Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || Buffer.byteLength(a) > 2048 || /[\x00\r\n]/.test(a)) || Buffer.byteLength(JSON.stringify(args)) > 16384) throw fail();
    } else if (c.transport === 'streamable-http') { exact(c.http, ['url']); if (validateUrl(c.http.url) !== c.http.url) throw fail(); }
    else throw fail();
    if (!Array.isArray(c.credentialBindings) || c.credentialBindings.length > 8) throw fail();
    const slots = new Set(), targets = new Set();
    for (const b of c.credentialBindings) {
      exact(b, ['slot','target','ref']);
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(b.slot) || slots.has(b.slot) || !uuid.test(b.ref)) throw fail(); slots.add(b.slot);
      if (c.transport === 'stdio') {
        exact(b.target, ['kind','name']);
        if (b.target.kind !== 'env' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(b.target.name) || forbiddenEnv.has(b.target.name.toUpperCase()) || /(?:PROXY|API_KEY|CONTROL_TOKEN|WRAPPER_TOKEN)$/.test(b.target.name)) throw fail();
      } else { exact(b.target, ['kind']); if (b.target.kind !== 'bearer') throw fail(); }
      const target = canonical(b.target); if (targets.has(target)) throw fail(); targets.add(target);
    }
    if (!Array.isArray(c.allowedTools) || c.allowedTools.length > 128) throw fail();
    const names = new Set();
    for (const t of c.allowedTools) {
      exact(t, ['name','definitionSha256','approvedReadOnly']);
      if (!text(t.name,128) || t.name === '*' || names.has(t.name) || !digest.test(t.definitionSha256) || t.approvedReadOnly !== true) throw fail(); names.add(t.name);
    }
    if (c.knowledgeApproval !== null) {
      const a = c.knowledgeApproval; exact(a, ['contract','clientId','sourceIds','toolDigests','endpointSha256']);
      if (a.contract !== 'dated-client-facts-v1' || !text(a.clientId,128) || a.endpointSha256 !== endpointDigest(c) || !Array.isArray(a.sourceIds) || !a.sourceIds.length || a.sourceIds.length > 32 || a.sourceIds.some(x => !text(x,128)) || new Set(a.sourceIds).size !== a.sourceIds.length || !Array.isArray(a.toolDigests) || !a.toolDigests.length || a.toolDigests.length > 32 || a.toolDigests.some(x => !digest.test(x) || !c.allowedTools.some(t => t.definitionSha256 === x))) throw fail();
    }
    exact(c.limits, ['connectMs','callMs','resultBytes','maxCalls']);
    for (const [key,min,max] of [['connectMs',1000,10000],['callMs',500,10000],['resultBytes',1024,32768],['maxCalls',1,4]]) if (!Number.isSafeInteger(c.limits[key]) || c.limits[key] < min || c.limits[key] > max) throw fail();
  }
  return JSON.parse(JSON.stringify(input));
}
module.exports = { validateConfig, validateUrl, endpointDigest, canonical, sha256, fail, exact, text, uuid, forbiddenEnv, osEnv };
