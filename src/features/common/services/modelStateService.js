const { EventEmitter } = require('events');
const { PROVIDERS, getProviderClass } = require('../ai/factory');
const providerSettingsRepository = require('../repositories/providerSettings');
const authService = require('./authService');
const ollamaModelRepository = require('../repositories/ollamaModel');
const { registerSecrets } = require('./secretRedactor');
const usable = row => !!row && (row.enabled || row.status === 'stored');
const presence = row => ({ hasKey: !!row?.hasKey, status: row?.status || 'missing', enabled: !!row?.enabled });

class ModelStateService extends EventEmitter {
    constructor() { super(); this.authService = authService; this.initialized = false; }
    async initialize(migration = {}) {
        if (this.initialized) return;
        if (migration.selections) {
            const active = await this.getSelectedModels();
            for (const type of ['llm', 'stt']) {
                const model = migration.selections[`${type}_model`] || migration.selections[`selected_${type}_model`];
                if (!active[type] && model) await this.setSelectedModel(type, model);
            }
        }
        this.setupLocalAIStateSync();
        await this._autoSelectAvailableModels([], true);
        this.initialized = true;
    }
    setupLocalAIStateSync() {
        require('./localAIManager').on('state-changed', (service, status) => {
            this.handleLocalAIStateChange(service, status).catch(() => console.warn('[ModelState] status_update_failed'));
        });
    }
    async handleLocalAIStateChange() {
        // Availability changes never discard a persisted user selection.
        this.emit('state-updated', await this.getLiveState());
    }
    async getCredentialStatus() {
        const rows = await providerSettingsRepository.getAll();
        return Object.fromEntries(Object.keys(PROVIDERS).filter(p => p !== 'openai-glass').map(p => [p, presence(rows.find(r => r.provider === p))]));
    }
    async getLiveState() { return { providers: await this.getCredentialStatus(), selectedModels: await this.getSelectedModels() }; }
    async _autoSelectAvailableModels(forceTypes = [], isInitialBoot = false) {
        const selected = await this.getSelectedModels();
        const availableProviders = new Set((await providerSettingsRepository.getAll()).filter(usable).map(row => row.provider));
        for (const type of ['llm', 'stt']) {
            if (selected[type] && !forceTypes.includes(type)) continue;
            const models = (await this.getAvailableModels(type)).filter(model => availableProviders.has(this.getProviderForModel(model.id, type)));
            const candidate = models.find(m => !['ollama', 'whisper'].includes(this.getProviderForModel(m.id, type))) || models[0];
            if (candidate) await this.setSelectedModel(type, candidate.id);
            else if (forceTypes.includes(type)) await providerSettingsRepository.setActiveProvider(null, type);
        }
        if (!isInitialBoot) this.emit('state-updated', await this.getLiveState());
    }
    async setFirebaseVirtualKey(key) {
        if (key == null) return this.removeApiKey('openai-glass');
        registerSecrets([key]);
        const result = await this.setApiKey('openai-glass', key);
        return result;
    }
    async setApiKey(provider, key) {
        if (typeof key === 'string') registerSecrets([key]);
        if (!PROVIDERS[provider]) return { success: false, error: 'invalid_provider' };
        if (provider !== 'openai-glass') {
            const result = await this.validateApiKey(provider, key);
            if (!result.success) return result;
        }
        const finalKey = ['ollama', 'whisper'].includes(provider) ? 'local' : key;
        await providerSettingsRepository.upsert(provider, { api_key: finalKey });
        await this._autoSelectAvailableModels();
        this.emit('settings-updated');
        return { success: true };
    }
    async removeApiKey(provider) {
        const row = await providerSettingsRepository.getByProvider(provider);
        if (!row || (!row.hasKey && !row.enabled)) return false;
        const active = await providerSettingsRepository.getActiveSettings();
        await providerSettingsRepository.upsert(provider, { api_key: null });
        await this._autoSelectAvailableModels(['llm', 'stt'].filter(type => active[type]?.provider === provider));
        this.emit('settings-updated'); return true;
    }
    isLoggedInWithFirebase() { return this.authService.getCurrentUser().isLoggedIn; }
    async hasValidApiKey() { return (await providerSettingsRepository.getAll()).some(usable); }
    getProviderForModel(arg1, arg2) {
        const [modelId, type] = ['llm', 'stt'].includes(arg1) ? [arg2, arg1] : [arg1, arg2];
        if (!modelId || !['llm', 'stt'].includes(type)) return null;
        for (const [provider, spec] of Object.entries(PROVIDERS)) if (spec[`${type}Models`]?.some(m => m.id === modelId)) return provider;
        if (type === 'llm' && ollamaModelRepository.getInstalledModels().some(m => m.name === modelId)) return 'ollama';
        return null;
    }
    async getSelectedModels() {
        const active = await providerSettingsRepository.getActiveSettings();
        return { llm: active.llm?.selected_llm_model || null, stt: active.stt?.selected_stt_model || null };
    }
    async setSelectedModel(type, modelId) {
        const provider = this.getProviderForModel(modelId, type);
        if (!provider) return false;
        await providerSettingsRepository.upsert(provider, { [`selected_${type}_model`]: modelId });
        await providerSettingsRepository.setActiveProvider(provider, type);
        if (type === 'llm' && provider === 'ollama') require('./localAIManager').warmUpModel(modelId).catch(() => console.warn('[ModelState] warmup_unavailable'));
        this.emit('state-updated', await this.getLiveState()); this.emit('settings-updated'); return true;
    }
    async getAvailableModels(type) {
        if (!['llm', 'stt'].includes(type)) return [];
        const available = [];
        for (const row of await providerSettingsRepository.getAll()) {
            if (!usable(row)) continue;
            if (row.provider === 'ollama' && type === 'llm') available.push(...ollamaModelRepository.getInstalledModels().map(m => ({ id: m.name, name: m.name })));
            else available.push(...(PROVIDERS[row.provider]?.[`${type}Models`] || []));
        }
        // Keep a saved offline model visible and selected even when discovery is unavailable.
        const active = await providerSettingsRepository.getActiveProvider(type);
        const saved = active?.[`selected_${type}_model`];
        if (saved) available.push({ id: saved, name: saved });
        return [...new Map(available.map(item => [item.id, item])).values()];
    }
    async getCurrentModelInfo(type) {
        const row = await providerSettingsRepository.getActiveProvider(type), model = row?.[`selected_${type}_model`];
        if (!model || !usable(row)) return null;
        return { provider: row.provider, model, apiKey: row.enabled ? 'local' : await providerSettingsRepository.resolveCredential(row.provider) };
    }
    async validateApiKey(provider, key) {
        if (typeof key === 'string') registerSecrets([key]);
        if (!PROVIDERS[provider]) return { success: false, error: 'invalid_provider' };
        if (typeof key !== 'string' || !key.trim()) return { success: false, error: 'credential_missing' };
        try {
            const ProviderClass = getProviderClass(provider);
            const result = ProviderClass?.validateApiKey ? await ProviderClass.validateApiKey(key) : { success: true };
            return result.success ? { success: true } : { success: false, error: 'credential_validation_failed' };
        } catch { return { success: false, error: 'credential_validation_failed' }; }
    }
    getProviderConfig() { return Object.fromEntries(Object.entries(PROVIDERS).map(([key, { handler, ...rest }]) => [key, rest])); }
    async handleRemoveApiKey(provider) {
        const success = await this.removeApiKey(provider);
        if (success && !(await providerSettingsRepository.getAll()).some(r => r.hasKey || r.enabled)) {
            this.diagnostics?.record('onboarding', { status: 'requested', code: 'all_credentials_cleared' });
            this.emit('force-show-apikey-header');
        }
        return success;
    }
    async handleValidateKey(provider, key) { return this.setApiKey(provider, key); }
    async handleSetSelectedModel(type, modelId) { return this.setSelectedModel(type, modelId); }
    async areProvidersConfigured() {
        // Preserve upstream account onboarding; inference still resolves an owned credential.
        if (this.isLoggedInWithFirebase()) return true;
        const rows = (await providerSettingsRepository.getAll()).filter(usable);
        return ['llm', 'stt'].every(type => rows.some(row => {
            if (row.provider === 'ollama') return type === 'llm' && (!!row.selected_llm_model || ollamaModelRepository.getInstalledModels().length > 0);
            return PROVIDERS[row.provider]?.[`${type}Models`]?.length > 0;
        }));
    }
}
module.exports = new ModelStateService();
