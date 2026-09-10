// Electron can report bounds 1-2 DIP larger than requested at fractional Windows
// scaling. Reusing those dimensions in every move grows the window indefinitely.
// Keep app-requested sizes; continue reading actual positions for native dragging.
const requestedSizes = new WeakMap();

function getWindowBounds(win) {
    const actual = win.getBounds();
    if (!requestedSizes.has(win)) {
        requestedSizes.set(win, { width: actual.width, height: actual.height });
    }
    return { ...actual, ...requestedSizes.get(win) };
}

function setWindowBounds(win, bounds) {
    const next = { ...getWindowBounds(win), ...bounds };
    // Store before native calls: resize/move events may run layout synchronously.
    requestedSizes.set(win, { width: next.width, height: next.height });
    win.setBounds(next);
}

module.exports = { getWindowBounds, setWindowBounds };

