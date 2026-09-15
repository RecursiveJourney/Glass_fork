const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
test('native form traverses preload, IPC, OS vault, SQLite and HTTP within the Save latency budget', { timeout: 45000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-twin-native-'));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    try {
        const child = spawn(require('electron'), [path.join(__dirname, 'helpers/twin-settings-native.cjs'), directory, 'node' + process.versions.node.split('.')[0]], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
        const timer = setTimeout(() => child.kill(), 40000);
        const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
        const line = output.split(/\r?\n/).find(s => s.startsWith('TWIN_NATIVE:')); assert.ok(line, 'native result available');
        const result = JSON.parse(line.slice('TWIN_NATIVE:'.length));
        assert.equal(result.passed, true, result.stage); assert.equal(code, 0); assert.equal(result.renderer.count, 20); assert.equal(result.externalInvitations, 0);
        console.log('Native Save metrics: ' + JSON.stringify(result));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
