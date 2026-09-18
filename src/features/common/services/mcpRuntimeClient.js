const http=require('node:http');
const {registerSecrets,redact}=require('./secretRedactor');
const {exact,text,fail}=require('./mcpConfig');
function projectState(value){
 if(value.inferenceEnabled!==undefined&&typeof value.inferenceEnabled!=='boolean')throw fail();
 exact(value,['component','protocolVersion','instanceId','appliedRevision','operationId','connections',...(Object.hasOwn(value,'inferenceEnabled')?['inferenceEnabled']:[])]);
 if(value.component!=='digital-twin'||value.protocolVersion!==1||!text(value.instanceId,128)||!Number.isSafeInteger(value.appliedRevision)||value.appliedRevision<0||value.operationId!==null&&!text(value.operationId,128)||!Array.isArray(value.connections)||value.connections.length>8)throw fail();
 const states=['disabled','connecting','discovering','ready','degraded','reconnecting','auth_required','failed'];
 for(const c of value.connections){
  exact(c,['id','name','state','generation','catalogRevision','lastSuccess','errorCode','retryAt','activeCalls','protocolVersion','tools']);
  if(!text(c.id,128)||!text(c.name,80)||!states.includes(c.state)||!['generation','catalogRevision','activeCalls'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0)||!['lastSuccess','retryAt'].every(k=>c[k]===null||Number.isFinite(c[k]))||c.errorCode!==null&&!/^[a-z_]{1,64}$/.test(c.errorCode)||c.protocolVersion!==null&&!['2025-11-25','2025-06-18','2025-03-26'].includes(c.protocolVersion)||!Array.isArray(c.tools)||c.tools.length>128)throw fail();
  for(const t of c.tools){exact(t,['name','description','definitionSha256','supported','blockedReason','allowed']);if(!text(t.name,128)||typeof t.description!=='string'||Buffer.byteLength(t.description)>1024||!/^[a-f0-9]{64}$/.test(t.definitionSha256)||typeof t.supported!=='boolean'||typeof t.allowed!=='boolean'||t.blockedReason!==null&&!/^[a-z_]{1,64}$/.test(t.blockedReason))throw fail();}
 }
 return redact(value);
}
class McpRuntimeClient {
 #url;#token;#timeout;
 constructor({url=process.env.TWIN_CONTROL_URL||'http://localhost:11434',token=process.env.TWIN_CONTROL_TOKEN,timeoutMs=800}={}){
  if(token)registerSecrets([token]);const u=new URL(url);if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw fail('invalid_runtime_url');this.#url=u.origin;this.#token=token;this.#timeout=timeoutMs;
 }
 #request(method,path,body,timeout=this.#timeout){
  if(typeof this.#token!=='string'||!/^[\x21-\x7e]{32,8192}$/.test(this.#token))return Promise.reject(fail('runtime_token_missing'));
  const data=body===undefined?undefined:JSON.stringify(body);if(data&&Buffer.byteLength(data)>131072)return Promise.reject(fail('mcp_config_too_large'));
  return new Promise((resolve,reject)=>{
   const req=http.request(this.#url+path,{method,agent:false,headers:{Authorization:'Bearer '+this.#token,...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{
    const chunks=[];let bytes=0;res.on('data',c=>{bytes+=c.length;if(bytes>1048576){req.destroy();reject(fail('runtime_invalid_response'));}else chunks.push(c);});res.on('error',()=>reject(fail('runtime_unavailable')));
    res.on('end',()=>{if(res.statusCode!==200)return reject(fail(res.statusCode===401?'runtime_unauthorized':res.statusCode===409?'runtime_conflict':'runtime_unavailable'));try{resolve(projectState(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{reject(fail('runtime_invalid_response'));}});
   });
   const timer=setTimeout(()=>{req.destroy();reject(fail('runtime_timeout'));},timeout);req.once('close',()=>clearTimeout(timer));req.on('error',()=>reject(fail('runtime_unavailable')));req.end(data);
  });
 }
 getState(){return this.#request('GET','/v1/mcp');}
 apply(payload){return this.#request('PUT','/v1/mcp/config',payload);}
 test(id,expectedRevision){return this.#request('POST','/v1/mcp/test',{id,expectedRevision},16000);}
}
module.exports={McpRuntimeClient,projectState};
