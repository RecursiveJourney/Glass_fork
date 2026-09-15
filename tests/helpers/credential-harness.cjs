const { spawn } = require('node:child_process');
const path = require('node:path');
module.exports = function runFixture(scenario) {
    return new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [path.join(__dirname, 'credential-worker.cjs'), scenario], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', c => { stdout += c; });
        child.stderr.on('data', c => { stderr += c; });
        const timer = setTimeout(() => { child.kill(); reject(Error('fixture_timeout')); }, 20000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            const line = stdout.split(/\r?\n/).find(s => s.startsWith('CREDENTIAL_FIXTURE:'));
            if (!line) return reject(Error(`fixture_process_failed:${code}:${stderr.slice(0, 500)}`));
            resolve(JSON.parse(line.slice('CREDENTIAL_FIXTURE:'.length)));
        });
    });
};
