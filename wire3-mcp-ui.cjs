// Explicit offline operator harness; the normal application entry remains unchanged.
const path=require('node:path');
function prepareOfflineLaunch({profile,env=process.env}={}){
 if(typeof profile!=='string'||!path.isAbsolute(profile)||!env.TWIN_CONTROL_TOKEN)throw Error('isolated_profile_and_control_token_required');
 const filtered=Object.fromEntries(Object.entries(env).filter(([key])=>key==='TWIN_CONTROL_TOKEN'||!/(?:KEY|TOKEN|SECRET|PASSWORD)|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH/i.test(key)));
 return {profile:path.resolve(profile),env:filtered};
}
function createProofIdentityAllocator(ids){if(!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw Error('invalid_proof_identities');let index=0;return ()=>{if(index>=ids.length)throw Error('proof_identity_budget_exhausted');return ids[index++];};}
module.exports={prepareOfflineLaunch,createProofIdentityAllocator};
// Electron's default app imports CommonJS entries, so require.main is not this module.
// Only the explicitly selected browser-process entry may start the application.
const isElectronEntry=Boolean(process.versions.electron&&process.type==='browser'&&process.argv[1]&&path.resolve(process.argv[1])===__filename);
if(require.main===module||isElectronEntry){
 const {app}=require('electron');const args=process.argv.slice(2);let prepared;
 try{if(args.includes('--mock')===args.includes('--proof')||!args.includes('--profile'))throw Error();prepared=prepareOfflineLaunch({profile:args[args.indexOf('--profile')+1]});if(prepared.profile===path.resolve(app.getPath('userData'))||args.includes('--proof')&&require('node:fs').existsSync(prepared.profile))throw Error();}
 catch{process.stderr.write('offline_ui_requires_separate_profile_and_token\n');app.exit(1);}
 if(prepared){for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,prepared.env);app.setPath('userData',prepared.profile);require('dotenv').config=()=>({parsed:{}});(async()=>{if(args.includes('--proof')){const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;const {verifyFreeze}=await import('../realtime_listener/lib/mcp-freeze.js');const frozen=await verifyFreeze(value('--freeze'),{model:value('--model'),profile:value('--inference-profile')});require('./src/features/settings/mcpSettingsService').getMcpSettingsService().newIdentity=createProofIdentityAllocator(frozen.uiProofs.map(c=>c.connection.id));}require('./src/index.js');})().catch(()=>{process.stderr.write('proof_launch_failed\n');app.exit(1);});}
}
