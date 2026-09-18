const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function component(api={}){const file=path.join(__dirname,'../src/ui/settings/McpConnectionsSettings.js');assert.ok(fs.existsSync(file),'MCP component exists');const context={window:{api:{settingsView:api}},customElements:{define(){}},LitElement:class{connectedCallback(){}disconnectedCallback(){}requestUpdate(){}},html:()=>'',css:()=>'',structuredClone,setInterval,clearInterval};vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class')+'\nglobalThis.Component=McpConnectionsSettings;',context);return new context.Component();}
const state={config:{schemaVersion:1,revision:0,connections:[]},savedRevision:0,state:'applied',credentialStatuses:[],runtime:null};
test('new MCP connection is disabled, credential input is write-only and cleared on every save outcome',async()=>{
 let payload;const c=component({newMcpIdentity:async()=>({success:true,data:'f10eeb54-5819-4e36-900e-289268ef1101'}),saveMcpSettings:async p=>{payload=p;return {success:true,data:{...state,savedRevision:1,config:p.config}};}});
 c.receive(state);await c.addConnection();assert.equal(c.draft.enabled,false);assert.equal(c.draft.allowedTools.length,0);
 await c.addCredential();c.secretValues.token='synthetic-password';await c.save();assert.equal(payload.credentials[0].value,'synthetic-password');assert.deepEqual(Object.keys(c.secretValues),[]);
 const failed=component({saveMcpSettings:async()=>{throw Error('synthetic-password');}});failed.receive({...state,config:payload.config,savedRevision:1});failed.editConnection(payload.config.connections[0]);failed.secretValues.token='synthetic-password';await failed.save();assert.deepEqual(Object.keys(failed.secretValues),[]);assert.ok(!failed.message.includes('synthetic-password'));
});
test('MCP polling preserves dirty edits and revision, Test requires saved state, endpoint edits revoke approval',async()=>{
 let tests=0;const c=component({testMcpConnection:async()=>{tests++;return {success:true,data:{connections:[]}};}});c.receive(state);
 c.editConnection({id:'fixture',name:'original',enabled:false,transport:'streamable-http',http:{url:'http://127.0.0.1:8765/mcp'},credentialBindings:[],allowedTools:[],knowledgeApproval:{contract:'dated-client-facts-v1'},limits:{connectMs:5000,callMs:5000,resultBytes:16384,maxCalls:4}});
 c.change('name','edited');c.receive({...state,savedRevision:3});assert.equal(c.draft.name,'edited');assert.equal(c.editRevision,0);await c.testConnection();assert.equal(tests,0);
 c.endpointChanged();assert.equal(c.draft.knowledgeApproval,null);assert.equal(c.tools.length,0);
 c.secretValues.token='synthetic';c.disconnectedCallback();assert.deepEqual(Object.keys(c.secretValues),[]);
});
test('MCP UI is added beside existing settings sections and uses safe Lit interpolation',()=>{
 const c=component();assert.equal(typeof c.render,'function');const source=fs.readFileSync(path.join(__dirname,'../src/ui/settings/SettingsView.js'),'utf8');assert.match(source,/<mcp-connections-settings/);assert.match(source,/<twin-connection-settings/);assert.match(source,/<twin-insights-settings/);
 const panel=fs.readFileSync(path.join(__dirname,'../src/ui/settings/McpConnectionsSettings.js'),'utf8');assert.ok(!/innerHTML|unsafeHTML/.test(panel));
});
test('disabled connection discovery remains reviewable across status polling',async()=>{
 const saved={id:'fixture',name:'Demo',enabled:false};const tool={name:'lookup',supported:true,definitionSha256:'a'.repeat(64)};
 const c=component({testMcpConnection:async()=>({success:true,data:{connections:[{id:'fixture',state:'ready',tools:[tool]}]}})});
 c.receive({...state,config:{...state.config,connections:[saved]}});c.editConnection(saved);await c.testConnection();assert.equal(c.tools.length,1);
 c.receive({...c.state,runtime:{connections:[{id:'fixture',state:'disabled',tools:[]}]}});assert.equal(c.tools.length,1);
});

test('adding after partial clear chooses unused slot and environment names',async()=>{
 const c=component({newMcpIdentity:async()=>({success:true,data:'f10eeb54-5819-4e36-900e-289268ef1104'})});c.receive(state);
 c.editConnection({id:'fixture',transport:'stdio',credentialBindings:[{slot:'token2',ref:'old',target:{kind:'env',name:'KNOWLEDGE_TOKEN'}}],knowledgeApproval:null});
 await c.addCredential();assert.equal(new Set(c.draft.credentialBindings.map(b=>b.slot)).size,2);assert.equal(new Set(c.draft.credentialBindings.map(b=>b.target.name.toUpperCase())).size,2);
});
