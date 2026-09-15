import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { updateFeedRows } from './keyedFeedRows.js';

export class SuggestionsView extends LitElement {
    static properties = { snapshot: { type: Object } };
    static styles = css`
        :host { display:block; min-height:0; color:#f0f5f7; }
        .suggestions-container { height:var(--meeting-pane-height,200px); max-height:var(--meeting-pane-max,260px); overflow-y:auto; overflow-anchor:none; padding:8px 12px; box-sizing:border-box; user-select:text; }
        article { border-left:2px solid #93ceb7; padding:10px 12px; margin:0 0 10px; background:rgba(147,206,183,.07); border-radius:2px 8px 8px 2px; font-size:13px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
        .empty { padding:10px 12px; color:#b2bec5; font-size:12px; }
    `;
    constructor() { super(); this.snapshot = null; this._rows = new Map(); this._instance = null; }
    updated() {
        const container = this.shadowRoot.querySelector('.suggestions-container');
        if (!container) return;
        const snapshot = this.snapshot;
        const rows = (snapshot?.suggestions || []).slice(-(snapshot?.suggestionHistoryLimit || 20)).filter(row => !row.noSuggestion);
        updateFeedRows(container, rows, this._rows, row => JSON.stringify([snapshot.instanceId, row.attemptId]),
            () => document.createElement('article'), (node, row) => { node.textContent = row.text; }, this._instance !== snapshot?.instanceId);
        this._instance = snapshot?.instanceId;
    }
    getSuggestionsText() { return (this.snapshot?.suggestions || []).filter(row => !row.noSuggestion).map(row => row.text).join('\n\n'); }
    render() {
        const visible = this.snapshot?.suggestions?.some(row => !row.noSuggestion);
        return html`<div class="suggestions-container" role="log" aria-label="Automatic suggestions"></div>
            ${visible ? '' : html`<div class="empty">${this.snapshot?.generation?.state === 'running' ? 'Preparing a suggestion…' : 'Suggestions appear here when ready.'}</div>`}`;
    }
}
customElements.define('suggestions-view', SuggestionsView);
