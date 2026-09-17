const { projectUsageWaits, readUsageWaits } = require('../services/focus-usage-waits');

test('projects only safe fields and distinguishes recovery from quota waits', () => {
  const result = projectUsageWaits([{taskId:'one', executor:'codex', resumeAtIso:'2026-09-08T12:00:00Z', limitedAtIso:'2026-09-07T12:00:00Z', workspace:'/private', executionId:'private', session:{sessionId:'secret', model:'gpt-6-astra', workspace:'/private'}}, {taskId:'two', kind:'session_recovery', requiresAction:true, resumeAtIso:'2026-09-08T12:00:00Z'}]);
  expect(result[0]).toEqual({taskId:'one', executor:'codex', model:'gpt-6-astra', kind:'usage_limit', resumeAt:'2026-09-08T12:00:00Z', limitedAt:'2026-09-07T12:00:00Z', requiresAction:false});
  expect(result[1].kind).toBe('session_recovery');
  expect(JSON.stringify(result)).not.toMatch(/secret|private|executionId/);
});
test('invalid and unreadable ledgers remain unknown', () => {
  expect(() => projectUsageWaits({})).toThrow();
  expect(() => projectUsageWaits([{taskId:'one',resumeAtIso:'garbage'}])).toThrow();
  expect(readUsageWaits('/definitely-not-a-real-ledger')).toEqual({items:[], available:false});
});
