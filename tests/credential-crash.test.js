const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
function run(directory, boundary, phase) {
    return new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [path.join(__dirname, 'helpers/credential-crash-worker.cjs'), directory, boundary, phase], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore',
        });
        const timer = setTimeout(() => { child.kill(); reject(Error('crash_fixture_timeout')); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
}
for (const boundary of ['before-commit', 'before-cleanup', 'after-cleanup']) {
    test(`abrupt process exit ${boundary}: encrypted migration recovers without source loss`, { timeout: 45000 }, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-crash-'));
        try {
            assert.equal(await run(directory, boundary, 'seed'), 0);
            assert.equal(await run(directory, boundary, 'crash'), 71, 'worker exits inside boundary without closing SQLite');
            assert.equal(await run(directory, boundary, 'recover'), 0);
        } finally { fs.rmSync(directory, { recursive: true }); }
    });
}
