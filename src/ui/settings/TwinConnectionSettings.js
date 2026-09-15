import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';

export class TwinConnectionSettings extends LitElement {
    static properties = { state: { state: true }, replacementKey: { state: true }, meetingLink: { state: true }, enabled: { state: true }, saving: { state: true }, message: { state: true } };
    static styles = css`
        :host { display: block; border-top: 1px solid #ffffff25; margin-top: 12px; padding: 12px 0; color: #eee; font: 12px system-ui; }
        h2 { font-size: 14px; margin: 0 0 12px; } label { display: block; margin-top: 10px; }
        input[type=password], input[type=url] { box-sizing: border-box; width: 100%; padding: 9px; margin-top: 5px; border: 1px solid #ffffff30; border-radius: 6px; color: #fff; background: #ffffff0b; }
        input:focus { outline: 2px solid #8ebcf4; outline-offset: 1px; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 8px; }
        button { padding: 7px 12px; border: 1px solid #ffffff30; border-radius: 6px; color: #fff; background: #ffffff15; cursor: pointer; }
        button:disabled { opacity: .5; cursor: default; } p { line-height: 1.5; margin: 6px 0; color: #bbb; }
        .status { color: #dcecff; }
    `;
    constructor() {
        super(); this.state = { savedRevision: 0, appliedRevision: 0, state: 'applied', hasKey: false };
        this.replacementKey = ''; this.meetingLink = ''; this.enabled = false; this.saving = false; this.message = '';
        this.dirty = false; this.editRevision = 0;
    }
    edit() { if (!this.dirty) this.editRevision = this.state.savedRevision; this.dirty = true; }
    async connectedCallback() {
        super.connectedCallback();
        this.unsubscribe = window.api?.settingsView.onTwinSettingsUpdated?.(state => {
            this.state = state;
            if (!this.dirty) { this.editRevision = state.savedRevision; this.meetingLink = state.meetingLink || ''; this.enabled = state.enabled; }
        });
        try {
            const result = await window.api?.settingsView.getTwinSettings();
            if (result?.success) { this.state = result.data; this.editRevision = result.data.savedRevision; this.meetingLink = result.data.meetingLink || ''; this.enabled = result.data.enabled; }
            else this.message = 'Settings could not be read. Existing data has been preserved.';
        } catch { this.message = 'Settings could not be read. Existing data has been preserved.'; }
    }
    disconnectedCallback() { this.unsubscribe?.(); this.replacementKey = ''; super.disconnectedCallback(); }
    async save(action = 'save') {
        if (this.saving) return;
        this.saving = true; this.message = '';
        try {
            const payload = { expectedRevision: this.dirty ? this.editRevision : this.state.savedRevision, enabled: action === 'clear' ? false : this.enabled, meetingLink: action === 'clear' ? this.state.meetingLink || '' : this.meetingLink,
                credential: action === 'clear' ? { action: 'clear' } : action === 'retry' || !this.replacementKey ? { action: 'keep' } : { action: 'set', value: this.replacementKey } };
            const api = window.api.settingsView;
            const result = await (action === 'retry' ? api.retryTwinJoin(payload) : api.saveTwinSettings(payload));
            if (result.success) { this.state = result.data; this.editRevision = result.data.savedRevision; this.dirty = false; this.enabled = result.data.enabled ?? this.enabled; this.meetingLink = result.data.meetingLink ?? this.meetingLink; }
            else this.message = result.error === 'revision_conflict' ? 'Settings changed elsewhere. Reopen settings before saving.' : 'Could not save these settings. Existing data has been preserved.';
        } catch { this.message = 'Could not save these settings. Please try again.'; }
        finally { this.replacementKey = ''; this.saving = false; }
    }
    render() {
        const retry = ['waiting', 'failed', 'rate_limited', 'auth_failed', 'uncertain'].includes(this.state.operationState);
        return html`
            <form @submit=${e => { e.preventDefault(); this.save(); }}>
            <h2>Digital Twin · Meeting connection</h2>
            <label><input type="checkbox" .checked=${this.enabled} @change=${e => { this.edit(); this.enabled = e.target.checked; }}> Enable Fireflies</label>
            <label>Fireflies API key<input type="password" autocomplete="new-password" spellcheck="false" .value=${this.replacementKey} placeholder=${this.state.hasKey ? 'Key stored · enter a replacement' : 'Enter API key'} @input=${e => { this.edit(); this.replacementKey = e.target.value; }}></label>
            <p>${this.state.credentialStatus === 'locked' ? 'Stored key is locked. Replace it or clear it to recover.' : 'Leave the key field empty to keep the stored key.'}</p>
            <label>Google Meet link<input type="url" .value=${this.meetingLink} placeholder="https://meet.google.com/abc-defg-hij" @input=${e => { this.edit(); this.meetingLink = e.target.value; }}></label>
            <div class="actions">
                <button type="submit" ?disabled=${this.saving}>${this.saving ? 'Saving…' : 'Save'}</button>
                <button type="button" ?disabled=${this.saving || !this.state.hasKey} @click=${() => this.save('clear')}>Clear key</button>
                ${retry ? html`<button type="button" ?disabled=${this.saving} @click=${() => this.save('retry')}>Join again</button>` : ''}
            </div>
            <p class="status" role="status" aria-live="polite">${this.message || (this.state.state === 'pending' ? 'Saved · waiting for the twin server' : `Applied · revision ${this.state.appliedRevision}`)}</p>
            <p>${this.state.operationState || 'unconfigured'}${this.state.errorCode ? ' · ' + this.state.errorCode : ''}</p>
            <p>Joining may take time. Repeated saves and key replacement do not send another invitation.</p>
            </form>
        `;
    }
}
customElements.define('twin-connection-settings', TwinConnectionSettings);
