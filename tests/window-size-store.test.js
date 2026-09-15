const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WindowSizeStore } = require('../src/window/windowSizeStore');
test('window preferences round-trip separately and reset persists automatic ownership', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-size-')); t.after(() => fs.rmSync(dir, { recursive: true }));
    const file = path.join(dir, 'sizes.json'), store = new WindowSizeStore(file);
    store.set('listen', { owner: 'user', width: 620, height: 480 });
    store.set('ask', { owner: 'user', width: 700, height: 360 });
    assert.deepEqual(new WindowSizeStore(file).get('listen'), { owner: 'user', width: 620, height: 480 });
    store.set('listen', { owner: 'automatic' });
    assert.equal(new WindowSizeStore(file).get('listen').owner, 'automatic');
    assert.equal(store.get('ask').width, 700);
    assert.throws(() => store.set('header', { owner: 'automatic' }));
    assert.throws(() => store.set('ask', { owner: 'user', width: NaN, height: 1 }));
});
test('corrupt original and failed atomic replacement preserve durable preferences', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-size-')); t.after(() => fs.rmSync(dir, { recursive: true }));
    const file = path.join(dir, 'sizes.json'); fs.writeFileSync(file, 'broken original');
    const broken = new WindowSizeStore(file); assert.equal(broken.error, 'size_read_failed');
    assert.throws(() => broken.set('ask', { owner: 'automatic' }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken original');
    fs.unlinkSync(file); const store = new WindowSizeStore(file); store.set('ask', { owner: 'user', width: 500, height: 300 });
    const before = fs.readFileSync(file, 'utf8');
    const failed = new WindowSizeStore(file, { ...fs, renameSync() { throw Error('synthetic failure'); } });
    assert.throws(() => failed.set('ask', { owner: 'automatic' }));
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(failed.get('ask').owner, 'user');
});
