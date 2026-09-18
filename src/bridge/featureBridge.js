// src/bridge/featureBridge.js
const { ipcMain, app, BrowserWindow } = require('electron');
const settingsService = require('../features/settings/settingsService');
const authService = require('../features/common/services/authService');
const whisperService = require('../features/common/services/whisperService');
const ollamaService = require('../features/common/services/ollamaService');
const modelStateService = require('../features/common/services/modelStateService');
const shortcutsService = require('../features/shortcuts/shortcutsService');
const presetRepository = require('../features/common/repositories/preset');
const localAIManager = require('../features/common/services/localAIManager');
const askService = require('../features/ask/askService');
const listenService = require('../features/listen/listenService');
const permissionService = require('../features/common/services/permissionService');
const encryptionService = require('../features/common/services/encryptionService');

function trustedSettingsSender(event) {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
        const url = new URL(event.sender.getURL());
        const pathname = decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\\/g, '/').toLowerCase();
        const root = app.getAppPath().replace(/\\/g, '/').toLowerCase();
        return url.protocol === 'file:' && pathname.startsWith(root + '/src/ui/');
    } catch { return false; }
}
function credentialHandler(action, mutation = false) {
    return async (event, payload) => {
        if (!trustedSettingsSender(event)) return { success: false, error: 'untrusted_sender' };
        try {
            if (mutation) {
                if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['provider', 'key'].includes(key)) || typeof payload.provider !== 'string' || typeof payload.key !== 'string' || Buffer.byteLength(payload.key, 'utf8') > 8192) return { success: false, error: 'invalid_payload' };
                require('../features/common/services/secretRedactor').registerSecrets([payload.key]);
                if (!Object.hasOwn(modelStateService.getProviderConfig(), payload.provider) || payload.provider === 'openai-glass') return { success: false, error: 'invalid_provider' };
            }
            return await action(payload);
        } catch (error) { return { success: false, error: ['revision_conflict', 'credential_locked', 'vault_unavailable', 'invalid_meeting_link', 'retry_not_available'].includes(error.code) ? error.code : 'credential_operation_failed' }; }
    };
}

