const { getWindowBounds, setWindowBounds } = require('./windowBounds');
const { screen } = require('electron');

class SmoothMovementManager {
    constructor(windowPool) {
        this.windowPool = windowPool;
        this.stepSize = 80;
        this.animationDuration = 300;
        this.headerPosition = { x: 0, y: 0 };
        this.isAnimating = false;
        this.hiddenPosition = null;
        this.lastVisiblePosition = null;
        this.currentDisplayId = null;
        this.animationFrameId = null;

        this.animationTimers = new Map();
        this.animationTargets = new Map();
    }

    /**
     * @param {BrowserWindow} win
     * @returns {boolean}
     */
    _isWindowValid(win) {
        if (!win || win.isDestroyed()) {
            // 해당 창의 타이머가 있으면 정리
            this.cancelWindowAnimation(win);
            return false;
        }
        return true;
    }

    /**
     * 
     * @param {BrowserWindow} win
     * @param {number} targetX
     * @param {number} targetY
     * @param {object} [options]
     * @param {object} [options.sizeOverride]
     * @param {function} [options.onComplete]
     * @param {number} [options.duration]
     */
    animateWindow(win, targetX, targetY, options = {}) {
        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }

        const { sizeOverride, onComplete, duration: animDuration } = options;
        const start = getWindowBounds(win);
        const startTime = Date.now();
        const duration = animDuration || this.animationDuration;
        const { width, height } = sizeOverride || start;

        const step = () => {
            if (!this._isWindowValid(win)) {
                if (onComplete) onComplete();
                return;
            }

            const p = Math.min((Date.now() - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
            const x = start.x + (targetX - start.x) * eased;
            const y = start.y + (targetY - start.y) * eased;

            setWindowBounds(win, { x: Math.round(x), y: Math.round(y), width, height });

            if (p < 1) {
                setTimeout(step, 8);
            } else {
                this.layoutManager.updateLayout();
                if (onComplete) {
                    onComplete();
                }
            }
        };
        step();
    }

    fade(win, { from, to, duration = 250, onComplete }) {
        if (!this._isWindowValid(win)) {
          if (onComplete) onComplete();
          return;
        }
        const startOpacity = from ?? win.getOpacity();
        const startTime = Date.now();
        
        const step = () => {
            if (!this._isWindowValid(win)) {
                if (onComplete) onComplete(); return;
            }
            const progress = Math.min(1, (Date.now() - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            win.setOpacity(startOpacity + (to - startOpacity) * eased);
    
            if (progress < 1) {
                setTimeout(step, 8);
            } else {
                win.setOpacity(to);
                if (onComplete) onComplete();
            }
        };
        step();
    }
    
    // A direct drag/layout supersedes old positions; optionally finish a pending resize.
    cancelWindowAnimation(win, finishSize = false) {
        const animation = this.animationTargets.get(win);
        clearTimeout(this.animationTimers.get(win));
        this.animationTimers.delete(win);
        this.animationTargets.delete(win);
        this.isAnimating = this.animationTargets.size > 0;
        if (finishSize && animation && win && !win.isDestroyed()) {
            const current = getWindowBounds(win);
            setWindowBounds(win, { ...current,
                width: animation.targetBounds.width ?? current.width,
                height: animation.targetBounds.height ?? current.height });
            // Restore temporary resize state before the caller calculates the new layout.
            if (animation.onComplete) animation.onComplete();
        }
    }

    animateWindowBounds(win, targetBounds, options = {}) {
        this.cancelWindowAnimation(win);

        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }

        const animation = { targetBounds, onComplete: options.onComplete };
        this.animationTargets.set(win, animation);
        this.isAnimating = true;

        const startBounds = getWindowBounds(win);
        const startTime = Date.now();
        const duration = options.duration || this.animationDuration;
    
        const step = () => {
            if (this.animationTargets.get(win) !== animation) return;
            if (!this._isWindowValid(win)) {
                if (options.onComplete) options.onComplete();
                return;
            }
            
            const progress = Math.min(1, (Date.now() - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
    
            const newBounds = {
                x: Math.round(startBounds.x + (targetBounds.x - startBounds.x) * eased),
                y: Math.round(startBounds.y + (targetBounds.y - startBounds.y) * eased),
                width: Math.round(startBounds.width + ((targetBounds.width ?? startBounds.width) - startBounds.width) * eased),
                height: Math.round(startBounds.height + ((targetBounds.height ?? startBounds.height) - startBounds.height) * eased),
            };
            setWindowBounds(win, newBounds);
            // Native move/resize handlers may have canceled this animation synchronously.
            if (this.animationTargets.get(win) !== animation) return;
    
            if (progress < 1) {
                const timerId = setTimeout(step, 8);
                this.animationTimers.set(win, timerId);
            } else {
                setWindowBounds(win, targetBounds);
                this.animationTimers.delete(win);
                this.animationTargets.delete(win);
                
                if (this.animationTargets.size === 0) {
                    this.isAnimating = false;
                }
                
                if (options.onComplete) options.onComplete();
            }
        };
        step();
    }
    
    animateWindowPosition(win, targetPosition, options = {}) {
        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }
        const currentBounds = getWindowBounds(win);
        const targetBounds = { ...currentBounds, ...targetPosition };
        this.animateWindowBounds(win, targetBounds, options);
    }
    
    animateLayout(layout, animated = true) {
        if (!layout) return;
        for (const winName in layout) {
            const win = this.windowPool.get(winName);
            const targetBounds = layout[winName];
            if (win && !win.isDestroyed() && targetBounds) {
                if (animated) {
                    this.animateWindowBounds(win, targetBounds);
                } else {
                    this.cancelWindowAnimation(win);
                    setWindowBounds(win, targetBounds);
                }
            }
        }
    }

    destroy() {
        if (this.animationFrameId) {
            clearTimeout(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.isAnimating = false;
        console.log('[Movement] Manager destroyed');
    }
}

module.exports = SmoothMovementManager;
