const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
function load(file,stubs){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features',file),'utf8'),{module,exports:module.exports,require:id=>id in stubs?stubs[id]:require(id),console:{log(){},warn(){},error(){}},AbortController,TextDecoder,Buffer,setTimeout,clearTimeout,process});return module.exports;}
function listen(){class Unit{setCallbacks(){}}return load('listen/listenService.js',{'./stt/sttService':Unit,'./summary/summaryService':Unit,'../common/services/authService':{},'../common/repositories/session':{},'./stt/repositories':{},'../../bridge/internalBridge':new EventEmitter(),'../../window/windowManager':{windowPool:new Map()}});}
test('Meeting Listen awaits MCP reconciliation, pending blocks feed and Stop prevents late dispatch',async()=>{
 const l=listen();assert.equal(typeof l.setMcpSettingsService,'function');await l.selectSource('meeting');let starts=0,release;
 l.startMeetingFeed=()=>{starts++;return {success:true};};l.setMcpSettingsService({ensureApplied:async()=>({success:false})});
 assert.equal((await l.handleListenRequest('Listen')).error,'mcp_settings_pending');assert.equal(starts,0);
 l.setMcpSettingsService({ensureApplied:()=>new Promise(r=>release=r)});const pending=l.handleListenRequest('Listen');await l.handleListenRequest('Stop');release({success:true});assert.equal((await pending).error,'listen_cancelled');assert.equal(starts,0);
 l.setMcpSettingsService({ensureApplied:async()=>({success:true})});assert.equal((await l.handleListenRequest('Listen')).success,true);assert.equal(starts,1);
});
function ask(screenshot=async()=>[]){let calls=0;const win={isDestroyed:()=>false,webContents:{send(){}}};const service=load('ask/askService.js',{'electron':{desktopCapturer:{getSources:screenshot}},'../common/ai/factory':{createStreamingLLM:()=>({streamChat:async()=>{calls++;return {body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{}})}};}})},'../../window/windowManager':{windowPool:new Map([['ask',win]])},'../../bridge/internalBridge':new EventEmitter(),'../common/repositories/session':{getOrCreateActive:async()=> 'fixture'},'./repositories':{addAiMessage:async()=>{}},'../common/prompts/promptBuilder':{getSystemPrompt:()=>''},'../common/services/modelStateService':{getCurrentModelInfo:async()=>({provider:'ollama',model:'rj-twin',apiKey:'synthetic'})}});return {service,calls:()=>calls};}
test('Twin Ask awaits MCP reconciliation; pending and cancelled requests never dispatch',async()=>{
 const {service:a,calls}=ask();assert.equal(typeof a.setMcpSettingsService,'function');a.setMcpSettingsService({ensureApplied:async()=>({success:false})});assert.equal((await a.sendMessage('fixture')).error,'mcp_settings_pending');assert.equal(calls(),0);
 let release;a.setMcpSettingsService({ensureApplied:()=>new Promise(r=>release=r)});const p=a.sendMessage('fixture');while(!release)await new Promise(r=>setImmediate(r));await a.closeAskWindow();release({success:true});assert.equal((await p).success,false);assert.equal(calls(),0);
 a.setMcpSettingsService({ensureApplied:async()=>({success:true})});assert.equal((await a.sendMessage('fixture')).success,true);assert.equal(calls(),1);
});
test('MCP reconciliation occurs after screenshot capture and Fireflies reconciliation',async()=>{
 let release,pending=false;const {service:a,calls}=ask(()=>new Promise(r=>release=r));a.setMcpSettingsService({ensureApplied:async()=>({success:!pending})});const request=a.sendMessage('fixture');while(!release)await new Promise(r=>setImmediate(r));pending=true;release([]);assert.equal((await request).error,'mcp_settings_pending');assert.equal(calls(),0);
});
test('MCP reconciliation occurs after Fireflies reconciliation',async()=>{
 const l=listen();await l.selectSource('meeting');let started=0,firefliesRelease,pending=false;l.startMeetingFeed=()=>{started++;return {success:true};};l.setMcpSettingsService({ensureApplied:async()=>({success:!pending})});l.setRuntimeSettingsService({ensureApplied:()=>new Promise(r=>firefliesRelease=r)});const listenRequest=l.handleListenRequest('Listen');while(!firefliesRelease)await new Promise(r=>setImmediate(r));pending=true;firefliesRelease({success:true});assert.equal((await listenRequest).error,'mcp_settings_pending');assert.equal(started,0);
});
