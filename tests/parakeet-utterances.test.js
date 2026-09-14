const {test}=require('node:test');
const assert=require('node:assert/strict');
const {UtteranceBuffer,LIMITS}=require('../src/features/common/ai/parakeet/utteranceBuffer');
const SR=16000;
function feed(p,seconds,events={},value=.02){
 const jobs=[],n=Math.round(seconds*SR),pending={...events};
 for(let i=0;i<n;i+=512){const size=Math.min(512,n-i),end=p.totalSamples+size,e={};
  for(const k of ['speechStart','speechEnd'])if(pending[k]!==undefined&&pending[k]<=end){e[k]=pending[k];delete pending[k];}
  if(pending.silences){e.silences=pending.silences.filter(s=>s.end<=end);pending.silences=pending.silences.filter(s=>s.end>end);}
  jobs.push(...p.push(new Float32Array(size).fill(value),e));
 }
 if(pending.speechStart!==undefined||pending.speechEnd!==undefined||pending.silences?.length)throw Error('Invalid evidence after test feed');
 return jobs;
}
test('pure silence has no decode and remains bounded',()=>{const p=new UtteranceBuffer();for(let i=0;i<100;i++)assert.deepEqual(feed(p,1),[]);assert.ok(p.bufferedSamples<=25*SR);assert.deepEqual(p.flush(),[]);});
test('natural VAD range keeps both allowances and exact original samples',()=>{const p=new UtteranceBuffer();feed(p,1);const jobs=feed(p,2,{speechStart:SR});jobs.push(...feed(p,1,{speechEnd:3*SR}),...feed(p,1));const last=jobs.at(-1);assert.equal(last.start,.25*SR);assert.equal(last.end,3.75*SR);assert.equal(last.reason,'silence');assert.equal(last.samples.length,3.5*SR);assert.equal(last.final,true);});
test('continuous speech forces handoff by 18.75s with input <=19.5s',()=>{const p=new UtteranceBuffer(),jobs=[];jobs.push(...feed(p,1,{speechStart:0}));for(let i=0;i<59;i++)jobs.push(...feed(p,1));jobs.push(...p.flush());assert.ok(jobs.length>=4);for(const j of jobs){assert.ok(j.end-j.start<=19.5*SR);assert.ok(j.ready-j.coreStart<=18.75*SR); }assert.equal(jobs[0].coreEnd,3*SR);assert.ok(jobs[0].ready<=3*SR+511);assert.equal(jobs[1].start,0);});
test('silence candidates do not postpone the three-second revisable analysis',()=>{const p=new UtteranceBuffer();const jobs=feed(p,16,{speechStart:0,silences:[{start:12*SR,end:12.2*SR,energy:.1},{start:13*SR,end:13.2*SR,energy:.01}]});assert.equal(jobs.length,5);for(const j of jobs){assert.equal(j.coreEnd-j.coreStart,3*SR);assert.equal(j.reason,'forced');}});
test('a short silence does not interrupt cadence; exact zero still advances active speech',()=>{const p=new UtteranceBuffer();const jobs=feed(p,14,{speechStart:0,silences:[{start:12*SR,end:12.05*SR,energy:0}]});jobs.push(...feed(p,2),...feed(p,3,{},0));assert.equal(jobs.at(-1).coreEnd,18*SR);assert.equal(p.totalSamples,19*SR);assert.ok(jobs.every(j=>j.ready-j.coreStart<=3*SR+511));});
test('entirely zero proposed speech skips decoding; nonzero is never energy gated',()=>{for(const x of [0,1/32768]){const p=new UtteranceBuffer();feed(p,1,{speechStart:0},x);assert.equal(p.flush().length,x===0?0:1);}});
test('flush preserves sub-window residual and is idempotent',()=>{const p=new UtteranceBuffer();p.push(Float32Array.of(.1,.2,.3),{speechStart:0});assert.deepEqual(Array.from(p.flush()[0].samples),Array.from(Float32Array.of(.1,.2,.3)));assert.deepEqual(p.flush(),[]);assert.throws(()=>feed(p,1),/closed/);});
test('overlapping padded VAD ranges merge but cannot defeat the hard bound',()=>{const p=new UtteranceBuffer();feed(p,3,{speechStart:0});feed(p,1,{speechEnd:3*SR});feed(p,.2,{speechStart:3.6*SR});const jobs=feed(p,15);assert.equal(jobs[0].coreEnd,6*SR);assert.equal(jobs[0].reason,'forced');assert.ok(p.bufferedSamples<25*SR);});
test('ownership intervals are contiguous across forced cuts on both channels',()=>{const a=new UtteranceBuffer(),b=new UtteranceBuffer();const aa=feed(a,40,{speechStart:0}),bb=feed(b,40,{speechStart:0},.07);aa.push(...a.flush());bb.push(...b.flush());assert.equal(aa.length,bb.length);for(let i=1;i<aa.length;i++)assert.equal(aa[i-1].coreEnd,aa[i].coreStart);assert.notEqual(aa[0].samples[0],bb[0].samples[0]);});
test('rejects future/out-of-order speech evidence and nonfinite PCM',()=>{const p=new UtteranceBuffer();assert.throws(()=>p.push(new Float32Array(512),{speechStart:2*SR}),/evidence/);assert.throws(()=>p.push(Float32Array.of(NaN)),/finite/);assert.equal(p.totalSamples,0);assert.equal(LIMITS.handoff,18.75*SR);});

