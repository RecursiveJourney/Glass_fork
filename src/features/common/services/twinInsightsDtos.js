const fail = () => { throw Object.assign(new Error('runtime_invalid_response'), { code: 'runtime_invalid_response' }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const activationErrors = ['invalid_profile_selection','activation_record_missing','activation_record_mismatch','activation_asset_missing','activation_asset_mismatch','activation_model_mismatch','activation_dossier_mismatch','activation_prompt_mismatch','activation_tools_mismatch','candidate_load_failed'];
const executionErrors = ['model_cost_limit','model_usage_invalid','model_usage_unavailable','model_usage_persistence_failed','model_usage_duplicate','model_version_changed','invalid_production_cost_limits'];
function activation(a) {
    if (!exact(a,['requestedProfile','activeProfile','state','errorCode','gate','freezeId'])) fail();
    if (a.state === 'gate_passed') { if (a.requestedProfile !== 'wire3-mcp-v1' || a.activeProfile !== 'wire3-mcp-v1' || a.errorCode !== null || a.gate !== 'passed' || !hash(a.freezeId)) fail(); }
    else if (a.state === 'rollback_selected') { if (a.requestedProfile !== 'wire-1' || a.activeProfile !== 'wire-1' || a.errorCode !== null || a.gate !== null || a.freezeId !== null) fail(); }
    else if (a.state === 'activation_failed') { if (!['wire3-mcp-v1','invalid'].includes(a.requestedProfile) || a.activeProfile !== 'wire-1' || !activationErrors.includes(a.errorCode) || a.gate !== null || !hash(a.freezeId)) fail(); }
    else fail();
    return a;
}
function execution(e) {
    if (!exact(e,['state','errorCode','reportedCostUsd','thresholdsUsd','unknownBilledAttempts']) || !['ready','generating','stopped'].includes(e.state) || !Number.isFinite(e.reportedCostUsd) || e.reportedCostUsd < 0 || !timestamp(e.unknownBilledAttempts) || e.errorCode !== null && !executionErrors.includes(e.errorCode) || (e.state === 'stopped') !== (e.errorCode !== null)) fail();
    if (e.thresholdsUsd !== null && (!exact(e.thresholdsUsd,['warn','stop']) || !Number.isFinite(e.thresholdsUsd.warn) || !Number.isFinite(e.thresholdsUsd.stop) || e.thresholdsUsd.warn <= 0 || e.thresholdsUsd.warn >= e.thresholdsUsd.stop)) fail();
    if (e.thresholdsUsd === null && e.errorCode !== 'invalid_production_cost_limits') fail();
    return e;
}
function liveUse(t) {
    if (!exact(t,['state','reason']) || !['eligible','blocked'].includes(t.state) || !['eligible','not_evaluated','disabled','not_approved','selection_conflict','unsupported_schema','not_ready','profile_inactive'].includes(t.reason) || (t.state === 'eligible') !== (t.reason === 'eligible')) fail();
    return t;
}
function mcp(m) {
    if (!exact(m,['state','totalConnections','readyConnections','errorCode','cost']) || !['disabled','no_eligible_tools','not_ready','selection_conflict','ready','generating','stopped'].includes(m.state) || ![m.totalConnections,m.readyConnections].every(n=>timestamp(n)&&n<=8) || m.readyConnections > m.totalConnections || m.errorCode !== null && !executionErrors.includes(m.errorCode)) fail();
    if (m.cost !== null) { const c=m.cost; if (!exact(c,['reportedUsd','warnUsd','stopUsd','unknownBilledAttempts']) || ![c.reportedUsd,c.warnUsd,c.stopUsd].every(n=>Number.isFinite(n)&&n>=0) || c.warnUsd <= 0 || c.warnUsd >= c.stopUsd || !timestamp(c.unknownBilledAttempts)) fail(); }
    return m;
}
function knowledge(value) {
    const keys=['schemaVersion','dossier','prompt',...(value?.evaluation===undefined?[]:['evaluation']),...(value?.activation===undefined?[]:['activation'])];
    if (!exact(value,keys) || value.schemaVersion !== 1) fail();
    if (value.dossier === null && value.prompt === null) { if (value.evaluation || value.activation) fail(); return value; }
    if (!exact(value.dossier,['name','sha256']) || typeof value.dossier.name !== 'string' || !value.dossier.name || value.dossier.name.length > 256 || /[\\/\x00-\x1f]/.test(value.dossier.name) || !hash(value.dossier.sha256) || !exact(value.prompt,['version','sha256']) || !['wire-1','wire3-mcp-v1'].includes(value.prompt.version) || !hash(value.prompt.sha256)) fail();
    const e=value.evaluation,a=value.activation;
    if (a !== undefined) { activation(a); if (a.activeProfile !== value.prompt.version) fail(); }
    if (e !== undefined) {
        if (!exact(e,['mode','freezeId','gate']) || !['offline','live','production'].includes(e.mode) || !hash(e.freezeId) || value.prompt.version !== 'wire3-mcp-v1') fail();
        if (e.mode === 'production') { if (e.gate !== 'passed' || a?.state !== 'gate_passed' || a.freezeId !== e.freezeId) fail(); }
        else if (e.gate !== 'not_evaluated' || a) fail();
    }
    if (value.prompt.version === 'wire3-mcp-v1' && !e) fail();
    return value;
}
function status(value) {
    if (!exact(value, ['schemaVersion', 'observedAt', 'gemini', 'fireflies', ...(value?.mcp === undefined ? [] : ['mcp'])]) || value.schemaVersion !== 1 || !timestamp(value.observedAt)) fail();
    if (value.mcp !== undefined) mcp(value.mcp);
    const g = value.gemini;
    if (!exact(g, ['model', 'state', 'inFlight', 'observedAt', 'errorCode']) || !['unconfigured', 'not_tested', 'generating', 'succeeded', 'failed'].includes(g.state) ||
        g.model !== null && (typeof g.model !== 'string' || !/^gemini-[a-z0-9._-]{1,100}$/i.test(g.model)) || !Number.isSafeInteger(g.inFlight) || g.inFlight < 0 ||
        g.observedAt !== null && !timestamp(g.observedAt) || ![null, 'network', 'timeout', 'empty', 'http', 'internal', 'authentication', 'rate_limited'].includes(g.errorCode) ||
        !exact(value.fireflies, ['state']) || !['unconfigured', 'applying', 'joining', 'waiting', 'connected', 'disconnected', 'failed', 'rate_limited', 'auth_failed', 'uncertain', 'disabled', 'credential_missing', 'meeting_missing'].includes(value.fireflies.state)) fail();
    return value;
}
module.exports = { knowledge, status, activation, execution, liveUse };
