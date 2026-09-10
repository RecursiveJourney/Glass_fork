const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ rounding = 0, deferNativeEvents = false } = {}) {
    let now = 0, nextTimer = 0;
    const timers = new Map();
    const schedule = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, at: now + delay });
        return id;
    };
    function advance(ms) {
        const until = now + ms;
        for (let count = 0; count < 10000; count++) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > until) { now = until; return; }
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        throw new Error('Timer loop did not settle');
    }
    class FakeWindow extends EventEmitter {
        constructor(options = {}) {
            super();
            this.bounds = { x: options.x || 0, y: options.y || 0,
                width: options.width || 400, height: options.height || 300 };
            this.visible = options.show !== false;
            this.resizable = !!options.resizable;
            this.options = options;
            this.emitMoves = true;
            this.webContents = new EventEmitter();
            this.webContents.send = () => {};
            this.webContents.openDevTools = () => {};
        }
        getBounds() { return { ...this.bounds }; }
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setBounds(bounds) {
            const old = this.bounds;
            this.bounds = { ...old, ...bounds };
            // Observed on Windows at 175%: reported size can exceed the request by 1-2 DIP.
            if (Object.hasOwn(bounds, 'width')) this.bounds.width += rounding;
            if (Object.hasOwn(bounds, 'height')) this.bounds.height += rounding;
            const emit = event => deferNativeEvents ? schedule(() => this.emit(event), 0) : this.emit(event);
            if (this.emitMoves && (old.x !== this.bounds.x || old.y !== this.bounds.y)) emit('move');
            if (old.width !== this.bounds.width || old.height !== this.bounds.height) emit('resize');
        }
        setPosition(x, y) { this.setBounds({ ...this.bounds, x, y }); }
        isDestroyed() { return false; }
        isVisible() { return this.visible; }
        show() { this.visible = true; }
        hide() { this.visible = false; }
        isResizable() { return this.resizable; }
        setResizable(value) { this.resizable = value; }
        getMinimumSize() { return [this.options.minWidth || 0, 0]; }
        getMaximumSize() { return [this.options.maxWidth || 0, this.options.maxHeight || 0]; }
        setContentProtection() {}
        setVisibleOnAllWorkspaces() {}
        loadFile() { return Promise.resolve(); }
        setOpacity() {}
        getOpacity() { return 1; }
        setAlwaysOnTop() {}
        setIgnoreMouseEvents() {}
        moveTop() {}
    }
    const displays = [
        { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }
    ];
    const screen = new EventEmitter();
    screen.getPrimaryDisplay = () => displays[0];
    screen.getDisplayNearestPoint = point => point.x < 0 ? displays[1] : displays[0];
    screen.getAllDisplays = () => displays;
    const bridge = new EventEmitter();
    const cache = new Map();
    function load(name) {
        if (cache.has(name)) return cache.get(name);
        const filename = path.join(__dirname, '../src/window', name + '.js');
        const module = { exports: {} };
        const stubs = {
            electron: { BrowserWindow: FakeWindow, screen, app: { isPackaged: true } },
            '../bridge/internalBridge': bridge,
            '../features/shortcuts/shortcutsService': { initialize() {}, registerShortcuts() {} },
            '../features/common/repositories/permission': {}
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, exports: module.exports, __dirname: path.dirname(filename),
            require: id => {
                if (Object.hasOwn(stubs, id)) return stubs[id];
                if (id.startsWith('./')) return load(id.slice(2));
                if (id === 'node:path' || id === 'os') return require(id);
                throw new Error('Unexpected dependency: ' + id);
            },
            process: { platform: 'win32', env: {} },
            Date: { now: () => now }, console: { log() {}, warn() {}, error() {} },
            setTimeout: schedule, clearTimeout: id => timers.delete(id)
        }, { filename });
        cache.set(name, module.exports);
        return module.exports;
    }
    const api = load('windowManager');
    api.createWindows();
    api.handleHeaderStateChanged('main');
    const header = api.windowPool.get('header');
    const listen = api.windowPool.get('listen');
    const ask = api.windowPool.get('ask');
    listen.show();
    return { api, header, listen, ask, bridge, timers, advance, load, FakeWindow };
}

function below(header, child) {
    assert.equal(child.getBounds().y, header.getBounds().y + header.getBounds().height + 8);
}
function centered(header, child) {
    const h = header.getBounds(), c = child.getBounds();
    assert.ok(Math.abs(c.x + c.width / 2 - (h.x + h.width / 2)) <= 0.5);
}

test('immediate layout cancels the older animation (original VM drift reproduction)', () => {
    const h = harness();
    const win = new h.FakeWindow({ x: 0, y: 100, width: 400, height: 300 });
    const manager = new (h.load('smoothMovementManager'))(new Map([['listen', win]]));
    manager.animateWindowBounds(win, { ...win.getBounds(), y: 200 });
    manager.animateLayout({ listen: { ...win.getBounds(), y: 500 } }, false);
    assert.equal(win.getBounds().y, 500);
    h.advance(500);
    assert.equal(win.getBounds().y, 500, 'older animation must not restore y=200');
    assert.equal(manager.isAnimating, false);
});

test('native header movement follows continuously before the final moved event', () => {
    const h = harness();
    h.header.setPosition(650, 120);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    h.header.setPosition(720, 190);
    below(h.header, h.listen);
    centered(h.header, h.listen);
});

