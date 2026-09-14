// Read-only verification; matching values and raw error content are never printed.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const glass=path.resolve(__dirname,'../..'),parent=path.dirname(glass);
const git=(cwd,args)=>{try{return execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{throw Error('Git verification failed; raw output suppressed.');}};
const list=s=>s.split('\0').filter(Boolean),known=new Set();
const remember=(k,v)=>{if(/TOKEN|SECRET|PASSWORD|API.?KEY|PRIVATE.?KEY/i.test(k)&&typeof v==='string'&&v.length>=12)known.add(v);};
Object.entries(process.env).forEach(([k,v])=>remember(k,v));
for(const dir of [glass,parent,path.join(parent,'realtime_listener')])for(const name of fs.readdirSync(dir).filter(n=>/^\.env(?:\.|$)/.test(n))){
 const p=path.join(dir,name);if(!fs.statSync(p).isFile())continue;
 for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/);if(m)remember(m[1],m[2].replace(/^['"]|['"]$/g,''));}
}
const patterns=[/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/,/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{24,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bAKIA[A-Z0-9]{16}\b/];
let count=0;
for(const root of [glass,parent]){
 const changed=list(git(root,['diff','--name-only','-z'])),fresh=list(git(root,['ls-files','--others','--exclude-standard','-z']));
 const allowed=file=>root===glass
  ? /^(?:src\/window\/(?:windowBounds|windowResize|windowLayoutManager|windowManager|smoothMovementManager)\.js|src\/ui\/listen\/ListenView\.js|tests\/(?:window-attachment|listen-resize-ack|native-resize)\.test\.js|tests\/helpers\/(?:meeting-fixture\.html|native-resize\.cjs)|docs\/(?:meeting-feed-subscriber\.md|wire2-(?:phase4|resize)-checkpoint\.md|wire2-(?:phase4|resize)-evidence\/[^/]+))$/.test(file)
  : /^(?:glass|realtime_listener\/README\.md|realtime_listener\/docs\/(?:design\.md|live-feed-contract\.md|wire2-manual-checklist\.md))$/.test(file);
 if([...changed,...fresh].some(f=>!allowed(f)))throw Error('Unexpected file scope; details suppressed.');
 const text=[git(root,['diff','--no-ext-diff','--no-textconv']).split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).join('\n'),...fresh.map(f=>fs.readFileSync(path.join(root,f),'utf8'))].join('\n');
 if(patterns.some(p=>p.test(text))||[...known].some(s=>text.includes(s)))throw Error('Possible secret; matching content suppressed.');
 if(git(root,['diff','--cached','--name-only']).trim())throw Error('Unexpected staged changes.');
 git(root,['-c','core.safecrlf=false','diff','--check']);count+=fresh.length;
}
if(git(glass,['rev-parse','HEAD']).trim()!=='a7394e4ce177f8356f16d65e88b2ea366c3611f5'||git(parent,['rev-parse','HEAD']).trim()!=='1182c176495b9556ef6a3cb01b8168a41eb4c94f')throw Error('HEAD changed.');
console.log('PASS: added diff lines and '+count+' untracked text files scanned; no configured credential or common key-pattern matches.');
console.log('PASS: changes limited to approved resize code/tests/docs and prior Phase 4 work; listener source/tests, Ask, capture, repositories and provider settings unchanged.');
console.log('PASS: both staging areas empty, both HEADs unchanged, git diff --check clean. No commits.');
