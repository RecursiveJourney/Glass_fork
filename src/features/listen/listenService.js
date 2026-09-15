const SttService = require('./stt/sttService');
const SummaryService = require('./summary/summaryService');
const authService = require('../common/services/authService');
const sessionRepository = require('../common/repositories/session');
const sttRepository = require('./stt/repositories');
const internalBridge = require('../../bridge/internalBridge');

class ListenService {
    constructor() {
        this.sttService = new SttService();
        this.summaryService = new SummaryService();
        this.currentSessionId = null;
        this.pendingSessionEndId = null;
        this.isInitializingSession = false;
        this.meetingFeed = null;
        this.meetingFeedUnsubscribe = null;
        this.state = { source: 'local', phase: 'idle', lifecycleId: 0, version: 0, error: null, feed: null };
        this.sourceInitialized = false;
        this.localInitPromise = null;
        this.stopPromise = null;
        this.capturePending = null;
        this.captureMayBeRunning = false;
        this.localResources = false;
        this.cleanupUncertain = false;
        this.setupServiceCallbacks();
    }

    setupServiceCallbacks(identity = this.state.lifecycleId) {
        this.sttService.setCallbacks({
            onTranscriptionComplete: (speaker, text) => this.handleTranscriptionComplete(speaker, text, identity),
            onStatusUpdate: status => { if (this.isLocalIdentity(identity)) this.sendToRenderer('update-status', status); }
        });
        this.summaryService.setCallbacks({ onAnalysisComplete: () => {},
            onStatusUpdate: status => { if (this.isLocalIdentity(identity)) this.sendToRenderer('update-status', status); } });
    }

    isLocalIdentity(identity) {
        return this.state.source === 'local' && this.state.lifecycleId === identity && ['starting', 'active'].includes(this.state.phase);
    }
    getListenState() { return { ...this.state, feed: this.state.source === 'meeting' ? this.getMeetingFeedState() : null }; }
    getTranscriptionStatus() {
        const info = this.sttService.modelInfo;
        const loaded = this.state.source === 'local' && ['starting', 'active'].includes(this.state.phase) && info && (this.sttService.mySttSession || this.sttService.theirSttSession);
        return { source: this.state.source, phase: this.state.phase, state: loaded ? 'loaded' : 'idle', provider: loaded ? info.provider : null, model: loaded ? info.model : null };
    }
    publish(changes = {}) {
        this.state = { ...this.state, ...changes, version: this.state.version + 1 };
        const state = this.getListenState();
        if (changes.source) internalBridge.emit('listen:source-changed', { source: state.source });
        const { windowPool } = require('../../window/windowManager');
        for (const name of ['header', 'listen']) {
            const win = windowPool?.get(name);
            try { if (win && !win.isDestroyed()) win.webContents.send('listen:state', state); } catch { /* Independent window sinks. */ }
        }
        return state;
    }
    async getListenCapabilities() {
        let configured = false, permitted = false;
        try {
            const models = require('../common/services/modelStateService');
            configured = await models.areProvidersConfigured();
            if (configured) {
                const permissions = await require('../common/services/permissionService').checkSystemPermissions();
                permitted = !permissions.needsSetup && permissions.microphone === 'granted' && permissions.screen === 'granted';
            }
        } catch { /* Capability reads never change provider configuration. */ }
        if (!this.sourceInitialized && ['idle', 'starting', 'stopped'].includes(this.state.phase)) {
            this.sourceInitialized = true;
            this.publish({ source: configured ? 'local' : 'meeting' });
        }
        return { meeting: true, localListen: !!configured && permitted, ask: true };
    }
    async selectSource(source) {
        if (!['local', 'meeting'].includes(source)) return this.result(false, 'invalid_source');
        if (['starting', 'active', 'stopping'].includes(this.state.phase)) return this.result(false, 'source_locked');
        if (this.cleanupUncertain) return this.result(false, 'local_cleanup_failed');
        this.sourceInitialized = true;
        this.publish({ source, error: null });
        return this.result(true);
    }
    result(success, error) { return { success, state: this.getListenState(), ...(error ? { error } : {}) }; }
    sendToRenderer(channel, data) {
        const { windowPool } = require('../../window/windowManager');
        const win = windowPool?.get('listen');
        if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    }

