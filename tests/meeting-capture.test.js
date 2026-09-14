const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(capture) {
    let command; const acks=[];
    const window={ location:{search:'?view=listen'},api:{renderer:{onChangeListenCaptureState:cb=>command=cb},listen:{ackCapture:async data=>acks.push(data)}} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/ui/listen/audioCore/renderer.js'),'utf8'),{
        window,URLSearchParams,console:{log(){},error(){}},require:()=>capture,
    });
    return {send:data=>command({},data),acks};
}
test('capture Stop acknowledges only after asynchronous resource release', async()=>{
    let release; const h=load({stopCapture:()=>new Promise(r=>release=r)});
    h.send({status:'stop',lifecycleId:2});await flush();assert.equal(h.acks.length,0);
    release();await flush();assert.deepEqual(JSON.parse(JSON.stringify(h.acks)),[{status:'stop',lifecycleId:2,success:true}]);
});
test('late local capture completion is released before stop ack and stale start is rejected', async()=>{
    let finishStart;let starts=0,stops=0;const h=load({startCapture:()=>{starts++;return new Promise(r=>finishStart=r)},stopCapture:async()=>{stops++}});
    h.send({status:'start',lifecycleId:1});await flush();h.send({status:'stop',lifecycleId:2});
    finishStart(true);await flush();await flush();
    assert.ok(stops>=1);assert.equal(h.acks.find(a=>a.status==='start').success,false);
    assert.equal(h.acks.find(a=>a.status==='stop').success,true);
    h.send({status:'start',lifecycleId:1});await flush();assert.equal(starts,1);
});
test('failed start is cleaned and acknowledged as failed',async()=>{
    let stops=0;const h=load({startCapture:async()=>false,stopCapture:async()=>{stops++}});
    h.send({status:'start',lifecycleId:1});await flush();assert.equal(h.acks[0]?.success,false);assert.equal(stops,1);
});
test('capture cleanup attempts every resource even if one disconnect throws',async()=>{
    const stopped=[];const module={exports:{}};
    const context=vm.createContext({module,console:{log(){},warn(){},error(){}},require:()=>{},setInterval:()=>1,clearInterval(){},window:{api:{platform:{isLinux:false,isMacOS:false},listenCapture:{onSystemAudioData(){}}}},Float32Array,Int16Array,Buffer});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/listen/audioCore/listenCapture.js'),'utf8'),context);
    context.stopped=stopped;
    vm.runInContext(`audioProcessor={disconnect(){throw Error('synthetic failure')}};audioContext={close:async()=>stopped.push('audio')};systemAudioContext={close:async()=>stopped.push('system')};mediaStream={getTracks:()=>[{stop:()=>stopped.push('display')}]};micMediaStream={getTracks:()=>[{stop:()=>stopped.push('mic')}]}`,context);
    await assert.rejects(async()=>module.exports.stopCapture());
    assert.deepEqual(stopped.sort(),['audio','display','mic','system']);
});

test('Linux capture owns and releases microphone, display and audio context before Stop completes',async()=>{
    const released=[],module={exports:{}};
    class AudioContext {
        constructor(){this.destination={};} createMediaStreamSource(){return {connect(){}};}
        createScriptProcessor(){return {connect(){},disconnect(){released.push('processor')}};}
        async close(){released.push('context');}
    }
    const stream=name=>({getTracks:()=>[{stop:()=>released.push(name)}]});
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/ui/listen/audioCore/listenCapture.js'),'utf8'),{
        module,console:{log(){},warn(){},error(){}},require:()=>{},setInterval:()=>1,clearInterval(){},AudioContext,
        navigator:{mediaDevices:{getDisplayMedia:async()=>stream('display'),getUserMedia:async()=>stream('mic')}},
        window:{api:{platform:{isLinux:true,isMacOS:false},listenCapture:{onSystemAudioData(){},isSessionActive:async()=>true}}},Float32Array,Int16Array,Buffer,
    });
    assert.equal(await module.exports.startCapture(),true);await module.exports.stopCapture();
    assert.deepEqual(released.sort(),['context','display','mic','processor']);
});

test('failed capture release remains owned until a successful cleanup retry',async()=>{
    let attempts=0,fail=true;const module={exports:{}};
    const context=vm.createContext({module,console:{log(){},warn(){},error(){}},require:()=>{},setInterval:()=>1,clearInterval(){},window:{api:{platform:{isLinux:false,isMacOS:false},listenCapture:{onSystemAudioData(){}}}},Float32Array,Int16Array,Buffer,
        track:{stop(){attempts++;if(fail)throw Error('synthetic release failure')}}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/listen/audioCore/listenCapture.js'),'utf8'),context);
    vm.runInContext('micMediaStream={getTracks:()=>[track]}',context);
    await assert.rejects(module.exports.stopCapture());
    await assert.rejects(module.exports.stopCapture());assert.equal(attempts,2);
    fail=false;await module.exports.stopCapture();assert.equal(attempts,3);
    await module.exports.stopCapture();assert.equal(attempts,3);
});
