const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function component(api = {}) {
    const file = path.join(__dirname, '../src/ui/settings/TwinInsightsSettings.js');
    const context = { window: { api: { settingsView: api } }, customElements: { define() {} }, LitElement: class { connectedCallback() {} disconnectedCallback() {} },
        html: (strings, ...values) => strings.reduce((text, value, index) => text + value + (values[index] ?? ''), ''), css: () => '', setTimeout, clearTimeout, Date };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') + '\nglobalThis.Component = TwinInsightsSettings;', context);
    return new context.Component();
}
const data = () => ({ server: { state: 'reachable' }, gemini: { state: 'not_tested', model: 'gemini-test', observedAt: null },
    transcription: { provider: 'whisper', model: 'whisper-base', source: 'local', state: 'loaded', phase: 'active' }, fireflies: { state: 'disabled' },
    knowledge: { state: 'stale', observedAt: 1000, data: { dossier: { name: 'demo.txt', sha256: 'a'.repeat(64) }, prompt: { version: 'wire-1', sha256: 'b'.repeat(64) } } }, canSetup: false });

test('component shows real observations, stale read-only Knowledge and Setup without a ready-by-key claim', () => {
    const c = component(); c.data = data(); const text = c.render();
    for (const label of ['Digital Twin server', 'Gemini', 'Transcription', 'Fireflies', 'Knowledge', 'Setup', 'whisper-base', 'demo.txt', 'wire-1', 'Not tested', 'stale']) assert.ok(text.includes(label), label);
    assert.equal(text.includes('<input'), false); assert.equal(text.includes('Gemini ready'), false);
});

test('disconnected component discards an outstanding read and does not schedule another poll', async () => {
    let finish; const c = component({ getTwinInsights: () => new Promise(resolve => { finish = resolve; }) });
    c.connectedCallback(); c.disconnectedCallback(); finish({ success: true, data: data() });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(c.data, null); assert.equal(c.timer, null);
});

test('Setup relocation removes only the fork entry and retains upstream labels', () => {
    const header = fs.readFileSync(path.join(__dirname, '../src/ui/app/MainHeader.js'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, '../src/ui/settings/SettingsView.js'), 'utf8');
    assert.equal(header.includes('glass-setup-requested'), false);
    assert.ok(settings.includes('Whisper is enabled')); assert.ok(settings.includes('Ollama'));
    assert.ok(settings.includes('twin-insights-settings'));
});

test('candidate Knowledge visibly identifies offline mode and its pending gate',()=>{const c=component();c.data=data();c.data.knowledge.data.evaluation={mode:'offline',freezeId:'c'.repeat(64),gate:'not_evaluated'};const rendered=c.render();assert.ok(rendered.includes('Offline evaluation'));assert.ok(rendered.includes('Not evaluated'));assert.ok(rendered.includes('c'.repeat(64)));});
