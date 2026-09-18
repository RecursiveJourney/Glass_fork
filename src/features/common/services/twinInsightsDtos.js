const fail = () => { throw Object.assign(new Error('runtime_invalid_response'), { code: 'runtime_invalid_response' }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
function knowledge(value) {
    if (!exact(value, value?.evaluation===undefined?['schemaVersion', 'dossier', 'prompt']:['schemaVersion', 'dossier', 'prompt', 'evaluation']) || value.schemaVersion !== 1) fail();
    if (value.dossier === null && value.prompt === null) return value;
    if (!exact(value.dossier, ['name', 'sha256']) || typeof value.dossier.name !== 'string' || !value.dossier.name || value.dossier.name.length > 256 || /[\\/\x00-\x1f]/.test(value.dossier.name) || !hash(value.dossier.sha256) ||
        !exact(value.prompt, ['version', 'sha256']) || !['wire-1','wire3-mcp-v1'].includes(value.prompt.version) || !hash(value.prompt.sha256)) fail();
    const e=value.evaluation;
    if(e!==undefined&&(!exact(e,['mode','freezeId','gate'])||!['offline','live'].includes(e.mode)||!hash(e.freezeId)||e.gate!=='not_evaluated'||value.prompt.version!=='wire3-mcp-v1'))fail();
    if(value.prompt.version==='wire3-mcp-v1'&&!e)fail();
    return value;
}
function status(value) {
    if (!exact(value, ['schemaVersion', 'observedAt', 'gemini', 'fireflies']) || value.schemaVersion !== 1 || !timestamp(value.observedAt)) fail();
    const g = value.gemini;
    if (!exact(g, ['model', 'state', 'inFlight', 'observedAt', 'errorCode']) || !['unconfigured', 'not_tested', 'generating', 'succeeded', 'failed'].includes(g.state) ||
        g.model !== null && (typeof g.model !== 'string' || !/^gemini-[a-z0-9._-]{1,100}$/i.test(g.model)) || !Number.isSafeInteger(g.inFlight) || g.inFlight < 0 ||
        g.observedAt !== null && !timestamp(g.observedAt) || ![null, 'network', 'timeout', 'empty', 'http', 'internal', 'authentication', 'rate_limited'].includes(g.errorCode) ||
        !exact(value.fireflies, ['state']) || !['unconfigured', 'applying', 'joining', 'waiting', 'connected', 'disconnected', 'failed', 'rate_limited', 'auth_failed', 'uncertain', 'disabled', 'credential_missing', 'meeting_missing'].includes(value.fireflies.state)) fail();
    return value;
}
module.exports = { knowledge, status };