test('a preferred silence beyond the padded natural end leaves no backwards residual',()=>{const p=new UtteranceBuffer();feed(p,14,{speechStart:0});const jobs=feed(p,1,{speechEnd:14.1*SR,silences:[{start:14.1*SR,end:14.9*SR,energy:0}]});jobs.push(...feed(p,2));jobs.push(...p.flush());assert.equal(jobs.at(-1).final,true);assert.ok(jobs.every(j=>j.coreEnd>=j.coreStart));});

test('actual packet callback, not an invented earlier ready time, meets the handoff bound',()=>{const p=new UtteranceBuffer();for(let i=0;i<2000;i++){const jobs=p.push(new Float32Array(512).fill(.1),i===0?{speechStart:0}:{});for(const j of jobs){assert.ok(p.totalSamples-j.coreStart<=LIMITS.handoff);assert.equal(j.ready,p.totalSamples);}}});

test('onset inside a packet preserves the sample ramp and oversized input requires reblocking',()=>{const p=new UtteranceBuffer(),samples=Float32Array.from({length:512},(_,i)=>i+1);const jobs=p.push(samples,{speechStart:400});jobs.push(...p.flush());assert.equal(jobs[0].samples[0],jobs[0].start+1);assert.equal(jobs[0].samples.at(-1),512);assert.throws(()=>new UtteranceBuffer().push(new Float32Array(32000),{speechStart:16000}),/Reblock/);});

test('three-second advances grow the prefix then carry 16.5 seconds of context',()=>{const p=new UtteranceBuffer(),jobs=feed(p,40,{speechStart:0});assert.equal(LIMITS.analysis,3*SR);assert.equal(LIMITS.advance,3*SR);for(const j of jobs){assert.equal(j.coreEnd-j.coreStart,3*SR);assert.equal(j.coreStart-j.start,Math.min(j.coreStart,16.5*SR));assert.equal(j.end,j.coreEnd);assert.ok(j.end-j.start<=19.5*SR);}assert.equal(jobs[0].samples.length,3*SR);assert.equal(jobs[1].samples.length,6*SR);assert.equal(jobs.at(-1).samples.length,19.5*SR);assert.equal(LIMITS.seek,12*SR);assert.equal(LIMITS.force,18*SR);});
test('context PCM remains an exact source slice after several advances',()=>{const p=new UtteranceBuffer();let at=0;for(let i=0;i<1600;i++){const pcm=Float32Array.from({length:512},(_,n)=>((at+n)%10000)/10000);const jobs=p.push(pcm,i===0?{speechStart:0}:{});at+=512;for(const j of jobs){assert.equal(j.samples[0],Math.fround((j.start%10000)/10000));assert.equal(j.samples.at(-1),Math.fround(((j.end-1)%10000)/10000));}}});

