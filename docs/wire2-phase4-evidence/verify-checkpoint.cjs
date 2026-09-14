// Read-only verification. Never print matching values or source lines.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const glass = path.resolve(__dirname, '../..');
const parent = path.dirname(glass);
const git = (cwd, args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('Git verification failed; raw output suppressed.'); }
};
const list = value => value.split('\0').filter(Boolean);
const known = new Set();
function credential(name, value) {
    if (/(?:TOKEN|SECRET|PASSWORD|API.?KEY|PRIVATE.?KEY)/i.test(name) && typeof value === 'string' && value.length >= 12) known.add(value);
}
for (const [name, value] of Object.entries(process.env)) credential(name, value);
for (const dir of [glass, parent, path.join(parent, 'realtime_listener')]) {
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
let scanned = 0;
for (const cwd of [glass, parent]) {
    const changed = list(git(cwd, ['diff', '--name-only', '-z']));
    const fresh = list(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
    const allowed = file => cwd === glass
        ? /^(?:tests\/window-attachment\.test\.js|docs\/meeting-feed-subscriber\.md|docs\/wire2-phase4-checkpoint\.md|docs\/wire2-phase4-evidence\/[^/]+)$/.test(file)
        : /^(?:glass|realtime_listener\/README\.md|realtime_listener\/docs\/(?:design\.md|live-feed-contract\.md|wire2-manual-checklist\.md))$/.test(file);
    if ([...changed, ...fresh].some(file => !allowed(file))) throw new Error('FAIL: unexpected Phase 4 file scope; details suppressed.');
    if (git(cwd, ['diff', '--cached', '--name-only']).trim()) throw new Error('FAIL: staged changes exist.');
    const content = [git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--']).split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')];
    for (const file of fresh) content.push(fs.readFileSync(path.join(cwd, file), 'utf8'));
    scanned += fresh.length;
    if (content.some(text => patterns.some(pattern => pattern.test(text)) || [...known].some(value => text.includes(value)))) {
        throw new Error('FAIL: possible secret; matching content suppressed.');
    }
    if (git(cwd, ['-c', 'core.safecrlf=false', 'diff', '--check']).trim()) throw new Error('FAIL: whitespace check.');
}
if (git(glass, ['rev-parse', 'HEAD']).trim() !== 'a7394e4ce177f8356f16d65e88b2ea366c3611f5') throw new Error('FAIL: Glass HEAD changed.');
if (git(parent, ['rev-parse', 'HEAD']).trim() !== '1182c176495b9556ef6a3cb01b8168a41eb4c94f') throw new Error('FAIL: parent HEAD changed.');
console.log(`PASS: added diff lines and ${scanned} untracked text files scanned; no configured environment/.env credential or key-pattern matches.`);
console.log('PASS: Phase 4 changes limited to window-attachment tests and documentation/evidence; all production code and listener tests unchanged.');
console.log('PASS: both staging areas empty, both expected HEADs unchanged, git diff --check clean. No Phase 4 commit.');
