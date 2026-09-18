import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
const names = { whisper: 'Whisper', openai: 'OpenAI', deepgram: 'Deepgram', gemini: 'Gemini', fireflies: 'Fireflies' };
const states = { reachable: 'Reachable', unavailable: 'Unavailable', unauthorized: 'Control authentication failed', unconfigured: 'Unconfigured',
    not_tested: 'Not tested', generating: 'Generating', succeeded: 'Last request succeeded', failed: 'Last request failed',
    loaded: 'Session loaded', idle: 'No local STT loaded', connected: 'Connected', disconnected: 'Disconnected', disabled: 'Disabled',
    applying: 'Applying settings', joining: 'Joining meeting', waiting: 'Waiting for meeting', rate_limited: 'Rate limited', auth_failed: 'Authentication failed',
    uncertain: 'Join outcome uncertain', credential_missing: 'Key missing', meeting_missing: 'Meeting link missing' };
export class TwinInsightsSettings extends LitElement {
    static properties = { data: { state: true }, message: { state: true }, settingUp: { state: true } };
    static styles = css`
        :host { display: block; margin-top: 18px; padding-top: 18px; border-top: 1px solid #ffffff24; color: #eee; font: 13px/1.45 Arial, sans-serif; }
        h2 { font-size: 15px; margin: 0 0 12px; } h3 { font-size: 14px; margin: 20px 0 8px; }
        dl { margin: 0; } .row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(0, 1.6fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid #ffffff10; }
        dt { color: #c7c9ce; } dd { margin: 0; overflow-wrap: anywhere; } small { display: block; color: #aaaeb7; margin-top: 3px; }
        .knowledge { padding: 12px; border: 1px solid #ffffff20; border-radius: 8px; background: #ffffff05; }
        code { font-size: 11px; overflow-wrap: anywhere; user-select: text; } p { color: #b9bdc6; margin: 9px 0; }
        .stale { color: #efc483; } button { background: #ffffff10; color: #eee; border: 1px solid #ffffff30; border-radius: 6px; padding: 7px 12px; cursor: pointer; }
        button:disabled { opacity: .5; cursor: default; } button:focus-visible { outline: 2px solid #9bbfff; outline-offset: 2px; }
    `;
    constructor() { super(); this.data = null; this.message = ''; this.settingUp = false; this.timer = null; this.epoch = 0; }
    connectedCallback() { super.connectedCallback(); this.mounted = true; this.refresh(++this.epoch); }
    disconnectedCallback() { this.mounted = false; this.epoch++; clearTimeout(this.timer); this.timer = null; super.disconnectedCallback(); }
    async refresh(epoch = this.epoch) {
        clearTimeout(this.timer); this.timer = null;
        try {
            const result = await window.api.settingsView.getTwinInsights();
            if (!this.mounted || epoch !== this.epoch) return;
            if (!result.success) throw Error('insights_unavailable');
            this.data = result.data;
        } catch {
            if (this.mounted && epoch === this.epoch) this.data = null;
        } finally {
            if (this.mounted && epoch === this.epoch) this.timer = setTimeout(() => this.refresh(epoch), 2000);
        }
    }
    async openSetup() {
        if (this.settingUp) return;
        this.settingUp = true; this.message = '';
        try {
            const result = await window.api.settingsView.openSetup();
            if (!result.success) this.message = result.error === 'listen_active' ? 'Stop Listen before opening Setup.' : 'Setup could not be opened.';
        } catch { this.message = 'Setup could not be opened.'; }
        finally { this.settingUp = false; }
    }
    label(value) { return states[value] || 'Unavailable'; }
    when(value) { return value ? new Date(value).toLocaleTimeString() : ''; }
    render() {
        const data = this.data, transcript = data?.transcription, knowledge = data?.knowledge;
        const metadata = knowledge?.data;
        return html`
            <section aria-label="Digital Twin component status">
                <h2>Digital Twin · Components</h2>
                <dl>
                    <div class="row"><dt>Digital Twin server</dt><dd>${this.label(data?.server.state)}<small>${data ? 'Checked ' + this.when(data.observedAt) : 'Waiting for status'}</small></dd></div>
                    <div class="row"><dt>Gemini</dt><dd>${this.label(data?.gemini.state)}<small>${data?.gemini.model || ''}${data?.gemini.observedAt ? ' · observed ' + this.when(data.gemini.observedAt) : ''}</small></dd></div>
                    <div class="row"><dt>Transcription</dt><dd>${transcript?.provider ? (names[transcript.provider] || transcript.provider) + ' · ' : ''}${this.label(transcript?.state)}<small>${transcript?.model || ''}${transcript ? ' · ' + transcript.source + ' Listen ' + transcript.phase : ''}</small></dd></div>
                    <div class="row"><dt>Fireflies</dt><dd>${this.label(data?.fireflies.state)}</dd></div>
                </dl>
                <p>Gemini status reflects real requests. A stored key alone is not a connection check.</p>
            </section>
            <section aria-label="Knowledge">
                <h3>Knowledge</h3>
                <div class="knowledge">
                    <p class=${knowledge?.state === 'stale' ? 'stale' : ''}>${knowledge?.state === 'stale' ? 'Cached metadata · stale — server could not be refreshed' : knowledge?.state === 'current' ? 'Current in-memory dossier' : 'Knowledge metadata unavailable'}</p>
                    ${metadata?.dossier ? html`
                        <strong>${metadata.dossier.name}</strong>
                        <small>Dossier SHA256</small><code>${metadata.dossier.sha256}</code>
                        <small>Prompt version</small><span>${metadata.prompt.version}</span>
                        <small>Prompt SHA256</small><code>${metadata.prompt.sha256}</code>
                        ${metadata.evaluation ? html`<small>Evaluation profile</small><span>${metadata.evaluation.mode === 'offline' ? 'Offline evaluation' : 'Live evaluation'} · Not evaluated for shipping</span><small>Freeze SHA256</small><code>${metadata.evaluation.freezeId}</code>` : ''}
                    ` : ''}
                </div>
                <p>Read-only identity of the dossier loaded by the twin. Knowledge browsing comes later.</p>
            </section>
            <section aria-label="Connection and permission setup">
                <h3>Setup</h3>
                <button type="button" ?disabled=${!data?.canSetup || this.settingUp} @click=${this.openSetup}>Setup</button>
                <p>${this.message || (data && !data.canSetup ? 'Stop Listen before opening Setup.' : 'Open connection and permission setup.')}</p>
            </section>`;
    }
}
customElements.define('twin-insights-settings', TwinInsightsSettings);
