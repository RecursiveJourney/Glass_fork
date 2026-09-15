const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function component(api) {
    const file = path.join(__dirname, '../src/ui/settings/TwinConnectionSettings.js');
    assert.ok(fs.existsSync(file), 'runtime settings component exists');
    const context = { window: { api: { settingsView: api } }, customElements: { define() {} }, LitElement: class { connectedCallback() {} disconnectedCallback() {} requestUpdate() {} }, html: () => '', css: () => '' };
    vm.createContext(context);
    const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
    vm.runInContext(source + '\nglobalThis.Component = TwinConnectionSettings;', context);
    return new context.Component();
}
test('replacement input is cleared after success and failure; renderer receives presence only', async () => {
    const calls = [], c = component({ saveTwinSettings: async payload => { calls.push(payload); return { success: true, data: { savedRevision: 1, appliedRevision: 1, state: 'applied', hasKey: true } }; } });
    c.replacementKey = 'synthetic-input'; c.meetingLink = 'https://meet.google.com/abc-defg-hij'; c.enabled = true;
    await c.save(); assert.equal(c.replacementKey, ''); assert.equal(c.state.hasKey, true);
    assert.equal(calls[0].credential.value, 'synthetic-input');
    const failed = component({ saveTwinSettings: async () => { throw Error('synthetic-input'); } });
    failed.replacementKey = 'synthetic-input'; await failed.save(); assert.equal(failed.replacementKey, ''); assert.equal(failed.message.includes('synthetic-input'), false);
});
