// Electron can report bounds 1-2 DIP larger than requested at fractional Windows
// scaling. Reusing those dimensions in every move grows the window indefinitely.
// Keep app-requested sizes; continue reading actual positions for native dragging.
const requestedSizes = new WeakMap();
const sizeLimits = new WeakMap();
const sizingPolicies = new WeakMap();
function registerSizingPolicy(win, policy) { sizingPolicies.set(win, policy); }
function getSizingPolicy(win) { return sizingPolicies.get(win); }
function adoptUserBounds(win) {
    const { width, height } = win.getBounds();
    requestedSizes.set(win, { width, height });
}

function getWindowBounds(win) {
    const actual = win.getBounds();
    getWindowSizeLimits(win);
    if (!requestedSizes.has(win)) {
        requestedSizes.set(win, { width: actual.width, height: actual.height });
    }
    return { ...actual, ...requestedSizes.get(win) };
}

function setWindowBounds(win, bounds) {
    let next = { ...getWindowBounds(win), ...bounds };
    const policy = sizingPolicies.get(win);
    if (policy) next = policy.project(next);
    if (!next) return;
    // Store before native calls: resize/move events may run layout synchronously.
    requestedSizes.set(win, { width: next.width, height: next.height });
    win.setBounds(next);
}

// Register construction intent: a window created resizable:false is already pinned
// when getMinimumSize/getMaximumSize are first queried on Windows.
function registerWindowSizeLimits(win, options) {
    sizeLimits.set(win, {
        min: [options.minWidth ?? 0, options.minHeight ?? 0],
        max: [options.maxWidth ?? 0, options.maxHeight ?? 0]
    });
}

// Fallback for windows not constructed by the managed window factory.
function getWindowSizeLimits(win) {
    if (!sizeLimits.has(win)) sizeLimits.set(win, {
        min: [...win.getMinimumSize()], max: [...win.getMaximumSize()]
    });
    return sizeLimits.get(win);
}
function restoreWindowSizeLimits(win) {
    const { min, max } = getWindowSizeLimits(win);
    win.setMinimumSize(...min);
    win.setMaximumSize(...max);
}
function reconcileRejectedSize(win) {
    const { width, height } = win.getBounds();
    const prior = requestedSizes.get(win);
    requestedSizes.set(win, {
        width: prior && Math.abs(width - prior.width) <= 2 ? prior.width : width,
        height: prior && Math.abs(height - prior.height) <= 2 ? prior.height : height
    });
}
module.exports = { registerWindowSizeLimits, getWindowBounds, setWindowBounds, getWindowSizeLimits, restoreWindowSizeLimits, reconcileRejectedSize, registerSizingPolicy, getSizingPolicy, adoptUserBounds };

