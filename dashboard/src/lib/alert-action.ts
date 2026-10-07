/** Read-only presentation of human obligations; activity flags are historical evidence. */
export interface AlertRequest {
  id: string;
  taskId?: string;
  question: string;
  priority?: string;
  requestedAt?: string;
  ttlSeconds?: number;
  options?: string[];
  metadata?: Record<string, unknown>;
  resolution?: { choice?: string; freeText?: string; resolvedAt?: string } | null;
}
export interface AlertEvent {
  id: number;
  event_type: string;
  title: string;
  message?: string | null;
  task_id?: string | null;
  metadata: Record<string, unknown> | string;
  requires_action: number;
  action_taken?: number;
}
export interface AlertEvidence {
  hitls: Record<string, AlertRequest | null | undefined>;
  tasks: Record<string, { status?: string } | null | undefined>;
  pending?: AlertRequest[];
  pendingKnown?: boolean;
}
export interface AlertActionView {
  state: 'pending' | 'resolved' | 'historical' | 'unknown';
  label: string;
  owner: string;
  instruction: string;
  reason?: string;
  question?: string;
  answer?: string;
  href: string;
  linkLabel: string;
  relatedLinks?: { href: string; label: string }[];
}
export const EMPTY_ALERT_EVIDENCE: AlertEvidence = { hitls: {}, tasks: {} };
export function selectPendingAlert<T extends AlertRequest>(requests: T[], recentFailure: boolean): T | undefined {
  const live = requests.filter(request => !isAlertRequestExpired(request));
  return live.find(request => request.priority === 'critical') ?? (recentFailure ? undefined : live[0]);
}
/** Matches Praxis hitl/ttl.ts, including its strict boundary and invalid-date fallback. */
export function isAlertRequestExpired(request: Pick<AlertRequest, 'requestedAt' | 'ttlSeconds'>, now = Date.now()): boolean {
  if (!request.ttlSeconds) return false;
  const at = Date.parse(request.requestedAt ?? '');
  return !Number.isNaN(at) && now - at > request.ttlSeconds * 1000;
}

export function safeAlertHref(value: string): string | undefined {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? value : undefined; }
  catch { return undefined; }
}

