import type { StreamEvent } from '@praxis/contract';
import { isThisClientActive } from './active-client';
import { speechOwner } from './speech-ownership';
import { pairVoiceAlerts, type BlockedEvent, type VoiceAlert } from './voice-alert-pairing';
import { describeHitlAction, isAlertRequest, isAlertRequestExpired, safeAlertHref } from './alert-action';
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
  if (e.type === 'hitl.created') return !e.request.resolution && !isAlertRequestExpired(e.request) && !ROUTINE.has(String(e.request?.metadata?.kind));
  return e.type === 'task.failed' || (mode === 'conversational' && (e.type === 'task.qa-passed' || e.type === 'task.blocked'));
}
export function alertFacts(e: StreamEvent, titleFor: (id: string) => string | undefined = () => undefined, blocked?: BlockedEvent): Record<string, unknown> {
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
    case 'task.failed': return { ...task, status: 'failed', reason: e.error, action: 'Review the current task status and failure details before deciding what to do. This failure event alone does not establish that human action is still needed.', actionHref: `/task/${encodeURIComponent(e.taskId)}`, actionLabel: 'Review current task' };
    case 'task.completed': return { ...task, status: 'execution_finished', outcome: e.result?.outcome, summary: e.result?.summary, verification: 'not established by this event' };
    case 'task.blocked': return { ...task, status: 'blocked', reason: e.reason, action: 'Review the current task and its open input request before acting.', actionHref: e.blockedOnHitlId ? `/inbox#${encodeURIComponent(e.blockedOnHitlId)}` : `/task/${encodeURIComponent(e.taskId)}`, actionLabel: e.blockedOnHitlId ? 'Review request in Inbox' : 'Review current task' };
    case 'hitl.created': {
      const action = isAlertRequest(e.request) ? describeHitlAction(e.request) : undefined;
      return { ...task, status: blocked ? 'blocked' : 'attention', ...(blocked ? { reason: blocked.reason } : {}), question: e.request?.question,
        ...(action ? { action: action.instruction, actionHref: action.href, actionLabel: action.linkLabel, owner: action.owner,
          actionStatus: action.state, deliveryInstruction: 'State the exact question or decision and where to answer it. Do not imply acknowledgment repairs an issue or a saved answer was delivered.' } : {}) };
    }
    default: return task;
  }
}

/** Verify the current request immediately before composing/archiving speech. */
export async function currentVoiceAlert(event: StreamEvent, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch, signal?: AbortSignal): Promise<StreamEvent | null> {
  if (event.type !== 'hitl.created' && event.type !== 'task.blocked' && event.type !== 'task.failed') return event;
  const hitlId = event.type === 'hitl.created' ? event.request.id : event.type === 'task.blocked' ? event.blockedOnHitlId : undefined;
  const taskId = 'taskId' in event ? event.taskId : undefined;
  const url = hitlId ? `/api/praxis/hitl/${encodeURIComponent(hitlId)}` : taskId ? `/api/tasks/${encodeURIComponent(taskId)}` : undefined;
  if (!url) return null;
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetcher(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return null;
    const value = await response.json();
    if (hitlId) {
      if (!isAlertRequest(value) || value.id !== hitlId || value.resolution || isAlertRequestExpired(value)) return null;
      return event.type === 'hitl.created' ? { ...event, request: { ...event.request, question: value.question, options: value.options, metadata: value.metadata, resolution: null } } : event;
    }
    const heldStates = event.type === 'task.blocked' ? ['blocked', 'suspended', 'needs_input'] : ['failed', 'blocked', 'suspended', 'needs_input', 'todo'];
    return typeof value?.status === 'string' && heldStates.includes(value.status) ? event : null;
  } catch { return null; }
}

