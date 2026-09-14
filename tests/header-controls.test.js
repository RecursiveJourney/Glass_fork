const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path');
test('shipped header controls in the native Electron renderer',{timeout:60000},async t=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[path.join(__dirname,'helpers/header-controls.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();
 const timer=setTimeout(()=>child.kill(),50000);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});clearTimeout(timer);
 const line=output.split(/\r?\n/).find(line=>line.startsWith('HEADER_TESTS:'));assert.ok(line,'structured renderer results');
 for(const result of JSON.parse(line.slice('HEADER_TESTS:'.length)))await t.test(result.name,()=>assert.equal(result.error,null,result.error||result.name));assert.equal(code,0);
});