module.exports = {
  // Renderer로부터의 요청을 수신하고 서비스로 전달
  initialize() {
    // Settings Service
    ipcMain.handle('settings:getPresets', async () => await settingsService.getPresets());
    ipcMain.handle('settings:get-auto-update', async () => await settingsService.getAutoUpdateSetting());
    ipcMain.handle('settings:set-auto-update', async (event, isEnabled) => await settingsService.setAutoUpdateSetting(isEnabled));  
    ipcMain.handle('settings:get-model-settings', credentialHandler(() => settingsService.getModelSettings()));
    ipcMain.handle('settings:clear-api-key', async (e, { provider }) => await settingsService.clearApiKey(provider));
    ipcMain.handle('settings:set-selected-model', async (e, { type, modelId }) => await settingsService.setSelectedModel(type, modelId));    

    ipcMain.handle('settings:get-ollama-status', async () => await settingsService.getOllamaStatus());
    ipcMain.handle('settings:ensure-ollama-ready', async () => await settingsService.ensureOllamaReady());
    ipcMain.handle('settings:shutdown-ollama', async () => await settingsService.shutdownOllama());

    // Shortcuts
    ipcMain.handle('settings:getCurrentShortcuts', async () => await shortcutsService.loadKeybinds());
    ipcMain.handle('shortcut:getDefaultShortcuts', async () => await shortcutsService.handleRestoreDefaults());
    ipcMain.handle('shortcut:closeShortcutSettingsWindow', async () => await shortcutsService.closeShortcutSettingsWindow());
    ipcMain.handle('shortcut:openShortcutSettingsWindow', async () => await shortcutsService.openShortcutSettingsWindow());
    ipcMain.handle('shortcut:saveShortcuts', async (event, newKeybinds) => await shortcutsService.handleSaveShortcuts(newKeybinds));
    ipcMain.handle('shortcut:toggleAllWindowsVisibility', async () => await shortcutsService.toggleAllWindowsVisibility());

    // Permissions
    ipcMain.handle('check-system-permissions', async () => await permissionService.checkSystemPermissions());
    ipcMain.handle('request-microphone-permission', async () => await permissionService.requestMicrophonePermission());
    ipcMain.handle('open-system-preferences', async (event, section) => await permissionService.openSystemPreferences(section));
    ipcMain.handle('mark-keychain-completed', async () => await permissionService.markKeychainCompleted());
    ipcMain.handle('check-keychain-completed', async () => await permissionService.checkKeychainCompleted());
    ipcMain.handle('initialize-encryption-key', async () => {
        const userId = authService.getCurrentUserId();
        await encryptionService.initializeKey(userId);
        return { success: true };
    });

    // User/Auth
    ipcMain.handle('get-current-user', () => authService.getCurrentUser());
    ipcMain.handle('start-firebase-auth', async () => await authService.startFirebaseAuthFlow());
    ipcMain.handle('firebase-logout', async () => await authService.signOut());

    // App
    ipcMain.handle('quit-application', () => app.quit());

    // Whisper
    ipcMain.handle('whisper:download-model', async (event, modelId) => await whisperService.handleDownloadModel(modelId));
    ipcMain.handle('whisper:get-installed-models', async () => await whisperService.handleGetInstalledModels());
       
    // General
    ipcMain.handle('get-preset-templates', () => presetRepository.getPresetTemplates());
    ipcMain.handle('get-web-url', () => process.env.pickleglass_WEB_URL || 'http://localhost:3000');

    // Ollama
    ipcMain.handle('ollama:get-status', async () => await ollamaService.handleGetStatus());
    ipcMain.handle('ollama:install', async () => await ollamaService.handleInstall());
    ipcMain.handle('ollama:start-service', async () => await ollamaService.handleStartService());
    ipcMain.handle('ollama:ensure-ready', async () => await ollamaService.handleEnsureReady());
    ipcMain.handle('ollama:get-models', async () => await ollamaService.handleGetModels());
    ipcMain.handle('ollama:get-model-suggestions', async () => await ollamaService.handleGetModelSuggestions());
    ipcMain.handle('ollama:pull-model', async (event, modelName) => await ollamaService.handlePullModel(modelName));
    ipcMain.handle('ollama:is-model-installed', async (event, modelName) => await ollamaService.handleIsModelInstalled(modelName));
    ipcMain.handle('ollama:warm-up-model', async (event, modelName) => await ollamaService.handleWarmUpModel(modelName));
    ipcMain.handle('ollama:auto-warm-up', async () => await ollamaService.handleAutoWarmUp());
    ipcMain.handle('ollama:get-warm-up-status', async () => await ollamaService.handleGetWarmUpStatus());
    ipcMain.handle('ollama:shutdown', async (event, force = false) => await ollamaService.handleShutdown(force));

    // Ask
    ipcMain.handle('ask:sendQuestionFromAsk', async (event, userPrompt) => await askService.sendMessage(userPrompt));
    ipcMain.handle('ask:sendQuestionFromSummary', async (event, userPrompt) => await askService.sendMessage(userPrompt));
    ipcMain.handle('ask:toggleAskButton', async () => await askService.toggleAskButton());
    ipcMain.handle('ask:closeAskWindow',  async () => await askService.closeAskWindow());
    
    // Listen
    // Main-process configuration only; renderer arguments are intentionally ignored.
    const meetingAction = action => listenService.getListenState().source === 'meeting'
      ? listenService.handleListenRequest(action) : { success: false, error: 'meeting_source_required' };
    ipcMain.handle('meeting-feed:start', () => meetingAction('Listen'));
    ipcMain.handle('meeting-feed:stop', () => meetingAction('Stop'));
    ipcMain.handle('meeting-feed:get-state', () => listenService.getMeetingFeedState());
    ipcMain.handle('listen:get-state', () => listenService.getListenState());
    ipcMain.handle('listen:get-capabilities', () => listenService.getListenCapabilities());
    ipcMain.handle('listen:select-source', (_event, source) => listenService.selectSource(source));
    ipcMain.handle('listen:capture-ack', (event, data) => listenService.acknowledgeCapture(data, event.sender));
    ipcMain.handle('listen:sendMicAudio', async (event, { data, mimeType }) => await listenService.handleSendMicAudioContent(data, mimeType));
    ipcMain.handle('listen:sendSystemAudio', async (event, { data, mimeType }) => {
        const result = await listenService.sendSystemAudioContent(data, mimeType);
        if(result.success) {
            listenService.sendToRenderer('system-audio-data', { data });
        }
        return result;
    });
    ipcMain.handle('listen:startMacosSystemAudio', async () => await listenService.handleStartMacosAudio());
    ipcMain.handle('listen:stopMacosSystemAudio', async () => await listenService.handleStopMacosAudio());
    ipcMain.handle('update-google-search-setting', async (event, enabled) => await listenService.handleUpdateGoogleSearchSetting(enabled));
    ipcMain.handle('listen:isSessionActive', async () => await listenService.isSessionActive());
    ipcMain.handle('listen:changeSession', async (event, listenButtonText) => {
      console.log('[FeatureBridge] listen:changeSession from mainheader', listenButtonText);
      try {
        return await listenService.handleListenRequest(listenButtonText);
      } catch (error) {
        console.error('[FeatureBridge] listen:changeSession failed', error.message);
        return { success: false, error: error.message };
      }
    });

    // ModelStateService
    ipcMain.handle('model:validate-key', credentialHandler(({ provider, key }) => modelStateService.handleValidateKey(provider, key), true));
    ipcMain.handle('model:get-credential-status', credentialHandler(() => modelStateService.getCredentialStatus()));
    const twin = () => require('../features/settings/twinSettingsService').getTwinSettingsService();
    const mcp = () => require('../features/settings/mcpSettingsService').getMcpSettingsService();
    const mcpHandler = action => async (event, data) => {
      if (!trustedSettingsSender(event) || require('../window/windowManager').windowPool?.get('settings')?.webContents !== event.sender) return { success: false, error: 'untrusted_sender' };
      try { return { success: true, data: await action(data) }; }
      catch (error) { return { success: false, error: ['revision_conflict', 'credential_locked', 'vault_unavailable', 'credential_destination_changed', 'credential_reference_invalid', 'invalid_mcp_config', 'runtime_pending', 'unsupported_schema'].includes(error.code) ? error.code : 'mcp_operation_failed' }; }
    };
    ipcMain.handle('mcp:settings', mcpHandler(data => { if (data !== undefined) throw Error(); return mcp().getState(); }));
    ipcMain.handle('mcp:save', mcpHandler(data => mcp().save(data)));
    ipcMain.handle('mcp:test', mcpHandler(data => mcp().test(data)));
    ipcMain.handle('mcp:new-identity', mcpHandler(data => { if (data !== undefined) throw Error(); return mcp().newIdentity(); }));
    ipcMain.handle('mcp:approve-knowledge', mcpHandler(data => mcp().approveKnowledge(data)));
    ipcMain.handle('twin:settings', credentialHandler(() => ({ success: true, data: twin().getState() })));
    ipcMain.handle('twin:insights', credentialHandler(async data => {
      if (data !== undefined) return { success: false, error: 'invalid_payload' };
      return { success: true, data: await require('../features/settings/settingsInsightsService').getSettingsInsightsService().read() };
    }));
    ipcMain.handle('settings:open-setup', async (event, data) => {
      if (!trustedSettingsSender(event)) return { success: false, error: 'untrusted_sender' };
      if (data !== undefined) return { success: false, error: 'invalid_payload' };
      try {
        const manager = require('../window/windowManager');
        if (manager.windowPool?.get('settings')?.webContents !== event.sender) return { success: false, error: 'untrusted_sender' };
        if (!['idle', 'stopped'].includes(listenService.getListenState().phase)) return { success: false, error: 'listen_active' };
        const header = manager.windowPool.get('header');
        if (!header || header.isDestroyed()) return { success: false, error: 'setup_unavailable' };
        require('./internalBridge').emit('window:requestVisibility', { name: 'header', visible: true });
        header.webContents.send('header:setup-requested');
        manager.closeSettingsWindow();
        return { success: true };
      } catch { return { success: false, error: 'setup_unavailable' }; }
    });
    ipcMain.handle('twin:save', credentialHandler(async data => ({ success: true, data: await twin().save(data) })));
    ipcMain.handle('twin:retry-join', credentialHandler(async data => ({ success: true, data: await twin().retryJoin(data) })));
    ipcMain.handle('model:set-api-key', credentialHandler(({ provider, key }) => modelStateService.setApiKey(provider, key), true));
    ipcMain.handle('model:remove-api-key', credentialHandler(provider => {
        if (typeof provider !== 'string' || provider === 'openai-glass' || !Object.hasOwn(modelStateService.getProviderConfig(), provider)) return { success: false, error: 'invalid_provider' };
        return modelStateService.handleRemoveApiKey(provider);
    }));
    ipcMain.handle('model:get-selected-models', async () => await modelStateService.getSelectedModels());
    ipcMain.handle('model:set-selected-model', async (e, { type, modelId }) => await modelStateService.handleSetSelectedModel(type, modelId));
    ipcMain.handle('model:get-available-models', async (e, { type }) => await modelStateService.getAvailableModels(type));
    ipcMain.handle('model:are-providers-configured', async () => await modelStateService.areProvidersConfigured());
    ipcMain.handle('model:get-provider-config', () => modelStateService.getProviderConfig());
    ipcMain.handle('model:re-initialize-state', async () => await modelStateService.initialize());

    // LocalAIManager 이벤트를 모든 윈도우에 브로드캐스트
    localAIManager.on('install-progress', (service, data) => {
      const event = { service, ...data };
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:install-progress', event);
        }
      });
    });
    localAIManager.on('installation-complete', (service) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:installation-complete', { service });
        }
      });
    });
    localAIManager.on('error', (error) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:error-occurred', error);
        }
      });
    });
    // Handle error-occurred events from LocalAIManager's error handling
    localAIManager.on('error-occurred', (error) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:error-occurred', error);
        }
      });
    });
    localAIManager.on('model-ready', (data) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:model-ready', data);
        }
      });
    });
    localAIManager.on('state-changed', (service, state) => {
      const event = { service, ...state };
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('localai:service-status-changed', event);
        }
      });
    });

    // 주기적 상태 동기화 시작
    localAIManager.startPeriodicSync();

    // ModelStateService 이벤트를 모든 윈도우에 브로드캐스트
    modelStateService.on('state-updated', (state) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('model-state:updated', state);
        }
      });
    });
    modelStateService.on('settings-updated', () => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('settings-updated');
        }
      });
    });
    modelStateService.on('force-show-apikey-header', () => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('force-show-apikey-header');
        }
      });
    });

    // LocalAI 통합 핸들러 추가
    ipcMain.handle('localai:install', async (event, { service, options }) => {
      return await localAIManager.installService(service, options);
    });
    ipcMain.handle('localai:get-status', async (event, service) => {
      return await localAIManager.getServiceStatus(service);
    });
    ipcMain.handle('localai:start-service', async (event, service) => {
      return await localAIManager.startService(service);
    });
    ipcMain.handle('localai:stop-service', async (event, service) => {
      return await localAIManager.stopService(service);
    });
    ipcMain.handle('localai:install-model', async (event, { service, modelId, options }) => {
      return await localAIManager.installModel(service, modelId, options);
    });
    ipcMain.handle('localai:get-installed-models', async (event, service) => {
      return await localAIManager.getInstalledModels(service);
    });
    ipcMain.handle('localai:run-diagnostics', async (event, service) => {
      return await localAIManager.runDiagnostics(service);
    });
    ipcMain.handle('localai:repair-service', async (event, service) => {
      return await localAIManager.repairService(service);
    });
    
    // 에러 처리 핸들러
    ipcMain.handle('localai:handle-error', async (event, { service, errorType, details }) => {
      return await localAIManager.handleError(service, errorType, details);
    });
    
    // 전체 상태 조회
    ipcMain.handle('localai:get-all-states', async (event) => {
      return await localAIManager.getAllServiceStates();
    });

    console.log('[FeatureBridge] Initialized with all feature handlers.');
  },

  // Renderer로 상태를 전송
  sendAskProgress(win, progress) {
    win.webContents.send('feature:ask:progress', progress);
  },
};
