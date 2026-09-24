const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dto=require('../src/features/common/services/twinInsightsDtos');
const {projectState}=require('../src/features/common/services/mcpRuntimeClient');
const {SettingsInsightsService}=require('../src/features/settings/settingsInsightsService');
const freeze='56255ef79397c686ecc73c66f3fc16537dc319931c339a21665be294221a8a7b';
const activation=()=>({requestedProfile:'wire3-mcp-v1',activeProfile:'wire3-mcp-v1',state:'gate_passed',errorCode:null,gate:'passed',freezeId:freeze});
const knowledge=()=>({schemaVersion:1,dossier:{name:'demo.txt',sha256:'a'.repeat(64)},prompt:{version:'wire3-mcp-v1',sha256:'b'.repeat(64)},evaluation:{mode:'production',gate:'passed',freezeId:freeze},activation:activation()});
const execution=()=>({state:'stopped',errorCode:'model_cost_limit',reportedCostUsd:10.01,thresholdsUsd:{warn:2,stop:10},unknownBilledAttempts:0});
const mcp=()=>({state:'stopped',totalConnections:1,readyConnections:1,errorCode:'model_cost_limit',cost:{reportedUsd:10.01,warnUsd:2,stopUsd:10,unknownBilledAttempts:0}});
const status=()=>({schemaVersion:1,observedAt:1,gemini:{model:'gemini-3.8-flash',state:'not_tested',inFlight:0,observedAt:null,errorCode:null},fireflies:{state:'disabled'},mcp:mcp()});
const runtime=()=>({component:'digital-twin',protocolVersion:1,instanceId:'fixture',appliedRevision:1,operationId:null,inferenceEnabled:true,activation:activation(),execution:execution(),connections:[{id:'fixture',name:'Fixture',state:'ready',generation:1,catalogRevision:1,lastSuccess:1,errorCode:null,retryAt:null,activeCalls:0,protocolVersion:'2025-11-25',tools:[{name:'lookup',description:'fixture',definitionSha256:'a'.repeat(64),supported:true,blockedReason:null,allowed:true,liveUse:{state:'blocked',reason:'not_evaluated'}}]}]});
function component(name){const context={window:{api:{settingsView:{}}},customElements:{define(){}},LitElement:class{},html:(s,...v)=>s.reduce((a,x,i)=>a+x+(Array.isArray(v[i])?v[i].join(''):v[i]??''),''),css:()=>'',structuredClone,setInterval,clearInterval,setTimeout,clearTimeout,Date};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/settings/'+name+'.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class')+'\nglobalThis.Component='+name+';',context);return new context.Component();}
test('production Knowledge accepts verified activation and rejects forged claims or nested secrets',()=>{
 assert.deepEqual(dto.knowledge(knowledge()),knowledge());
 for(const mutate of [k=>delete k.activation,k=>k.activation.freezeId='c'.repeat(64),k=>k.activation.secret='synthetic',k=>k.evaluation.gate='not_evaluated',k=>k.evaluation.mode='offline',k=>k.prompt.version='wire-1']){const k=knowledge();mutate(k);assert.throws(()=>dto.knowledge(k));}
 for(const state of ['rollback_selected','activation_failed']){const k=knowledge();delete k.evaluation;k.prompt.version='wire-1';k.activation={requestedProfile:state==='rollback_selected'?'wire-1':'wire3-mcp-v1',activeProfile:'wire-1',state,errorCode:state==='activation_failed'?'activation_asset_mismatch':null,gate:null,freezeId:state==='rollback_selected'?null:freeze};assert.deepEqual(dto.knowledge(k),k);}
});
test('production status and MCP control carry strict metadata only including stopped and per-tool eligibility',()=>{
 assert.deepEqual(dto.status(status()),status());assert.deepEqual(projectState(runtime()),runtime());
 for(const mutate of [r=>r.activation.token='synthetic',r=>r.execution.thresholdsUsd.key='synthetic',r=>r.execution.errorCode='arbitrary_error',r=>r.connections[0].tools[0].liveUse.secret='synthetic',r=>r.connections[0].tools[0].liveUse={state:'eligible',reason:'not_evaluated'}]){const r=runtime();mutate(r);assert.throws(()=>projectState(r));}
 const invalid=status();invalid.mcp.cost.secret='synthetic';assert.throws(()=>dto.status(invalid));
 const stopped=runtime();stopped.execution.errorCode='invalid_production_cost_limits';stopped.execution.thresholdsUsd=null;assert.deepEqual(projectState(stopped),stopped);
});
test('settings service forwards stopped MCP state and marks it unavailable after server loss',async()=>{
 let down=false;const service=new SettingsInsightsService({client:{getStatus:async()=>{if(down)throw Error();return status();},getKnowledge:async()=>{if(down)throw Error();return knowledge();}},listenService:{getTranscriptionStatus:()=>({source:'local',phase:'idle',state:'idle',provider:null,model:null})}});
 assert.deepEqual((await service.read()).mcp,mcp());down=true;const stale=await service.read();assert.equal(stale.mcp.state,'unavailable');assert.equal(stale.knowledge.state,'stale');
});
test('Knowledge renders production gate, failure or rollback and Components shows nonfatal cost stop',()=>{
 const c=component('TwinInsightsSettings');c.data={server:{state:'reachable'},gemini:status().gemini,fireflies:{state:'disabled'},mcp:mcp(),knowledge:{state:'current',data:knowledge()},canSetup:true};let text=c.render();
 for(const value of ['Gate passed',freeze,'wire3-mcp-v1','MCP','Paused','model_cost_limit','$10','Not tested','Setup'])assert.ok(text.includes(value),value);assert.ok(!text.includes('Not evaluated for shipping'));
 c.data.knowledge.state='stale';assert.match(c.render(),/stale/);
 c.data.knowledge.data.activation={state:'activation_failed',activeProfile:'wire-1',errorCode:'activation_asset_mismatch'};delete c.data.knowledge.data.evaluation;c.data.knowledge.data.prompt.version='wire-1';text=c.render();assert.match(text,/activation_asset_mismatch/);assert.match(text,/wire-1/);
 c.data.knowledge.data.activation={state:'rollback_selected',activeProfile:'wire-1'};assert.match(c.render(),/Rollback selected/);
});
test('MCP panel preserves controls and separates approval from evaluated live use and facts',()=>{
 const c=component('McpConnectionsSettings');c.state={config:{connections:[]},runtime:runtime()};assert.match(c.render(),/Gate passed/);assert.doesNotMatch(c.render(),/awaits the frozen/);
 for(const [reason,label] of [['not_evaluated','Not evaluated for live use'],['not_approved','Not approved'],['selection_conflict','Choose one'],['disabled','Disabled'],['not_ready','Not ready'],['profile_inactive','Profile inactive'],['eligible','Eligible']])assert.ok(c.toolLiveLabel({liveUse:{state:reason==='eligible'?'eligible':'blocked',reason}}).includes(label),reason);
 c.state.runtime=null;assert.equal(c.toolLiveLabel({liveUse:{state:'eligible',reason:'eligible'}}),'Unavailable');
});
