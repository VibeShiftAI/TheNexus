const express = require('express');
const createProof = require('../services/task-dispatch-proof');
let server, base, authority, signed;
beforeEach(async () => {
 authority={ok:true,actor:{authority:'access_user'}};signed=[];
 const app=express();app.use(express.json());
 app.post('/',createProof({authorize:async()=>authority,sign:(message,options)=>{signed.push({message,options});return {'x-praxis-operator-provenance':'fixture'};}}),(req,res)=>res.json({proof:req.taskDispatchProof??null}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/`;
});
afterEach(async()=>{await new Promise(r=>server.close(r));});
const send=body=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('raw operator flag cannot mint proof for unattended caller',async()=>{
 authority={ok:true,actor:{authority:'runtime_credential'}};
 expect((await send({taskId:'task',operator:true})).status).toBe(403);expect(signed).toHaveLength(0);
});
test('verified human dispatch signs exact body',async()=>{
 const body={taskId:'task',operator:true,executor:'codex'};expect((await send(body)).status).toBe(200);
 expect(signed).toEqual([{message:JSON.stringify(body),options:{surface:'task-dispatch'}}]);
});
test('ordinary unattended path never gains operator proof',async()=>{
 expect((await (await send({taskId:'task'})).json()).proof).toBeNull();expect(signed).toHaveLength(0);
});
