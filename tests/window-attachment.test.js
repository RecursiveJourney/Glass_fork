const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ rounding = 0, deferNativeEvents = false, nativeLimits = false } = {}) {
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
            this.nativeMin = [options.minWidth || 0, options.minHeight || 0];
            this.nativeMax = [options.maxWidth || 0, options.maxHeight || 0];
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
        setResizable(value) { this.resizable = value; if (nativeLimits) { this.nativeMin = value ? [0,0] : [this.bounds.width,this.bounds.height]; this.nativeMax = [...this.nativeMin]; } }
        getMinimumSize() { return nativeLimits ? this.nativeMin : [this.options.minWidth || 0, this.options.minHeight || 0]; }
        getMaximumSize() { return nativeLimits ? this.nativeMax : [this.options.maxWidth || 0, this.options.maxHeight || 0]; }
        setMinimumSize(width, height) { this.options.minWidth = width; this.options.minHeight = height; this.nativeMin = [width,height]; }
        setMaximumSize(width, height) { this.options.maxWidth = width; this.options.maxHeight = height; this.nativeMax = [width,height]; }
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

// ListenView measures the complete meeting container. Its fixed transcript and
// suggestions panes are 280px and 200px (SttView/SuggestionsView CSS). Use 600px
// as a safe measured fixture including headings/chrome, not a DOM measurement;
// 700px is ListenView's actual cap. Browser layout is covered separately.
const MEETING_HEIGHT = 600;
const MEETING_MAX_HEIGHT = 700;

function meetingHarness(options) {
    const h = harness(options);
    // HeaderController._resizeForMain requests this size for the source controls.
    h.api.resizeHeaderWindow({ width: 445, height: 47 });
    h.advance(600);
    h.api.adjustWindowHeight('listen', MEETING_HEIGHT);
    h.advance(600);
    return h;
}

function listenViewHarness(h) {
    const requests = [], errors = [];
    let measuredHeight = MEETING_HEIGHT;
    const filename = path.join(__dirname, '../src/ui/listen/ListenView.js');
    // Keep real ListenView state/resize methods. Lit, child rendering, and DOM
    // measurements are stubbed; this VM does not verify browser pane layout.
    const source = fs.readFileSync(filename, 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace('export class ListenView', 'class ListenView');
    let ListenView;
    vm.runInNewContext(source, {
        LitElement: class { updated() {} },
        css: String.raw, html: String.raw,
        customElements: { define(name, component) { ListenView = component; } },
        window: { api: { listenView: { adjustWindowHeight(name, height) {
            requests.push({ name, height });
            h.api.adjustWindowHeight(name, height);
            return Promise.resolve({ applied: true, height });
        } } } },
        setInterval: () => 1, clearInterval() {},
        console: { log() {}, error(error) { errors.push(String(error)); } },
    }, { filename });
    const view = new ListenView();
    view.updateComplete = Promise.resolve();
    view.isConnected = true;
    view.shadowRoot = { querySelector(selector) {
        if (selector === '.assistant-container') return { getBoundingClientRect: () => ({ height: measuredHeight }) };
        if (selector === '.top-bar') return { offsetHeight: 40 };
        if (selector === 'summary-view') return { scrollHeight: 140, resetAnalysis() {} };
        if (selector === 'stt-view') return { scrollHeight: 320, resetTranscript() {} };
        return null;
    } };
    return { view, requests, async update(state, height = MEETING_HEIGHT) {
        measuredHeight = height;
        view.applyListenState(state);
        view.updated(new Map([['listenState', null]]));
        await view.updateComplete;
        await Promise.resolve();
        assert.deepEqual(errors, [], 'resize callbacks must not swallow an error');
    } };
}

function meetingFeedFixture(version, connectionStatus = 'connected') {
    return {
        connectionStatus, error: null,
        nextRetryAt: connectionStatus === 'reconnecting' ? Date.parse('2026-09-14T10:00:00.500Z') : null,
        snapshot: {
            instanceId: 'window-fixture', transcriptId: 'meeting-fixture',
            sequence: version, revision: version, suggestionHistoryLimit: 20,
            connectionState: 'connected', availability: 'available', ageMs: 0,
            chunks: [{ chunk_id: '1', speaker_name: 'Speaker', text: 'Stream '.repeat(version),
                start_time: 1, end_time: 2 }],
            suggestions: [{ attemptId: `completed-${version}`, revision: version,
                text: 'Suggestion '.repeat(version), noSuggestion: false,
                completedAt: '2026-09-14T10:00:00.000Z' }],
            generation: version % 3 ? { state: 'running', attemptId: `pending-${version}`,
                revision: version, startedAt: '2026-09-14T10:00:01.000Z' } : { state: 'idle' },
        },
    };
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

test('meeting container attaches to the 445x47 source-control header', () => {
    const h = meetingHarness();
    h.api.moveHeaderTo(650, 80);
    assert.deepEqual(h.header.getBounds(), { x: 650, y: 80, width: 445, height: 47 });
    assert.equal(h.listen.getBounds().width, 400);
    assert.equal(h.listen.getBounds().height, MEETING_HEIGHT);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    assert.equal(h.listen.isResizable(), false);
});

test('meeting stream/status updates with equal measurements do not restart resizing', async () => {
    const h = meetingHarness();
    const renderer = listenViewHarness(h);
    h.api.moveHeaderTo(650, 80);
    for (let version = 1; version <= 100; version++) {
        await renderer.update({ source: 'meeting', lifecycleId: 1, version, phase: 'active', error: null,
            feed: meetingFeedFixture(version, version % 2 ? 'connected' : 'reconnecting') });
        assert.equal(renderer.view.meetingStatus(), version % 2 ? 'Live' : 'Reconnecting…');
        h.api.moveHeaderTo(650 + version, 80);
        h.advance(10);
    }
    h.advance(600);
    assert.deepEqual(renderer.requests, [{ name: 'listen', height: MEETING_HEIGHT }]);
    assert.match(renderer.view.render(), /aria-label="Transcript"[\s\S]*<stt-view[\s\S]*aria-label="Suggestions"[\s\S]*<suggestions-view/,
        'streaming keeps both panes in the meeting template');
    assert.equal(h.listen.getBounds().height, MEETING_HEIGHT);
    assert.equal(h.listen.isResizable(), false);
    below(h.header, h.listen);
    centered(h.header, h.listen);
    assert.equal(h.timers.size, 0, 'stream updates must leave no stale resize animations');
});

test('meeting measurement rounds upward and caps status/error chrome at 700px', async () => {
    const h = meetingHarness();
    const renderer = listenViewHarness(h);
    const state = { source: 'meeting', lifecycleId: 1, phase: 'active' };
    await renderer.update({ ...state, version: 1 }, 600.25);
    h.advance(600);
    assert.equal(h.listen.getBounds().height, 601);
    await renderer.update({ ...state, version: 2, error: 'Synthetic status' }, 850);
    h.advance(600);
    assert.deepEqual(renderer.requests.map(request => request.height), [601, MEETING_MAX_HEIGHT]);
    assert.equal(h.listen.getBounds().height, MEETING_MAX_HEIGHT);
});

for (const rounding of [0, 2]) {
    test(`meeting drag and below/above destination-monitor transitions stay bounded (rounding ${rounding} DIP)`, () => {
        const h = meetingHarness({ rounding, deferNativeEvents: rounding > 0 });
        h.header.emitMoves = false;
        for (let i = 0; i < 80; i++) {
            const above = i % 2 === 0;
            const onLeftDisplay = i % 4 < 2;
            const height = i % 3 ? MEETING_HEIGHT : MEETING_MAX_HEIGHT;
            h.api.adjustWindowHeight('listen', height);
            h.advance(40);
            h.api.moveHeaderTo(onLeftDisplay ? -1200 : 650, above ? 1000 : 80);
            h.header.emit('moved');
            h.advance(600);
            const header = h.header.getBounds(), listen = h.listen.getBounds();
            assert.equal(header.width, 445 + rounding);
            assert.equal(header.height, 47 + rounding);
            assert.equal(listen.width, 400 + rounding);
            assert.equal(listen.height, height + rounding);
            assert.ok(Math.abs(listen.x + listen.width / 2 - (header.x + header.width / 2)) <= 0.5);
            const gap = above ? header.y - (listen.y + listen.height) : listen.y - (header.y + header.height);
            assert.ok(Math.abs(gap - 8) <= rounding, 'attachment gap tolerates only native rounding');
            const origin = onLeftDisplay ? -1920 : 0;
            assert.ok(listen.x >= origin && listen.x + listen.width <= origin + 1920);
            assert.ok(listen.y >= 0 && listen.y + listen.height <= 1080);
            assert.equal(h.listen.isResizable(), false);
        }
        const settled = h.listen.getBounds();
        h.advance(1000);
        assert.deepEqual(h.listen.getBounds(), settled, 'old animation must not restore earlier bounds');
        assert.equal(h.timers.size, 0);
    });
}

test('meeting and Ask keep independent heights side by side across monitors and edges', () => {
    const h = meetingHarness({ rounding: 2, deferNativeEvents: true });
    h.ask.show();
    h.api.adjustWindowHeight('ask', 180);
    h.advance(600);
    for (const [x, y] of [[0, 80], [1550, 80], [-1910, 1000], [-500, 80]]) {
        h.api.adjustWindowHeight('listen', MEETING_MAX_HEIGHT);
        h.advance(40);
        h.api.moveHeaderTo(x, y);
        h.advance(600);
        const header = h.header.getBounds(), listen = h.listen.getBounds(), ask = h.ask.getBounds();
        assert.equal(ask.height, 182, 'meeting updates must not resize Ask');
        assert.equal(ask.width, 602);
        assert.equal(listen.height, 702);
        assert.equal(listen.width, 402);
        assert.equal(ask.x - (listen.x + 400), 8, 'placement uses requested widths, not inflated native widths');
        if (y === 1000) {
            assert.equal(listen.y + listen.height, ask.y + ask.height);
            assert.equal(header.y - (listen.y + listen.height), 6);
        } else {
            assert.equal(listen.y, ask.y);
            assert.equal(listen.y - (header.y + 47), 8);
        }
        const origin = x < 0 ? -1920 : 0;
        assert.ok(listen.x >= origin && ask.x + ask.width <= origin + 1920);
    }
    h.api.adjustWindowHeight('ask', 260);
    h.advance(600);
    assert.equal(h.ask.getBounds().height, 262);
    assert.equal(h.listen.getBounds().height, 702, 'Ask growth must not resize meeting panes');
});

test('Stop retains meeting geometry and switching to local resizes from local content', async () => {
    const h = meetingHarness();
    const renderer = listenViewHarness(h);
    h.api.moveHeaderTo(650, 80);
    const feed = meetingFeedFixture(3);
    await renderer.update({ source: 'meeting', lifecycleId: 1, version: 1, phase: 'active', error: null, feed });
    h.advance(600);
    const active = h.listen.getBounds();
    await renderer.update({ source: 'meeting', lifecycleId: 2, version: 2, phase: 'stopping', error: null, feed });
    h.advance(600);
    assert.deepEqual(h.listen.getBounds(), active, 'stopping must retain the populated meeting layout');
    assert.equal(renderer.view.isSessionActive, true);
    await renderer.update({ source: 'meeting', lifecycleId: 2, version: 3, phase: 'stopped', error: null,
        feed: { ...feed, connectionStatus: 'stopped' } });
    h.advance(600);
    assert.deepEqual(h.listen.getBounds(), active);
    assert.equal(renderer.requests.length, 1, 'Stop must retain the meeting measurement');
    assert.equal(renderer.view.hasCompletedRecording, true);
    assert.equal(renderer.view.isSessionActive, false);
    assert.equal(renderer.view.meetingStatus(), 'Stopped');
    assert.deepEqual(renderer.view.listenState.feed.snapshot, feed.snapshot, 'Stop retains transcript and completed suggestions');
    assert.match(renderer.view.render(), /meeting-layout[\s\S]*<stt-view[\s\S]*<suggestions-view/,
        'stopped meeting keeps both panes instead of switching to local content');
    // Selecting the local source preserves the stopped phase and lifecycle ID.
    await renderer.update({ source: 'local', lifecycleId: 2, version: 4, phase: 'stopped', error: null, feed: null });
    h.advance(600);
    assert.deepEqual(renderer.requests.map(request => request.height), [MEETING_HEIGHT, 180]);
    assert.equal(h.listen.getBounds().height, 180, 'local insights use top bar plus local content');
    renderer.view.viewMode = 'transcript';
    await renderer.update({ source: 'local', lifecycleId: 2, version: 5, phase: 'stopped', error: null, feed: null });
    h.advance(600);
    assert.equal(h.listen.getBounds().height, 360, 'local transcript uses its own content height');
    below(h.header, h.listen);
    centered(h.header, h.listen);
    assert.equal(h.listen.isResizable(), false);
});


test('native-style locked min/max cannot replace intended limits', async () => {
    const h = harness({ rounding: 1, nativeLimits: true });
    let result = h.api.adjustWindowHeight('listen', 223); h.advance(600);
    assert.equal((await result).applied, true);
    assert.equal(h.listen.getMaximumSize()[1], 224);
    result = h.api.adjustWindowHeight('listen', 614); h.advance(600);
    assert.equal((await result).applied, true);
    assert.equal(h.listen.getBounds().height, 615);
    assert.equal(h.listen.isResizable(), false);
    result = h.api.adjustWindowHeight('listen', 1000); h.advance(600);
    assert.equal((await result).applied, false);
    assert.equal(h.listen.getBounds().height, 901);
});
test('drag during resize settles applied acknowledgement and restores the resize lock', async () => {
    const h = harness({ nativeLimits: true });
    const result = h.api.adjustWindowHeight('listen', 614); h.advance(40);
    h.api.moveHeaderTo(650, 80); h.advance(600);
    assert.equal((await result).applied, true);
    assert.equal(h.listen.getBounds().height, 614);
    assert.equal(h.listen.isResizable(), false);
});
test('a superseded resize settles false and the latest request owns the lock', async () => {
    const h = harness({ nativeLimits: true });
    const first = h.api.adjustWindowHeight('listen', 614); h.advance(40);
    const second = h.api.adjustWindowHeight('listen', 580); h.advance(600);
    assert.equal((await first).applied, false);
    assert.equal((await second).applied, true);
    assert.equal(h.listen.getBounds().height, 580);
    assert.equal(h.listen.isResizable(), false);
});
test('native rejection is reported using actual bounds, not requested-size bookkeeping', async () => {
    const h = harness();
    const native = h.listen.setBounds.bind(h.listen);
    h.listen.setBounds = bounds => native({ ...bounds, height: 225 });
    const result = h.api.adjustWindowHeight('listen', 614); h.advance(600);
    const ack = await result;
    assert.equal(ack.applied, false); assert.equal(ack.height, 225);
    assert.equal(h.listen.isResizable(), false);
    assert.equal(h.load('windowBounds').getWindowBounds(h.listen).height, 225);
});
test('native setter failure settles the IPC response and restores the lock', async () => {
    const h = harness();
    h.listen.setBounds = () => { throw Error('synthetic native failure'); };
    const result = h.api.adjustWindowHeight('listen', 614); h.advance(600);
    assert.equal((await result).applied, false);
    assert.equal(h.listen.isResizable(), false);
    assert.equal(h.timers.size, 0);
});
test('missing windows and invalid sizes return a failed acknowledgement', async () => {
    const h = harness();
    assert.equal((await h.api.adjustWindowHeight('absent', 614)).applied, false);
    assert.equal((await h.api.adjustWindowHeight('listen', NaN)).applied, false);
});

test('header resize during another window animation must not disappear', async()=>{
 const h=harness({nativeLimits:true});
 h.api.adjustWindowHeight('listen',600);
 const result=h.api.resizeHeaderWindow({width:520,height:47});
 h.advance(1200);
 assert.equal(h.header.getBounds().width,520,'added controls require resize even while Listen animates');
 await result;
});
test('normal Settings window is reachable without local providers and survives source-independent show/hide',()=>{
 const h=harness();
 const settings=h.api.windowPool.get('settings');
 h.api.showSettingsWindow();assert.equal(settings.isVisible(),true);
 h.api.hideSettingsWindow();h.advance(100);h.api.cancelHideSettingsWindow();h.advance(300);
 assert.equal(settings.isVisible(),true,'entering Settings cancels header hover hide');
 h.api.hideSettingsWindow();h.advance(300);assert.equal(settings.isVisible(),false);
});

test('a rejected header width is reconciled even when the requested height applies',async()=>{
 const h=harness();const native=h.header.setBounds.bind(h.header);
 h.header.setBounds=bounds=>native({...bounds,width:357});
 const pending=h.api.resizeHeaderWindow({width:462,height:47});h.advance(600);
 const ack=await pending;assert.equal(ack.applied,false);assert.equal(ack.width,357);
 assert.equal(h.load('windowBounds').getWindowBounds(h.header).width,357,'rejected requested width must not survive in layout cache');
 h.header.setBounds=native;
 const retry=h.api.resizeHeaderWindow({width:462,height:47});h.advance(600);
 assert.equal((await retry).applied,true);assert.equal(h.header.getBounds().width,462);
});

function overlaps(a,b) { return a.x<b.x+b.width && b.x<a.x+a.width && a.y<b.y+b.height && b.y<a.y+a.height; }
test('Meeting Settings avoids Listen and Ask at screen edges and follows layout changes',()=>{
 const h=meetingHarness({rounding:2});
 h.bridge.emit('listen:source-changed',{source:'meeting'});
 h.api.showSettingsWindow();h.advance(600);
 const settings=h.api.windowPool.get('settings');
 const clear=()=>{
   assert.ok(!overlaps(settings.getBounds(),h.listen.getBounds()),'Settings overlaps meeting transcript');
   if(h.ask.isVisible())assert.ok(!overlaps(settings.getBounds(),h.ask.getBounds()),'Settings overlaps Ask');
 };
 clear();
 h.api.adjustWindowHeight('listen',700);h.advance(600);clear();
 h.bridge.emit('window:requestVisibility',{name:'ask',visible:true});h.advance(600);clear();
 for(const [x,y] of [[20,30],[1450,800],[-1800,30],[-500,800]]){
   h.api.moveHeaderTo(x,y);h.advance(600);clear();
   const s=settings.getBounds(),origin=x<0?-1920:0;
   assert.ok(s.x>=origin&&s.x+s.width<=origin+1920,'Settings stays on the current display');
 }
});
test('Local Settings retains its shipped placement formula',()=>{
 const h=meetingHarness();
 const b=h.load('windowBounds').getWindowBounds(h.header);
 const settings=h.api.windowPool.get('settings'),s=h.load('windowBounds').getWindowBounds(settings);
 const expected={x:Math.round(Math.max(10,Math.min(1920-s.width-10,b.x+b.width-s.width+170))),y:Math.round(Math.max(10,Math.min(1080-s.height-10,b.y+b.height+5)))};
 h.api.showSettingsWindow();assert.equal(settings.getBounds().x,expected.x);assert.equal(settings.getBounds().y,expected.y);
 h.bridge.emit('listen:source-changed',{source:'meeting'});
 h.bridge.emit('listen:source-changed',{source:'local'});
 assert.equal(settings.getBounds().x,expected.x);assert.equal(settings.getBounds().y,expected.y);
});
