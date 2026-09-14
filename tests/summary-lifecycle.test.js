const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(options = {}) {
    let resolve, dispatched;
    const gate = new Promise(r => { resolve = r; }), started = new Promise(r => { dispatched = r; });
    const calls = [], module = { exports: {} };
    const stubs = {
        electron: {}, '../../common/prompts/promptBuilder.js': { getSystemPrompt: () => '{{CONVERSATION_HISTORY}}' },
        '../../common/ai/factory': { createLLM: () => ({ chat: () => { dispatched(); return gate; } }) },
        '../../common/services/modelStateService': { getCurrentModelInfo: async () => ({ provider: 'test', model: 'test', apiKey: 'synthetic' }) },
        '../../common/repositories/session': { touch: async id => calls.push(['touch', id]) },
        './repositories': { saveSummary: value => { calls.push(['save', value]); return options.saveSummary?.(value); } },
        '../../../window/windowManager': { windowPool: new Map([['listen', { isDestroyed: () => false, webContents: { send: (...args) => calls.push(['render', ...args]) } }]]) },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/features/listen/summary/summaryService.js'), 'utf8'), { module, require: id => stubs[id], console: { log() {}, error() {} } });
    return { service: new module.exports(), calls, started, resolve };
}
test('reset clears summary session identity', () => {
    const h = harness(); h.service.setSessionId('old'); h.service.resetConversationHistory();
    assert.equal(h.service.currentSessionId, null);
});
test('late summary completion after reset cannot save, render, or overwrite the new lifecycle', async () => {
    const h = harness(); h.service.setSessionId('old'); h.service.conversationHistory = Array(5).fill('Me: previous');
    const pending = h.service.triggerAnalysisIfNeeded(); await h.started;
    h.service.resetConversationHistory(); h.service.setSessionId('new');
    h.resolve({ content: '**Summary Overview**\n- stale\n**Key Topic: old**\n- stale detail' }); await pending;
    assert.equal(h.calls.some(call => call[0] === 'save' || call[0] === 'render'), false);
    assert.equal(h.service.previousAnalysisResult, null); assert.equal(h.service.analysisHistory.length, 0);
});
test('reset during a pending summary save prevents late rendering and analysis state changes', async () => {
    let resolveSave, signalSaving;
    const saveGate = new Promise(resolve => { resolveSave = resolve; });
    const saving = new Promise(resolve => { signalSaving = resolve; });
    const h = harness({ saveSummary: () => { signalSaving(); return saveGate; } });
    h.service.setSessionId('old'); h.service.conversationHistory = Array(5).fill('Me: previous');
    let analysisCallbacks = 0;
    h.service.setCallbacks({ onAnalysisComplete: () => { analysisCallbacks++; } });
    const pending = h.service.triggerAnalysisIfNeeded(); await h.started;
    h.resolve({ content: '**Summary Overview**\n- previous\n**Key Topic: old**\n- previous detail' });
    await saving;
    assert.equal(h.calls.find(call => call[0] === 'save')[1].sessionId, 'old');
    h.service.resetConversationHistory(); h.service.setSessionId('new');
    resolveSave(); await pending;
    assert.equal(h.calls.some(call => call[0] === 'render'), false);
    assert.equal(analysisCallbacks, 0);
    assert.equal(h.service.currentSessionId, 'new');
    assert.equal(h.service.previousAnalysisResult, null);
    assert.equal(h.service.analysisHistory.length, 0);
    assert.equal(h.service.conversationHistory.length, 0);
});
