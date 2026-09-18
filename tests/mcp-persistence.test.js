const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
for (const scenario of ['migration','migration_rollback','rollback','binding','locked','corrupt','unknown','rotation','registration','status','partial_clear']) test('MCP native persistence: ' + scenario, { timeout: 20000 }, async () => {
  const child = spawn(require('electron'), [path.join(__dirname,'helpers/mcp-persistence.cjs'),scenario], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.resume();
  const timer = setTimeout(() => child.kill(),15000);
  const code = await new Promise((resolve,reject) => { child.once('close',resolve); child.once('error',reject); }).finally(() => clearTimeout(timer));
  assert.equal(code,0,'native scenario failed: '+output.trim()); assert.match(output,/MCP_PERSISTENCE_PASS/);
});
