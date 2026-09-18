import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@praxis/contract';
import { VoiceAlerts, alertFacts, readAlertMode, ALERT_MODE_KEY, ALERT_STORE_KEY, alertDelay, eligibleAlert } from '../voice-alerts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (type: string, extra = {}) => ({ type, eventId: 'event-1', at: new Date(2026, 8, 7, 12).toISOString(), taskId: 'task-1', ...extra }) as StreamEvent;
test('settings default conversational and honor previously disabled alerts', () => {
  localStorage.clear(); assert.equal(readAlertMode(), 'conversational');
  localStorage.setItem('nexus.voice.alerts', '0'); assert.equal(readAlertMode(), 'off');
  localStorage.setItem('nexus.voice.alerts', 'false'); assert.equal(readAlertMode(), 'off');
  localStorage.setItem(ALERT_MODE_KEY, 'attention'); assert.equal(readAlertMode(), 'attention');
});
test('attention and conversational selection preserve routine exclusions and whole details', () => {
  const failed = event('task.failed', { error: 'Detailed failure. '.repeat(50) });
  assert.equal(eligibleAlert(failed, 'off'), false); assert.equal(eligibleAlert(failed, 'attention'), true);
  assert.equal(eligibleAlert(event('task.completed'), 'attention'), false);
  assert.equal(eligibleAlert(event('task.completed'), 'conversational'), false);
  assert.equal(eligibleAlert(event('task.qa-passed'), 'conversational'), true);
  assert.equal(eligibleAlert(event('task.qa-passed'), 'attention'), false);
  assert.equal(eligibleAlert(event('task.blocked'), 'conversational'), true);
  assert.equal(eligibleAlert(event('hitl.created', { request: { question: 'Approve?', metadata: { kind: 'day-schedule' } } }), 'conversational'), false);
  assert.equal(alertFacts(failed, () => 'Build the ship').title, 'Build the ship');
  assert.equal(alertFacts(failed).reason, 'Detailed failure. '.repeat(50));
});
test('quiet hours and rate interval provide a concrete future wakeup', () => {
  const noon = new Date(2026, 8, 7, 12).getTime();
  assert.equal(alertDelay(noon, noon - 1000), 119000);
  assert.equal(alertDelay(new Date(2026, 8, 7, 23).getTime(), 0), 9 * 3600000);
  assert.equal(alertDelay(new Date(2026, 8, 7, 8).getTime(), 0), 0);
});
function fixture(active = true) {
  let now = new Date(2026, 8, 7, 12).getTime(); const timers = new Map<number, { callback: () => void; delay: number }>(); let id = 0; const spoken: string[] = [];
  const alerts = new VoiceAlerts({ mountedAt: now - 1, now: () => now, active: async () => active,
    announce: e => { spoken.push(e.eventId); return Promise.resolve(); },
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; }, clearTimer: timer => { timers.delete(timer as number); } });
  return { alerts, timers, spoken, advance: (ms: number) => { now += ms; const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(t => t.callback()); } };
}
test('deferred alert wakes without another event and disposal cancels its timer', async () => {
  localStorage.clear(); const f = fixture(); f.alerts.update([event('task.failed', { error: 'one' })], 'attention'); await tick();
  f.alerts.update([event('task.failed', { eventId: 'event-2', error: 'two' })], 'attention'); await tick();
  assert.equal(f.spoken.length, 1); assert.ok([...f.timers.values()].some(t => t.delay === 120000));
  f.advance(120000); await tick(); assert.equal(f.spoken.length, 2);
  f.alerts.dispose(); assert.equal(f.timers.size, 0);
});
test('inactive devices never speak and persisted dedupe survives new scheduler instances', async () => {
  localStorage.clear(); const off = fixture(false); off.alerts.update([event('task.failed')], 'attention'); await tick(); assert.equal(off.spoken.length, 0); off.alerts.dispose();
  const first = fixture(); first.alerts.update([event('task.failed')], 'attention'); await tick(); first.alerts.dispose();
  const second = fixture(); second.alerts.update([event('task.failed')], 'attention'); await tick(); assert.equal(second.spoken.length, 0); second.alerts.dispose();
  const stored = JSON.parse(localStorage.getItem(ALERT_STORE_KEY)!); assert.equal(stored.ids.length, 1);
});
test('unmount during deferred active check cannot announce', async () => {
  localStorage.clear(); let finish!: (active: boolean) => void; let spoken = 0;
  const alerts = new VoiceAlerts({ mountedAt: 0, now: () => new Date(2026, 8, 7, 12).getTime(), active: () => new Promise(r => finish = r), announce: () => { spoken++; return Promise.resolve(); } });
  alerts.update([event('task.failed')], 'attention'); alerts.dispose(); finish(true); await tick(); assert.equal(spoken, 0);
});
test('persisted event registry stays bounded and retains the newly announced identity', async () => {
  localStorage.clear(); localStorage.setItem(ALERT_STORE_KEY, JSON.stringify({ ids: Array.from({ length: 400 }, (_, i) => `old-${i}`), lastAt: 0 }));
  const f = fixture(); f.alerts.update([event('task.failed')], 'attention'); await tick(); f.alerts.dispose();
  const stored = JSON.parse(localStorage.getItem(ALERT_STORE_KEY)!); assert.equal(stored.ids.length, 300); assert.equal(stored.ids.at(-1), 'event-1');
});
test('tab lock prevents overlapping checks and the losing tab observes persisted dedupe', async t => {
  localStorage.clear(); let locked = false; let locks = 0;
  const original = navigator.locks;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: {} | null) => Promise<void>) => {
    locks++; if (locked) return callback(null); locked = true; try { await callback({}); } finally { locked = false; }
  } } });
  t.after(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: original }));
  const first = fixture(); const second = fixture();
  first.alerts.update([event('task.failed')], 'attention'); second.alerts.update([event('task.failed')], 'attention'); await tick();
  second.advance(5000); await tick();
  assert.ok(locks >= 2); assert.equal(first.spoken.length + second.spoken.length, 1); first.alerts.dispose(); second.alerts.dispose();
});
test('an event arriving while an empty scan finishes still gets a wakeup', async () => {
  localStorage.clear(); const f = fixture(); f.alerts.update([], 'attention'); f.alerts.update([event('task.failed')], 'attention'); await tick();
  assert.equal(f.spoken.length, 1); f.alerts.dispose();
});
test('turning alerts off cancels a scheduled announcement', async () => {
  localStorage.clear(); const f = fixture(); f.alerts.update([event('task.failed')], 'attention'); await tick();
  f.alerts.update([event('task.failed', { eventId: 'later' })], 'attention'); await tick(); assert.ok(f.timers.size);
  f.alerts.update([event('task.failed', { eventId: 'later' })], 'off'); assert.equal(f.timers.size, 0);
  f.advance(120000); await tick(); assert.equal(f.spoken.length, 1); f.alerts.dispose();
});
test('quiet hours are checked again after a delayed active-device response', async t => {
  localStorage.clear(); let now = new Date(2026, 8, 7, 21, 59, 59).getTime(); let finish!: (active: boolean) => void; let spoken = 0;
  const alerts = new VoiceAlerts({ mountedAt: 0, now: () => now, active: () => new Promise(r => finish = r), announce: () => { spoken++; return Promise.resolve(); } });
  t.after(() => alerts.dispose());
  alerts.update([event('task.failed', { at: new Date(now).toISOString() })], 'attention'); now += 2000; finish(true); await tick();
  assert.equal(spoken, 0); alerts.dispose();
});

