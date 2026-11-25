/** The active projection shared by Praxis's queue and dispatch-state routes.
 * Optional fields also accept the last payload version during a rolling upgrade. */
export interface LocalActivityJob {
  id?: string;
  type?: string;
  status?: string;
  payload?: Record<string, unknown>;
  executionLane?: string | null;
  startedAt?: string | null;
  updatedAt?: string;
  attempts?: number;
  maxAttempts?: number;
}

interface RunningItem extends LocalActivityJob {
  id: string;
  name?: string;
  sourceTitle?: string | null;
  localCallInFlight?: boolean;
}

export interface LocalActivityRun {
  id: string;
  runId?: string | null;
  started?: boolean;
  type: string;
  name?: string;
  running: number;
  queued: number;
  finished: number | null;
  observedFinished?: number;
  total: number | null;
  allowedNow?: boolean;
  waitReason?: string | null;
  items: RunningItem[];
  updatedAt?: string;
}

export interface LocalActivityQueue {
  available?: boolean;
  worker?: { paused?: boolean; pauseReason?: string } | null;
  counts?: Record<string, number>;
  jobs?: LocalActivityJob[];
  runs?: LocalActivityRun[];
  localWindowOpen?: boolean;
  directCallers?: string[];
  directCallsInFlight?: number;
  nextLocalRunId?: string | null;
  jobNames?: Record<string, string>;
}

export interface LocalStudioState {
  reachable?: boolean;
  available?: boolean;
  models?: { id?: string; type?: string | null; state?: string; status?: string | null }[];
  instances?: { id: string; type: string; status: string | null; queued: number | null }[] | null;
  loadedCount?: number;
  lastActivityAt?: string | null;
}

export function readableJobName(type?: string) {
  const words = type?.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unnamed job';
}

/** Older producers carried a title on the job, or only a hash. A hash isn't a title. */
function queueSourceTitle(job: LocalActivityJob): string | null {
  const payload = job.payload;
  if (!payload) return null;
  const nested = payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>).title : null;
  for (const title of [payload.source_title, payload.title, nested, payload.name, payload.source]) {
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return null;
}

/** Management rows retain the queue's item order and its prompt preview. */
export function describeQueuedJob(job: LocalActivityJob, names?: Record<string, string>) {
  const name = job.type ? names?.[job.type] : null;
  const label = typeof name === 'string' && name.trim() ? name : readableJobName(job.type);
  const title = queueSourceTitle(job);
  if (title) return `${label} · ${title}`;
  const source = job.payload?.url;
  const caller = job.payload?.caller;
  const prompt = job.payload?.prompt ?? job.payload?.input;
  const preview = typeof prompt === 'string' ? prompt.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  const detail = typeof source === 'string' && source.trim() ? source
    : typeof caller === 'string' && caller.trim() ? `Caller · ${caller}` : preview && `Prompt · ${preview}`;
  return [label, 'Source title not reported', detail].filter(Boolean).join(' · ');
}

function legacyRuns(jobs: LocalActivityJob[]): LocalActivityRun[] {
  const runs = new Map<string, LocalActivityRun>();
  for (const [index, job] of jobs.entries()) {
    if (job.status !== 'running' && job.status !== 'queued') continue;
    const jobId = job.id ?? String(index);
    const type = job.type ?? '';
    const family = type === 'ingestion_finalize_run' ? 'ingest_item' : type;
    const runId = job.payload?.run_id;
    const id = typeof runId === 'string' && runId ? `${family}:${runId}` : `job:${jobId}`;
    const run: LocalActivityRun = runs.get(id) ?? { id, runId: typeof runId === 'string' ? runId : null,
      type: family, finished: null, total: null, running: 0, queued: 0, items: [] };
    run[job.status]++;
    if (job.updatedAt && (!run.updatedAt || job.updatedAt > run.updatedAt)) run.updatedAt = job.updatedAt;
    if (job.status === 'running') run.items.push({ ...job, id: jobId, sourceTitle: queueSourceTitle(job) });
    runs.set(id, run);
  }
  return [...runs.values()];
}

function localModel(lm?: LocalStudioState | null): string | null {
  if (!lm || lm.reachable === false || lm.available === false) return null;
  // The native request-queue feed contains resident models only. The dispatch
  // catalog can also include unloaded models and the always-resident embedder.
  const resident = lm.instances ?? lm.models?.filter(m => m.state === 'loaded' || (m.state === undefined && lm.available === true));
  const chat = resident?.filter(m => m.id && (m.type === 'llm' || m.type === 'vlm')) ?? [];
  const generating = chat.filter(m => m.status?.toLowerCase() === 'generating');
  const candidates = generating.length ? generating : chat;
  return candidates.length === 1 ? candidates[0].id ?? null : null;
}

