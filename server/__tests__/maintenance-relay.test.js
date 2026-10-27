const express = require('express');
const http = require('http');
const createRouter = require('../routes/project-maintenance');
const id = '11111111-1111-4111-8111-111111111111';
let server, base, calls, signatures, authority;
beforeEach(async () => {
 calls=[]; signatures=[]; authority={ok:true,actor:{authority:'access_user',id:'operator'}};
 const app=express();app.use(express.json());app.use(createRouter({authorize:async()=>authority,
 sign:(message,options)=>{signatures.push({message,options});return {'X-Proof':'signed'};},
 relay:async(path,options)=>{calls.push({path,options});return {status:200,json:async()=>({policy:null})};}}));
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
});
afterEach(async()=>{await new Promise(r=>server.close(r));});
test('reads cannot mint maintenance authority',async()=>{
 expect((await fetch(base+'/'+id)).status).toBe(200);
 expect(calls[0].path).toBe('/api/project-maintenance/'+id);expect(signatures).toHaveLength(0);
});
test('operator writes bind exact policy and revision',async()=>{
 const body={policy:{projectId:id,taskAutonomy:'execute_simple'},expectedRevision:null};
 expect((await fetch(base+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(200);
 expect(signatures[0]).toEqual({message:JSON.stringify({purpose:'project-maintenance-policy',id,body}),options:{surface:'maintenance-settings'}});
});
test.each(['document_executor_credential','runtime_credential'])('%s cannot grant maintenance authority',async role=>{
 authority={ok:true,actor:{authority:role}};
 expect((await fetch(base+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
 expect(calls).toHaveLength(0);expect(signatures).toHaveLength(0);
});
test('cross-site changes cannot mint maintenance authority',async()=>{
 expect((await fetch(base+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'},body:'{}'})).status).toBe(403);
 expect(signatures).toHaveLength(0);
});
