const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
test('real OS safeStorage decrypts a synthetic credential in a second Electron process', { timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-vault-smoke-'));
    try {
        for (const mode of ['write', 'read']) {
            const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
            const child = spawn(require('electron'), [path.join(__dirname, 'helpers/safe-storage-smoke.cjs'), directory, mode], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
            const timer = setTimeout(() => child.kill(), 12000);
            const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
            assert.equal(code, 0); assert.ok(output.includes('SAFE_STORAGE_RESULT:ok'));
        }
        assert.equal(fs.readFileSync(path.join(directory, 'encrypted-fixture.bin')).includes(Buffer.from('synthetic-os-restart-marker')), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
