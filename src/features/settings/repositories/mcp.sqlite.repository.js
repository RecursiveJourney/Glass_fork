const { randomUUID } = require('node:crypto');
const { SecretStore } = require('../../common/services/secretStore');
const { validateConfig, endpointDigest, canonical, fail, exact, text } = require('../../common/services/mcpConfig');
const scope = (installation,c,b) => `${installation}/mcp/${c.id}/${endpointDigest(c)}/${b.slot}`;
function createMcpRepository({ getDb = () => require('../../common/services/sqliteClient').getDb(), store = new SecretStore(), beforeCommit = () => {} } = {}) {
 function read() {
  const db=getDb(); let row;
  try { row=db.prepare('SELECT * FROM mcp_settings WHERE id=1').get(); } catch { throw fail('mcp_config_corrupt'); }
  if(!row) throw fail('mcp_config_corrupt');
  if(row.schema_version!==1) throw fail('unsupported_schema');
  try { return {...row,config:validateConfig({schemaVersion:row.schema_version,revision:row.desired_revision,connections:JSON.parse(row.connections_json)}),outbox:db.prepare('SELECT * FROM mcp_apply_outbox WHERE id=1').get() || null}; }
  catch { throw fail('mcp_config_corrupt'); }
 }
 function initialize() {
  const db=getDb();
  db.transaction(()=>{
   const installation=db.prepare('SELECT installation_id FROM twin_settings WHERE id=1').get()?.installation_id;
   if(!installation) throw fail('settings_not_initialized');
   db.exec('CREATE TABLE IF NOT EXISTS mcp_settings (id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,installation_id TEXT NOT NULL,desired_revision INTEGER NOT NULL,connections_json TEXT NOT NULL,updated_at INTEGER NOT NULL)');
   db.exec('CREATE TABLE IF NOT EXISTS mcp_apply_outbox (id INTEGER PRIMARY KEY CHECK(id=1),desired_revision INTEGER NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,applied_revision INTEGER NOT NULL DEFAULT 0,server_instance TEXT,last_error_code TEXT)');
   const marker=db.prepare("SELECT 1 FROM settings_migrations WHERE id='mcp-v1'").get();
   const row=db.prepare('SELECT * FROM mcp_settings WHERE id=1').get();
   if(!row && marker) throw fail('mcp_config_corrupt');
   if(!row) db.prepare("INSERT INTO mcp_settings VALUES (1,1,?,0,'[]',?)").run(installation,Date.now());
   const current=read(); if(current.installation_id!==installation) throw fail('mcp_config_corrupt');
   db.prepare("INSERT OR IGNORE INTO settings_migrations(id,version,stage,result_code,updated_at) VALUES ('mcp-v1',1,'committed','ready',?)").run(Date.now());
   beforeCommit();
  })(); return read();
 }
 function open(row,c,b) {
  const s=getDb().prepare('SELECT scope,ciphertext FROM secret_records WHERE ref=?').get(b.ref);
  const binding={ref:b.ref,scope:scope(row.installation_id,c,b)};
  if(!s || s.scope!==binding.scope) throw fail('credential_reference_invalid');
  return store.open(s.ciphertext,binding);
 }
 function resolveCredentials() {
  const row=read(); return row.config.connections.flatMap(c=>c.credentialBindings.map(b=>({connectionId:c.id,slot:b.slot,value:open(row,c,b)})));
 }
 function credentialStatuses() {
  const row=read();return row.config.connections.flatMap(c=>c.credentialBindings.map(b=>{
   try{open(row,c,b);return {connectionId:c.id,slot:b.slot,hasKey:true,status:'stored'};}
   catch{return {connectionId:c.id,slot:b.slot,hasKey:true,status:'locked'};}
  }));
 }
 function commit({expectedRevision,config,credentials=[]}) {
  // Register before any validation/storage output sink; fixed errors never include submitted data.
  if(Array.isArray(credentials)) for(const action of credentials) if(typeof action?.value==='string') store.registerSecrets([action.value]);
  config=validateConfig(config);
  if(!Array.isArray(credentials)||credentials.length>64) throw fail();
  const actions=new Map();
  for(const a of credentials) {
   exact(a,a?.action==='set'?['connectionId','slot','action','value']:['connectionId','slot','action']);
   if(!['set','keep','clear'].includes(a.action)||a.action==='set'&&!text(a.value,8192)) throw fail('invalid_credential_action');
   const key=a.connectionId+'/'+a.slot; if(actions.has(key)) throw fail('invalid_credential_action'); actions.set(key,a);
  }
  const db=getDb();
  db.transaction(()=>{
   const previous=read(); if(expectedRevision!==previous.desired_revision || config.revision!==expectedRevision+1) throw fail('revision_conflict');
   const oldRefs=new Set(previous.config.connections.flatMap(c=>c.credentialBindings.map(b=>b.ref)));
   for(const c of config.connections) {
    // The final target set defines the envelope scope. Resolve clears before sealing any retained slot.
    c.credentialBindings=c.credentialBindings.filter(b=>{
     const key=c.id+'/'+b.slot;if(actions.get(key)?.action!=='clear')return true;
     actions.delete(key);return false;
    });
    const old=previous.config.connections.find(x=>x.id===c.id), changed=old&&endpointDigest(old)!==endpointDigest(c);
    if(changed && c.knowledgeApproval!==null) throw fail('knowledge_approval_invalid');
    const bindings=[];
    for(const b of c.credentialBindings) {
     const key=c.id+'/'+b.slot, action=actions.get(key)||{action:'keep'}; actions.delete(key);
     const prior=old?.credentialBindings.find(x=>x.slot===b.slot);
     if(action.action==='keep') {
      if(changed) throw fail('credential_destination_changed');
      if(!prior || prior.ref!==b.ref || canonical(prior.target)!==canonical(b.target)) throw fail('credential_reference_invalid');
      open(previous,old,prior); bindings.push(b); continue;
     }
     const ref=randomUUID(), binding={ref,scope:scope(previous.installation_id,c,b)};
     const ciphertext=store.seal(action.value,binding);
     if(store.open(ciphertext,binding)!==action.value) throw fail('storage_write_failed');
     db.prepare('INSERT INTO secret_records(ref,scope,format_version,ciphertext,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(ref,binding.scope,ciphertext,Date.now(),Date.now());
     bindings.push({...b,ref});
    }
    c.credentialBindings=bindings;
   }
   if(actions.size) throw fail('invalid_credential_action');
   validateConfig(config);
   db.prepare('UPDATE mcp_settings SET desired_revision=?,connections_json=?,updated_at=? WHERE id=1').run(config.revision,JSON.stringify(config.connections),Date.now());
   db.prepare("INSERT OR REPLACE INTO mcp_apply_outbox VALUES (1,?,?,'pending',0,NULL,NULL)").run(config.revision,randomUUID());
   const refs=new Set(config.connections.flatMap(c=>c.credentialBindings.map(b=>b.ref)));
   for(const ref of oldRefs) if(!refs.has(ref)) db.prepare('DELETE FROM secret_records WHERE ref=?').run(ref);
   beforeCommit();
  })(); return read();
 }
 function acknowledge(revision,instance) { getDb().prepare("UPDATE mcp_apply_outbox SET applied_revision=?,server_instance=?,state='applied',last_error_code=NULL WHERE id=1 AND desired_revision=?").run(revision,instance,revision); }
 function pending(code) { getDb().prepare("UPDATE mcp_apply_outbox SET state='pending',last_error_code=? WHERE id=1").run(/^[a-z_]{1,64}$/.test(code)?code:'runtime_unavailable'); }
 return {initialize,read,commit,resolveCredentials,credentialStatuses,acknowledge,pending};
}
module.exports={createMcpRepository};
