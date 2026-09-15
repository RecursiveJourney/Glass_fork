import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
export class WindowSizeControls extends LitElement {
    static properties = { state: { state: true }, message: { state: true } };
    static styles = css`
        :host {
            display: block;
            flex: 0 0 auto;
            padding: 5px 10px;
            box-sizing: border-box;
            -webkit-app-region: no-drag;
        }
        button {
            color: #cbd3db;
            background: transparent;
            border: 1px solid #ffffff30;
            border-radius: 5px;
            font:
                11px/16px Arial,
                sans-serif;
            cursor: pointer;
        }
        button:disabled {
            opacity: 0.45;
            cursor: default;
        }
        button:focus-visible {
            outline: 2px solid #9bbfff;
        }
        small {
            color: #efc483;
            display: block;
            font:
                11px/16px Arial,
                sans-serif;
        }
    `;
    connectedCallback() {
        super.connectedCallback();
        this.active = true;
        this.revision = (this.revision || 0) + 1;
        const api = window.api?.windowSizing;
        this.off = api?.onChanged(state => {
            this.revision++;
            this.apply(state);
        });
        const revision = this.revision;
        api?.get()
            .then(result => {
                if (this.active && revision === this.revision && result.data) this.apply(result.data);
            })
            .catch(() => {});
    }
    disconnectedCallback() {
        this.active = false;
        this.revision++;
        this.off?.();
        super.disconnectedCallback();
    }
    apply(state) {
        if (!this.active) return;
        this.state = state;
        const view = this.getRootNode().host;
        const wasUser = view.sizeOwner === 'user';
        view.sizeOwner = state.owner;
        view.toggleAttribute('user-sized', state.owner === 'user');
        view.requestUpdate();
        if (wasUser && state.owner === 'automatic') {
            view._lastHeight = null;
            view.updateComplete.then(() => {
                if (this.active) view.adjustWindowHeight?.();
            });
        }
    }
    async reset() {
        const revision = ++this.revision;
        try {
            const result = await window.api.windowSizing.reset();
            if (!this.active || this.revision !== revision) return;
            if (result.data) this.apply(result.data);
            this.message = result.success ? '' : 'Size could not be reset.';
        } catch {
            if (this.active) this.message = 'Size could not be reset.';
        }
    }
    render() {
        return html`<button type="button" ?disabled=${this.state?.owner !== 'user' || this.state?.dragging} @click=${this.reset}>
                Reset to automatic size
            </button>
            ${this.state?.persistenceError ? html`<small role="status">Window size could not be saved.</small>` : ''}${this.message
                ? html`<small role="status">${this.message}</small>`
                : ''}`;
    }
}
customElements.define('window-size-controls', WindowSizeControls);
