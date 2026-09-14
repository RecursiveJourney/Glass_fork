const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function viewWith(send) {
    let View;
    const source = fs.readFileSync(path.join(__dirname,'../src/ui/listen/ListenView.js'),'utf8')
        .replace(/^import .*;\r?\n/gm,'').replace('export class ListenView','class ListenView');
    vm.runInNewContext(source, { LitElement:class {}, html:String.raw, css:String.raw,
        customElements:{define(_,v){View=v;}},window:{api:{listenView:{adjustWindowHeight:send}}},
        setTimeout,clearTimeout,console:{log(){},error(){}} });
    const view = new View(); view.isConnected=true; return view;
}
test('resize cache waits for applied acknowledgement and tolerates fractional DPI', async()=>{
    let resolve, calls=0;
    const v=viewWith(()=>{calls++;return new Promise(r=>resolve=r);});
    const pending=v.resizeIfChanged(614);
    assert.equal(v._lastHeight,null,'request is not evidence of an applied size');
    v.resizeIfChanged(614);assert.equal(calls,1,'coalesce in-flight identical requests');
    resolve({applied:true,height:615});await pending;
    assert.equal(v._lastHeight,615);
    v.resizeIfChanged(614);assert.equal(calls,1,'DPI rounding must not repeat resizing');
});
test('OS-rejected height is never cached and a subsequent update can retry',async()=>{
    let calls=0;
    const v=viewWith(async()=>{calls++;return calls===1?{applied:false,height:225}:{applied:true,height:614};});
    await v.resizeIfChanged(614);assert.equal(v._lastHeight,null);
    await v.resizeIfChanged(614);assert.equal(calls,2);assert.equal(v._lastHeight,614);
});
test('IPC rejection is contained and never acknowledges a size',async()=>{
    const v=viewWith(async()=>{throw Error('synthetic rejection');});
    await v.resizeIfChanged(614);assert.equal(v._lastHeight,null);
});
test('only the latest changed measurement follows an in-flight resize',async()=>{
    const pending=[],calls=[];
    const v=viewWith((_,height)=>{calls.push(height);return new Promise(r=>pending.push(r));});
    const first=v.resizeIfChanged(614);
    v.resizeIfChanged(580);v.resizeIfChanged(600);
    pending.shift()({applied:true,height:615});await first;
    assert.deepEqual(calls,[614,600]);
    pending.shift()({applied:true,height:600});
    await new Promise(r=>setImmediate(r));
    assert.equal(v._lastHeight,600);
});
