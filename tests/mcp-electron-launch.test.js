const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const entry = path.resolve(__dirname, '../wire3-mcp-ui.cjs');
const electron = require('electron');

function runElectron(args, { token = true, preload = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD)|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH/i.test(key)));
  if (token) env.TWIN_CONTROL_TOKEN = 'synthetic-bootstrap-control';
  env.GEMINI_API_KEY = 'synthetic-bootstrap-provider';
  if (preload) env.NODE_OPTIONS = `--require="${path.join(__dirname, 'helpers/mcp-launch-boundary.cjs').replaceAll('\\', '/')}"`;
  return new Promise((resolve, reject) => {
    const child = spawn(electron, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-launch-bootstrap-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('glass-launch-bootstrap-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
function diagnostic(result, expected) {
  assert.equal(result.timedOut, false, `Electron did not execute the launcher; expected ${expected}`);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(expected), `Expected launcher diagnostic ${expected}`);
  assert.ok(!result.stdout.includes('synthetic-bootstrap-') && !result.stderr.includes('synthetic-bootstrap-'), 'No synthetic secrets in output');
}

test('actual Electron entry rejects missing control token', { timeout: 12000 }, async t => {
  const directory = temporaryDirectory(t);
  diagnostic(await runElectron([entry, '--proof', '--profile', path.join(directory, 'fresh')], { token: false }), 'offline_ui_requires_separate_profile_and_token');
});
test('actual Electron proof entry rejects an existing profile', { timeout: 12000 }, async t => {
  diagnostic(await runElectron([entry, '--proof', '--profile', temporaryDirectory(t)]), 'offline_ui_requires_separate_profile_and_token');
});
test('actual Electron proof entry reaches freeze verification and rejects invalid freeze', { timeout: 12000 }, async t => {
  const directory = temporaryDirectory(t);
  const manifest = path.join(directory, 'invalid-manifest.json');
  fs.writeFileSync(manifest, '{}');
  diagnostic(await runElectron([entry, '--proof', '--profile', path.join(directory, 'fresh'), '--freeze', manifest, '--model', 'gemini-3.8-flash', '--inference-profile', 'wire3-mcp-v1']), 'proof_launch_failed');
});
test('actual Electron proof entry verifies freeze and hands off isolated startup', { timeout: 12000 }, async t => {
  const directory = temporaryDirectory(t);
  const profile = path.join(directory, 'fresh');
  const { createFreeze } = await import('../../realtime_listener/lib/mcp-freeze.js');
  const frozen = await createFreeze({ outputRoot: directory, model: 'gemini-3.8-flash', profile: 'wire3-mcp-v1' });
  const result = await runElectron([entry, '--proof', '--profile', profile, '--freeze', frozen.manifestPath, '--model', 'gemini-3.8-flash', '--inference-profile', 'wire3-mcp-v1'], { preload: true });
  assert.equal(result.timedOut, false, 'Electron launcher must reach the application boot boundary');
  assert.equal(result.code, 0, JSON.stringify(result).replaceAll('synthetic-bootstrap-control', '[redacted]').replaceAll('synthetic-bootstrap-provider', '[redacted]'));
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('MCP_LAUNCH_BOUNDARY:'));
  assert.ok(line, 'Real entry must reach the offline application boot boundary');
  const record = JSON.parse(line.slice('MCP_LAUNCH_BOUNDARY:'.length));
  assert.equal(record.electron, '30.5.1');
  assert.equal(record.processType, 'browser');
  assert.equal(record.entry, entry);
  assert.equal(record.profile, profile);
  assert.equal(record.controlPresent, true);
  assert.equal(record.providerAbsent, true);
  assert.equal(record.preloadAbsent, true);
  assert.equal(record.dotenvDisabled, true);
  assert.deepEqual(record.proofIds, ['f10eeb54-5819-4e36-900e-289268ef1102', 'f10eeb54-5819-4e36-900e-289268ef1101']);
  assert.equal(record.identityBudgetExhausted, true);
  assert.equal(record.nativeWindowLoaded, true);
  assert.ok(!result.stdout.includes('synthetic-bootstrap-') && !result.stderr.includes('synthetic-bootstrap-'));
  console.log('Electron startup boundary: ' + JSON.stringify({ coordinatorNode: process.versions.node, ...record }));
});
test('launcher helper import remains inert inside Electron', { timeout: 12000 }, async () => {
  const result = await runElectron([path.join(__dirname, 'helpers/mcp-launch-import.cjs')], { token: false });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, JSON.stringify(result).replaceAll('synthetic-bootstrap-control', '[redacted]').replaceAll('synthetic-bootstrap-provider', '[redacted]'));
  assert.ok(result.stdout.includes('MCP_LAUNCH_IMPORT:inert'));
  assert.ok(!result.stderr.includes('offline_ui_requires_'));
});
test('launcher helper import remains inert inside Node', () => {
  assert.equal(typeof require(entry).prepareOfflineLaunch, 'function');
});



