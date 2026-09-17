import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBridgeActivity } from '../bridge-activity';

const now = Date.parse('2026-09-08T12:00:00Z');
const run = {taskId:'a',executor:'codex',title:'Work',kind:'task' as const,status:'active' as const,phase:'writing',startedAt:new Date(now-60000).toISOString(),updatedAt:new Date(now-30000).toISOString()};
test('modules share attributed active work and stop it after a newer terminal event', () => {
  const input = {now, connected:true,events:[],runs:[run],runsAvailable:true,knowledge:null};
  assert.equal(deriveBridgeActivity(input).activeItems[0].executor, 'codex');
  assert.equal(deriveBridgeActivity(input).activeItems[0].phase, 'writing');
  assert.equal(deriveBridgeActivity({...input,runsAvailable:false}).activeItems.length, 0);
  const done = {type:'task.completed',eventId:'done',at:new Date(now-1000).toISOString(),taskId:'a',result:{outcome:'success',executor:'codex'}};
  assert.equal(deriveBridgeActivity({...input,events:[done as never]}).activeItems.length, 0);
});