    startMeetingFeed() {
        try {
            if (!this.meetingFeed) {
                const MeetingFeedService = require('./meeting/meetingFeedService');
                this.meetingFeed = new MeetingFeedService();
            }
            if (!this.meetingFeedUnsubscribe) {
                this.meetingFeedUnsubscribe = this.meetingFeed.subscribe(state => {
                    this.sendToRenderer('meeting-feed:state', state);
                    if (this.state.source === 'meeting' && ['starting', 'active'].includes(this.state.phase)) {
                        const terminal = state.connectionStatus === 'closed';
                        this.publish(terminal ? { phase: 'stopped', error: null } : {});
                    }
                });
            }
            return { success: true, state: this.meetingFeed.start() };
        } catch {
            this.stopMeetingFeed();
            return { success: false, error: 'meeting_feed_unavailable' };
        }
    }
    stopMeetingFeed() {
        let result;
        try { result = { success: true, state: this.meetingFeed ? this.meetingFeed.stop() : { connectionStatus: 'stopped', snapshot: null, error: null, nextRetryAt: null } }; }
        catch { result = { success: false, error: 'meeting_feed_unavailable' }; }
        finally {
            try { this.meetingFeedUnsubscribe?.(); } catch { result = { success: false, error: 'meeting_feed_unavailable' }; }
            this.meetingFeedUnsubscribe = null;
        }
        return result;
    }
    getMeetingFeedState() { return this.meetingFeed?.getState() ?? { connectionStatus: 'idle', snapshot: null, error: null, nextRetryAt: null }; }
    initialize() { this.setupIpcHandlers?.(); }
    setRuntimeSettingsService(service) { this.runtimeSettingsService = service; }

    async handleListenRequest(action) {
        let result;
        if (action === 'Listen') {
            if (['starting', 'active', 'stopping'].includes(this.state.phase)) return this.result(false, 'listen_busy');
            if (this.cleanupUncertain) return this.result(false, 'local_cleanup_failed');
            const dispatchId = this.state.lifecycleId + 1;
            this.publish({ lifecycleId: dispatchId, phase: 'starting', error: null });
            let capabilities;
            if (!this.sourceInitialized || this.state.source === 'local') capabilities = await this.getListenCapabilities();
            if (this.state.lifecycleId !== dispatchId || this.state.phase !== 'starting') return this.result(false, 'listen_cancelled');
            if (this.state.source === 'local' && !capabilities?.localListen) {
                this.publish({ phase: 'stopped', error: 'local_setup_required' });
                return this.result(false, 'local_setup_required');
            }
            internalBridge.emit('window:requestVisibility', { name: 'listen', visible: true });
            if (this.state.source === 'meeting') {
                const id = this.state.lifecycleId + 1;
                this.publish({ lifecycleId: id, phase: 'starting', error: null });
                if (this.runtimeSettingsService) {
                    const applied = await this.runtimeSettingsService.ensureApplied();
                    if (this.state.lifecycleId !== id || this.state.phase !== 'starting') return this.result(false, 'listen_cancelled');
                    if (!applied.success) { this.publish({ phase: 'stopped', error: 'runtime_settings_pending' }); return this.result(false, 'runtime_settings_pending'); }
                }
                const feed = this.startMeetingFeed();
                if (this.state.lifecycleId === id && this.state.phase === 'starting')
                    this.publish({ phase: feed.success ? 'active' : 'stopped', error: feed.error || null });
                result = this.result(feed.success, feed.error);
            } else {
                const success = await this.initializeSession();
                result = this.result(success, success ? null : (this.state.error || 'local_initialization_failed'));
            }
        } else if (action === 'Stop' || action === 'Done') {
            result = await this.closeSession();
            if (action === 'Done') internalBridge.emit('window:requestVisibility', { name: 'listen', visible: false });
        } else result = this.result(false, 'invalid_listen_action');
        const { windowPool } = require('../../window/windowManager');
        const header = windowPool?.get('header');
        if (header && !header.isDestroyed()) header.webContents.send('listen:changeSessionResult', result);
        return result;
    }

