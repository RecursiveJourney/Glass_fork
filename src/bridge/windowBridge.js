// src/bridge/windowBridge.js
const { ipcMain, shell, app } = require('electron');
const { getSizingPolicy } = require('../window/windowBounds');

// Bridge는 단순히 IPC 핸들러를 등록하는 역할만 함 (비즈니스 로직 없음)
module.exports = {
  initialize() {
    // initialize 시점에 windowManager를 require하여 circular dependency 문제 해결
    const windowManager = require('../window/windowManager');
    const sizing = reset => (event, payload) => {
      if (payload !== undefined) return { success: false, error: 'invalid_payload' };
      try {
        const entry = [...windowManager.windowPool].find(([name, win]) => ['listen','ask','settings'].includes(name) && win.webContents === event.sender);
        const url = new URL(event.sender.getURL());
        const pathname = decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\\/g, '/').toLowerCase();
        const root = app.getAppPath().replace(/\\/g, '/').toLowerCase();
        if (!entry || entry[1].isDestroyed() || event.senderFrame !== event.sender.mainFrame || url.protocol !== 'file:' || !pathname.startsWith(root + '/src/ui/')) return { success: false, error: 'untrusted_sender' };
        const policy = getSizingPolicy(entry[1]);
        if (!policy) return { success: false, error: 'sizing_unavailable' };
        const data = reset ? policy.reset() : policy.state();
        return { success: !data.error && !data.persistenceError, data, ...(data.error ? { error: data.error } : {}) };
      } catch { return { success: false, error: 'sizing_unavailable' }; }
    };
    ipcMain.handle('window:sizing-get', sizing(false));
    ipcMain.handle('window:sizing-reset', sizing(true));
    ipcMain.on('settings:toggle-pin', (event, payload) => {
      if (payload !== undefined) return;
      try {
        const header = windowManager.windowPool.get('header');
        if (!header || header.isDestroyed() || header.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) return;
        const url = new URL(event.sender.getURL());
        const pathname = decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\\/g, '/').toLowerCase();
        const root = app.getAppPath().replace(/\\/g, '/').toLowerCase();
        if (url.protocol !== 'file:' || !pathname.startsWith(root + '/src/ui/')) return;
        windowManager.toggleSettingsPinned();
      } catch { /* Ignore stale or untrusted renderers. */ }
    });
    
    // 기존 IPC 핸들러들
    ipcMain.handle('toggle-content-protection', () => windowManager.toggleContentProtection());
    ipcMain.handle('resize-header-window', (event, args) => windowManager.resizeHeaderWindow(args));
    ipcMain.handle('get-content-protection-status', () => windowManager.getContentProtectionStatus());
    ipcMain.on('show-settings-window', () => windowManager.showSettingsWindow());
    ipcMain.on('hide-settings-window', () => windowManager.hideSettingsWindow());
    ipcMain.on('cancel-hide-settings-window', () => windowManager.cancelHideSettingsWindow());

    ipcMain.handle('open-login-page', () => windowManager.openLoginPage());
    ipcMain.handle('open-personalize-page', () => windowManager.openLoginPage());
    ipcMain.handle('move-window-step', (event, direction) => windowManager.moveWindowStep(direction));
    ipcMain.handle('open-external', (event, url) => shell.openExternal(url));

    // Newly moved handlers from windowManager
    ipcMain.on('header-state-changed', (event, state) => windowManager.handleHeaderStateChanged(state));
    ipcMain.on('header-animation-finished', (event, state) => windowManager.handleHeaderAnimationFinished(state));
    ipcMain.handle('get-header-position', () => windowManager.getHeaderPosition());
    ipcMain.handle('move-header-to', (event, newX, newY) => windowManager.moveHeaderTo(newX, newY));
    ipcMain.handle('adjust-window-height', (event, { winName, height }) => windowManager.adjustWindowHeight(winName, height));
  },

  notifyFocusChange(win, isFocused) {
    win.webContents.send('window:focus-change', isFocused);
  }
};
