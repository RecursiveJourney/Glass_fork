const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachWindowSizing } = require('../src/window/windowSizing');
const { getWindowBounds, setWindowBounds, registerWindowSizeLimits } = require('../src/window/windowBounds');
const { animateResize } = require('../src/window/windowResize');
function fixture(saved) {
    const win = new EventEmitter(); let actual = { x: 50, y: 50, width: 400, height: 300 }, area = { x: 0, y: 0, width: 1000, height: 800 };
    Object.assign(win, { getBounds: () => ({ ...actual }), setBounds: b => { actual = { ...b, width: b.width + 1, height: b.height + 1 }; win.emit('resize'); },
        isDestroyed: () => false, isResizable: () => true, setMinimumSize(...size) { this.minimum=size; }, setMaximumSize(...size) { this.maximum=size; }, webContents: { send() {} } });
    registerWindowSizeLimits(win, { minWidth: 400, minHeight: 180 });
    let cancelled = 0; const writes = [];
    const control = attachWindowSizing(win, { name: 'listen', defaults: { width: 400, height: 300 }, min: [400,180],
        store: { get: () => saved, set: (name, value) => writes.push({ name, value }) },
        workArea: () => area, cancel: () => cancelled++ });
    return { win, control, writes, cancelled: () => cancelled, native: b => { actual = { ...actual, ...b }; }, area: b => { area = b; } };
}
test('native intent cancels automatic animation and completion adopts exact user bounds', async () => {
    const f = fixture(); setWindowBounds(f.win, { width: 500, height: 350 });
    f.win.emit('resize'); f.win.emit('resized'); assert.equal(f.control.state().owner, 'automatic'); assert.equal(f.writes.length, 0);
    assert.equal(getWindowBounds(f.win).width, 500);
    f.win.emit('will-resize'); assert.equal(f.cancelled(), 1); assert.equal(f.control.state().owner, 'user');
    setWindowBounds(f.win, { width: 800, height: 600 }); assert.equal(f.win.getBounds().width, 501);
    f.native({ width: 620, height: 480 }); f.win.emit('resize'); f.win.emit('resized');
    assert.equal(getWindowBounds(f.win).width, 620); assert.equal(f.writes[0].value.width, 620);
    for (let i = 0; i < 20; i++) setWindowBounds(f.win, { x: 20+i, width: 900, height: 700 });
    assert.equal(getWindowBounds(f.win).width, 620); assert.equal(f.writes.length, 1);
    const ack = await animateResize(f.win, () => { throw Error('automatic target must not run'); }, {}, () => {}, 600);
    assert.equal(ack.reason, 'user_owned'); assert.equal(ack.applied, false);
});
test('programmatic cross-display moves update native limits without claiming user intent',()=>{
    const f=fixture({owner:'user',width:720,height:580});
    f.area({x:1000,y:0,width:500,height:400});setWindowBounds(f.win,{x:1010});
    assert.deepEqual(f.win.maximum,[500,400]);assert.equal(getWindowBounds(f.win).width,500);
    f.area({x:0,y:0,width:1200,height:900});setWindowBounds(f.win,{x:20});
    assert.deepEqual(f.win.maximum,[1200,900]);assert.equal(getWindowBounds(f.win).width,720);
    assert.equal(f.writes.length,0);assert.equal(f.control.state().dragging,false);
});
test('saved user sizes clamp without replacing preference; reset and other windows are independent', () => {
    const f = fixture({ owner: 'user', width: 720, height: 580 }), other = fixture();
    assert.equal(getWindowBounds(f.win).width, 720); assert.equal(other.control.state().owner, 'automatic');
    f.area({ x: -500, y: 0, width: 500, height: 400 }); f.control.restore();
    assert.equal(getWindowBounds(f.win).width, 500); assert.equal(getWindowBounds(f.win).x, -500); assert.equal(f.writes.length, 0);
    f.area({ x: 0, y: 0, width: 1000, height: 800 }); f.control.restore(); assert.equal(getWindowBounds(f.win).width, 720);
    f.control.reset(); assert.equal(f.control.state().owner, 'automatic'); assert.equal(getWindowBounds(f.win).width, 400);
    assert.deepEqual(f.writes.at(-1).value, { owner: 'automatic' });
});
