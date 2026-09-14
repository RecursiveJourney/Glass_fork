const SR=16000, EDGE=.75*SR, TAIL=3*SR, TOLERANCE=.4*SR;
const normalize = text => {const n=text.toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');return ({'2':'two','10':'ten','12':'twelve','20':'twenty'})[n]??n;};
// Sherpa's transducer returns BPE pieces, not word timestamps. Leading spaces
// start words; punctuation and contraction pieces belong to the preceding word.
function wordsFromTokens(result, offset=0, sourceEnd=Infinity) {
    const {tokens,timestamps,durations=[]}=result;
    if(!Array.isArray(tokens)||!Array.isArray(timestamps)||tokens.length!==timestamps.length) throw Error('Missing token timestamp alignment');
    const chars=[];
    for(let i=0;i<tokens.length;i++) {
        if(typeof tokens[i]!=='string'||!Number.isFinite(timestamps[i])||timestamps[i]<0||i&&timestamps[i]<timestamps[i-1]) throw Error('Invalid token timestamp');
        const start=offset+Math.round(timestamps[i]*SR),duration=durations[i]??0;
        if(!Number.isFinite(duration)||duration<0)throw Error('Invalid token duration');
        const end=Math.min(sourceEnd,start+Math.round(duration*SR));
        if(start>sourceEnd)throw Error('Token outside source bounds');
        for(const char of tokens[i].replace(/▁/g,' '))if(!/\s/u.test(char))chars.push({char,start,end});
    }
    // Text carries spaces omitted by numeric BPE pieces; standalone space
    // tokens also matter. Align non-space characters to token timings instead
    // of guessing words from a leading space on each nonempty token.
    const text=result.text??tokens.join('').replace(/▁/g,' ');
    if(text.replace(/\s/gu,'')!==chars.map(c=>c.char).join(''))throw Error('Text/token alignment mismatch');
    let at=0;
    return (text.match(/\S+/gu)||[]).map(text=>{const n=Array.from(text).length,first=chars[at],last=chars[at+n-1];at+=n;return {text,start:first.start,end:last.end};});
}
// Align the complete overlapping context before applying a confirmation to its
// own span. Neighbor words are anchors, not replacement candidates for the dispute.
function align(existing, words) {
    const n=existing.length,m=words.length,d=Array.from({length:n+1},()=>Array(m+1).fill(Infinity));
    const prev=Array.from({length:n+1},()=>Array(m+1));d[0][0]=0;
    function put(i,j,cost,from,a,b){if(cost<d[i][j]){d[i][j]=cost;prev[i][j]={from,a,b};}}
    for(let i=0;i<=n;i++)for(let j=0;j<=m;j++){
        if(i<n)put(i+1,j,d[i][j]+.85,[i,j],1,0);
        if(j<m)put(i,j+1,d[i][j]+.85,[i,j],0,1);
        if(i===n||j===m||Math.abs(existing[i].best.start-words[j].start)>TOLERANCE)continue;
        for(let a=1;i+a<=n;a++)for(let b=1;b<=Math.min(m-j,a===1?m-j:1);b++){
            if(a>1&&existing[i+a-1].best.start>words[j].end+TOLERANCE)break;
            if(b>1&&words[j+b-1].start>existing[i].best.end+TOLERANCE)break;
            const old=existing.slice(i,i+a),fresh=words.slice(j,j+b);
            const same=normalize(old.map(s=>s.best.text).join(''))===normalize(fresh.map(w=>w.text).join(''));
            // Unequal tokenizations may still describe the same complete source
            // span. Keep every word ("can't" / "can not"), not just its first.
            const sameBounds=Math.abs(old[0].best.start-fresh[0].start)<=.12*SR&&Math.abs(old.at(-1).best.end-fresh.at(-1).end)<=.12*SR;
            if((a>1||b>1)&&!same&&!sameBounds)continue;
            if(a>1&&![...old[0].history.keys()].some(id=>old.every(s=>s.history.has(id))))continue;
            const delta=Math.abs(old[0].best.start-fresh[0].start);
            const overlap=Math.min(old.at(-1).best.end,fresh.at(-1).end)>Math.max(old[0].best.start,fresh[0].start);
            if(delta>TOLERANCE||!same&&!overlap)continue;
            // Prefer a complete same-source alternative over an exact prefix
            // plus a discarded suffix ("can" must not swallow "can not").
            const cost=(same?0:(a>1||b>1)?.6:1.1)+.15*delta/TOLERANCE+.05*(a+b-2);
            put(i+a,j+b,d[i][j]+cost,[i,j],a,b);
        }
    }
    const out=[];let i=n,j=m;
    while(i||j){const step=prev[i][j], [x,y]=step.from;out.push({old:existing.slice(x,i),fresh:words.slice(y,j)});i=x;j=y;}
    return out.reverse();
}
// Every observation is immediately visible. "commits" is the existing upsert
// transport name, not an irreversible text append: provisional=false settles it.
class TranscriptStitcher {
    constructor(){this.spans=new Map();this.nextSpan=0;this.lastEnd=-1;this.sourceClock=0;this.seen=new Set();this.closed=false;}
    get pending(){return [...this.spans.values()].filter(s=>!s.finalized).map(s=>({...s.best,spanId:s.id,retentionEnd:s.end,provisional:true}));}
    _candidate(words,result){const start=words[0].start,end=words.at(-1).end;return {text:words.map(w=>w.text).join(' '),start,end,decodeId:result.id,windowStart:result.start,windowEnd:result.end,
        edgeDistance:Math.min(start-result.start,result.end-end),contextSamples:result.end-result.start};}
    _better(a,b){return a.edgeDistance>b.edgeDistance||a.edgeDistance===b.edgeDistance&&a.contextSamples>b.contextSamples;}
    _best(span,candidate){span.history.set(candidate.decodeId,candidate);if(this._better(candidate,span.best))span.best=candidate;}
    _output(commits,alternatives=[]){
        commits.sort((a,b)=>a.sourceStart-b.sourceStart||a.spanId.localeCompare(b.spanId));
        return {text:commits.map(c=>c.text).join(' '),words:commits,commits,removeSpanIds:commits.flatMap(c=>c.removeSpanIds||[]),
            uncertain:commits.some(c=>c.uncertain),alternatives,unresolved:[],committedThrough:Math.max(0,this.sourceClock-25*SR)};
    }
    _emit(span,provisional){
        const b=span.best,old=span.emitted;
        const value={spanId:span.id,sourceStart:span.start,sourceEnd:span.end,start:b.start,end:b.end,text:b.text,
            provisional,uncertain:span.disputed,edgeDistance:b.edgeDistance,decodeId:b.decodeId,revision:(old?.revision??0)+1};
        if(old&&['sourceStart','sourceEnd','start','end','text','provisional','uncertain','edgeDistance'].every(k=>old[k]===value[k])&&!span.pendingRemoval?.length)return null;
        value.removeSpanIds=span.pendingRemoval??[];span.pendingRemoval=[];span.emitted=value;return value;
    }
    _merge(old){
        const span=old[0];if(old.length===1)return span;
        const history=new Map();
        // A merged alternative must come from one decode, not invented pieces
        // selected independently from incompatible whole-window hypotheses.
        for(const id of span.history.keys())if(old.every(s=>s.history.has(id))){
            const pieces=old.map(s=>s.history.get(id)),first=pieces[0];history.set(id,this._candidate(pieces,{id,start:first.windowStart,end:first.windowEnd}));
        }
        span.history=history;span.best=[...history.values()].reduce((a,b)=>this._better(b,a)?b:a);
        span.end=old.at(-1).end;span.disputed=old.some(s=>s.disputed);
        span.pendingRemoval=[...(span.pendingRemoval||[]),...old.slice(1).flatMap(s=>[s.id,...(s.pendingRemoval||[])])];
        for(const other of old.slice(1))this.spans.delete(other.id);
        return span;
    }
    advance(sourceClock){
        if(this.closed)throw Error('Stitcher closed');
        if(!Number.isSafeInteger(sourceClock)||sourceClock<this.sourceClock)throw Error('Invalid source clock');
        this.sourceClock=sourceClock;const commits=[];
        for(const [id,span] of this.spans){
            if(!span.finalized&&span.end+25*SR<=sourceClock){span.finalized=true;const c=this._emit(span,false);if(c)commits.push(c);}
            // Keep finalized text anchors, without PCM, for one further retention
            // window. Timestamp drift in a stale decode cannot reopen a word.
            if(span.finalized&&span.end+50*SR<sourceClock)this.spans.delete(id);
        }
        return this._output(commits);
    }
    accept(result){
        if(this.closed)throw Error('Stitcher closed');
        const {id,words,start,end,coreEnd}=result;
        // Native VAD may finish behind an already emitted3s cut. Its clamped
        // final context has no new core, but remains a legal provisional observation.
        const observation=result.observation===true||result.final===true&&result.coreStart===coreEnd&&coreEnd===this.lastEnd;
        if(this.seen.has(id))return {...this._output([]),duplicate:true};
        if(result.confirmationFor!==undefined||result.observation!==undefined&&typeof result.observation!=='boolean')throw Error('Invalid result kind');
        if(typeof id!=='string'||!id||![start,end,coreEnd].every(Number.isSafeInteger)||start<0||end<start||coreEnd<start||coreEnd>end||(!observation&&coreEnd<=this.lastEnd))throw Error('Invalid result order/bounds');
        if(end-start>19.5*SR)throw Error('Decode input ceiling exceeded');
        if(!Array.isArray(words)||words.length>2048||words.some((w,i)=>typeof w.text!=='string'||!Number.isSafeInteger(w.start)||!Number.isSafeInteger(w.end)||w.start<start||w.end<w.start||w.end>end||i&&w.start<words[i-1].start))throw Error('Invalid word order/timestamp bounds');
        const clock=result.sourceClock??Math.max(this.sourceClock,end);
        if(!Number.isSafeInteger(clock)||clock<this.sourceClock||clock<end)throw Error('Invalid source clock');
        const commits=this.advance(clock).commits,alternatives=[];
        const existing=[...this.spans.values()].filter(s=>s.best.end>=start-TOLERANCE&&s.best.start<=end+TOLERANCE).sort((a,b)=>a.start-b.start);
        for(const {old,fresh} of align(existing,words)){
            // Settled anchors participate in alignment, but never in revisions.
            if(old.some(s=>s.finalized))continue;
            if(!fresh.length){
                for(const span of old)if(span.start>=start+EDGE&&span.end<=end-EDGE){span.disputed=true;alternatives.push({spanId:span.id,previous:span.best.text,current:null});}
                continue;
            }
            if(fresh.at(-1).end<=clock-25*SR)continue;
            const candidate=this._candidate(fresh,result);let span;
            if(!old.length){
                span={id:'span-'+String(++this.nextSpan).padStart(8,'0'),start:candidate.start,end:candidate.end,best:candidate,history:new Map([[id,candidate]]),disputed:false,finalized:false,emitted:null};this.spans.set(span.id,span);
            }else{
                span=this._merge(old);
                if(normalize(candidate.text)!==normalize(span.best.text)){span.disputed=true;alternatives.push({spanId:span.id,previous:span.best.text,current:candidate.text});}
                this._best(span,candidate);
            }
        }
        for(const span of this.spans.values())if(!span.finalized){
            const c=this._emit(span,true);if(c)commits.push(c);
            for(const key of span.history.keys()){if(span.history.size<=16)break;if(key!==span.best.decodeId)span.history.delete(key);}
        }
        if(this.spans.size>4096)throw Error('Span history capacity exceeded');
        if(!observation)this.lastEnd=coreEnd;
        this.seen.add(id);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value);
        return this._output(commits,alternatives);
    }
    flush(){
        if(this.closed)return this._output([]);
        const commits=[];
        for(const span of this.spans.values())if(!span.finalized){span.finalized=true;const c=this._emit(span,false);if(c)commits.push(c);}
        this.closed=true;return this._output(commits);
    }
}
module.exports={wordsFromTokens,TranscriptStitcher};
