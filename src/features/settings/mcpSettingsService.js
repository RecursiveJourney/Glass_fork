const {EventEmitter}=require('node:events');
const {createMcpRepository}=require('./repositories/mcp.sqlite.repository');
const {McpRuntimeClient}=require('../common/services/mcpRuntimeClient');
const redactor=require('../common/services/secretRedactor');
const {exact,fail,validateConfig,endpointDigest}=require('../common/services/mcpConfig');
const {randomUUID}=require('node:crypto');
const fixture=require('./mcpKnowledgeFixture.json');
class McpSettingsService extends EventEmitter {
 #repo;#client;#register;#queue=Promise.resolve();#reconciling;#timer;#runtime=null;
 constructor({repository=createMcpRepository(),client=new McpRuntimeClient(),registerSecrets=redactor.registerSecrets}={}){super();this.#repo=repository;this.#client=client;this.#register=registerSecrets;}
 initialize(){this.#repo.initialize();this.start();}
 newIdentity(){return randomUUID();}
 approveKnowledge(connection){
  const c=validateConfig({schemaVersion:1,revision:0,connections:[{...connection,knowledgeApproval:null}]}).connections[0];
  if(!c.allowedTools.some(t=>t.name===fixture.name&&t.definitionSha256===fixture.definitionSha256&&t.approvedReadOnly))throw fail('knowledge_approval_invalid');
  return {contract:'dated-client-facts-v1',clientId:fixture.clientId,sourceIds:[...fixture.sourceIds],toolDigests:[fixture.definitionSha256],endpointSha256:endpointDigest(c)};
 }
 getState(){
  try{const row=this.#repo.read();return redactor.redact({config:row.config,credentialStatuses:this.#repo.credentialStatuses?.()||[],savedRevision:row.desired_revision,appliedRevision:row.outbox?.applied_revision||0,state:row.outbox?.state||'applied',errorCode:row.outbox?.last_error_code||null,runtime:this.#runtime});}
  catch(error){return {config:null,savedRevision:null,appliedRevision:null,state:'blocked',errorCode:['unsupported_schema','mcp_config_corrupt'].includes(error.code)?error.code:'mcp_storage_unavailable',runtime:null};}
 }
 #emit(){this.emit('updated',this.getState());}
 save(input){
  if(Array.isArray(input?.credentials))this.#register(input.credentials.filter(c=>typeof c?.value==='string').map(c=>c.value));
  input=structuredClone(input);
  const action=async()=>{
   exact(input,['expectedRevision','config','credentials']);const row=this.#repo.read();if(input.expectedRevision!==row.desired_revision)throw fail('revision_conflict');
   this.#repo.commit(input);this.#emit();let timer;
   try{return await Promise.race([this.reconcile(),new Promise(resolve=>{timer=setTimeout(()=>resolve(this.getState()),800);})]);}finally{clearTimeout(timer);}
  };
  const next=this.#queue.then(action);this.#queue=next.catch(()=>{});return next;
 }
 reconcile(){
  if(this.#reconciling)return this.#reconciling;
  this.#reconciling=(async()=>{
   for(let n=0;n<8;n++){
    try{
     const before=this.#repo.read();if(!before.outbox)return this.getState();
     const server=await this.#client.getState();this.#runtime=server;
     const row=this.#repo.read(),outbox=row.outbox;
     if(server.appliedRevision===row.desired_revision&&server.operationId===outbox.operation_id){this.#repo.acknowledge(row.desired_revision,server.instanceId);this.#emit();return this.getState();}
     if(server.appliedRevision>=row.desired_revision)throw fail('runtime_revision_conflict');
     const credentials=this.#repo.resolveCredentials();this.#register(credentials.map(c=>c.value));
     const applied=await this.#client.apply({installationId:row.installation_id,expectedInstanceId:server.instanceId,expectedRevision:server.appliedRevision,desiredRevision:row.desired_revision,operationId:outbox.operation_id,config:row.config,credentials});this.#runtime=applied;
     if(applied.appliedRevision!==row.desired_revision||applied.operationId!==outbox.operation_id)throw fail('runtime_invalid_response');
     this.#repo.acknowledge(row.desired_revision,applied.instanceId);if(this.#repo.read().desired_revision===row.desired_revision){this.#emit();return this.getState();}
    }catch(error){try{this.#repo.pending(/^[a-z_]{1,64}$/.test(error.code)?error.code:'runtime_unavailable');}catch{}this.#runtime=null;this.#emit();return this.getState();}
   }return this.getState();
  })().finally(()=>this.#reconciling=null);return this.#reconciling;
 }
 async ensureApplied(){
  await this.#queue;const state=await this.reconcile();
  if(state.state==='blocked'){
   // Only a fresh authenticated statement that inference is base-only permits recovery fallback.
   // Missing metadata, an MCP-enabled profile or an unreachable server remains fail-closed.
   try{const runtime=await this.#client.getState();if(runtime.inferenceEnabled===false)return {...state,success:true,mcpDisabled:true};}catch{}
  }
  return {success:state.state==='applied',...state};
 }
 async test(input){exact(input,['id','expectedRevision']);await this.#queue;const state=await this.ensureApplied();if(!state.success)throw fail('runtime_pending');return this.#client.test(input.id,input.expectedRevision);}
 start(){if(this.#timer)return;this.#timer=setInterval(()=>this.reconcile().catch(()=>{}),2000);this.#timer.unref?.();this.reconcile().catch(()=>{});}
 stop(){clearInterval(this.#timer);this.#timer=null;}
}
let singleton;function getMcpSettingsService(){return singleton||=new McpSettingsService();}
module.exports={McpSettingsService,getMcpSettingsService};
