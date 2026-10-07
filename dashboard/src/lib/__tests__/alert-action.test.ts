import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAlertAction, describeHitlAction, loadAlertEvidence, safeAlertHref, selectPendingAlert, isAlertRequestExpired } from '../alert-action';

const event = (extra = {}) => ({ id: 1, event_type: 'task_blocked', title: 'Task blocked', message: 'Old question', task_id: 'task-1', requires_action: 1, metadata: { hitlId: 'question-1' }, ...extra });
const request = (extra = {}) => ({ id: 'question-1', taskId: 'task-1', question: 'Choose the staging URL, then paste it below.', reason: 'explicit_request', requestedAt: '2026-10-05T00:00:00Z', workspace: '/tmp', ...extra });

test('verified pending request exposes the exact question and specific inbox destination', () => {
  const action = describeAlertAction(event(), { hitls: { 'question-1': request() }, tasks: {} });
  assert.equal(action.state, 'pending');
  assert.equal(action.question, request().question);
  assert.equal(action.href, '/inbox#question-1');
  assert.match(action.instruction, /answer|choose/i);
});
test('answered event preserves choice and notes without claiming the task resumed', () => {
  const answer = { resolvedAt: '2026-10-06T00:00:00Z', choice: 'keep it saved for the next run', freeText: 'Use staging only.' };
  const action = describeAlertAction(event(), { hitls: { 'question-1': request({ resolution: answer }) }, tasks: {} });
  assert.equal(action.state, 'resolved');
  assert.match(action.answer!, /keep it saved for the next run\n\nUse staging only/);
  assert.doesNotMatch(action.instruction, /resumed|retry|answer again/i);
});
test('absent or unavailable evidence never falsely clears an alert', () => {
  for (const value of [undefined, null]) {
    const action = describeAlertAction(event(), { hitls: { 'question-1': value }, tasks: {} });
    assert.equal(action.state, 'unknown');
    assert.equal(action.href, '/inbox#question-1');
    assert.match(action.instruction, /current|status/i);
  }
});
test('completed task makes its old blocked signal historical but not unrelated incident fixed', () => {
  const evidence = { hitls: {}, tasks: { 'task-1': { status: 'completed' } } };
  assert.equal(describeAlertAction(event({ metadata: {} }), evidence).state, 'historical');
  assert.equal(describeAlertAction(event({ metadata: {}, event_type: 'service_unresponsive' }), evidence).state, 'unknown');
});
test('red alert acknowledgment is distinguished from repairing the incident', () => {
  const action = describeHitlAction(request({ metadata: { kind: 'red-alert' }, options: ['acknowledged'] }));
  assert.match(action.instruction, /acknowledged/i);
  assert.match(action.instruction, /does not (repair|fix)/i);
});
test('saved predictive restart proposals require current-state review before a decision', () => {
  const action = describeHitlAction(request({ id: 'hitl-predictive-action-123', question: 'Praxis paused infra_restart_service.', options: ['Approve this exact action', 'Reject and re-plan'] }));
  assert.match(action.instruction, /current system status/);
  assert.match(action.instruction, /still needed/);
  assert.deepEqual(action.relatedLinks, [{ href: '/system-monitor', label: 'Review current system status' }]);
});
test('saved answer holds ask only for delivery choice and preserve the answer', () => {
  const action = describeHitlAction(request({ metadata: { kind: 'task-answer-held', answer: 'Approved staging only', holdReason: 'Contract review pending' } }));
  assert.match(action.instruction, /retry delivery now/);
  assert.match(action.instruction, /keep it saved for the next run/);
  assert.equal(action.answer, 'Approved staging only');
  assert.equal(action.reason, 'Contract review pending');
});
test('safe destinations reject active protocols, protocol-relative URLs and encoded controls', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', '//evil.test', '/\\evil.test', 'https://ok.test\n@evil.test', '/%0aevil']) assert.equal(safeAlertHref(url), undefined, url);
  assert.equal(safeAlertHref('/task/a#contract-hold'), '/task/a#contract-hold');
  assert.equal(safeAlertHref('https://example.com/form'), 'https://example.com/form');
});
test('bridge keeps a fresh failure above a routine request while a critical request stays visible', () => {
  const normal = request(); const critical = request({ id: 'critical', priority: 'critical' });
  assert.equal(selectPendingAlert([normal], true), undefined);
  assert.equal(selectPendingAlert([normal, critical], true), critical);
  assert.equal(selectPendingAlert([normal], false), normal);
});
test('TTL expiry matches runtime strict boundary and retains invalid-date fallback', () => {
  const timed = request({ ttlSeconds: 60 }); const at = Date.parse(timed.requestedAt);
  assert.equal(isAlertRequestExpired(timed, at + 60_000), false);
  assert.equal(isAlertRequestExpired(timed, at + 60_001), true);
  assert.equal(isAlertRequestExpired({ ...timed, requestedAt: 'bad' }, at + 60_001), false);
  assert.equal(describeHitlAction(timed).state, 'historical');
});
test('read budget is capped and shared request/task IDs are deduplicated', async () => {
  const calls: string[] = [];
  let active = 0, max = 0;
  const fetcher = async (url: string) => {
    calls.push(url); active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(JSON.stringify(url.endsWith('/pending') ? { requests: [] } : url.includes('/hitl/') ? request({ id: url.split('/').pop(), resolution: { choice: 'done' } }) : { status: 'completed' }));
  };
  await loadAlertEvidence(Array.from({ length: 464 }, (_, i) => event({ id: i, task_id: `t-${i % 30}`, metadata: { hitlId: `h-${i % 30}` } })), fetcher);
  assert.ok(calls.length <= 21, `${calls.length} reads exceeds budget`);
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(max <= 4);
});
