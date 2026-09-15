const { TwinRuntimeClient } = require('../common/services/twinRuntimeClient');
class SettingsInsightsService {
    #client; #listen; #now; #knowledge = null; #knowledgeAt = null; #pending = null;
    constructor({ client = new TwinRuntimeClient(), listenService = require('../listen/listenService'), now = Date.now } = {}) {
        this.#client = client; this.#listen = listenService; this.#now = now;
    }
    read() {
        if (this.#pending) return this.#pending;
        this.#pending = this.#read().finally(() => { this.#pending = null; }); return this.#pending;
    }
    async #read() {
        const [status, knowledge] = await Promise.allSettled([this.#client.getStatus(), this.#client.getKnowledge()]);
        const observedAt = this.#now(), available = status.status === 'fulfilled';
        if (knowledge.status === 'fulfilled') { this.#knowledge = knowledge.value; this.#knowledgeAt = observedAt; }
        const local = this.#listen.getTranscriptionStatus();
        const fireflies = { state: available ? status.value.fireflies.state : 'unavailable' };
        return { observedAt,
            server: { state: available ? 'reachable' : status.reason?.code === 'runtime_unauthorized' ? 'unauthorized' : 'unavailable' },
            gemini: available ? status.value.gemini : { model: null, state: 'unavailable', observedAt: null, inFlight: 0, errorCode: null },
            fireflies,
            transcription: { source: local.source, phase: local.phase, state: local.source === 'meeting' ? fireflies.state : local.state,
                provider: local.source === 'meeting' ? 'fireflies' : local.provider, model: local.source === 'meeting' ? null : local.model },
            knowledge: { state: knowledge.status === 'fulfilled' ? 'current' : this.#knowledge ? 'stale' : 'unavailable', observedAt: this.#knowledgeAt, data: this.#knowledge },
            canSetup: ['idle', 'stopped'].includes(local.phase) };
    }
}
let singleton;
function getSettingsInsightsService() { return singleton ||= new SettingsInsightsService(); }
module.exports = { SettingsInsightsService, getSettingsInsightsService };