    async handleTranscriptionComplete(speaker, text, identity = this.state.lifecycleId) {
        if (!this.isLocalIdentity(identity)) return;
        await this.saveConversationTurn(speaker, text, identity);
        if (this.isLocalIdentity(identity)) this.summaryService.addConversationTurn(speaker, text);
    }
    async saveConversationTurn(speaker, transcription, identity = this.state.lifecycleId) {
        const sessionId = this.currentSessionId;
        if (!sessionId || !this.isLocalIdentity(identity) || !transcription.trim()) return;
        try {
            await sessionRepository.touch(sessionId);
            if (!this.isLocalIdentity(identity) || this.currentSessionId !== sessionId) return;
            await sttRepository.addTranscript({ sessionId, speaker, text: transcription.trim() });
        } catch { /* Persistence failure must not expose transcript content. */ }
    }
    async initializeNewSession(identity = this.state.lifecycleId) {
        if (!authService.getCurrentUser()) return false;
        const sessionId = await sessionRepository.getOrCreateActive('listen');
        // Stop waits for initialization, so this resource remains owned by its cleanup.
        this.currentSessionId = sessionId;
        if (!this.isLocalIdentity(identity)) return false;
        this.summaryService.resetConversationHistory();
        this.summaryService.setSessionId(sessionId);
        return true;
    }
    async initializeSession(language = 'en') {
        if (this.isInitializingSession || this.state.source !== 'local' || this.cleanupUncertain || this.state.phase === 'stopping') return false;
        this.sourceInitialized = true;
        const identity = this.state.lifecycleId + 1;
        this.publish({ lifecycleId: identity, phase: 'starting', error: null });
        this.localResources = true;
        this.isInitializingSession = true;
        this.setupServiceCallbacks(identity);
        this.sttService.setLifecycleGuard?.(() => this.isLocalIdentity(identity));
        this.sendToRenderer('session-initializing', true);
        const init = (async () => {
            try {
                if (!await this.initializeNewSession(identity) || !this.isLocalIdentity(identity)) return false;
                await this.sttService.initializeSttSessions(language);
                if (!this.isLocalIdentity(identity)) return false;
                this.captureMayBeRunning = true;
                const captured = await this.requestCapture('start', identity);
                if (!captured || !this.isLocalIdentity(identity)) return false;
                this.publish({ phase: 'active' });
                return true;
            } catch { return false; }
            finally { this.isInitializingSession = false; this.sendToRenderer('session-initializing', false); }
        })();
        this.localInitPromise = init;
        const success = await init;
        if (this.localInitPromise === init) this.localInitPromise = null;
        if (!success && this.isLocalIdentity(identity)) {
            const cleanup = await this.closeSession();
            this.publish({ error: cleanup.success ? 'local_initialization_failed' : 'local_cleanup_failed' });
        }
        return success;
    }
    requestCapture(status, lifecycleId) {
        this.capturePending?.finish(false);
        return new Promise(resolve => {
            const pending = { status, lifecycleId, finish: success => {
                clearTimeout(pending.timer);
                if (this.capturePending === pending) this.capturePending = null;
                resolve(success);
            } };
            pending.timer = setTimeout(() => pending.finish(false), 5000);
            this.capturePending = pending;
            try { this.sendToRenderer('change-listen-capture-state', { status, lifecycleId }); }
            catch { pending.finish(false); }
        });
    }
    acknowledgeCapture(payload, senderWebContents) {
        const { windowPool } = require('../../window/windowManager');
        const win = windowPool?.get('listen'), pending = this.capturePending;
        if (!win || win.isDestroyed() || win.webContents !== senderWebContents || !pending ||
            payload?.status !== pending.status || payload?.lifecycleId !== pending.lifecycleId || typeof payload.success !== 'boolean') return { success: false };
        pending.finish(payload.success);
        return { success: true };
    }
    async sendMicAudioContent(data, mimeType) {
        const identity = this.state.lifecycleId;
        if (!this.isLocalIdentity(identity)) return { success: false, error: 'local_inactive' };
        const result = await this.sttService.sendMicAudioContent(data, mimeType);
        return this.isLocalIdentity(identity) ? (result ?? { success: true }) : { success: false, error: 'local_inactive' };
    }
    async sendSystemAudioContent(data, mimeType) {
        const identity = this.state.lifecycleId;
        if (!this.isLocalIdentity(identity)) return { success: false, error: 'local_inactive' };
        const result = await this.sttService.sendSystemAudioContent(data, mimeType);
        return this.isLocalIdentity(identity) ? (result ?? { success: true }) : { success: false, error: 'local_inactive' };
    }
    async startMacOSAudioCapture() {
        if (!this.isLocalIdentity(this.state.lifecycleId)) throw new Error('local_inactive');
        if (process.platform !== 'darwin') throw new Error('macOS audio capture only available on macOS');
        return this.sttService.startMacOSAudioCapture();
    }
    async stopMacOSAudioCapture() { await this.sttService.stopMacOSAudioCapture(); }
    isSessionActive() { return this.isLocalIdentity(this.state.lifecycleId) && this.sttService.isSessionActive(); }
    async closeSession() {
        if (this.stopPromise) return this.stopPromise;
        const local = this.localResources;
        if (!local && ['idle', 'stopped'].includes(this.state.phase) && !this.meetingFeedUnsubscribe) return this.result(true);
        this.publish({ phase: 'stopping', lifecycleId: this.state.lifecycleId + 1 });
        let invalidated = true;
        if (local) {
            try { this.sttService.invalidateLifecycle?.(); } catch { invalidated = false; }
            try { this.summaryService.resetConversationHistory(); } catch { invalidated = false; }
        }
        this.capturePending?.finish(false);
        const stopping = (async () => {
            const feedStopped = this.stopMeetingFeed().success;
            let success = feedStopped && invalidated;
            if (local) {
                const step = async fn => { try { await fn(); } catch { success = false; } };
                // Invalidate immediately, then wait until initialization has relinquished its resources.
                await step(() => this.localInitPromise);
                if (this.captureMayBeRunning) {
                    const stopped = await this.requestCapture('stop', this.state.lifecycleId);
                    if (stopped) this.captureMayBeRunning = false;
                    else success = false;
                }
                await step(() => this.sttService.closeSessions());
                await step(() => this.stopMacOSAudioCapture());
                const sessionId = this.currentSessionId || this.pendingSessionEndId;
                this.currentSessionId = null;
                if (sessionId) {
                    this.pendingSessionEndId = sessionId;
                    await step(async () => {
                        await sessionRepository.end(sessionId);
                        this.pendingSessionEndId = null;
                    });
                }
                await step(() => this.summaryService.resetConversationHistory());
                this.localResources = !success;
                this.cleanupUncertain = !success;
            }
            this.publish({ phase: 'stopped', error: success ? null : (local ? 'local_cleanup_failed' : 'meeting_feed_unavailable') });
            return this.result(success, this.state.error);
        })();
        this.stopPromise = stopping;
        try { return await stopping; } finally { if (this.stopPromise === stopping) this.stopPromise = null; }
    }

