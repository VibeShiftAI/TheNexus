import type { WorkAdmissionReceipt } from './nexus/tasks';
import type { AlertRequest } from './alert-action';
import { isAlertRequestExpired } from './alert-action';
import type { EvidenceDossier } from './task-evidence';
import { EVIDENCE_PIECE_LABELS } from './task-evidence';
import type { LiveWorkResponse } from './nexus/dispatch-insight';

export interface ProgressAttempt {
  id: string; executor: string; outcome: string; kind: string; parentId: string | null;
  startedAt: string; completedAt: string | null;
  commentary: { available: boolean; reason: string | null; truncated: boolean; observedAt?: string; messages: Array<{ text: string; at: string | null; sequence: number }> };
}
export interface ProgressEvent { id: string; title: string; text: string; at: string; type?: string; href?: string; attemptId?: string }
export interface TaskImprovement {
  id: string;
  status: 'proposed' | 'retained' | 'completed_after_review' | 'linked' | 'waiting' | 'running' | 'reviewing' | 'verified' | 'declined' | 'needs_attention' | 'review_held' | 'unknown';
  updatedAt: string | null;
  author: string;
  dispatchId?: string;
  optionalTaskId?: string;
  suggestions: Array<{ source: string; text: string }>;
  reason: string;
  review?: { assessment: 'pass' | 'fail'; notes: string; evidence: string; reviewer: string };
  followupReview?: { status: 'proposed' | 'retained' | 'completed'; reviewedAt: string | null; reason: string; slateId?: string; priority?: number; decisions: Array<{ index: number; disposition: 'execute' | 'retain' | 'complete'; reason: string; evidence: string[] }> };
  commitSha?: string;
}
export interface TaskImprovements { available: boolean; items: TaskImprovement[] }
export interface TaskProgressRecord {
  taskId: string; fetchedAt: string; attempts: ProgressAttempt[]; attemptsTruncated: boolean;
  events: ProgressEvent[]; eventsAvailable: boolean; eventsTruncated: boolean;
  improvements?: TaskImprovements;
}
export interface ProgressSource<T> { data: T | null; at: number | null; error: string | null }
export interface ProgressInput {
  task: { id: string; status: string; metadata?: Record<string, unknown> | null }; now: number;
  progress: ProgressSource<TaskProgressRecord>; live: ProgressSource<LiveWorkResponse>;
  pending: ProgressSource<AlertRequest[]>; recent: ProgressSource<AlertRequest[]>;
  evidence: ProgressSource<EvidenceDossier>;
}
export const emptyProgressSource = <T>(): ProgressSource<T> => ({ data: null, at: null, error: null });
export function buildTaskProgress(input: ProgressInput) {
  const { task, now } = input; const gaps: string[] = [];
  const fresh = <T>(name: string, source: ProgressSource<T>) => {
    const ok = source.data !== null && source.at !== null && now - source.at < 60_000 && !source.error;
    if (!ok) gaps.push(`${name}: ${source.data === null ? 'unavailable' : 'stale — last successful snapshot retained'}.`);
    return ok;
  };
  const progressFresh = fresh('Progress history', input.progress);
  const liveFresh = fresh('Runtime state', input.live) && input.live.data?.praxis.reachable === true;
  if (input.live.data?.praxis.reachable === false) gaps.push('Runtime is unreachable; current activity cannot be confirmed.');
  const pendingFresh = fresh('Pending requests', input.pending);
  fresh('Decision history', input.recent);
  const evidenceFresh = fresh('Verification evidence', input.evidence);
  const attempts = [...(input.progress.data?.attempts ?? [])].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  // Optional improvements retain their own review; they do not reopen the parent's QA.
  // Require the explicit dispatch link so ordinary follow-ups and new attempts still count.
  const improvementDispatches = new Set((input.progress.data?.improvements?.items ?? []).map(item => item.dispatchId).filter(Boolean));
  const latest = attempts.filter(attempt => !(attempt.kind === 'follow_up' && improvementDispatches.has(attempt.id))).at(-1);
  const live = liveFresh ? input.live.data?.items.find(item => item.taskId === task.id && !item.improvement) : undefined;
  const questions = pendingFresh ? (input.pending.data ?? []).filter(q => q.taskId === task.id && !q.resolution && !isAlertRequestExpired(q, now)) : [];
  const receipt = task.metadata?.work_admission as WorkAdmissionReceipt | undefined;
  const admission = !['dispatched', 'in_progress', 'running', 'qa', 'ready_for_review', 'review', 'suspended', 'completed', 'complete', 'done', 'cancelled', 'canceled', 'archived'].includes(task.status)
    && !['running', 'qa'].includes(live?.lane ?? '')
    && receipt && !receipt.contract_hold && receipt.hold_kind !== 'contract_drift'
    && ['needs_evidence', 'partial_overlap', 'covered_by_open', 'already_delivered'].includes(receipt.decision) ? receipt : null;
  const background = live?.backgroundObligation;
  const statusReason = background?.detail ?? null;
  let state = 'Unknown'; let stateAt: string | null = null;
  if (questions.length) { state = 'Waiting for you'; stateAt = questions[0].requestedAt ?? null; }
  else if (background) { state = background.state === 'held' ? 'Held for background evidence' : 'Waiting for background evidence'; stateAt = live?.updatedAt ?? null; }
  else if (live?.lane === 'running') { state = 'Active'; stateAt = live.startedAt ?? null; }
  else if (live?.lane === 'qa') { state = 'QA in progress'; stateAt = live.qa?.startedAt ?? live.finishedAt ?? null; }
  else if (admission) { state = 'Waiting for admission'; stateAt = typeof admission.checked_at === 'string' ? admission.checked_at : null; }
  else if (live?.lane === 'queued') { state = live.correction ? 'Retrying — queued' : 'Waiting in queue'; stateAt = live.enqueuedAt ?? null; }
  else if (live?.lane === 'waiting') { state = 'Waiting'; stateAt = live.updatedAt ?? null; }
  else if (liveFresh && progressFresh) {
    state = ['completed', 'done'].includes(task.status) ? 'Completed' : latest?.outcome === 'success' ? 'Reported complete' : (task.status === 'blocked' || task.status === 'failed' || latest && ['failure', 'timeout', 'cancelled'].includes(latest.outcome)) ? 'Stopped' : 'Waiting';
    stateAt = latest?.completedAt ?? null;
  }
  const newerExecution = live?.lane === 'running' && latest?.completedAt && live.startedAt && Date.parse(live.startedAt) > Date.parse(latest.completedAt);
  if (newerExecution) gaps.push('The runtime has a newer execution than the recorded dispatch; its commentary is not available yet.');
  const currentStep = !newerExecution && progressFresh && latest?.commentary.available ? latest.commentary.messages.at(-1)?.text ?? 'No public progress message has been recorded for this attempt.' : 'Current step unavailable. See source details below.';
  const currentStepAt = !newerExecution && progressFresh && latest?.commentary.available ? latest.commentary.messages.at(-1)?.at ?? null : null;
  if (latest && !latest.commentary.available) gaps.push(latest.commentary.reason || 'Worker commentary unavailable.');
  if (latest?.commentary.truncated) gaps.push('Worker commentary is a bounded excerpt of the current attempt.');
  if (input.progress.data?.attemptsTruncated) gaps.push('Only the newest 50 attempts are shown.');
  if (input.progress.data?.eventsTruncated) gaps.push('Only the newest 200 retained task activity events are shown.');
  if (input.progress.data?.eventsAvailable === false) gaps.push('Task activity history is unavailable.');
  const dossier = evidenceFresh ? input.evidence.data : null;
  const verifiedAt = dossier?.verification?.ts;
  const historicalVerification = dossier?.state === 'verified' && (!['completed', 'done'].includes(task.status) || latest?.outcome === 'running' || (verifiedAt && latest && Date.parse(verifiedAt) < Date.parse(latest.startedAt)));
  const verification = historicalVerification ? 'Earlier completion was verified; current attempt is not verified' : dossier?.state === 'verified' ? 'Verified completion' : dossier ? 'Completion not yet verified' : 'Verification unavailable';
  const remaining = historicalVerification ? 'The current attempt still needs its own verification and QA evidence.' : dossier?.state === 'verified' ? 'No completion evidence gates remain open.' : dossier?.missing.length ? `Still needs evidence: ${dossier.missing.map(key => EVIDENCE_PIECE_LABELS[key]).join(', ')}.` : 'Remaining verification and QA requirements are not confirmed.';
  const history: ProgressEvent[] = [...(input.progress.data?.events ?? [])];
  const requests = new Map((input.recent.data ?? []).filter(q => q.taskId === task.id).map(q => [q.id, q]));
  for (const q of input.pending.data ?? []) if (q.taskId === task.id && !requests.get(q.id)?.resolution) requests.set(q.id, q);
  for (const q of requests.values()) {
    const href = `/inbox#${encodeURIComponent(q.id)}`;
    history.push({ id: `question-${q.id}`, title: 'Question requested', text: q.question, at: q.requestedAt ?? '', href });
    if (q.resolution) history.push({ id: `answer-${q.id}`, title: 'Response recorded', text: [q.resolution.choice, q.resolution.freeText].filter(Boolean).join('\n') || 'Closed without a recorded answer.', at: q.resolution.resolvedAt ?? '', href });
  }
  history.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return { state, stateAt, statusReason, admission, currentStep, currentStepAt, latest, attempts, questions, history, verification, remaining, gaps, dossier,
    action: !pendingFresh ? 'Cannot confirm whether you need to act; pending requests are unavailable or stale.' : questions.length ? 'Your response is needed.' : background ? 'No pending recovery request is recorded.' : state === 'Stopped' ? 'Stopped; recovery action is not recorded. Review task controls below.' : state === 'Unknown' ? 'No pending task question is recorded; current work status is unknown.' : 'No action needed from you.' };
}

/** A short prose preview only; callers retain the complete source in disclosure. */
export function progressPreview(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  let prose = '';
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      if (/^\s*(?:PRAXIS_[A-Z_]+\s*:|```|\{|\[\s*\{)/.test(line)) break;
      if (/^\s*#{1,6}\s+/.test(line)) continue;
      kept.push(line);
    }
    prose = kept.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (prose) break;
  }
  if (!prose) return 'Technical result recorded. Expand the full message to read it.';
  return prose.length > 400 ? prose.slice(0, 400).trimEnd() + '…' : prose;
}
