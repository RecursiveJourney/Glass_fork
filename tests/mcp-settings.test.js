const test=require('node:test'),assert=require('node:assert/strict');
let Service;try{({McpSettingsService:Service}=require('../src/features/settings/mcpSettingsService'));}catch{}
function fixture(){
 assert.equal(typeof Service,'function');let row={installation_id:'fixture',desired_revision:0,config:{schemaVersion:1,revision:0,connections:[]},outbox:null};
 let server={component:'digital-twin',protocolVersion:1,instanceId:'server',appliedRevision:0,operationId:null,connections:[]};let calls=0;const registered=[];
 const repo={read:()=>structuredClone(row),resolveCredentials:()=>[],commit({expectedRevision,config}){assert.equal(expectedRevision,row.desired_revision);row={...row,desired_revision:config.revision,config,outbox:{operation_id:'op-'+config.revision,desired_revision:config.revision,state:'pending',applied_revision:0}};},acknowledge(revision,instance){if(row.desired_revision===revision)Object.assign(row.outbox,{state:'applied',applied_revision:revision,server_instance:instance});},pending(code){if(row.outbox)Object.assign(row.outbox,{state:'pending',last_error_code:code});}};
 const client={getState:async()=>server,apply:async p=>{calls++;assert.equal(p.installationId,'fixture');server={...server,appliedRevision:p.desiredRevision,operationId:p.operationId};return server;},test:async()=>server};
 const service=new Service({repository:repo,client,registerSecrets:xs=>registered.push(...xs)});
 return {service,repo,client,registered,calls:()=>calls,restart:()=>server={...server,instanceId:'restarted',appliedRevision:0,operationId:null}};
}
const input=revision=>({expectedRevision:revision,config:{schemaVersion:1,revision:revision+1,connections:[]},credentials:[]});
test('MCP save applies revision, restart reconciles, lost ack does not reapply',async()=>{
 const f=fixture();await f.service.save(input(0));assert.equal((await f.service.ensureApplied()).success,true);assert.equal(f.calls(),1);
 f.restart();await f.service.reconcile();assert.equal(f.calls(),2);
 const apply=f.client.apply;f.client.apply=async p=>{await apply(p);throw Error('lost_ack');};await f.service.save(input(1));await f.service.reconcile();assert.equal(f.calls(),3);assert.equal(f.service.getState().state,'applied');
});
test('offline MCP save is durable pending; next dispatch cannot use stale tools',async()=>{
 const f=fixture();f.client.getState=async()=>{throw Error('synthetic-secret');};await f.service.save(input(0));assert.equal(f.repo.read().desired_revision,1);assert.equal((await f.service.ensureApplied()).success,false);assert.ok(!JSON.stringify(f.service.getState()).includes('synthetic-secret'));
});
test('MCP registers supplied credential before repository sees it and rejects stale edits',async()=>{
 const f=fixture(),commit=f.repo.commit;f.repo.commit=p=>{assert.ok(f.registered.includes('synthetic-new'));commit(p);};await f.service.save({...input(0),credentials:[{connectionId:'fixture',slot:'token',action:'set',value:'synthetic-new'}]});
 await assert.rejects(f.service.save(input(0)),{code:'revision_conflict'});
});
test('corrupt MCP config is visible without silently resetting it',()=>{
 const f=fixture();f.repo.read=()=>{throw Object.assign(Error('unsupported_schema'),{code:'unsupported_schema'});};assert.equal(f.service.getState().errorCode,'unsupported_schema');
});
test('MCP startup initializes the repository before starting reconciliation',()=>{
 const f=fixture();let initialized=false;f.repo.initialize=()=>{initialized=true;};f.service.initialize();assert.equal(initialized,true);f.service.stop();
});
test('MCP editor identities are main-generated and approval is restricted to the reviewed fixture',()=>{
 const f=fixture();assert.equal(typeof f.service.newIdentity,'function');const a=f.service.newIdentity(),b=f.service.newIdentity();assert.match(a,/^[a-f0-9-]{36}$/);assert.notEqual(a,b);
 assert.equal(typeof f.service.approveKnowledge,'function');
 const c={id:a,name:'Demo',enabled:false,transport:'streamable-http',http:{url:'http://127.0.0.1:8765/mcp'},credentialBindings:[],allowedTools:[],knowledgeApproval:null,limits:{connectMs:5000,callMs:5000,resultBytes:16384,maxCalls:4}};
 assert.throws(()=>f.service.approveKnowledge(c),{code:'knowledge_approval_invalid'});
 const {definitionSha256}=require('../src/features/settings/mcpKnowledgeFixture.json');c.allowedTools=[{name:'lookup_client_fact',definitionSha256,approvedReadOnly:true}];
 const approval=f.service.approveKnowledge(c);assert.equal(approval.contract,'dated-client-facts-v1');assert.equal(approval.clientId,'demo-client');assert.deepEqual(approval.sourceIds,['fixture-calibration-v1']);
 c.allowedTools[0].definitionSha256='0'.repeat(64);assert.throws(()=>f.service.approveKnowledge(c),{code:'knowledge_approval_invalid'});
});
test('corrupt MCP storage permits only a freshly confirmed base inference profile',async()=>{
 const f=fixture();f.repo.read=()=>{throw Object.assign(Error('unsupported_schema'),{code:'unsupported_schema'});};
 f.client.getState=async()=>({inferenceEnabled:false});const base=await f.service.ensureApplied();assert.equal(base.success,true);assert.equal(base.mcpDisabled,true);assert.equal(base.state,'blocked');
 for(const flag of [true,undefined]){f.client.getState=async()=>({inferenceEnabled:flag});assert.equal((await f.service.ensureApplied()).success,false);}
 f.client.getState=async()=>{throw Error('offline');};assert.equal((await f.service.ensureApplied()).success,false);
});
