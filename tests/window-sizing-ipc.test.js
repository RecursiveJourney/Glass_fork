const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
test('size IPC only reads/resets the trusted calling feature window and accepts no bounds', async () => {
    const handlers = new Map(), frame = {}, sender = { mainFrame: frame, getURL: () => 'file:///fixture/src/ui/app/content.html?view=ask' };
    const win = { webContents: sender, isDestroyed: () => false }, policy = { state: () => ({ owner: 'user' }), reset: () => ({ owner: 'automatic' }) };
    const manager = { windowPool: new Map([['ask', win]]) };
    const stubs = { electron: { ipcMain: { handle: (n,fn) => handlers.set(n,fn), on() {} }, app: { getAppPath: () => '/fixture' }, shell: {} },
        '../window/windowManager': manager, '../window/windowBounds': { getSizingPolicy: w => w === win ? policy : null } };
    const module = { exports: {} }; const file = path.join(__dirname,'../src/bridge/windowBridge.js');
    vm.runInNewContext(fs.readFileSync(file,'utf8'), { require: id => stubs[id], module, URL }); module.exports.initialize();
    const event = { sender, senderFrame: frame };
    for (const channel of ['window:sizing-get','window:sizing-reset']) {
        const handler = handlers.get(channel); assert.equal(typeof handler,'function');
        assert.equal((await handler({ ...event, senderFrame: {} })).success, false);
        assert.equal((await handler(event, { name: 'listen', width: 2000 })).success, false);
        assert.equal((await handler({ sender: {}, senderFrame: {} })).success, false);
    }
    assert.equal((await handlers.get('window:sizing-get')(event)).data.owner,'user');
    assert.equal((await handlers.get('window:sizing-reset')(event)).data.owner,'automatic');
});