function elapsed(since: string | null | undefined, now: number) {
  const secs = Math.floor((now - Date.parse(since ?? '')) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return 'Start time not reported';
  if (secs < 60) return `${secs}s elapsed`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s elapsed`;
  return `${Math.floor(secs / 3600)}h ${Math.floor(secs % 3600 / 60)}m elapsed`;
}

function describeRun(run: LocalActivityRun, queue: LocalActivityQueue, model: string | null, now: number, localWorkerOccupied: boolean) {
  const name = run.name || readableJobName(run.type);
  const items = run.items.map(item => {
    const lane = item.executionLane;
    const usesLocal = lane === 'local' && (queue.localWindowOpen !== false || item.localCallInFlight === true);
    let server = 'Lane not reported';
    if (lane === 'spillover') server = 'CLI spillover';
    if (usesLocal) {
      if (item.localCallInFlight) server = model ? `Local model · ${model}` : 'Local model · name not reported';
      else server = model ? `Local worker · ${model} resident · serving model unconfirmed` : 'Local worker · serving model name not reported';
    }
    if (lane === 'local' && !usesLocal) server = 'Local worker · serving model unconfirmed';
    const description = [item.name || readableJobName(item.type), item.sourceTitle || 'Source title not reported',
      server, elapsed(item.startedAt, now)].join(' · ');
    return { id: item.id, description, usesLocal, lane };
  });
  const localCount = items.filter(i => i.usesLocal).length;
  const spillCount = items.filter(i => i.lane === 'spillover').length;
  const lanes = [localCount && `${localCount} local`, spillCount && `${spillCount} CLI spillover`].filter(Boolean);
  const counts = `${run.running} running${lanes.length ? ` (${lanes.join(', ')})` : ''} · ${run.queued} queued`;
  const finished = run.finished != null ? `${run.finished} finished`
    : run.observedFinished ? `At least ${run.observedFinished} finished` : null;
  const progress = run.finished != null && run.total != null ? `${run.finished} of ${run.total} finished`
    : [finished ?? (run.total != null ? 'Finished count not reported' : null),
      run.total != null ? `${run.total} total` : 'Total not reported'].filter(Boolean).join(' · ');
  // A batch is between claims only after it started and while it is next in
  // line. Other runnable batches and independent jobs are waiting for the worker.
  const began = run.started ?? ((run.finished ?? run.observedFinished ?? 0) > 0);
  const next = queue.nextLocalRunId === undefined || queue.nextLocalRunId === run.id;
  const between = began && run.runId !== null && run.allowedNow && next && !localWorkerOccupied;
  const status = run.running > 0 ? 'running' : queue.worker?.paused ? 'paused'
    : between ? 'draining' : run.allowedNow != null ? 'waiting' : 'unknown';
  let state = '';
  if (queue.worker?.paused) {
    const reason = queue.worker.pauseReason || run.waitReason || 'reason not reported';
    state = run.running ? `Current work continues · worker paused · ${reason}` : `Paused · ${reason}`;
  }
  else if (status === 'draining') state = 'Between items';
  else if (status === 'waiting') state = run.allowedNow ? 'Waiting for worker' : `Waiting · ${run.waitReason || 'reason not reported'}`;
  else if (status === 'unknown') state = 'Queued · eligibility not reported';
  else if (!localCount && spillCount === run.running) state = 'CLI spillover';
  else if (!localCount) state = 'Serving model unconfirmed';
  const summary = [name, progress, state].filter(Boolean).join(' · ');
  const confirmed = run.items.some(item => item.executionLane === 'local' && item.localCallInFlight);
  return { id: run.id, type: run.type, name, status, summary, progress, state, counts, running: run.running,
    queued: run.queued, items, updatedAt: run.updatedAt, localCount, model: confirmed ? model : null };
}

export type DescribedLocalRun = ReturnType<typeof describeRun>;

/** Run eligibility comes from Praxis. Current LM Studio activity is distinct
 * from its last log timestamp, which may belong to an already finished job. */
export function describeLocalActivity(queue?: LocalActivityQueue | null, lm?: LocalStudioState | null, now = Date.now()) {
  const known = !!queue && queue.available !== false && !!(queue.runs || queue.jobs || queue.counts || queue.worker);
  const model = localModel(lm);
  const groups = known ? queue.runs ?? legacyRuns(queue.jobs ?? []) : [];
  const occupied = groups.some(run => run.items.some(item => item.executionLane === 'local'));
  const runs = groups.map(run => describeRun(run, queue!, model, now, occupied));
  const primary = runs.find(r => r.localCount) ?? runs.find(r => r.status === 'draining') ?? runs.find(r => r.running) ?? runs[0];
  const draining = runs.some(r => r.status === 'draining');
  const callers = queue?.directCallers ?? [];
  const generating = (lm?.instances ?? lm?.models)?.some(m => ['generating', 'processingprompt'].includes(
    m.status?.toLowerCase().replace(/[_ -]/g, '') ?? ''));
  const traffic = lm?.reachable !== false && lm?.available !== false && generating;
  const anyRunning = runs.some(r => r.running > 0) || Boolean(queue?.counts?.running);
  const direct = callers.length ? `Direct traffic · ${callers.join(', ')}`
    : queue?.directCallsInFlight || (known && !anyRunning && !draining && traffic)
      ? 'Direct traffic, caller not reported' : null;
  const busy = Boolean(direct || draining || runs.some(r => r.localCount));
  let summary = primary?.summary;
  if (!summary) {
    if (!known) summary = 'Queue unavailable';
    else if (queue.worker?.paused) summary = `Queue paused · ${queue.worker.pauseReason || 'reason not reported'}`;
    else if (queue.counts?.running || queue.counts?.queued) summary = 'Job details not reported';
    else if (lm?.reachable === false || lm?.available === false) summary = 'LM Studio offline';
    else if (lm?.loadedCount != null) summary = `${lm.loadedCount} resident`;
    else summary = 'Standing by';
  }
  if (direct) summary = primary || queue?.worker?.paused ? `${summary} · ${direct}` : direct;
  return { summary, busy, runs, direct };
}