export function alertMetadata(event: AlertEvent): Record<string, unknown> {
  if (typeof event.metadata !== 'string') return event.metadata ?? {};
  try { const value = JSON.parse(event.metadata); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export function alertHitlId(event: AlertEvent): string | undefined {
  const value = alertMetadata(event).hitlId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
export function savedAlertAnswer(request: AlertRequest): string | undefined {
  return [request.resolution?.choice, request.resolution?.freeText].filter(Boolean).join('\n\n') || undefined;
}
export function describeHitlAction(request: AlertRequest, inline = false): AlertActionView {
  const kind = request.metadata?.kind;
  const href = `/inbox#${encodeURIComponent(request.id)}`;
  if (request.resolution) return {
    state: 'resolved', label: 'Request closed', owner: 'No further answer requested',
    instruction: 'This request is closed. Its recorded response is shown below. Check the task or system status for the outcome.',
    question: request.question, answer: savedAlertAnswer(request) ?? '(Closed without an answer.)', href, linkLabel: 'View recorded response',
  };
  if (isAlertRequestExpired(request)) return {
    state: 'historical', label: 'Request expired', owner: 'Praxis must renew the request',
    instruction: 'This request has passed its decision deadline. Ask Praxis for a current request before approving or answering it.',
    question: request.question, href, linkLabel: 'View expired request',
  };
  let instruction = request.options?.length
    ? 'Choose one of the listed options, or type your answer and select Send Answer.'
    : 'Type your answer to the question and select Send Answer.';
  if (kind === 'red-alert') instruction = 'Select “acknowledged” to confirm you have seen this alert. This does not repair the underlying issue. Add any notes before acknowledging.';
  if (kind === 'task-answer-held') instruction = 'Your answer is already saved. Choose “retry delivery now” or “keep it saved for the next run”; you do not need to answer the original question again.';
  const predictiveRestart = request.id.startsWith('hitl-predictive-action-') && request.question.includes('infra_restart_service');
  if (predictiveRestart) instruction = 'Review current system status before approving this older request and confirm a restart is still needed. Approval may restart the service. This card does not provide a safe dismiss-only action; “Reject and re-plan” resumes agent planning.';
  const relatedLinks: { href: string; label: string }[] = [];
  if (predictiveRestart || kind === 'red-alert') relatedLinks.push({ href: '/system-monitor', label: 'Review current system status' });
  if (request.taskId && /return_to_authorized|contract.decision/.test(request.question)) relatedLinks.push({ href: `/task/${encodeURIComponent(request.taskId)}#contract-hold`, label: 'Review task contract decision' });
  return {
    state: 'pending', label: predictiveRestart ? 'Restart proposal needs revalidation' : kind === 'red-alert' ? 'Acknowledgment requested' : kind === 'task-answer-held' ? 'Delivery decision needed' : 'Your input is needed',
    owner: predictiveRestart ? 'Praxis / recovery; Robert decides whether to approve' : 'Robert', instruction: `${inline ? '' : 'Open this request in Inbox. '}${instruction}`,
    question: request.question,
    reason: typeof request.metadata?.holdReason === 'string' ? request.metadata.holdReason : undefined,
    answer: kind === 'task-answer-held' && typeof request.metadata?.answer === 'string' ? request.metadata.answer : undefined,
    href, linkLabel: kind === 'red-alert' ? 'Acknowledge in Inbox' : kind === 'task-answer-held' ? 'Choose answer delivery' : 'Answer in Inbox',
    ...(relatedLinks.length ? { relatedLinks } : {}),
  };
}

function reviewDestination(event: AlertEvent): { href: string; linkLabel: string } {
  if (event.task_id) return { href: `/task/${encodeURIComponent(event.task_id)}`, linkLabel: 'Review current task' };
  if (event.event_type.startsWith('ingestion_')) return { href: '/knowledge-ingestion', linkLabel: 'Review ingestion run history' };
  if (event.event_type.startsWith('feedback.')) return { href: '/mail', linkLabel: 'Review mailbox' };
  if (/^(executor_|cli_gate_|local_llm_|service_|code_freshness_)/.test(event.event_type)) return { href: '/system-monitor', linkLabel: 'Review system status' };
  return { href: '/inbox', linkLabel: 'Check current requests in Inbox' };
}
const TASK_LIFECYCLE = /^(task_(blocked|failed|stale_exit|completed_unreviewed|correction_exhausted|correction_dispatch_failed)|session_resume_(model|settings)_conflict|usage_limit_resume_failed|executor_auth_failure)$/;

export function describeAlertAction(event: AlertEvent, evidence: AlertEvidence = EMPTY_ALERT_EVIDENCE): AlertActionView {
  const hitlId = alertHitlId(event);
  const hitl = hitlId ? evidence.hitls[hitlId] : undefined;
  if (hitl) return describeHitlAction(hitl);
  const destination = hitlId ? { href: `/inbox#${encodeURIComponent(hitlId)}`, linkLabel: 'Check this request in Inbox' } : reviewDestination(event);
  if (event.action_taken) return { state: 'resolved', label: 'Action recorded', owner: 'No new request recorded', instruction: 'An action was recorded for this historical alert. Review its destination for the current state.', ...destination };
  const status = event.task_id ? evidence.tasks[event.task_id]?.status : undefined;
  // A task's terminal state only supersedes its own lifecycle signal. It says
  // nothing about fleet health, third-party replies, or other independent work.
  if (!hitlId && TASK_LIFECYCLE.test(event.event_type) && status && ['completed', 'cancelled', 'archived'].includes(status)) {
    return { state: 'historical', label: 'Historical task alert', owner: 'No current request established', instruction: `This task is now ${status}. The text below records an earlier interruption; it is not a new request to repeat that action.`, ...destination };
  }
  return {
    state: 'unknown', label: 'Current action status unverified', owner: 'Not established',
    instruction: 'This event recorded a request for attention. Check the current destination before acting; the event alone does not establish that the request is still open.',
    ...destination,
  };
}

type AlertFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const ALERT_DETAIL_READ_LIMIT = 20;
/** At most one pending snapshot + 20 unique detail reads, four in flight. */
export async function loadAlertEvidence(events: readonly AlertEvent[], fetcher: AlertFetcher = fetch, signal?: AbortSignal): Promise<AlertEvidence> {
  const evidence: AlertEvidence = { hitls: {}, tasks: {} };
  const read = async (url: string): Promise<unknown> => {
    try {
      const timeout = AbortSignal.timeout(5000);
      const res = await fetcher(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) return undefined;
      return await res.json();
    } catch { return undefined; }
  };
  const snapshot = await read('/api/praxis/hitl/pending') as { requests?: unknown } | undefined;
  if (Array.isArray(snapshot?.requests)) {
    evidence.pendingKnown = true;
    evidence.pending = snapshot.requests.filter(isAlertRequest);
    for (const request of evidence.pending) evidence.hitls[request.id] = request;
  }
  const reads = new Map<string, () => Promise<void>>();
  for (const event of events) {
    if (!event.requires_action) continue;
    const id = alertHitlId(event);
    if (id && !evidence.hitls[id]) {
      const url = `/api/praxis/hitl/${encodeURIComponent(id)}`;
      reads.set(url, async () => { const value = await read(url); evidence.hitls[id] = isAlertRequest(value) && value.id === id ? value : undefined; });
    } else if (!id && event.task_id && TASK_LIFECYCLE.test(event.event_type)) {
      const taskId = event.task_id;
      const url = `/api/tasks/${encodeURIComponent(taskId)}`;
      reads.set(url, async () => { const value = await read(url) as { status?: unknown } | undefined; evidence.tasks[taskId] = value && typeof value.status === 'string' ? { status: value.status } : undefined; });
    }
  }
  const queue = [...reads.values()].slice(0, ALERT_DETAIL_READ_LIMIT);
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && !signal?.aborted) await queue.shift()!();
  }));
  return evidence;
}
export function isAlertRequest(value: unknown): value is AlertRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<AlertRequest>;
  return typeof request.id === 'string' && typeof request.question === 'string';
}
