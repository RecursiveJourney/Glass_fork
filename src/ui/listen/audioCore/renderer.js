// renderer.js
const listenCapture = require('./listenCapture.js');
const params        = new URLSearchParams(window.location.search);
const isListenView  = params.get('view') === 'listen';


window.pickleGlass = {
    startCapture: listenCapture.startCapture,
    stopCapture: listenCapture.stopCapture,
    isLinux: listenCapture.isLinux,
    isMacOS: listenCapture.isMacOS,
    captureManualScreenshot: listenCapture.captureManualScreenshot,
    getCurrentScreenshot: listenCapture.getCurrentScreenshot,
};


let captureQueue = Promise.resolve();
let latestLifecycle = -1;
window.api.renderer.onChangeListenCaptureState((_event, { status, lifecycleId }) => {
    if (!isListenView) {
        console.log('[Renderer] Non-listen view: ignoring capture-state change');
        return;
    }
    if (!Number.isSafeInteger(lifecycleId) || !['start','stop'].includes(status)) return;
    latestLifecycle = Math.max(latestLifecycle, lifecycleId);
    captureQueue = captureQueue.then(async () => {
        let success = false;
        try {
            if (lifecycleId === latestLifecycle) {
                if (status === 'stop') { await listenCapture.stopCapture(); success = true; }
                else {
                    success = await listenCapture.startCapture() !== false;
                    if (lifecycleId !== latestLifecycle || !success) { success = false; await listenCapture.stopCapture(); }
                }
            }
        } catch {
            success = false;
            if (status === 'start') { try { await listenCapture.stopCapture(); } catch { /* Ack remains failed. */ } }
        }
        try { await window.api.listen.ackCapture({ status, lifecycleId, success }); } catch { /* Main timeout handles a lost acknowledgement. */ }
    });
});
