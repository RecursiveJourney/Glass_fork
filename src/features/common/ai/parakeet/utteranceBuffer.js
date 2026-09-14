// All positions are absolute 16 kHz sample indices, not wall-clock timestamps.
// Native VAD decisions remain data: this planner never applies an energy gate.
const SR = 16000;
const LIMITS = Object.freeze({seek:12*SR,target:15*SR,force:18*SR,padding:.75*SR,
    retention:25*SR,analysis:3*SR,context:16.5*SR,advance:3*SR,input:19.5*SR,handoff:18.75*SR,minSilence:.1*SR,onsetLookback:2*512+.1*SR});
const integer = n => Number.isSafeInteger(n) && n >= 0;
class UtteranceBuffer {
    constructor() {
        this.totalSamples=0; this.base=0; this.audio=new Float32Array(0);
        this.coreStart=null; this.decodeStart=null; this.naturalEnd=null; this.candidates=[]; this.nextId=0; this.closed=false; this.origin=null; this.hasWindow=false;
    }
    get bufferedSamples(){return this.audio.length;}
    push(samples, evidence={}) {
        if(this.closed) throw Error('Utterance buffer closed');
        if(samples.length>512)throw Error('Reblock PCM into at most 512 samples before planning');
        if(!(samples instanceof Float32Array) || !samples.every(Number.isFinite)) throw Error('Expected finite Float32 PCM');
        const total=this.totalSamples+samples.length;
        const {speechStart,speechEnd,silences=[]}=evidence;
        for(const n of [speechStart,speechEnd]) if(n!==undefined && (!integer(n)||n>total||n<this.base)) throw Error('Invalid speech evidence');
        for(const s of silences) if(!integer(s.start)||!integer(s.end)||s.end<s.start||s.end>total||!Number.isFinite(s.energy)||s.energy<0) throw Error('Invalid silence evidence');
        const jobs=[];
        // A late native onset includes its documented lookback. Keep enough idle
        // history for that onset plus the accepted 750ms pre-roll.
        if(speechStart!==undefined) {
            const start=Math.max(0,speechStart-LIMITS.padding);
            if(this.coreStart===null) {this.coreStart=start;this.decodeStart=start;this.origin=start;this.hasWindow=false;}
            else if(this.naturalEnd!==null && start>this.naturalEnd) {
                const end=Math.max(this.coreStart,this.naturalEnd);
                jobs.push(...this._emit(end,end,this.totalSamples,'silence',true));
                this.coreStart=start;this.decodeStart=start;this.origin=start;this.hasWindow=false;
            }
            this.naturalEnd=null;
        }
        if(speechEnd!==undefined && this.coreStart!==null) this.naturalEnd=speechEnd+LIMITS.padding;
        this.candidates.push(...silences.map(s=>({...s})));
        // The caller reblocks transport packets to model frames; all readiness
        // values below are the observed end of that frame, never backdated.
        for(let i=0;i<samples.length;i+=512) {
            const part=samples.subarray(i,i+512), joined=new Float32Array(this.audio.length+part.length);
            joined.set(this.audio);joined.set(part,this.audio.length);this.audio=joined;
            this.totalSamples+=part.length;
            jobs.push(...this._advance());this._trim();
        }
        return jobs;
    }
    _advance() {
        const jobs=[];
        while(this.coreStart!==null) {
            // Revisable analysis needs no forced right-context wait. The first
            // window is 3s; later windows keep the full legal preceding context.
            const hard=this.coreStart+LIMITS.analysis;
            // Preserve native padded-range coalescing independently of analysis.
            // Late VAD completion may refer to audio already owned by a window;
            // reanalyze that boundary without moving ownership backwards.
            const naturalReady=this.naturalEnd===null?Infinity:this.naturalEnd+LIMITS.padding+LIMITS.onsetLookback;
            if(naturalReady<=this.totalSamples) {
                const end=Math.max(this.coreStart,this.naturalEnd);
                jobs.push(...this._emit(end,end,this.totalSamples,'silence',true));continue;
            }
            if(this.totalSamples>=hard) {
                jobs.push(...this._emit(hard,hard,this.totalSamples,'forced',false));continue;
            }
            break;
        }
        return jobs;
    }
    _emit(coreEnd,end,ready,reason,final) {
        const coreStart=this.coreStart,start=this.decodeStart;
        end=Math.min(end,this.totalSamples);
        if(start<this.base || end-start>LIMITS.input || coreEnd<coreStart) throw Error('Planner audio ownership/ceiling violated '+JSON.stringify({start,base:this.base,end,coreStart,coreEnd,ready,naturalEnd:this.naturalEnd}));
        const samples=this.audio.slice(start-this.base,end-this.base);
        const job={id:String(++this.nextId),start,end,coreStart,coreEnd,ready,reason,final,origin:this.origin,samples};
        this.coreStart=final?null:coreEnd;
        this.decodeStart=final?null:Math.max(this.origin,coreEnd-LIMITS.context);
        this.hasWindow=!final;
        if(final)this.naturalEnd=null;
        this.candidates=this.candidates.filter(s=>s.end>coreEnd);
        return samples.some(x=>x!==0)?[job]:[];
    }
    _trim() {
        const idle=Math.max(0,this.totalSamples-LIMITS.padding-LIMITS.onsetLookback-512);
        // Source retention outlives individual decode windows so recent spans
        // remain available for revision, including while native VAD is idle.
        const retained=Math.max(0,this.totalSamples-LIMITS.retention);
        const keep=Math.min(retained,this.coreStart===null?idle:this.decodeStart);
        if(keep>this.base){this.audio=this.audio.slice(keep-this.base);this.base=keep;}
        this.candidates=this.candidates.filter(s=>s.end>=this.base);
    }
    flush() {
        if(this.closed)return [];
        const jobs=this._advance();
        if(this.coreStart!==null) {
            const end=Math.max(this.coreStart,Math.min(this.naturalEnd??this.totalSamples,this.totalSamples));
            jobs.push(...this._emit(end,end,this.totalSamples,'flush',true));
        }
        this.closed=true;this.audio=new Float32Array(0);this.base=this.totalSamples;
        return jobs;
    }
}
// Plan a single context confirmation, without accessing PCM. Callers must retain
// [start,end) and wait until observed audio reaches ready before taking a slice.
// All arguments and results use absolute 16 kHz sample indices. The earliest
// retained span cannot gain left context; prefer the fullest legal window then.
function planConfirmation({start,end,availableStart=0,availableEnd,final=false}) {
    if(![start,end,availableStart,availableEnd].every(integer) ||
        availableStart>start || end<=start || end>availableEnd || end-start>LIMITS.input) {
        throw new RangeError('Invalid or unretained confirmation span');
    }
    const horizon=final?availableEnd:availableEnd+LIMITS.handoff;
    if(!integer(horizon))throw new RangeError('Confirmation horizon exceeds safe sample indices');
    const length=Math.min(LIMITS.input,horizon-availableStart);
    // Centering maximizes the smaller context edge. Clamping to retained audio
    // or EOF preserves that optimum, with a full-length window as the tie-break.
    const centered=start-Math.floor((length-(end-start))/2);
    const windowStart=Math.max(availableStart,Math.min(centered,horizon-length));
    const windowEnd=windowStart+length;
    return {start:windowStart,end:windowEnd,ready:Math.max(availableEnd,windowEnd),
        edgeDistance:Math.min(start-windowStart,windowEnd-end)};
}
module.exports={UtteranceBuffer,LIMITS,planConfirmation};
