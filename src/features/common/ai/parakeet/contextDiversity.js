const {LIMITS}=require('./utteranceBuffer');
const SR=16000;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
// Proactive context diversity is driven only by source windows, never recognized
// words or reference scripts. Alternate full windows shift their framing by 3s.
function planDiversity(job,ordinal,{endOfAudio}={}) {
    if(!job||!integer(ordinal)||ordinal===0||![job.start,job.end,job.ready].every(integer)||job.end<job.start||job.ready<job.end||endOfAudio!==undefined&&!integer(endOfAudio))throw Error('Invalid diversity source window');
    if(job.final||ordinal%2===0)return null;
    const start=job.start+3*SR,end=Math.min(start+LIMITS.input,endOfAudio??Infinity);
    if(end<=start)return null;
    const ready=Math.max(job.ready,end);
    if(!integer(ready)||ready-job.ready>LIMITS.handoff)throw Error('Invalid diversity deadline');
    return {start,end,ready,requestedAt:job.ready};
}
module.exports={planDiversity};
