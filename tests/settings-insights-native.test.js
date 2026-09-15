const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
test('native Settings reads authenticated insights and routes Setup only through main', { timeout: 40000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-insights-'));
    try {
        const result = await new Promise((resolve, reject) => {
            const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
            const child = spawn(require('electron'), [path.join(__dirname, 'helpers/settings-insights-native.cjs'), directory, 'node' + process.versions.node.split('.')[0]], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            let output = ''; child.stdout.on('data', chunk => { output += chunk; });
            const timer = setTimeout(() => { child.kill(); reject(Error('native_insights_timeout')); }, 30000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); const line = output.split(/\r?\n/).find(value => value.startsWith('INSIGHTS_NATIVE:')); resolve(line ? JSON.parse(line.slice('INSIGHTS_NATIVE:'.length)) : { passed: false, code: 'native_process_failed' }); });
        });
        assert.equal(result.passed, true, result.code || 'native insights');
        assert.equal(result.externalRequests, 0); console.log('Native insights result: ' + JSON.stringify(result));
    } finally { fs.rmSync(directory, { recursive: true }); }
});
