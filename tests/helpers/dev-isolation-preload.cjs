// Ordinary Glass entry with native Electron, DB, storage, and services; no paid network.
require('./dev-network-deny.cjs');
function installNativeProbe() {
    const { app, BrowserWindow, session, dialog } = require('electron');
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const src = path.resolve(__dirname, '../../src');
    const trace = row => fs.appendFileSync(process.env.ISOLATION_TRACE, JSON.stringify(row) + '\n');
    app.disableHardwareAcceleration();
    app.setAsDefaultProtocolClient = () => { throw Error('isolated_profile_must_not_register_protocol'); };
    dialog.showErrorBox = () => { trace({ kind: 'startup-error' }); app.exit(1); };
    BrowserWindow.prototype.show = function() {};
    app.whenReady().then(() => {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            const u = new URL(details.url);
            const allow = ['file:', 'devtools:', 'about:', 'data:'].includes(u.protocol) || ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
            if (!allow) trace({ kind: 'denied', transport: 'chromium' });
            callback({ cancel: !allow });
        });
        let attempts = 0;
        const timer = setInterval(async () => {
            if (!BrowserWindow.getAllWindows().length) { if (++attempts > 150) { clearInterval(timer); trace({ kind: 'startup-timeout' }); app.exit(1); } return; }
            clearInterval(timer);
            try {
                const db = require(path.join(src, 'features/common/services/databaseInitializer'));
                assert.equal(db.existedAtStartup, false);
                assert.equal(db.dbPath, path.join(process.env.GLASS_USER_DATA_DIR, 'pickleglass.db'));
                const twin = require(path.join(src, 'features/settings/twinSettingsService')).getTwinSettingsService().getState();
                const mcp = require(path.join(src, 'features/settings/mcpSettingsService')).getMcpSettingsService().getState();
                assert.equal(twin.hasKey, false); assert.equal(twin.enabled, false); assert.equal(mcp.config.connections.length, 0);
                const ollama = require(path.join(src, 'features/common/services/ollamaService'));
                assert.equal(await ollama.isServiceRunning(), true);
                await ollama.makeRequest('/api/tags');
                await ollama.getInstalledModelsList();
                const manager = require(path.join(src, 'features/common/services/localAIManager'));
                assert.equal((await manager.repairService('ollama')).error, 'externally_managed_service');
                assert.equal((await ollama.handleInstall()).error, 'externally_managed_service');
                const provider = require(path.join(src, 'features/common/ai/providers/ollama'));
                assert.equal((await provider.OllamaProvider.validateApiKey()).success, true);
                await provider.createLLM({ model: 'rj-twin' }).generateContent(['Synthetic isolation smoke']);
                await provider.createLLM({ model: 'rj-twin' }).chat([{role:'user',content:'Synthetic isolation smoke'}]);
                const stream = await provider.createStreamingLLM({ model: 'rj-twin' }).streamChat([{role:'user',content:'Synthetic isolation smoke'}]);
                const reader = stream.body.getReader(); while (!(await reader.read()).done) {}
                const { TwinRuntimeClient } = require(path.join(src, 'features/common/services/twinRuntimeClient'));
                const client = new TwinRuntimeClient(); await client.getState(); await client.getKnowledge(); await client.getStatus();
                const { McpRuntimeClient } = require(path.join(src, 'features/common/services/mcpRuntimeClient')); await new McpRuntimeClient().getState();
                const Feed = require(path.join(src, 'features/listen/meeting/meetingFeedService'));
                const feed = new Feed(); feed.start(); await new Promise(r => setTimeout(r, 250)); feed.stop();
                const record = { kind: 'native-result', profile: app.getPath('userData'), sessionData: app.getPath('sessionData'),
                    dbPath: db.dbPath, freshDatabase: !db.existedAtStartup, firefliesKey: twin.hasKey, connections: mcp.config.connections.length,
                    windows: BrowserWindow.getAllWindows().length, electron: process.versions.electron, protocolRegistration: false };
                assert.equal(record.profile, process.env.GLASS_USER_DATA_DIR);
                assert.equal(record.sessionData, process.env.GLASS_USER_DATA_DIR);
                trace(record); app.quit();
            } catch (e) { trace({ kind: 'smoke-error', message: e.message }); app.exit(1); }
        }, 100);
    });
}

const Module = require('node:module');
const probePath = require('node:path');
const entryPath = probePath.resolve(__dirname, '../../src/index.js');
const originalLoad = Module._load;
let installed = false;
Module._load = function(request, parent, isMain) {
    if (!installed && probePath.resolve(request) === entryPath) {
        installed = true; installNativeProbe();
    }
    return originalLoad.apply(this, arguments);
};
