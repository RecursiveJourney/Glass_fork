const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
let Client;try{({McpRuntimeClient:Client}=require('../src/features/common/services/mcpRuntimeClient'));}catch{}
const state=()=>({component:'digital-twin',protocolVersion:1,instanceId:'fixture',appliedRevision:1,operationId:'op',connections:[]});
test('MCP DTO preserves the explicit inference gate without accepting truthy strings',()=>{
 const {projectState}=require('../src/features/common/services/mcpRuntimeClient');assert.equal(projectState({...state(),inferenceEnabled:false}).inferenceEnabled,false);assert.throws(()=>projectState({...state(),inferenceEnabled:'false'}));
});
test('MCP runtime client uses control token and exact routes, with metadata-only responses',async t=>{
 assert.equal(typeof Client,'function');const paths=[];const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer synthetic-control-token-32-characters');paths.push(req.method+' '+req.url);req.resume();res.end(JSON.stringify(state()));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const client=new Client({url:'http://127.0.0.1:'+server.address().port,token:'synthetic-control-token-32-characters'});await client.getState();await client.apply({});await client.test('fixture',1);
 assert.deepEqual(paths,['GET /v1/mcp','PUT /v1/mcp/config','POST /v1/mcp/test']);
});
test('MCP runtime client rejects credential-bearing or malformed server DTOs',async t=>{
 assert.ok(Client);let value=state();const server=http.createServer((req,res)=>{req.resume();res.end(JSON.stringify(value));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const client=new Client({url:'http://127.0.0.1:'+server.address().port,token:'synthetic-control-token-32-characters'});
 for(const bad of [{...state(),credentials:[{value:'synthetic'}]},{...state(),connections:[{id:'x',state:'ready',apiKey:'synthetic'}]},{...state(),appliedRevision:-1}]){value=bad;await assert.rejects(client.getState(),{code:'runtime_invalid_response'});}
});
