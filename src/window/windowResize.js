const { getWindowSizeLimits, restoreWindowSizeLimits, reconcileRejectedSize, getSizingPolicy } = require('./windowBounds');

// Resolve only after native application or cancellation; no raw errors cross IPC.
function animateResize(win, target, movement, afterResize, requestedHeight, requestedWidth) {
    if (!win || win.isDestroyed()) return Promise.resolve({ applied: false, height: null });
    if (getSizingPolicy(win)?.state().owner === 'user') return Promise.resolve({ applied: false, height: win.getBounds().height, reason: 'user_owned' });
    movement.cancelWindowAnimation(win);
    getWindowSizeLimits(win);
    const wasResizable = win.isResizable();
    return new Promise(resolve => {
        let finished = false;
        const onClosed = () => movement.cancelWindowAnimation(win);
        const settle = complete => {
            if (finished) return;
            finished = true;
            win.removeListener('closed', onClosed);
            let height = null, applied = false;
            try {
                if (!win.isDestroyed()) {
                    if (!wasResizable) win.setResizable(false);
                    const actual = win.getBounds();
                    height = actual.height;
                    // Width rejection must reconcile the cache even if height succeeded.
                    // Two DIP allows the existing fractional-scale rounding without drag growth.
                    applied = complete && Math.abs(height - requestedHeight) <= 2
                        && (requestedWidth === undefined || Math.abs(actual.width - requestedWidth) <= 2);
                    if (!applied) reconcileRejectedSize(win);
                    if (complete) afterResize();
                }
            } catch { applied = false; }
            resolve({ applied, height });
        };
        win.once('closed', onClosed);
        try {
            if (!wasResizable) win.setResizable(true);
            if (!getSizingPolicy(win)) restoreWindowSizeLimits(win);
            const bounds = target();
            movement.animateWindowBounds(win, bounds, {
                onComplete: () => settle(true), onCancel: () => settle(false)
            });
        } catch { settle(false); }
    });
}
module.exports = { animateResize };