test('alert composition receives event facts instead of stock spoken lines', async () => {
  const alerts = await import('../voice-alerts');
  assert.equal(typeof alerts.alertFacts, 'function');
  assert.deepEqual(alerts.alertFacts(event('task.failed', { error: 'Compiler failed' }), () => 'Build the ship'), { taskId: 'task-1', title: 'Build the ship', status: 'failed', reason: 'Compiler failed' });
  assert.deepEqual(alerts.alertFacts(event('hitl.created', { request: { taskId: 'task-1', question: 'Approve the release?' } }), () => 'Release'), { taskId: 'task-1', title: 'Release', status: 'attention', question: 'Approve the release?' });
});

function playbackFixture(now = new Date(2026, 8, 7, 12).getTime(), active: (signal?: AbortSignal) => Promise<boolean> = async () => true) {
  let currentNow = now;
  const alerts = new VoiceAlerts({ mountedAt: 0, now: () => currentNow, active, announce: () => null });
  alerts.update([], 'conversational');
  return { alerts, controller: new AbortController(), setNow: (value: number) => { currentNow = value; } };
}
test('alert playback rechecks mode and quiet hours without rejecting its own recorded event', async () => {
  const f = playbackFixture();
  try {
    assert.equal(typeof f.alerts.canPlay, 'function');
    localStorage.setItem(ALERT_STORE_KEY, JSON.stringify({ ids: ['event-1'], lastAt: new Date(2026, 8, 7, 12).getTime() }));
    assert.equal(await f.alerts.canPlay(event('task.qa-passed'), f.controller.signal, () => true), true);
    f.alerts.update([], 'attention');
    assert.equal(await f.alerts.canPlay(event('task.qa-passed'), f.controller.signal, () => true), false);
    assert.equal(await f.alerts.canPlay(event('task.failed'), f.controller.signal, () => true), true);
    f.alerts.update([], 'off');
    assert.equal(await f.alerts.canPlay(event('task.failed'), f.controller.signal, () => true), false);
    f.alerts.update([], 'conversational'); f.setNow(new Date(2026, 8, 7, 22).getTime());
    assert.equal(await f.alerts.canPlay(event('task.failed', { at: new Date(2026, 8, 7, 21, 59).toISOString() }), f.controller.signal, () => true), false);
  } finally { f.alerts.dispose(); localStorage.clear(); }
});
for (const change of ['mode', 'quiet-hours', 'ownership', 'device']) test(`alert playback rechecks ${change} after the active-device await`, async () => {
  let finish!: (active: boolean) => void;
  const at = new Date(2026, 8, 7, 21, 59, 59).getTime();
  const f = playbackFixture(at, () => new Promise(resolve => finish = resolve)); let owns = true;
  try {
    assert.equal(typeof f.alerts.canPlay, 'function');
    const pending = f.alerts.canPlay(event('task.qa-passed', { at: new Date(at).toISOString() }), f.controller.signal, () => owns);
    if (change === 'mode') f.alerts.update([], 'attention');
    if (change === 'quiet-hours') f.setNow(at + 2000);
    if (change === 'ownership') owns = false;
    finish(change !== 'device');
    assert.equal(await pending, false);
  } finally { f.alerts.dispose(); }
});
for (const stop of ['timeout', 'cancel']) test(`alert playback bounds an unresponsive active-device check on ${stop}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let requestSignal: AbortSignal | undefined;
  const f = playbackFixture(undefined, signal => { requestSignal = signal; return new Promise(() => {}); });
  try {
    assert.equal(typeof f.alerts.canPlay, 'function');
    const pending = f.alerts.canPlay(event('task.failed'), f.controller.signal, () => true);
    if (stop === 'cancel') f.controller.abort(); else t.mock.timers.tick(1500);
    assert.equal(await pending, false); assert.equal(requestSignal?.aborted, true);
  } finally { f.alerts.dispose(); }
});

test('internal QA runs and suspension terminal events never announce task completion', () => {
  for (const type of ['task.completed', 'task.failed', 'task.blocked']) {
    assert.equal(eligibleAlert(event(type, { taskId: 'qa--a35ec50b-a5c7-4c07-bf7b-328fc45df620' }), 'conversational'), false);
  }
  assert.equal(eligibleAlert(event('task.completed', { result: { summary: '⏸️ Waiting for input', outcome: 'success' } }), 'conversational'), false);
});

test('completion facts retain outcome and summary without claiming reviewed completion', () => {
  const facts = alertFacts(event('task.completed', { result: { outcome: 'success', summary: 'Repaired calendar sync; three checks passed.' } }), () => 'Repair calendar sync');
  assert.equal(facts.summary, 'Repaired calendar sync; three checks passed.');
  assert.equal(facts.outcome, 'success');
  assert.equal(facts.status, 'execution_finished');
  assert.equal(facts.verification, 'not established by this event');
});

test('unknown and identifier-shaped titles are never presented as human task names', () => {
  assert.equal(alertFacts(event('task.failed')).title, undefined);
  assert.equal(alertFacts(event('task.failed'), () => 'a35ec50b-a5c7-4c07-bf7b-328fc45df620').title, undefined);
});

test('QA pass speech carries the reviewer enhancements without claiming implementation', () => {
  const facts = alertFacts(event('task.qa-passed', { title: 'Repair sync', reviewer: 'codex', improvements: [{ source: 'reviewer', text: 'Add retry jitter.' }] }));
  assert.equal(facts.status, 'qa_passed');
  assert.equal(facts.title, 'Repair sync');
  assert.deepEqual(facts.enhancements, [{ source: 'reviewer', text: 'Add retry jitter.' }]);
  assert.match(String(facts.enhancementStatus), /suggestions.*not.*implemented/i);
});

test('long enhancements fit the speech endpoint while indicating abridgement', () => {
  const facts = alertFacts(event('task.qa-passed', { improvements: Array.from({length: 10}, () => ({source:'reviewer', text:'A long finding. '.repeat(3000)})) }));
  assert.ok(JSON.stringify(facts).length <= 12000);
  assert.equal(facts.enhancementsAbridged, true);
});
test('speech distinguishes no suggestions from an unavailable answer', () => {
  assert.equal(alertFacts(event('task.qa-passed', { improvements: [], reviewerNoneOffered: true })).reviewerNoneOffered, true);
  assert.equal(alertFacts(event('task.qa-passed', { improvements: [] })).reviewerNoneOffered, false);
});