export function voiceAlertSpeech(text: string, facts: Record<string, unknown>): string {
  const parts = [text];
  if (typeof facts.question === 'string' && !text.includes(facts.question)) {
    parts.push(facts.question.length <= 1600 ? facts.question : 'The full question and diagnostic details are in Inbox.');
  }
  if (typeof facts.action === 'string' && !text.includes(facts.action)) parts.push(facts.action);
  return parts.join('\n\n');
}
/** Keep the full exact ask and deterministic link alongside generated prose. */
export function voiceAlertArchive(text: string, facts: Record<string, unknown>): string {
  const parts = [voiceAlertSpeech(text, facts)];
  if (typeof facts.question === 'string' && facts.question.length > 1600) parts.push(facts.question);
  if (typeof facts.actionHref === 'string' && safeAlertHref(facts.actionHref)) {
    const label = typeof facts.actionLabel === 'string' ? facts.actionLabel : 'Review request';
    parts.push(`[${label.replace(/[\[\]\\]/g, '')}](${facts.actionHref})`);
  }
  return parts.join('\n\n');
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
  private reservation?: { ids: string[]; at: number; previousAt: number };
  private unsubscribe: () => void;
  constructor(private options: {
    mountedAt: number; announce: (event: StreamEvent, blocked?: BlockedEvent) => Promise<void> | null;
    now?: () => number; active?: (signal?: AbortSignal) => Promise<boolean>;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
    clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
  }) { this.unsubscribe = speechOwner.subscribe(() => this.wake()); }
  update(events: StreamEvent[], mode: AlertMode) {
    // The SSE hook only keeps 50 events; unrelated telemetry must not erase a
    // blocked alert while it waits for its question or the speech cooldown.
    const now = (this.options.now ?? Date.now)();
    this.events = [...new Map([...this.events, ...events].map(e => [e.eventId, e])).values()]
      .filter(e => e.eventId && eligibleAlert(e, 'conversational') && now - Date.parse(e.at) <= MAX_AGE_MS)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, STORE_MAX);
    this.mode = mode; this.clear();
    this.updatedDuringCheck = this.running;
    this.wake();
  }
  dispose() { this.disposed = true; this.clear(); this.unsubscribe(); }
  /** Recheck playback after prose generation; this event already owns its ID and rate reservation. */
  async canPlay(event: StreamEvent, signal: AbortSignal, owns: () => boolean, preparedBlock?: BlockedEvent): Promise<boolean> {
    const eligible = () => {
      const now = (this.options.now ?? Date.now)();
      if (this.disposed || signal.aborted || !owns() || !eligibleAlert(event, this.mode)
        || now - Date.parse(event.at) > MAX_AGE_MS || alertDelay(now, 0) !== 0) return false;
      const current = pairVoiceAlerts(this.events).find(a => a.ids.includes(event.eventId));
      if (current?.blocked && (event.type === 'task.blocked' || current.blocked.eventId !== preparedBlock?.eventId)) {
        // Prose was prepared before the incident was complete. Cancel either
        // fallback and release only our reservation so the full pair can speak.
        this.releaseReservation(event.eventId);
        return false;
      }
      return true;
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
  private releaseReservation(eventId: string) {
    const reservation = this.reservation;
    if (!reservation?.ids.includes(eventId)) return;
    const release = (registry: Registry): Registry => ({
      ids: registry.ids.filter(id => !reservation.ids.includes(id)),
      lastAt: registry.lastAt === reservation.at ? reservation.previousAt : registry.lastAt,
    });
    this.local = release(this.local);
    try { localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(release(readRegistry()))); } catch { /* session fallback */ }
    this.reservation = undefined;
    this.updatedDuringCheck = true;
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
  private nextAlert(ids: Set<string>, now: number): VoiceAlert | undefined {
    let wait = Infinity;
    for (const alert of pairVoiceAlerts(this.events)) {
      const e = alert.event;
      // A spoken question covers its block. A spoken fallback block does NOT
      // cover a later question: that question contains new actionable detail.
      if (ids.has(e.eventId) || !eligibleAlert(e, this.mode) || Date.parse(e.at) <= this.options.mountedAt || now - Date.parse(e.at) > MAX_AGE_MS) continue;
      if (alert.readyAt <= now) return alert;
      wait = Math.min(wait, alert.readyAt - now);
    }
    if (Number.isFinite(wait)) this.schedule(wait);
    return undefined;
  }
  private async check() {
    const attempt = async () => {
      const now = (this.options.now ?? Date.now)();
      const stored = readRegistry(); const ids = new Set([...stored.ids, ...this.local.ids]);
      if (this.disposed || !this.nextAlert(ids, now)) return;
      const delay = alertDelay(now, Math.max(stored.lastAt, this.local.lastAt));
      if (delay) { this.schedule(delay); return; }
      if (speechOwner.busy()) { this.schedule(5000); return; }
      const active = await (this.options.active ?? isThisClientActive)();
      if (this.disposed || this.mode === 'off') return;
      if (!active || speechOwner.busy()) { this.schedule(5000); return; }
      // The device lookup may straddle quiet hours or another tab's start.
      const checkedAt = (this.options.now ?? Date.now)();
      const latest = readRegistry();
      latest.ids.forEach(id => ids.add(id));
      // A question can arrive while the active-device request is in flight.
      // Select again so the prose writer receives the complete incident.
      const alert = this.nextAlert(ids, checkedAt);
      if (!alert) return;
      const remaining = alertDelay(checkedAt, Math.max(latest.lastAt, this.local.lastAt));
      if (remaining) { this.schedule(remaining); return; }
      const playback = this.options.announce(alert.event, alert.blocked);
      if (!playback) { this.schedule(1000); return; }
      const reservedAt = (this.options.now ?? Date.now)();
      this.reservation = { ids: alert.ids, at: reservedAt, previousAt: Math.max(latest.lastAt, this.local.lastAt) };
      alert.ids.forEach(id => ids.add(id)); this.local = { ids: [...ids].slice(-STORE_MAX), lastAt: reservedAt };
      try { localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(this.local)); } catch { /* bounded session fallback */ }
      await playback;
      this.reservation = undefined;
      if (!this.disposed) this.schedule(Math.max(1, alertDelay((this.options.now ?? Date.now)(), this.local.lastAt)));
    };
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request('nexus.voice.alert-announcement', { ifAvailable: true }, async lock => {
        if (lock) await attempt(); else this.schedule(5000);
      });
    } else await attempt();
  }
}
