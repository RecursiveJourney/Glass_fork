const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { syntheticCodec } = require('./credential-fixtures.cjs');
const { SecretStore } = require('../../src/features/common/services/secretStore');
const { migrateSettings } = require('../../src/features/common/services/settingsMigrationService');
let createMcpRepository; try { ({ createMcpRepository } = require('../../src/features/settings/repositories/mcp.sqlite.repository')); } catch {}
const scenario = process.argv[2];
(async () => {
 assert.equal(typeof createMcpRepository,'function','MCP repository must exist');
 const db = new Database(':memory:'), registered = [];
 const store = new SecretStore({ codec: syntheticCodec(), isReady: () => true, platform: 'win32', registerSecrets: xs => registered.push(...xs) });
 await migrateSettings({db,store});
 const original = db.prepare('SELECT * FROM twin_settings').all();
 let abort = false;
 const repo = createMcpRepository({ getDb: () => db,store,beforeCommit: () => { if(abort) throw Error('fixture_interrupted'); } });
 if(scenario==='migration_rollback'){abort=true;assert.throws(()=>repo.initialize());assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mcp_settings'").get().n,0);abort=false;}
 repo.initialize(); repo.initialize();
 const c = {id:'f10eeb54-5819-4e36-900e-289268ef1101',name:'Fixture',enabled:false,transport:'streamable-http',http:{url:'http://127.0.0.1:8765/mcp'},credentialBindings:[{slot:'token',target:{kind:'bearer'},ref:'f10eeb54-5819-4e36-900e-289268ef1102'}],allowedTools:[],knowledgeApproval:null,limits:{connectMs:5000,callMs:5000,resultBytes:16384,maxCalls:4}};
 const secret = 'synthetic-mcp-storage-fixture';
 const set = value => [{connectionId:c.id,slot:'token',action:'set',value}];
 const save = () => repo.commit({expectedRevision:0,config:{schemaVersion:1,revision:1,connections:[c]},credentials:set(secret)});
 if(scenario === 'migration' || scenario==='migration_rollback') {
  assert.deepEqual(repo.read().config,{schemaVersion:1,revision:0,connections:[]});
  assert.deepEqual(db.prepare('SELECT * FROM twin_settings').all(),original);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings_migrations WHERE id='mcp-v1'").get().n,1);
  assert.equal(repo.read().installation_id,original[0].installation_id);
 } else if(scenario === 'partial_clear') {
  const local={...c,transport:'stdio',stdio:{executable:process.execPath,args:[],cwd:process.cwd()},credentialBindings:[{slot:'token',target:{kind:'env',name:'KNOWLEDGE_TOKEN'},ref:c.credentialBindings[0].ref},{slot:'token2',target:{kind:'env',name:'KNOWLEDGE_TOKEN_2'},ref:'f10eeb54-5819-4e36-900e-289268ef1103'}]};delete local.http;
  repo.commit({expectedRevision:0,config:{schemaVersion:1,revision:1,connections:[local]},credentials:[...set(secret),{connectionId:c.id,slot:'token2',action:'set',value:'synthetic-second'}]});
  const before=JSON.stringify(repo.read()),next=repo.read().config;next.revision=2;
  const clear={connectionId:c.id,slot:'token',action:'clear'};
  assert.throws(()=>repo.commit({expectedRevision:1,config:next,credentials:[clear]}),{code:'credential_destination_changed'});assert.equal(JSON.stringify(repo.read()),before);
  repo.commit({expectedRevision:1,config:next,credentials:[clear,{connectionId:c.id,slot:'token2',action:'set',value:'synthetic-reentered'}]});
  assert.equal(repo.read().config.connections[0].credentialBindings.length,1);assert.equal(repo.resolveCredentials()[0].value,'synthetic-reentered');assert.equal(db.prepare('SELECT count(*) AS n FROM secret_records').get().n,1);
 } else if(scenario === 'rollback') {
  abort=true; assert.throws(save); assert.equal(repo.read().desired_revision,0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secret_records').get().n,0);
  abort=false; save(); assert.equal(repo.read().desired_revision,1);
 } else if(scenario === 'locked' || scenario === 'registration') {
  if(scenario === 'locked') store.isReady=()=>false; else store.registerSecrets=()=>{ throw Error('registry_capacity'); };
  assert.throws(save); assert.equal(repo.read().desired_revision,0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secret_records').get().n,0);
 } else if(scenario === 'corrupt' || scenario === 'unknown') {
  db.prepare('UPDATE mcp_settings SET connections_json=?,schema_version=? WHERE id=1').run(scenario==='corrupt'?'broken':'[]',scenario==='unknown'?99:1);
  const before = db.prepare('SELECT * FROM mcp_settings').get(); assert.throws(()=>repo.initialize(),{code:scenario==='unknown'?'unsupported_schema':'mcp_config_corrupt'});
  assert.deepEqual(db.prepare('SELECT * FROM mcp_settings').get(),before);
 } else {
  save(); const row=repo.read(), saved=row.config.connections[0], before=JSON.stringify(row);
  assert.ok(registered.includes(secret)); assert.ok(!before.includes(secret)); assert.equal(repo.resolveCredentials()[0].value,secret);
  const blob=db.prepare('SELECT ciphertext FROM secret_records WHERE ref=?').get(saved.credentialBindings[0].ref).ciphertext;
  assert.ok(!blob.includes(Buffer.from(secret)));
  if(scenario==='binding') {
   const changed=structuredClone(row.config); changed.revision=2; changed.connections[0].http.url+='/other';
   assert.throws(()=>repo.commit({expectedRevision:1,config:changed,credentials:[]}),{code:'credential_destination_changed'});
   assert.equal(JSON.stringify(repo.read()),before);
   changed.connections[0].http.url=saved.http.url; changed.connections[0].credentialBindings[0].ref=c.credentialBindings[0].ref;
   assert.throws(()=>repo.commit({expectedRevision:1,config:changed,credentials:[]}),{code:'credential_reference_invalid'});
  } else if(scenario==='status') {
   assert.deepEqual(repo.credentialStatuses(),[{connectionId:c.id,slot:'token',hasKey:true,status:'stored'}]);store.isReady=()=>false;
   assert.deepEqual(repo.credentialStatuses(),[{connectionId:c.id,slot:'token',hasKey:true,status:'locked'}]);
  } else {
   const changed=structuredClone(row.config); changed.revision=2;
   repo.commit({expectedRevision:1,config:changed,credentials:set('synthetic-replacement')});
   assert.equal(repo.resolveCredentials()[0].value,'synthetic-replacement');
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secret_records').get().n,1);
   repo.acknowledge(1,'old'); assert.equal(repo.read().outbox.state,'pending'); repo.acknowledge(2,'new'); assert.equal(repo.read().outbox.state,'applied');
  }
 }
 db.close(); process.stdout.write('MCP_PERSISTENCE_PASS\n');
})().catch(error=>{process.stdout.write(error.code || 'assertion_failed');process.exitCode=1;});
