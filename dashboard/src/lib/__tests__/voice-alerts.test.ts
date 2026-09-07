import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@praxis/contract';
import { VoiceAlerts, alertLine, readAlertMode, ALERT_MODE_KEY, ALERT_STORE_KEY, alertDelay, eligibleAlert } from '../voice-alerts';
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
  assert.equal(eligibleAlert(event('task.completed'), 'conversational'), true);
  assert.equal(eligibleAlert(event('task.blocked'), 'conversational'), true);
  assert.equal(eligibleAlert(event('hitl.created', { request: { question: 'Approve?', metadata: { kind: 'day-schedule' } } }), 'conversational'), false);
  assert.match(alertLine(failed, () => 'Build the ship'), /Build the ship/);
  assert.ok(alertLine(failed).endsWith('Detailed failure. '.repeat(50)));
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