test('explicit drag synchronizes children even without native move events', () => {
    const h = harness();
    h.header.emitMoves = false;
    h.api.moveHeaderTo(600, 150);
    below(h.header, h.listen);
    centered(h.header, h.listen);
});

test('drag during transcript growth preserves requested height and restores resize state', () => {
    const h = harness();
    h.api.moveHeaderTo(600, 80);
    h.api.adjustWindowHeight('listen', 600);
    h.advance(80);
    h.api.moveHeaderTo(700, 160);
    h.header.emit('moved');
    h.advance(600);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    assert.equal(h.listen.getBounds().height, 600);
    assert.equal(h.listen.isResizable(), false);
});

test('final moved event reconciles position while a child animation is active', () => {
    const h = harness();
    h.api.adjustWindowHeight('listen', 500);
    h.header.emitMoves = false;
    h.header.setPosition(700, 170);
    h.header.emit('moved');
    below(h.header, h.listen);
    centered(h.header, h.listen);
    h.advance(600);
    below(h.header, h.listen);
    centered(h.header, h.listen);
});

test('Ask and Listen remain side by side through left and right edge drags', () => {
    const h = harness();
    h.ask.show();
    for (const x of [0, 1550, 600]) {
        h.api.moveHeaderTo(x, 80);
        below(h.header, h.listen);
        below(h.header, h.ask);
        const l = h.listen.getBounds(), a = h.ask.getBounds();
        assert.equal(l.x + l.width + 8, a.x);
        assert.ok(l.x >= 0 && a.x + a.width <= 1920);
    }
});

test('screen-edge transitions place Listen above then below without stale jumps', () => {
    const h = harness();
    h.api.moveHeaderTo(650, 1000);
    let l = h.listen.getBounds(), header = h.header.getBounds();
    assert.equal(l.y + l.height + 8, header.y);
    h.api.moveHeaderTo(650, 50);
    below(h.header, h.listen);
    h.advance(600);
    below(h.header, h.listen);
});

test('attachment uses the destination monitor origin', () => {
    const h = harness();
    h.api.moveHeaderTo(-1200, 120);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    assert.ok(h.listen.getBounds().x < 0);
});

test('keyboard movement keeps attachment through animation and at completion', () => {
    const h = harness();
    h.api.moveHeaderTo(650, 100);
    h.api.moveWindowStep('right');
    h.advance(120);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    h.advance(600);
    assert.equal(h.header.getBounds().x, 730);
    below(h.header, h.listen);
    centered(h.header, h.listen);
});

test('manual drag supersedes a running header animation', () => {
    const h = harness();
    h.api.moveHeaderTo(650, 100);
    h.api.moveWindowStep('right');
    h.advance(80);
    h.api.moveHeaderTo(950, 150);
    h.advance(600);
    assert.equal(h.header.getBounds().x, 950);
    below(h.header, h.listen);
    centered(h.header, h.listen);
});


test('175% DPI rounding does not accumulate size over repeated Listen drags', () => {
    const h = harness({ rounding: 2, deferNativeEvents: true });
    h.api.adjustWindowHeight('listen', 360);
    h.advance(600);
    for (let i = 0; i < 150; i++) {
        h.api.moveHeaderTo(600 + (i % 50), 80);
        h.advance(10);
    }
    h.advance(600);
    assert.ok(h.listen.getBounds().width <= 402, 'Listen must not feed native width inflation back into layout');
    assert.ok(h.listen.getBounds().height <= 362, 'Listen must preserve requested height');
    assert.ok(h.header.getBounds().width <= 355, 'header position changes must not accumulate width');
    assert.ok(Math.abs(h.listen.getBounds().y - (h.header.getBounds().y + 47 + 8)) <= 2);
});

test('rounded Ask + Listen bounds stay bounded during drag and transcript growth', () => {
    const h = harness({ rounding: 2, deferNativeEvents: true });
    h.ask.show();
    h.api.adjustWindowHeight('ask', 180);
    for (let i = 0; i < 100; i++) {
        if (i % 10 === 0) h.api.adjustWindowHeight('listen', 360 + i);
        h.api.moveHeaderTo(650 + i, 70);
        h.advance(10);
    }
    h.advance(600);
    const l = h.listen.getBounds(), a = h.ask.getBounds();
    assert.ok(l.width <= 402 && a.width <= 602, 'neither child may grow toward full-screen width');
    assert.ok(l.height <= 452 && a.height <= 182);
    assert.ok(Math.abs(l.x + 400 + 8 - a.x) <= 2, 'requested widths determine side-by-side placement');
    assert.ok(l.y + l.height < 1080 && a.y + a.height < 1080);
    assert.equal(h.listen.isResizable(), false);
});

test('DPI rounding across below/above transitions does not change requested dimensions', () => {
    const h = harness({ rounding: 2, deferNativeEvents: true });
    h.api.adjustWindowHeight('listen', 360);
    h.advance(600);
    for (let i = 0; i < 30; i++) {
        h.api.moveHeaderTo(650, i % 2 ? 80 : 1000);
        h.advance(20);
    }
    h.advance(600);
    const l = h.listen.getBounds();
    assert.ok(l.width <= 402 && l.height <= 362);
    assert.ok(Math.abs(l.y - (h.header.getBounds().y + 47 + 8)) <= 2);
});