test('a natural end just before a context cut cannot create a backwards remainder',()=>{const p=new UtteranceBuffer(),jobs=[];for(let i=0;i<520;i++){const e=i===0?{speechStart:0}:i===468?{speechEnd:227328,silences:[{start:227328,end:240128,energy:0}]}:{};jobs.push(...p.push(new Float32Array(512).fill(.1),e));}assert.equal(jobs.at(-1).final,true);assert.equal(jobs.at(-1).coreEnd,15*SR);assert.equal(jobs.at(-1).coreStart,15*SR);assert.ok(jobs.every(j=>j.coreEnd>=j.coreStart));});


test('first live analysis arrives on the first frame at three seconds without forced lookahead',()=>{
 const p=new UtteranceBuffer();
 for(let i=0;i<93;i++)assert.deepEqual(p.push(new Float32Array(512).fill(.1),i===0?{speechStart:0}:{}),[]);
 const [job]=p.push(new Float32Array(512).fill(.1));
 assert.ok(job);assert.equal(job.coreEnd,48000);assert.equal(job.end,48000);assert.equal(job.ready,48128);assert.equal(job.samples.length,48000);
});

test('flush covers every tail sample after rapid full-context advances',()=>{
 const p=new UtteranceBuffer(),jobs=[],length=40*SR+137;
 for(let at=0;at<length;at+=512){const size=Math.min(512,length-at);jobs.push(...p.push(Float32Array.from({length:size},(_,i)=>(at+i+1)/length),at===0?{speechStart:0}:{}));}
 jobs.push(...p.flush());let owned=0;
 for(const job of jobs){assert.equal(job.coreStart,owned);owned=job.coreEnd;assert.equal(job.samples.length,job.end-job.start);assert.equal(job.samples[0],Math.fround((job.start+1)/length));assert.equal(job.samples.at(-1),Math.fround(job.end/length));assert.ok(job.samples.length<=19.5*SR);}
 assert.equal(owned,length);assert.equal(jobs.at(-1).end,length);assert.equal(jobs.at(-1).final,true);
});

test('late natural completion closes at current ownership without a backwards final job',()=>{
 const p=new UtteranceBuffer(),jobs=feed(p,6,{speechStart:0});
 jobs.push(...feed(p,.1,{speechEnd:4*SR}),...feed(p,1),...p.flush());
 assert.equal(jobs.length,3);assert.equal(jobs.at(-1).coreStart,6*SR);assert.equal(jobs.at(-1).coreEnd,6*SR);assert.equal(jobs.at(-1).end,6*SR);assert.equal(jobs.at(-1).final,true);
});

test('flush also clamps late native completion to current ownership',()=>{
 const p=new UtteranceBuffer(),jobs=feed(p,6,{speechStart:0});
 jobs.push(...feed(p,.032,{speechEnd:5.15*SR}));
 // Native end is still within the coalescing allowance at EOF.
 jobs.push(...p.flush());assert.equal(jobs.at(-1).coreStart,6*SR);assert.equal(jobs.at(-1).coreEnd,6*SR);assert.equal(jobs.at(-1).end,6*SR);assert.equal(jobs.at(-1).final,true);
});


test('active and idle buffers retain exactly the last 25 seconds of source PCM',()=>{
 for(const active of [false,true]){
  const p=new UtteranceBuffer();let at=0;
  for(let i=0;i<1000;i++){
   const pcm=Float32Array.from({length:512},(_,n)=>((at+n)%10000)/10000);
   p.push(pcm,active&&i===0?{speechStart:0}:{});at+=512;
   assert.equal(p.bufferedSamples,Math.min(at,25*SR));
   assert.equal(p.base,Math.max(0,at-25*SR));
  }
  assert.equal(p.audio[0],Math.fround((p.base%10000)/10000));
  assert.equal(p.audio.at(-1),Math.fround(((at-1)%10000)/10000));
  p.flush();assert.equal(p.bufferedSamples,0);
 }
});
