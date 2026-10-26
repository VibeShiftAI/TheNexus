const express = require('express');
const http = require('http');
const createRouter = require('../routes/mail-draft-review');
let server, base, calls, signatures, authority;
beforeEach(async () => {
 calls=[];signatures=[];authority={ok:true,actor:{authority:'access_user',id:'operator'}};
 const app=express();app.use(express.json());app.use(createRouter({authorize:async()=>authority,
 sign:(message,options)=>{signatures.push({message,options});return {'X-Proof':'signed'};},
 relay:async(path,options)=>{calls.push({path,options});return {status:200,json:async()=>({items:[],counts:{drafts:0,cancelled:0}})};}}));
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
});
afterEach(async()=>{await new Promise(r=>server.close(r));});
test('read folder forwards without minting operator proof',async()=>{expect((await fetch(base+'?folder=cancelled')).status).toBe(200);expect(calls[0].path).toBe('/api/mailbox/drafts-review?folder=cancelled');expect(signatures).toHaveLength(0);});
test('operator action signs exact id and payload',async()=>{const body={action:'edit',version:'abc',subject:'Revised',body:'New text'};expect((await fetch(base+'/md_abc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(200);expect(signatures[0]).toEqual({message:JSON.stringify({purpose:'mail-draft-review',id:'md_abc',body}),options:{surface:'mail-drafts'}});expect(calls[0].options.headers).toEqual({'X-Proof':'signed'});});
test.each(['document_executor_credential','runtime_credential'])('%s cannot mint send authority',async role=>{authority={ok:true,actor:{authority:role}};expect((await fetch(base+'/md_abc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'approve_send',version:'abc'})})).status).toBe(403);expect(calls).toHaveLength(0);expect(signatures).toHaveLength(0);});
test('cross-site actions cannot mint send authority',async()=>{expect((await fetch(base+'/md_abc',{method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'},body:'{}'})).status).toBe(403);expect(signatures).toHaveLength(0);});
