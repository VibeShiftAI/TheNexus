const fs = require('fs');
const os = require('os');
const path = require('path');
const service = () => require('../services/task-improvements');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improvements-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function write(folder, name, value) {
 fs.mkdirSync(path.join(dir, folder), { recursive: true });
 fs.writeFileSync(path.join(dir, folder, `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
}
const suggestion = { source: 'qa', text: 'Add a regression test.' };
const finalization = (id, optionalStatus) => ({ id, taskId: 't1', createdAt: '2026-10-10T10:00:00Z', optionalStatus, evidence: { author: 'codex' }, opts: { improvements: { suggestions: [suggestion] } } });
const run = (status = 'reviewing') => ({ id: 'r1', taskId: 't1', status, author: 'codex', updatedAt: '2026-10-10T11:00:00Z', createdAt: '2026-10-10T10:00:00Z', dispatchId: 'd1', suggestions: [suggestion] });
test('projects durable records and supersedes the matching deferred finalization without leaking internals', () => {
 write('task-finalizations', 'r1', finalization('r1', 'deferred'));
 write('qa-improvement-runs', 'r1', { ...run(), reason: 'API_KEY=secret123', workspace: '/private/worktree', session: 'hidden', prompt: 'private prompt', baseline: 'private baseline' });
 write('qa-improvement-runs', 'other', { ...run(), id: 'other', taskId: 'other', suggestions: [{text:'other task secret'}] });
 const result = service().readTaskImprovements('t1', { dataDir: dir });
 expect(result.available).toBe(true); expect(result.items).toHaveLength(1);
 expect(result.items[0]).toMatchObject({ id: 'r1', status: 'reviewing', dispatchId: 'd1', suggestions: [suggestion] });
 expect(JSON.stringify(result)).not.toMatch(/secret123|worktree|session|private|other task/);
});
test('maps legacy finalizations truthfully without treating sent as success', () => {
 for (const status of ['pending','deferred','dispatching','sent','not-sent']) write('task-finalizations', status, finalization(status, status));
 const result = service().readTaskImprovements('t1', { dataDir: dir });
 const items = Object.fromEntries(result.items.map(item => [item.id, item]));
 expect(items.pending.status).toBe('waiting'); expect(items.deferred.status).toBe('waiting');
 expect(items.deferred.reason).toMatch(/thirty continuous idle minutes/i);
 expect(items.dispatching.status).toBe('unknown'); expect(items.sent.status).toBe('unknown');
 expect(items['not-sent'].status).toBe('needs_attention');
});
test('only reports verified when independent passing review evidence is present', () => {
 write('qa-improvement-runs', 'r1', run('verified'));
 expect(service().readTaskImprovements('t1', { dataDir: dir }).items[0].status).toBe('needs_attention');
 write('qa-improvement-runs', 'r1', { ...run('verified'), commitSha: 'a'.repeat(40), review: { assessment:'pass', notes:'Reviewed diff.', evidence:['npm test: 5 passed'], reviewer:'claude-code', prompt:'secret' } });
 const item = service().readTaskImprovements('t1', { dataDir: dir }).items[0];
 expect(item.status).toBe('verified'); expect(item.review.reviewer).toBe('claude-code'); expect(item.review.prompt).toBeUndefined();
});
test('missing, corrupt, oversized and symlink records never become verified or leak read errors', () => {
 expect(service().readTaskImprovements('t1', { dataDir: dir })).toEqual({ available: false, items: [] });
 write('qa-improvement-runs', 'bad', '{private-corruption');
 write('qa-improvement-runs', 'large', 'x'.repeat(300000));
 const outside = path.join(dir, 'outside.json'); fs.writeFileSync(outside, JSON.stringify(run('verified')));
 fs.symlinkSync(outside, path.join(dir, 'qa-improvement-runs', 'link.json'));
 const result = service().readTaskImprovements('t1', { dataDir: dir });
 expect(result).toEqual({ available: false, items: [] });
});
test('bounds directory enumeration and preserves uncertainty when the scan is incomplete', () => {
 for(let i=0;i<4;i++) write('task-finalizations', `r${i}`, finalization(`r${i}`, 'deferred'));
 const result = service().readTaskImprovements('t1', { dataDir: dir, maxFiles: 2 });
 expect(result.available).toBe(false); expect(result.items.length).toBeLessThanOrEqual(2);
});
test('reads large finalization envelopes while projecting only improvement fields', () => {
 write('task-finalizations', 'r1', {...finalization('r1','deferred'), privateDiff:'x'.repeat(800000)});
 const result = service().readTaskImprovements('t1', { dataDir: dir });
 expect(result.available).toBe(true); expect(result.items[0].status).toBe('waiting');
 expect(JSON.stringify(result).length).toBeLessThan(1000);
});

test('calendar reads all tasks once, keeps improvement identity and filters archived parents', () => {
 write('task-finalizations', 'r1', finalization('r1', 'deferred'));
 write('qa-improvement-runs', 'r2', { ...run('running'), id:'r2', taskId:'t2' });
 write('qa-improvement-runs', 'r3', { ...run('reviewing'), id:'r3', taskId:'archived' });
 const result = service().readCalendarImprovements([
  {id:'t1',name:'Parent one',status:'completed'}, {id:'t2',name:'Parent two',status:'completed'},
  {id:'archived',name:'Archived',archived_at:'2026-10-11'}
 ], {dataDir:dir});
 expect(result.available).toBe(true);
 expect(result.items).toHaveLength(2);
 expect(result.items.find(i=>i.taskId==='t1')).toMatchObject({title:'QA improvements — Parent one',lane:'waiting',improvement:{id:'r1',status:'waiting'}});
 expect(result.items.find(i=>i.taskId==='t2')).toMatchObject({lane:'running',improvement:{id:'r2',status:'running'}});
});
test('held legacy suggestions remain visible in the pending calendar list', () => {
 write('task-finalizations','r1',{...finalization('r1','review-held'),optionalReview:{required:true,reason:'Review relevance with Robert first'}});
 const detail=service().readTaskImprovements('t1',{dataDir:dir});
 expect(detail.items[0]).toMatchObject({status:'review_held',reviewRequired:true});
 expect(service().readCalendarImprovements([{id:'t1',name:'Parent',status:'completed'}],{dataDir:dir}).items).toHaveLength(1);
 // Legacy runs remain visible as pending review, never active execution.
 write('qa-improvement-runs','r1',run());
 expect(service().readCalendarImprovements([{id:'t1',name:'Parent',status:'completed'}],{dataDir:dir}).items).toHaveLength(1);
});

const optionalTaskId = '0d1001a3-20b5-4d74-b6b1-a1a13cdb0945';
test('linked finalization overrides a legacy attention run and suppresses duplicate calendar entries', () => {
 write('qa-improvement-runs', 'r1', {...run('needs_attention'),reason:'Old failure'});
 write('task-finalizations', 'r1', {...finalization('r1','sent'),optionalTaskId});
 const detail = service().readTaskImprovements('t1',{dataDir:dir});
 expect(detail.items).toHaveLength(1);
 expect(detail.items[0]).toMatchObject({status:'linked',optionalTaskId,dispatchId:'d1'});
 expect(detail.items[0].reason).not.toMatch(/Old failure/);
 expect(service().readCalendarImprovements([{id:'t1',name:'Parent',status:'completed'},{id:optionalTaskId,name:'Follow-up',status:'approved'}],{dataDir:dir}).items).toEqual([]);
});
test('linked finalizations work without a legacy run and preserve explicit review holds', () => {
 write('task-finalizations','r1',{...finalization('r1','sent'),optionalTaskId});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0]).toMatchObject({status:'linked',optionalTaskId});
 write('qa-improvement-runs','r1',run('running'));
 write('task-finalizations','r1',{...finalization('r1','sent'),optionalTaskId,optionalReview:{required:true,reason:'Review relevance first'}});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0]).toMatchObject({status:'review_held',reviewRequired:true,reason:'Review relevance first',optionalTaskId});
 expect(service().readCalendarImprovements([{id:'t1',status:'completed'}],{dataDir:dir}).items).toEqual([]);
});
test('invalid follow-up task identifiers cannot hide legacy calendar records', () => {
 write('task-finalizations','r1',{...finalization('r1','deferred'),optionalTaskId:'../../bad'});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0].optionalTaskId).toBeUndefined();
 expect(service().readCalendarImprovements([{id:'t1',status:'completed'}],{dataDir:dir}).items).toHaveLength(1);
});

function withHeader(folder, record, body = record, version = 1) {
 return JSON.stringify({_dashboardSummary:{version,kind:folder,record}}).slice(0,-1) + ',\n' + JSON.stringify(body).slice(1);
}
test('reads only a bounded header for an 8 MiB finalization', () => {
 const record = finalization('large-header','deferred');
 write('task-finalizations',record.id,withHeader('task-finalizations',record,{...record,privateDiff:'x'.repeat(8*1024*1024)}));
 const original = fs.readSync; let bytes = 0;
 const spy = jest.spyOn(fs,'readSync').mockImplementation((...args) => { const n = original(...args); bytes += n; return n; });
 try {
  const result = service().readTaskImprovements('t1',{dataDir:dir});
  expect(result.available).toBe(true); expect(result.items[0].status).toBe('waiting');
  expect(bytes).toBeLessThanOrEqual(64*1024);
 } finally { spy.mockRestore(); }
});
test('header records retain verification checks, redaction and linked/held finalization precedence', () => {
 const r = {...run('verified'),reason:'TOKEN=hidden-value'};
 write('qa-improvement-runs','r1',withHeader('qa-improvement-runs',r));
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0].status).toBe('needs_attention');
 const f = {...finalization('r1','sent'),optionalTaskId,optionalReview:{required:true,reason:'Review scope'}};
 write('task-finalizations','r1',withHeader('task-finalizations',f));
 const result=service().readTaskImprovements('t1',{dataDir:dir});
 expect(result.items[0]).toMatchObject({status:'review_held',optionalTaskId});
 expect(JSON.stringify(result)).not.toContain('hidden-value');
 expect(service().readCalendarImprovements([{id:'t1',status:'completed'}],{dataDir:dir}).items).toEqual([]);
});
test.each(['future','malformed','wrong-kind','missing-record','long-header'])('rejects %s header rather than trusting the full body as fallback', issue => {
 const r=run('verified'); let text=withHeader('qa-improvement-runs',r);
 if(issue==='future') text=withHeader('qa-improvement-runs',r,r,2);
 if(issue==='malformed') text='{"_dashboardSummary":broken,\n'+JSON.stringify(r).slice(1);
 if(issue==='wrong-kind') text=withHeader('task-finalizations',r);
 if(issue==='missing-record') text=withHeader('qa-improvement-runs',null,r);
 if(issue==='long-header') text=withHeader('qa-improvement-runs',{...r,reason:'x'.repeat(70000)});
 write('qa-improvement-runs','r1',text);
 expect(service().readTaskImprovements('t1',{dataDir:dir})).toEqual({available:false,items:[]});
});

const followupReview = status => ({status, reviewedAt:'2026-10-21T12:00:00Z', reason:'Evidence assessed.', slateId:'slate-1',priority:2,decisions:[{index:0,disposition:status==='completed'?'complete':status==='proposed'?'execute':'retain',reason:'Concrete reason.',evidence:['Existing fix verified.']}]});
test.each(['proposed','retained','completed'])('projects %s follow-up review without claiming implementation QA', status => {
 write('task-finalizations','r1',withHeader('task-finalizations',{...finalization('r1','review-held'),optionalReview:{required:true},followupReview:followupReview(status)}));
 const item=service().readTaskImprovements('t1',{dataDir:dir}).items[0];
 expect(item.status).toBe(status==='completed'?'completed_after_review':status);
 expect(item.followupReview).toMatchObject({status,priority:2,decisions:[{index:0,reason:'Concrete reason.',evidence:['Existing fix verified.']}]});
 expect(item.updatedAt).toBe('2026-10-21T12:00:00.000Z');
 expect(service().readCalendarImprovements([{id:'t1',status:'completed'}],{dataDir:dir}).items[0].lane).toBe(status==='completed'?'finished':'waiting');
});
test('review decision supersedes legacy run but linked task remains authoritative', () => {
 write('qa-improvement-runs','r1',run('running'));
 write('task-finalizations','r1',{...finalization('r1','deferred'),followupReview:followupReview('retained')});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0].status).toBe('retained');
 write('task-finalizations','r1',{...finalization('r1','sent'),optionalTaskId,followupReview:followupReview('proposed')});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0]).toMatchObject({status:'linked',followupReview:{status:'proposed'}});
 expect(service().readCalendarImprovements([{id:'t1',status:'completed'}],{dataDir:dir}).items).toEqual([]);
});

test('linked execution retains a separate pending row for unresolved findings only', () => {
 const review={...followupReview('proposed'),decisions:[{index:0,disposition:'execute',reason:'Fix now.',evidence:[]},{index:1,disposition:'retain',reason:'Waiting for dependency.',evidence:['Dependency open.']}]};
 write('task-finalizations','r1',{...finalization('r1','sent'),optionalTaskId,followupReview:review});
 const result=service().readCalendarImprovements([{id:'t1',status:'completed'},{id:optionalTaskId,status:'approved'}],{dataDir:dir});
 expect(result.items).toHaveLength(1);
 expect(result.items[0]).toMatchObject({lane:'waiting',improvement:{status:'retained',reason:'Waiting for dependency.'}});
 expect(service().readTaskImprovements('t1',{dataDir:dir}).items[0].status).toBe('linked');
});
