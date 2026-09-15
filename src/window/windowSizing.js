const { registerSizingPolicy, getWindowBounds, setWindowBounds, adoptUserBounds } = require('./windowBounds');

function attachWindowSizing(win, { name, defaults, min, store, workArea, cancel, changed = () => {} }) {
    const saved = store.get(name);
    let owner = saved?.owner || 'automatic',
        preferred = saved?.owner === 'user' ? { width: saved.width, height: saved.height } : null;
    let dragging = false,
        persistenceError = store.error || null;
    let limits;
    const state = () => ({ name, owner, dragging, persistenceError });
    const notify = () => {
        if (!win.isDestroyed()) win.webContents.send('window:sizing-changed', state());
        changed(state());
    };
    function persist(value) {
        try {
            store.set(name, value);
            persistenceError = null;
        } catch {
            persistenceError = store.error || 'size_write_failed';
        }
    }
    function project(bounds) {
        if (dragging) return null;
        const area = workArea(bounds);
        // The target display can differ from the display used at creation/reopen.
        // Memoize before native calls, whose resize events can synchronously relayout.
        if (!limits || limits.width !== area.width || limits.height !== area.height) {
            limits = { width: area.width, height: area.height };
            win.setMinimumSize(Math.min(min[0], area.width), Math.min(min[1], area.height));
            win.setMaximumSize(area.width, area.height);
        }
        const dimensions = owner === 'user' ? preferred : bounds;
        const width = Math.min(area.width, Math.max(min[0], dimensions.width));
        const height = Math.min(area.height, Math.max(min[1], dimensions.height));
        return {
            x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
            y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
            width,
            height,
        };
    }
    function restore() {
        if (win.isDestroyed() || dragging) return;
        setWindowBounds(win, getWindowBounds(win));
    }
    function finish() {
        if (!dragging || win.isDestroyed()) return;
        adoptUserBounds(win);
        const { width, height } = getWindowBounds(win);
        preferred = { width, height };
        dragging = false;
        persist({ owner: 'user', ...preferred });
        notify();
    }
    win.on('will-resize', () => {
        if (dragging) return;
        dragging = true;
        owner = 'user';
        // Do not finish the cancelled animation's target size over the pointer drag.
        cancel();
        notify();
    });
    win.on('resized', finish);
    win.on('hide', finish);
    win.on('close', finish);
    const policy = {
        state,
        project,
        restore,
        reset() {
            if (dragging) return { ...state(), error: 'resize_in_progress' };
            persist({ owner: 'automatic' });
            if (persistenceError) {
                notify();
                return state();
            }
            owner = 'automatic';
            preferred = null;
            cancel();
            setWindowBounds(win, { ...getWindowBounds(win), ...defaults });
            notify();
            return state();
        },
    };
    registerSizingPolicy(win, policy);
    restore();
    return policy;
}
module.exports = { attachWindowSizing };
