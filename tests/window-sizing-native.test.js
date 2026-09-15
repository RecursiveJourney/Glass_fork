const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
test('native 175% ownership, viewport scrolling, reset IPC and separate-process restore', {timeout:60000},async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glass-size-native-'));
    try {
        for(const mode of ['write','read']){
            const result=await new Promise((resolve,reject)=>{
                const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
                const child=spawn(require('electron'),[path.join(__dirname,'helpers/window-sizing-native.cjs'),dir,mode,'node'+process.versions.node.split('.')[0]],{env,windowsHide:true,stdio:['ignore','pipe','ignore']});
                let output='';child.stdout.on('data',c=>output+=c);const timer=setTimeout(()=>{child.kill();reject(Error('native_timeout'));},25000);
                child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);const row=output.split(/\r?\n/).find(s=>s.startsWith('SIZING_NATIVE:'));resolve(row?JSON.parse(row.slice(14)):{error:'missing_result'});});
            });
            assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.windows,3);assert.equal(result.mode,mode);
            console.log('Native sizing '+JSON.stringify(result));
        }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
