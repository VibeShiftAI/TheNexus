import type { StreamEvent } from '@praxis/contract';
import { isThisClientActive } from './active-client';
import { speechOwner } from './speech-ownership';
export type AlertMode = 'off' | 'attention' | 'conversational';
export const ALERT_MODE_KEY = 'nexus.voice.alertMode';
export const ALERT_STORE_KEY = 'nexus.voice.announcedEvents';
const RATE_MS = 120_000;
const MAX_AGE_MS = 10 * 60_000;
const STORE_MAX = 300;
const ROUTINE = new Set(['day-schedule', 'skill-candidates', 'board-maintenance']);
export function readAlertMode(): AlertMode {
  try {
    const saved = localStorage.getItem(ALERT_MODE_KEY);
    if (saved === 'off' || saved === 'attention' || saved === 'conversational') return saved;
    if (['0', 'false'].includes(localStorage.getItem('nexus.voice.alerts') ?? '')) return 'off';
  } catch { /* session defaults when storage is unavailable */ }
  return 'conversational';
}
export function eligibleAlert(e: StreamEvent, mode: AlertMode): boolean {
  if (mode === 'off') return false;
  // Review worker lifecycle is presence telemetry, not the parent task verdict.
  if ('taskId' in e && e.taskId?.startsWith('qa--')) return false;
  if (e.type === 'task.completed' && e.result?.summary?.trimStart().startsWith('⏸️')) return false;
  if (e.type === 'hitl.created') return !ROUTINE.has(String(e.request?.metadata?.kind));
  return e.type === 'task.failed' || (mode === 'conversational' && (e.type === 'task.qa-passed' || e.type === 'task.blocked'));
}
export function alertFacts(e: StreamEvent, titleFor: (id: string) => string | undefined = () => undefined): Record<string, unknown> {
  const taskId = e.type === 'hitl.created' ? e.request?.taskId : 'taskId' in e ? e.taskId : undefined;
  const candidate = taskId ? titleFor(taskId)?.trim() : undefined;
  const title = candidate && candidate !== taskId && !/qa--|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(candidate) ? candidate : undefined;
  const task = taskId ? { taskId, ...(title ? { title } : {}) } : {};
  switch (e.type) {
    case 'task.qa-passed': {
      // The speech API rejects >12k characters. Full findings stay in chat;
      // keep a bounded excerpt so a long critic report cannot silence the pass.
      const original = e.improvements ?? [];
      const enhancements = original.slice(0, 3).map(s => ({ source: s.source.slice(0, 80), text: s.text.slice(0, 1800) }));
      return { ...task, ...(e.title ? { title: e.title.slice(0, 500) } : {}), status: 'qa_passed', reviewer: e.reviewer,
        enhancements, enhancementsAbridged: original.length > 3 || original.some(s => s.text.length > 1800),
        reviewerNoneOffered: e.reviewerNoneOffered === true,
        enhancementStatus: 'Optional QA suggestions; not established as implemented. Mention what QA found. If abridged, full details are in chat. Say QA offered none only when reviewerNoneOffered is true; otherwise an empty list means no enhancement answer was recorded.' };
    }
    case 'task.failed': return { ...task, status: 'failed', reason: e.error };
    case 'task.completed': return { ...task, status: 'execution_finished', outcome: e.result?.outcome, summary: e.result?.summary, verification: 'not established by this event' };
    case 'task.blocked': return { ...task, status: 'blocked', reason: e.reason };
    case 'hitl.created': return { ...task, status: 'attention', question: e.request?.question };
    default: return task;
  }
}
export function alertDelay(now: number, lastAt: number): number {
  const date = new Date(now); const hour = date.getHours();
  let quietDelay = 0;
  if (hour >= 22 || hour < 8) {
    const morning = new Date(now); if (hour >= 22) morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 0, 0, 0); quietDelay = morning.getTime() - now;
  }
  return Math.max(quietDelay, RATE_MS - (now - lastAt), 0);
}
type Registry = { ids: string[]; lastAt: number };
function readRegistry(): Registry {
  try {
    const value = JSON.parse(localStorage.getItem(ALERT_STORE_KEY) || '{}');
    return { ids: Array.isArray(value.ids) ? value.ids.filter((v: unknown) => typeof v === 'string').slice(-STORE_MAX) : [], lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0 };
  } catch { return { ids: [], lastAt: 0 }; }
}
/** A cancellable wakeup, including checks that await active-device and tab locks. */
export class VoiceAlerts {
  private events: StreamEvent[] = []; private mode: AlertMode = 'off'; private disposed = false;
  private running = false; private updatedDuringCheck = false; private timer: ReturnType<typeof setTimeout> | number | null = null;
  private local: Registry = { ids: [], lastAt: 0 };
  private unsubscribe: () => void;
  constructor(private options: {
    mountedAt: number; announce: (event: StreamEvent) => Promise<void> | null;
    now?: () => number; active?: (signal?: AbortSignal) => Promise<boolean>;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
    clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
  }) { this.unsubscribe = speechOwner.subscribe(() => this.wake()); }
  update(events: StreamEvent[], mode: AlertMode) {
    this.events = events; this.mode = mode; this.clear();
    this.updatedDuringCheck = this.running;
    this.wake();
  }
  dispose() { this.disposed = true; this.clear(); this.unsubscribe(); }
  /** Recheck playback after prose generation; this event already owns its ID and rate reservation. */
  async canPlay(event: StreamEvent, signal: AbortSignal, owns: () => boolean): Promise<boolean> {
    const eligible = () => {
      const now = (this.options.now ?? Date.now)();
      return !this.disposed && !signal.aborted && owns() && eligibleAlert(event, this.mode)
        && now - Date.parse(event.at) <= MAX_AGE_MS && alertDelay(now, 0) === 0;
    };
    if (!eligible()) return false;
    const controller = new AbortController();
    let cancel!: (value: boolean) => void;
    const canceled = new Promise<boolean>(resolve => { cancel = resolve; });
    const abort = () => { cancel(false); controller.abort(); };
    const timer = setTimeout(abort, 1500);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const active = await Promise.race([(this.options.active ?? isThisClientActive)(controller.signal), canceled]);
      return active && eligible();
    } catch { return false; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private clear() { if (this.timer !== null) (this.options.clearTimer ?? (id => clearTimeout(id)))(this.timer); this.timer = null; }
  private schedule(delay: number) {
    if (this.disposed || this.mode === 'off') return;
    this.clear(); this.timer = (this.options.setTimer ?? setTimeout)(() => { this.timer = null; this.wake(); }, delay);
  }
  private wake() {
    if (this.disposed || this.running || this.mode === 'off') return;
    this.running = true;
    void this.check().catch(() => this.schedule(5000)).finally(() => {
      this.running = false;
      if (this.updatedDuringCheck) { this.updatedDuringCheck = false; this.wake(); }
    });
  }
  private async check() {
    const attempt = async () => {
      const now = (this.options.now ?? Date.now)();
      const stored = readRegistry(); const ids = new Set([...stored.ids, ...this.local.ids]);
      const event = [...this.events].reverse().find(e => eligibleAlert(e, this.mode) && e.eventId && !ids.has(e.eventId) && Date.parse(e.at) > this.options.mountedAt && now - Date.parse(e.at) <= MAX_AGE_MS);
      if (!event || this.disposed) return;
      const delay = alertDelay(now, Math.max(stored.lastAt, this.local.lastAt));
      if (delay) { this.schedule(delay); return; }
      if (speechOwner.busy()) { this.schedule(5000); return; }
      const active = await (this.options.active ?? isThisClientActive)();
      if (this.disposed || !eligibleAlert(event, this.mode)) return;
      if (!active || speechOwner.busy()) { this.schedule(5000); return; }
      // The device lookup may straddle quiet hours or another tab's start.
      const checkedAt = (this.options.now ?? Date.now)();
      const latest = readRegistry();
      latest.ids.forEach(id => ids.add(id));
      if (ids.has(event.eventId) || checkedAt - Date.parse(event.at) > MAX_AGE_MS) return;
      const remaining = alertDelay(checkedAt, Math.max(latest.lastAt, this.local.lastAt));
      if (remaining) { this.schedule(remaining); return; }
      const playback = this.options.announce(event);
      if (!playback) { this.schedule(1000); return; }
      ids.add(event.eventId); this.local = { ids: [...ids].slice(-STORE_MAX), lastAt: (this.options.now ?? Date.now)() };
      try { localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(this.local)); } catch { /* bounded session fallback */ }
      await playback;
      if (!this.disposed) this.schedule(Math.max(1, alertDelay((this.options.now ?? Date.now)(), this.local.lastAt)));
    };
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request('nexus.voice.alert-announcement', { ifAvailable: true }, async lock => {
        if (lock) await attempt(); else this.schedule(5000);
      });
    } else await attempt();
  }
}
