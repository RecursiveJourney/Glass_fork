const assert = require('node:assert/strict');
const { app } = require('electron');
const before = app.getPath('userData');
const helper = require('../../wire3-mcp-ui.cjs');
assert.equal(typeof helper.prepareOfflineLaunch, 'function');
assert.equal(app.getPath('userData'), before);
process.stdout.write('MCP_LAUNCH_IMPORT:inert\n');
app.exit(0);
