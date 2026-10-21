const fs=require('fs');const path=require('path');const Database=require('better-sqlite3');
jest.mock('../services/followup-activity',()=>({...jest.requireActual('../services/followup-activity'),notifyTaskEvidenceChange:jest.fn().mockResolvedValue(true)}));
const {notifyTaskEvidenceChange}=require('../services/followup-activity');
let dir,db,raw;
beforeAll(()=>{
 dir=fs.mkdtempSync('/Volumes/Projects/followup-db-test-');process.env.NEXUS_DB_PATH=path.join(dir,'test.db');
 db=require('../../db');raw=new Database(process.env.NEXUS_DB_PATH);
 raw.prepare("INSERT INTO projects (id,name,path) VALUES ('p','Project','/project')").run();
 raw.prepare("INSERT INTO tasks (id,project_id,name,status) VALUES ('t1','p','Task','todo')").run();
});
afterAll(()=>{raw.close();delete process.env.NEXUS_DB_PATH;fs.rmSync(dir,{recursive:true,force:true});});
test('actual persisted evidence changes notify; bookkeeping and rejected writes do not',async()=>{
 const first=await db.getTask('t1');
 await db.updateTask('t1',{walkthrough:'Evidence added'},first.version);await new Promise(r=>setImmediate(r));
 expect(notifyTaskEvidenceChange).toHaveBeenCalledTimes(1);
 expect(notifyTaskEvidenceChange.mock.calls[0][1]).toMatchObject({id:'t1',walkthrough:'Evidence added'});
 notifyTaskEvidenceChange.mockClear();
 await db.updateTask('t1',{status_message:'progress',updated_at:new Date().toISOString()});await new Promise(r=>setImmediate(r));
 expect(notifyTaskEvidenceChange).not.toHaveBeenCalled();
 await expect(db.updateTask('t1',{walkthrough:'Rejected'},first.version)).rejects.toThrow();await new Promise(r=>setImmediate(r));
 expect(notifyTaskEvidenceChange).not.toHaveBeenCalled();
 await db.updateTask('t1',{dependencies:['dependency']});await new Promise(r=>setImmediate(r));
 expect(notifyTaskEvidenceChange).toHaveBeenCalledTimes(1);
});
test('new task evidence notifies through the central creation seam',async()=>{
 notifyTaskEvidenceChange.mockClear();
 const task=await db.createTask({id:'created',project_id:'p',name:'New evidence task',status:'todo',description:'Document a new, unrelated import format and its examples.',source:'user'});
 expect(task).toBeTruthy();await new Promise(r=>setImmediate(r));
 expect(notifyTaskEvidenceChange).toHaveBeenCalledTimes(1);
 expect(notifyTaskEvidenceChange.mock.calls[0][0]).toBeNull();
 expect(notifyTaskEvidenceChange.mock.calls[0][1].id).toBe(task.id);
});
