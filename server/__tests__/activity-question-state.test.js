const Database = require('better-sqlite3');
const {initializeActivityEvents, recordActivityEvent, readActivityEvents} = require('../../db/activity-events');
let db;
beforeEach(()=>{db=new Database(':memory:');initializeActivityEvents(db);});
afterEach(()=>db.close());
const add=(type,metadata={},extra={})=>recordActivityEvent(db,{event_type:type,title:'Task blocked',task_id:'task',severity:'warning',requires_action:true,metadata,created_at:'2026-10-21T17:16:37Z',...extra});
test('one question has one activity entry despite archived chat and repeated publication',()=>{
 add('task_blocked',{hitlId:'q1',chatMessageId:'chat'});
 add('task_blocked',{hitlId:'q1'});
 add('task_blocked',{hitlId:'q1'});
 expect(readActivityEvents(db)).toHaveLength(1);
 expect(readActivityEvents(db)[0].metadata.chatMessageId).toBeUndefined();
});
test('a resumed answer resolves only its question, even outside the feed window',()=>{
 add('task_blocked',{hitlId:'q1'});
 add('task_blocked',{hitlId:'q2'});
 add('task_resumed_with_answer',{rootHitlId:'q1'},{created_at:'2026-10-21T17:17:11Z'});
 const rows=readActivityEvents(db);
 const old=rows.find(r=>r.metadata.hitlId==='q1');
 expect(old).toMatchObject({event_type:'task_question_resolved',severity:'info',requires_action:0,action_taken:1,title:'Question answered; task resumed'});
 expect(old.created_at).toBe('2026-10-21T17:16:37Z');
 expect(rows.find(r=>r.metadata.hitlId==='q2').requires_action).toBe(1);
 expect(readActivityEvents(db,{severity:'warning'}).map(r=>r.metadata.hitlId)).not.toContain('q1');
});
test('late archived notices remain resolved and unlinked blocks stay visible',()=>{
 add('hitl_resolved',{hitlId:'q1'},{task_id:null});
 add('task_blocked',{hitlId:'q1',chatMessageId:'late'});
 add('task_blocked',{});
 const rows=readActivityEvents(db);
 expect(rows.find(r=>r.metadata.hitlId==='q1'&&r.metadata.chatMessageId)).toMatchObject({requires_action:0,title:'Question answered'});
 expect(rows.find(r=>r.event_type==='task_blocked').requires_action).toBe(1);
});
test('resolution is matched by question and task, and applied before limit and severity',()=>{
 add('task_blocked',{hitlId:'q1'});
 add('task_resumed_with_answer',{rootHitlId:'q1'},{task_id:'different-task',created_at:'2026-10-21T17:17:11Z',severity:'info'});
 expect(readActivityEvents(db,{severity:'warning',limit:1})[0].event_type).toBe('task_blocked');
 add('task_resumed_with_answer',{rootHitlId:'q1'},{created_at:'2026-10-21T17:18:11Z',severity:'info'});
 expect(readActivityEvents(db,{severity:'warning',limit:1})).toHaveLength(0);
 expect(db.prepare("SELECT event_type,requires_action FROM ag_events WHERE id=1").get()).toEqual({event_type:'task_blocked',requires_action:1});
});
test('resolved state survives retention of the permanent archived question',()=>{
 add('task_blocked',{hitlId:'q1',chatMessageId:'chat'});
 add('hitl_resolved',{hitlId:'q1'},{task_id:null});
 recordActivityEvent(db,{event_type:'other',title:'other',created_at:'2026-10-21T17:20:00Z'},1);
 expect(readActivityEvents(db).find(r=>r.metadata.hitlId==='q1').event_type).toBe('task_question_resolved');
});
test('an older answer still resolves a late notice selected by since and limit',()=>{
 add('hitl_resolved',{hitlId:'q1'},{task_id:null,created_at:'2026-10-21T17:00:00Z'});
 add('task_blocked',{hitlId:'q1',chatMessageId:'late'},{created_at:'2026-10-21T17:30:00Z'});
 const rows=readActivityEvents(db,{since:'2026-10-21T17:20:00Z',limit:1});
 expect(rows).toHaveLength(1);
 expect(rows[0].event_type).toBe('task_question_resolved');
});
test('initialization backfills existing answer history without changing original records',()=>{
 add('task_blocked',{hitlId:'q1'});
 add('task_resumed_with_answer',{rootHitlId:'q1'});
 db.exec('DROP TABLE ag_question_resolutions');
 initializeActivityEvents(db);
 initializeActivityEvents(db);
 expect(db.prepare('SELECT count(*) AS n FROM ag_question_resolutions').get().n).toBe(1);
 expect(readActivityEvents(db).find(r=>r.metadata.hitlId==='q1').title).toBe('Question answered; task resumed');
});
