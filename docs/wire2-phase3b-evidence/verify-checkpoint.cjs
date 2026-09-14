// Read-only scope and secret verification; never output matching values or source lines.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const git = (args, cwd = root) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('Git verification could not complete; raw output suppressed.'); }
};
const list = value => value.split('\0').filter(Boolean);
const changed = list(git(['diff', '--name-only', '-z']));
const fresh = list(git(['ls-files', '--others', '--exclude-standard', '-z']));
const known = new Set();
function credential(name, value) {
    if (/(?:TOKEN|SECRET|PASSWORD|API.?KEY|PRIVATE.?KEY)/i.test(name) && typeof value === 'string' && value.length >= 12) known.add(value);
}
for (const [name, value] of Object.entries(process.env)) credential(name, value);
for (const dir of [root, path.dirname(root), path.join(path.dirname(root), 'realtime_listener')]) {
    for (const name of fs.readdirSync(dir).filter(name => /^\.env(?:\.|$)/.test(name))) {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) continue;
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
            if (match) credential(match[1], match[2].replace(/^['"]|['"]$/g, ''));
        }
    }
}
const patterns = [
    /\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{24,}/,
    /\b(?:ghp_|github_pat_)[a-zA-Z0-9_]{24,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[A-Z0-9]{16}\b/,
];
const content = [git(['diff', '--no-ext-diff', '--no-textconv', '--']).split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')];
for (const file of fresh) if (!/\.(?:png|jpg|jpeg)$/i.test(file)) content.push(fs.readFileSync(path.join(root, file), 'utf8'));
const secretHit = content.some(text => patterns.some(pattern => pattern.test(text)) || [...known].some(value => text.includes(value)));
const protectedChange = changed.some(file => /^(?:src\/features\/(?:ask|settings|shortcuts|common\/(?:repositories|ai\/providers))\/|src\/features\/common\/services\/modelStateService\.js$)/.test(file));
const parentChanges = list(git(['diff', '--name-only', '-z'], path.dirname(root)));
const listenerChanged = parentChanges.some(file => file.startsWith('realtime_listener/'));
const staged = git(['diff', '--cached', '--name-only']).trim();
const whitespace = git(['-c', 'core.safecrlf=false', 'diff', '--check']);
if (secretHit || protectedChange || listenerChanged || staged || whitespace) {
    console.log('FAIL: checkpoint verification; matching content is suppressed.'); process.exitCode = 1;
} else {
    console.log(`PASS: secret scan of added diff lines and ${fresh.length} untracked files (image content verified separately); no configured environment/.env credentials or key-pattern matches.`);
    console.log('PASS: Ask, repositories, provider implementations/settings, shortcuts and listener source unchanged.');
    console.log('PASS: no staged changes; git diff --check clean.');
}
