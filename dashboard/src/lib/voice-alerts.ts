import type { StreamEvent } from '@praxis/contract';
import { isThisClientActive } from './active-client';
import { speechOwner } from './speech-ownership';
import { pairVoiceAlerts, type BlockedEvent, type VoiceAlert } from './voice-alert-pairing';
import { describeHitlAction, isAlertRequest, isAlertRequestExpired, safeAlertHref } from './alert-action';
import { briefFromMetadata, briefQuestions, renderHumanBrief } from './human-brief';
export type AlertMode = 'off' | 'attention' | 'conversational';
export const ALERT_MODE_KEY = 'nexus.voice.alertMode';
export const ALERT_STORE_KEY = 'nexus.voice.announcedEvents';
const OUTCOME_SINCE_KEY = 'nexus.voice.outcomesSince';
const ALERTS_ENABLED_SINCE_KEY = 'nexus.voice.alertsEnabledSince';
export type OutcomeAlert = { type: 'chat.outcome'; eventId: string; speech: string; deliveredAt: number };
type AlertEvent = StreamEvent | OutcomeAlert;
const RATE_MS = 120_000;
const STORE_MAX = 300;
const ROUTINE = new Set(['day-schedule', 'skill-candidates', 'board-maintenance']);
/** The runtime callback owns retry/escalation; only its final request interrupts. */
function callbackOwnsFailure(event: StreamEvent): boolean {
  return event.type === 'task.failed'
    && (event as StreamEvent & { failureRecoveryOwner?: unknown }).failureRecoveryOwner === 'callback';
}
export function readAlertMode(): AlertMode {
  try {
    const saved = localStorage.getItem(ALERT_MODE_KEY);
    if (saved === 'off' || saved === 'attention' || saved === 'conversational') return saved;
    if (['0', 'false'].includes(localStorage.getItem('nexus.voice.alerts') ?? '')) return 'off';
  } catch { /* session defaults when storage is unavailable */ }
  return 'conversational';
}
export function eligibleAlert(e: AlertEvent, mode: AlertMode): boolean {
  if (mode === 'off') return false;
  if (e.type === 'chat.outcome') return mode === 'conversational';
  if (callbackOwnsFailure(e)) return false;
  if (e.type === 'task.qa-passed' && 'outcomeFollowUpId' in e && e.outcomeFollowUpId) return false;
  // Review worker lifecycle is presence telemetry, not the parent task verdict.
  if ('taskId' in e && e.taskId?.startsWith('qa--')) return false;
  if (e.type === 'task.completed' && e.result?.summary?.trimStart().startsWith('⏸️')) return false;
  if (e.type === 'hitl.created') return !e.request.resolution && !isAlertRequestExpired(e.request) && !ROUTINE.has(String(e.request?.metadata?.kind));
  return e.type === 'task.failed' || (mode === 'conversational' && (e.type === 'task.qa-passed' || e.type === 'task.blocked'));
}
export function alertFacts(e: StreamEvent, titleFor: (id: string) => string | undefined = () => undefined, blocked?: BlockedEvent): Record<string, unknown> {
  const taskId = e.type === 'hitl.created' ? e.request?.taskId : 'taskId' in e ? e.taskId : undefined;
  const candidate = (taskId ? titleFor(taskId)?.trim() : undefined)
    || (e.type === 'hitl.created' && typeof e.request.metadata?.taskTitle === 'string' ? e.request.metadata.taskTitle.trim() : undefined);
  const title = candidate && candidate !== taskId && !/qa--|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(candidate) ? candidate : undefined;
  const task = { ...(taskId ? { taskId } : {}), ...(title ? { title } : {}) };
  switch (e.type) {
    case 'task.qa-passed': {
      // The speech API rejects >12k characters. Full findings stay in chat;
      // keep a bounded excerpt so a long critic report cannot silence the pass.
      const original = e.improvements ?? [];
      const enhancements = original.slice(0, 3).map(s => ({ source: s.source.slice(0, 80), text: s.text.slice(0, 1800) }));
      return { ...task, ...(e.title ? { title: e.title.slice(0, 500) } : {}), status: 'qa_passed', reviewer: e.reviewer,
        enhancements, enhancementsAbridged: original.length > 3 || original.some(s => s.text.length > 1800),
        reviewerNoneOffered: e.reviewerNoneOffered === true,
        enhancementStatus: 'Optional QA suggestions; not established as implemented. Mention what QA found. When enhancementsAbridged is true, the list is an excerpt: speak about what it contains and do not say where the rest is. Say QA offered none only when reviewerNoneOffered is true; otherwise an empty list means no enhancement answer was recorded.' };
    }
    case 'task.failed': return { ...task, status: 'failed', reason: e.error, action: 'Review the current task status and failure details before deciding what to do. This failure event alone does not establish that human action is still needed.', actionHref: `/task/${encodeURIComponent(e.taskId)}`, actionLabel: 'Review current task' };
    case 'task.completed': return { ...task, status: 'execution_finished', outcome: e.result?.outcome, summary: e.result?.summary, verification: 'not established by this event' };
    case 'task.blocked': return { ...task, status: 'blocked', reason: e.reason, action: 'Review the current task and its open input request before acting.', actionHref: e.blockedOnHitlId ? `/inbox#${encodeURIComponent(e.blockedOnHitlId)}` : `/task/${encodeURIComponent(e.taskId)}`, actionLabel: e.blockedOnHitlId ? 'Review request in Inbox' : 'Review current task' };
    case 'hitl.created': {
      const action = isAlertRequest(e.request) ? describeHitlAction(e.request) : undefined;
      const brief = briefFromMetadata(e.request.metadata);
      const questions = briefQuestions(e.request.metadata);
      return { ...task, status: blocked ? 'blocked' : 'attention', ...(blocked ? { reason: blocked.reason } : {}),
        ...(brief ? { brief } : {}), ...(questions.length ? { questions } : {}),
        ...(!brief || !questions.length ? { question: e.request.question } : {}),
        ...(e.request.options?.length ? { options: e.request.options } : {}),
        ...(action ? { action: action.instruction, actionHref: action.href, actionLabel: action.linkLabel,
          actionStatus: action.state } : {}) };
    }
    default: return task;
  }
}

