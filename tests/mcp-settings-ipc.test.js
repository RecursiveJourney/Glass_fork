const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
function fixture(){
 const handlers=new Map(),source=fs.readFileSync(path.join(__dirname,'../src/bridge/featureBridge.js'),'utf8'),stubs={};
 for(const [,id]of source.matchAll(/require\('([^']+)'\)/g))stubs[id]=new EventEmitter();
 const sender={mainFrame:{},getURL:()=> 'file:///fixture/src/ui/settings.html'},win={isDestroyed:()=>false,webContents:sender};
 stubs.electron={ipcMain:{handle:(n,f)=>handlers.set(n,f),on:()=>{}},app:{getAppPath:()=>'/fixture'},BrowserWindow:{fromWebContents:()=>win,getAllWindows:()=>[]}};
 stubs['../features/common/services/localAIManager'].startPeriodicSync=()=>{};
 stubs['../window/windowManager']={windowPool:new Map([['settings',win]])};
 const calls=[];stubs['../features/settings/mcpSettingsService']={getMcpSettingsService:()=>({getState:()=>({state:'applied'}),save:async p=>{calls.push(p);return {state:'pending'};},test:async p=>{calls.push(p);return {state:'ready'};}})};
 const module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source+'\n})')(id=>stubs[id],module,module.exports);module.exports.initialize();
 return {handlers,event:{sender,senderFrame:sender.mainFrame},calls,stubs};
}
test('MCP IPC accepts only Settings main frame and provides narrow get/save/test routes',async()=>{
 const f=fixture();for(const name of ['mcp:settings','mcp:save','mcp:test','mcp:new-identity','mcp:approve-knowledge'])assert.equal(typeof f.handlers.get(name),'function');
 assert.deepEqual(await f.handlers.get('mcp:settings')(f.event),{success:true,data:{state:'applied'}});
 assert.equal((await f.handlers.get('mcp:save')({...f.event,senderFrame:{}},{})).success,false);assert.equal(f.calls.length,0);
 f.stubs['../window/windowManager'].windowPool.clear();assert.equal((await f.handlers.get('mcp:save')(f.event,{})).success,false);
});
test('MCP preload exposes operations without credential-read or arbitrary channel APIs',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/preload.js'),'utf8');for(const route of ['mcp:settings','mcp:save','mcp:test'])assert.ok(source.includes("invoke('"+route+"'"));assert.ok(!source.includes("invoke('mcp:credential'"));
});
