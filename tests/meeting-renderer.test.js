const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('meeting overlay in the actual Electron renderer', { timeout: 90000 }, async t => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'helpers/meeting-renderer.cjs')], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); // Browser diagnostics are not a test or credential sink.
    const timer = setTimeout(() => child.kill(), 80000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    const line = output.split(/\r?\n/).find(line => line.startsWith('MEETING_TESTS:'));
    assert.ok(line, 'isolated renderer returned structured test results');
    const results = JSON.parse(line.slice('MEETING_TESTS:'.length));
    for (const result of results) await t.test(result.name, () => assert.equal(result.error, null, result.error || result.name));
    assert.equal(code, 0);
});
