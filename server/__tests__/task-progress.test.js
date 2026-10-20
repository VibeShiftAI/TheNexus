const { parseProgressLog, readProgressLog } = require('../services/task-progress');
const fs = require('fs'); const os = require('os'); const path = require('path');
const run = { id: 'd1', executor: 'codex', started_at: '2026-10-09T10:00:00Z', completed_at: null };
const header = '=== codex detached run started 2026-10-09T10:00:01Z ===\n';
const event = (text, type = 'agent_message') => JSON.stringify({ type: 'item.completed', item: { type, text } }) + '\n';
test('projects only user-facing messages inside this attempt, not previous runs, reasoning or tools', () => {
 const parsed = parseProgressLog('=== codex detached run started 2026-10-09T09:00:00Z ===\n' + event('old failure') + header + event('Checking the updated page.') + event('secret reasoning', 'reasoning') + event('tool output', 'command_execution'), run);
 expect(parsed.messages.map(m => m.text)).toEqual(['Checking the updated page.']);
 expect(parsed.messages[0].at).toBeNull();
 expect(parsed.available).toBe(true);
});
test('does not promote a boundaryless tail or a later dispatch into this attempt', () => {
 expect(parseProgressLog(event('unknown run'), run).available).toBe(false);
 expect(parseProgressLog(header + event('later'), { ...run, nextStartedAt: '2026-10-09T10:00:00.500Z' }).messages).toEqual([]);
});
test('Claude includes text only and redacts credential forms', () => {
 const raw = '=== Claude Code run started 2026-10-09T10:00:01Z ===\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Verified API_KEY=abc123 and Bearer xyz456; https://u:pass@example.com' }] } }) + '\n';
 const parsed = parseProgressLog(raw, { ...run, executor: 'claude-code' });
 expect(parsed.messages[0].text).not.toMatch(/abc123|xyz456|u:pass|private/);
});
test('rejects symlinks outside allowed roots and caps bytes without inventing attribution', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-progress-'));
 try { const root = path.join(dir, 'logs'); fs.mkdirSync(root); const outside = path.join(dir, 'secret'); fs.writeFileSync(outside, header + event('private')); const link = path.join(root, 'link'); fs.symlinkSync(outside, link);
 expect(readProgressLog({ ...run, log_path: link }, [root]).available).toBe(false);
 const log = path.join(root, 'run'); fs.writeFileSync(log, header + event('update') + 'x'.repeat(3 * 1024 * 1024));
 const parsed = readProgressLog({ ...run, log_path: log }, [root]); expect(parsed.truncated).toBe(true); expect(parsed.messages).toEqual([]);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('HTTP projection stays task scoped, readonly and omits prompts, paths and raw metadata', async () => {
 const express = require('express'); const Database = require('better-sqlite3');
 const createRouter = require('../routes/task-progress');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-progress-http-')); const dbPath = path.join(dir, 'board.db'); const log = path.join(dir, 'run.log');
 fs.writeFileSync(log, header + event('Testing the change.'));
 const db = new Database(dbPath);
 db.exec('CREATE TABLE task_dispatches (id TEXT, task_id TEXT, executor TEXT, outcome TEXT, kind TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT, log_path TEXT); CREATE TABLE ag_events (id INTEGER, task_id TEXT, title TEXT, message TEXT, event_type TEXT, created_at TEXT, metadata TEXT);');
 db.prepare('INSERT INTO task_dispatches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('d1', 't1', 'codex', 'running', 'dispatch', null, run.started_at, null, log);
 db.prepare('INSERT INTO ag_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 't1', 'Retry scheduled', 'A new attempt was requested.', 'task_retry', run.started_at, '{"private":"secret"}');
 db.prepare('INSERT INTO ag_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'other', 'OTHER TASK SECRET', '', 'task_retry', run.started_at, '{}'); db.close();
 fs.mkdirSync(path.join(dir, 'task-finalizations'));
 fs.writeFileSync(path.join(dir, 'task-finalizations', 'f1.json'), JSON.stringify({ id: 'f1', taskId: 't1', optionalStatus: 'deferred', opts: { improvements: { suggestions: [{source:'qa', text:'Add test.'}] } } }));
 const app = express(); app.use('/api/task-progress', createRouter({ dbPath, logRoots: [dir], improvementsDataDir: dir })); const server = app.listen(0, '127.0.0.1');
 await new Promise(resolve => server.once('listening', resolve));
 try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/task-progress/t1`); const body = await response.json();
 expect(response.status).toBe(200); expect(body.improvements.items[0]).toMatchObject({id:'f1',status:'waiting'}); expect(body.attempts[0].commentary.messages[0].text).toBe('Testing the change.'); expect(body.events).toHaveLength(1);
 expect(JSON.stringify(body)).not.toMatch(/OTHER TASK SECRET|private|log_path|board.db|run.log/);
 } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('SQLite UTC activity timestamps include their timezone in the public projection', () => {
 const { activityTimestamp } = require('../services/task-progress');
 expect(activityTimestamp('2026-10-09 23:29:43')).toBe('2026-10-09T23:29:43Z');
 expect(activityTimestamp('2026-10-09T23:29:43.836Z')).toBe('2026-10-09T23:29:43.836Z');
 expect(activityTimestamp('2026-10-09T19:29:43-04:00')).toBe('2026-10-09T19:29:43-04:00');
});
test('message timestamps use valid explicit source times inside the attempt only', () => {
 const log = timestamp => header + JSON.stringify({type:'item.completed', timestamp, item:{type:'agent_message',text:'Checking links.'}});
 expect(parseProgressLog(log('2026-10-09T10:04:15Z'), run).messages[0].at).toBe('2026-10-09T10:04:15.000Z');
 for (const timestamp of [undefined, 'bad', '2026-10-09T10:04:15', '2026-10-09T09:00:00Z']) expect(parseProgressLog(log(timestamp),run).messages[0].at).toBeNull();
 const claude = '=== Claude Code run started 2026-10-09T10:00:01Z ===\n'+JSON.stringify({type:'assistant',timestamp:'2026-10-09T10:04:15Z',message:{content:[{type:'text',text:'Checking links.'}]}});
 expect(parseProgressLog(claude,{...run,executor:'claude-code'}).messages[0].at).toBe('2026-10-09T10:04:15.000Z');
});
test('large current log retains tail commentary only after proving its preceding attempt boundary', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-progress-large-'));
 const log=path.join(root,'run.log');
 try {
  fs.writeFileSync(log,header + event('old message') + 'x'.repeat(3*1024*1024) + '\n' + event('Fresh current progress'));
  const parsed=readProgressLog({...run,log_path:log},[root]);
  expect(parsed.available).toBe(true);expect(parsed.truncated).toBe(true);
  expect(parsed.messages.map(m=>m.text)).toEqual(['Fresh current progress']);
  fs.appendFileSync(log,'=== codex detached run started 2026-10-09T12:00:01Z ===\n'+event('Different attempt'));
  const earlier=readProgressLog({...run,completed_at:'2026-10-09T11:00:00Z',log_path:log},[root]);
  expect(earlier.messages.map(m=>m.text)).toEqual(['Fresh current progress']);
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('prefix attribution never crosses a prior ended run or a newer start outside the tail',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-progress-ended-'));const log=path.join(root,'run.log');
 try {
  for(const boundary of ['=== codex run ended 2026-10-09T10:01:00Z ===\n','=== codex detached run started 2026-10-09T12:00:01Z ===\n']){
   fs.writeFileSync(log,header+boundary+'x'.repeat(3*1024*1024)+'\n'+event('Unattributed message'));
   const parsed=readProgressLog({...run,completed_at:'2026-10-09T11:00:00Z',log_path:log},[root]);expect(parsed.messages).toEqual([]);
  }
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('a start boundary split at the tail cutoff cannot leak a newer attempt',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-progress-seam-'));const log=path.join(root,'run.log');
 try {
  const newer='=== codex detached run started 2026-10-09T12:00:01Z ===\n';
  const message=event('Different attempt');
  const suffix='x'.repeat(2*1024*1024-(newer.length-12)-message.length-1)+'\n'+message;
  fs.writeFileSync(log,header+'padding\n'+newer+suffix);
  const parsed=readProgressLog({...run,completed_at:'2026-10-09T11:00:00Z',log_path:log},[root]);expect(parsed.messages).toEqual([]);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