    getCurrentSessionData() {
        return {
            sessionId: this.currentSessionId,
            conversationHistory: this.summaryService.getConversationHistory(),
            totalTexts: this.summaryService.getConversationHistory().length,
            analysisData: this.summaryService.getCurrentAnalysisData(),
        };
    }

    getConversationHistory() {
        return this.summaryService.getConversationHistory();
    }

    _createHandler(asyncFn, successMessage, errorMessage) {
        return async (...args) => {
            try {
                const result = await asyncFn.apply(this, args);
                if (successMessage) console.log(successMessage);
                // `startMacOSAudioCapture`는 성공 시 { success, error } 객체를 반환하지 않으므로,
                // 핸들러가 일관된 응답을 보내도록 여기서 success 객체를 반환합니다.
                // 다른 함수들은 이미 success 객체를 반환합니다.
                return result && typeof result.success !== 'undefined' ? result : { success: true };
            } catch (e) {
                console.error(errorMessage, e);
                return { success: false, error: e.message };
            }
        };
    }

    // `_createHandler`를 사용하여 핸들러들을 동적으로 생성합니다.
    handleSendMicAudioContent = this._createHandler(
        this.sendMicAudioContent,
        null,
        'Error sending user audio:'
    );

    handleStartMacosAudio = this._createHandler(
        async () => {
            if (process.platform !== 'darwin') {
                return { success: false, error: 'macOS audio capture only available on macOS' };
            }
            if (this.sttService.isMacOSAudioRunning?.()) {
                return { success: false, error: 'already_running' };
            }
            await this.startMacOSAudioCapture();
            return { success: true, error: null };
        },
        'macOS audio capture started.',
        'Error starting macOS audio capture:'
    );
    
    handleStopMacosAudio = this._createHandler(
        this.stopMacOSAudioCapture,
        'macOS audio capture stopped.',
        'Error stopping macOS audio capture:'
    );

    handleUpdateGoogleSearchSetting = this._createHandler(
        async (enabled) => {
            console.log('Google Search setting updated to:', enabled);
        },
        null,
        'Error updating Google Search setting:'
    );
}

const listenService = new ListenService();
module.exports = listenService;