/** Verify the current request immediately before composing/archiving speech. */
export async function currentVoiceAlert(event: StreamEvent, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch, signal?: AbortSignal): Promise<StreamEvent | null> {
  if (callbackOwnsFailure(event)) return null;
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

/** Only collapse an exact text twin; a different or additional question remains evidence. */
function voiceAlertQuestion(facts: Record<string, unknown>): string | undefined {
  if (typeof facts.question !== 'string') return undefined;
  const brief = briefFromMetadata({ brief: facts.brief });
  const normalized = (value: string) => value.replace(/\*\*(Project|What happened|The problem|What I need from you|My recommendation|If you do nothing):\*\*/g, '$1:').replace(/\s+/g, ' ').trim();
  return brief && normalized(facts.question) === normalized(renderHumanBrief(brief)) ? undefined : facts.question;
}
export function voiceAlertSpeech(text: string, facts: Record<string, unknown>): string {
  const brief = briefFromMetadata({ brief: facts.brief });
  const parts = [brief ? renderHumanBrief(brief) : text];
  const add = (value: string) => { if (value.trim() && !parts.some(part => part.includes(value))) parts.push(value); };
  if (Array.isArray(facts.questions)) facts.questions.forEach(question => { if (typeof question === 'string') add(question); });
  const question = voiceAlertQuestion(facts);
  if (question && !parts.some(part => part.includes(question))) {
    parts.push(question.length <= 1600 ? question : 'The full question and diagnostic details are in Inbox.');
  }
  if (Array.isArray(facts.options)) {
    const options = facts.options.filter((value): value is string => typeof value === 'string');
    if (options.length && !parts.some(part => part.includes(options.join(' / ')))) add(`Options: ${options.join(' / ')}.`);
  }
  if (typeof facts.action === 'string') add(facts.action);
  return parts.filter(Boolean).join('\n\n');
}
/** Keep the full exact ask and deterministic link alongside generated prose. */
export function voiceAlertArchive(text: string, facts: Record<string, unknown>): string {
  const parts = [voiceAlertSpeech(text, facts)];
  const question = voiceAlertQuestion(facts);
  if (question && question.length > 1600) parts.push(question);
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
function readSince(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0; }
  catch { return 0; }
}
/** A cancellable wakeup, including checks that await active-device and tab locks. */
export class VoiceAlerts {
  private outcomes: OutcomeAlert[] = [];
  private enabledSince = 0;
  private conversationalSince = 0;
  private events: StreamEvent[] = []; private mode: AlertMode = readAlertMode(); private disposed = false;
  private running = false; private updatedDuringCheck = false; private timer: ReturnType<typeof setTimeout> | number | null = null;
  private heard = new Set<string>();
  private lastAt = 0;
  private reservation?: { ids: string[]; at: number; previousAt: number };
  private unsubscribe: () => void;
  constructor(private options: {
    mountedAt: number; announce: (event: AlertEvent, blocked?: BlockedEvent) => Promise<boolean | void> | null;
    now?: () => number; active?: (signal?: AbortSignal) => Promise<boolean>;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
    clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
  }) { this.unsubscribe = speechOwner.subscribe(() => this.wake()); }
  update(events: StreamEvent[], mode: AlertMode) {
    // The SSE hook only keeps 50 events; unrelated telemetry must not erase a
    // blocked alert while it waits for its question or the speech cooldown.
    this.events = [...new Map([...this.events, ...events].map(e => [e.eventId, e])).values()]
      .filter(e => e.eventId && eligibleAlert(e, 'conversational') && Date.parse(e.at) > this.options.mountedAt)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, STORE_MAX);
    this.setMode(mode);
    this.clear();
    this.updatedDuringCheck = this.running;
    this.wake();
  }
  setMode(mode: AlertMode) {
    if (mode === this.mode) return;
    // Settings changes apply across tabs. A tab observing the change uses the
    // instant the operator enabled speech, even if it woke up later.
    const alreadySaved = readAlertMode() === mode;
    const resume = (key: string) => {
      const since = (alreadySaved && readSince(key)) || (this.options.now ?? Date.now)();
      try { localStorage.setItem(key, String(since)); } catch { /* session fallback */ }
      return since;
    };
    if (this.mode === 'off') this.enabledSince = resume(ALERTS_ENABLED_SINCE_KEY);
    if (mode === 'conversational') this.conversationalSince = resume(OUTCOME_SINCE_KEY);
    this.mode = mode;
    try { localStorage.setItem(ALERT_MODE_KEY, mode); } catch { /* session fallback */ }
  }
  private canAnnounce(event: AlertEvent): boolean {
    const at = event.type === 'chat.outcome' ? event.deliveredAt : Date.parse(event.at);
    // The page mount is local to this listener. Opening a second tab must
    // neither inherit an earlier session nor move the first tab's boundary.
    if (!(at > this.options.mountedAt) || !eligibleAlert(event, this.mode)) return false;
    return eligibleAlert(event, 'attention')
      ? at >= Math.max(this.enabledSince, readSince(ALERTS_ENABLED_SINCE_KEY))
      : at >= Math.max(this.conversationalSince, readSince(OUTCOME_SINCE_KEY));
  }
  updateOutcomes(rows: { id: string; speech: string; deliveredAt: string }[]) {
    this.outcomes = rows.map(row => ({ type: 'chat.outcome', eventId: row.id, speech: row.speech,
      deliveredAt: Date.parse(row.deliveredAt) || 0 }));
    this.updatedDuringCheck = this.running;
    this.wake();
  }
  dispose() { this.disposed = true; this.clear(); this.unsubscribe(); }
  /** Recheck playback after prose generation; this event already owns its ID and rate reservation. */
  async canPlay(event: AlertEvent, signal: AbortSignal, owns: () => boolean, preparedBlock?: BlockedEvent): Promise<boolean> {
    const eligible = () => {
      const now = (this.options.now ?? Date.now)();
      if (this.disposed || signal.aborted || !owns() || !this.canAnnounce(event)
        || alertDelay(now, 0) !== 0) return false;
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
    reservation.ids.forEach(id => this.heard.delete(id));
    if (this.lastAt === reservation.at) this.lastAt = reservation.previousAt;
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
  private nextAlert(registry: Registry, now: number): (Omit<VoiceAlert, 'event'> & { event: AlertEvent }) | undefined {
    const shared = new Set(registry.ids);
    const heard = (id: string) => this.heard.has(id) || shared.has(id);
    let wait = Infinity;
    for (const alert of pairVoiceAlerts(this.events)) {
      const e = alert.event;
      // A spoken question covers its block. A spoken fallback block does NOT
      // cover a later question: that question contains new actionable detail.
      if (heard(e.eventId) || !this.canAnnounce(e)) continue;
      if (alert.readyAt <= now) return alert;
      wait = Math.min(wait, alert.readyAt - now);
    }
    if (Number.isFinite(wait)) this.schedule(wait);
    else if (this.mode === 'conversational') {
      const outcome = this.outcomes.find(e => !heard(e.eventId) && this.canAnnounce(e));
      if (outcome) return { event: outcome, ids: [outcome.eventId], readyAt: now };
    }
    return undefined;
  }
  private async check() {
    const attempt = async () => {
      const now = (this.options.now ?? Date.now)();
      const stored = readRegistry();
      if (this.disposed || !this.nextAlert(stored, now)) return;
      const delay = alertDelay(now, Math.max(stored.lastAt, this.lastAt));
      if (delay) { this.schedule(delay); return; }
      if (speechOwner.busy()) { this.schedule(5000); return; }
      const active = await (this.options.active ?? isThisClientActive)();
      if (this.disposed || this.mode === 'off') return;
      if (!active || speechOwner.busy()) { this.schedule(5000); return; }
      // The device lookup may straddle quiet hours or another tab's start.
      const checkedAt = (this.options.now ?? Date.now)();
      const latest = readRegistry();
      // A question can arrive while the active-device request is in flight.
      // Select again so the prose writer receives the complete incident.
      const alert = this.nextAlert(latest, checkedAt);
      if (!alert) return;
      const remaining = alertDelay(checkedAt, Math.max(latest.lastAt, this.lastAt));
      if (remaining) { this.schedule(remaining); return; }
      const playback = this.options.announce(alert.event, alert.blocked);
      if (!playback) { this.schedule(1000); return; }
      const reservedAt = (this.options.now ?? Date.now)();
      if (alert.event.type === 'chat.outcome') {
        // Nexus owns this ID across devices. Only started audio consumes
        // the local spacing slot.
        const started = await playback;
        this.outcomes = this.outcomes.filter(e => e.eventId !== alert.event.eventId);
        if (started === false) { this.updatedDuringCheck = true; return; }
      }
      this.reservation = { ids: alert.ids, at: reservedAt, previousAt: Math.max(latest.lastAt, this.lastAt) };
      alert.ids.forEach(id => this.heard.add(id));
      this.lastAt = reservedAt;
      const recent = [...new Set([...latest.ids, ...alert.ids])].slice(-STORE_MAX);
      try { localStorage.setItem(ALERT_STORE_KEY, JSON.stringify({ ids: recent, lastAt: reservedAt })); } catch { /* session fallback */ }
      if (alert.event.type !== 'chat.outcome') await playback;
      this.reservation = undefined;
      if (!this.disposed) this.schedule(Math.max(1, alertDelay((this.options.now ?? Date.now)(), this.lastAt)));
    };
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request('nexus.voice.alert-announcement', { ifAvailable: true }, async lock => {
        if (lock) await attempt(); else this.schedule(5000);
      });
    } else await attempt();
  }
}
