const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planConfirmation,LIMITS}=require('../src/features/common/ai/parakeet/utteranceBuffer');
const SR=16000;

test('confirmation centers a disputed span within one full context window',()=>{
    assert.equal(typeof planConfirmation,'function');
    assert.deepEqual(planConfirmation({start:20*SR,end:21*SR,availableEnd:25*SR}),{
        start:10.75*SR,end:30.25*SR,ready:30.25*SR,edgeDistance:9.25*SR
    });
});

test('scheduled confirmation cannot be sampled before its declared readiness',()=>{
    const availableEnd=21*SR;
    const plan=planConfirmation({start:20*SR,end:21*SR,availableEnd});
    assert.ok(plan.end>availableEnd);
    assert.equal(plan.ready,plan.end);
    assert.ok(plan.end-plan.start<=LIMITS.input);
    for(const observed of [availableEnd,plan.ready-1,plan.ready,plan.ready+512]){
        if(observed>=plan.ready)assert.ok(plan.end<=observed);
        else assert.ok(plan.end>observed);
    }
    assert.equal(planConfirmation({start:20*SR,end:21*SR,availableEnd:35*SR}).ready,35*SR);
});

test('retained audio boundary shifts full context to the right',()=>{
    assert.deepEqual(planConfirmation({start:20*SR,end:21*SR,availableStart:18*SR,availableEnd:25*SR}),{
        start:18*SR,end:37.5*SR,ready:37.5*SR,edgeDistance:2*SR
    });
});

test('final confirmation clamps to EOF and preserves every trailing sample',()=>{
    assert.deepEqual(planConfirmation({start:24*SR,end:25*SR,availableEnd:25*SR,final:true}),{
        start:5.5*SR,end:25*SR,ready:25*SR,edgeDistance:0
    });
    assert.deepEqual(planConfirmation({start:23*SR,end:24*SR,availableEnd:25*SR,final:true}),{
        start:5.5*SR,end:25*SR,ready:25*SR,edgeDistance:SR
    });
});

test('final short retained buffer uses available context without waiting',()=>{
    assert.deepEqual(planConfirmation({start:20*SR,end:21*SR,availableStart:18*SR,availableEnd:25*SR,final:true}),{
        start:18*SR,end:25*SR,ready:25*SR,edgeDistance:2*SR
    });
});

test('odd sample spans remain integer and maximize the weaker edge',()=>{
    const plan=planConfirmation({start:20*SR,end:20*SR+1,availableEnd:21*SR});
    assert.equal(plan.end-plan.start,LIMITS.input);
    assert.equal(plan.edgeDistance,Math.floor((LIMITS.input-1)/2));
    for(const value of Object.values(plan))assert.ok(Number.isSafeInteger(value));
});

test('a span exactly at the input ceiling fits with no additional context',()=>{
    assert.deepEqual(planConfirmation({start:SR,end:SR+LIMITS.input,availableEnd:SR+LIMITS.input}),{
        start:SR,end:SR+LIMITS.input,ready:SR+LIMITS.input,edgeDistance:0
    });
});

test('invalid, future, unretained, and over-ceiling spans are rejected',()=>{
    const valid={start:20*SR,end:21*SR,availableStart:18*SR,availableEnd:25*SR};
    for(const changes of [
        {start:-1},{start:NaN},{end:Infinity},{start:20*SR+.5},
        {start:21*SR},{start:22*SR},{start:17*SR},{end:26*SR},
        {availableStart:-1},{availableStart:26*SR},{availableEnd:19*SR},
        {availableEnd:Number.MAX_SAFE_INTEGER+1},{availableEnd:undefined},
        {start:0,availableStart:0,end:LIMITS.input+1},
        {start:Number.MAX_SAFE_INTEGER-1,end:Number.MAX_SAFE_INTEGER,availableEnd:Number.MAX_SAFE_INTEGER}
    ])assert.throws(()=>planConfirmation({...valid,...changes}),RangeError);
});

test('near the earliest retained sample confirmation never waits beyond the hard bound',()=>{
    const availableEnd=.25*SR;
    assert.deepEqual(planConfirmation({start:0,end:availableEnd,availableEnd}),{
        start:0,end:19*SR,ready:19*SR,edgeDistance:0
    });
});
