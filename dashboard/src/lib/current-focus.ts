import type { BoardProject, BoardTask } from './task-board';
import { getBoardLaneId } from './task-board';

export type FocusStatus = 'running' | 'queued' | 'quota' | 'awaiting_input' | 'blocked' | 'unconfirmed';
/**
 * One telemetry value with its provenance. `value` is null whenever the feeds
 * did not evidence it, and then `reason` says why: an unavailable value is
 * null plus a reason, never a guess (docs/contracts/activity-evidence.md).
 */
export interface FocusTelemetry { value: string | null; reason: string | null; source: string | null; at: string | null }
/**
 * Last-known durable lifecycle, kept separately from the live indicator so a
 * freshness rule can withhold "Thinking" without erasing what was recorded.
 */
export interface FocusLifecycle {
  board: string | null; boardAt: string | null;
  run: 'active' | 'completed' | 'failed' | null; runPhase: string | null; runAt: string | null;
}
export interface FocusItem {
  id: string; taskId: string | null; title: string; purpose: string | null;
  projectId: string | null; projectName: string; status: FocusStatus; stage: string;
  action: string | null; executor: string | null; model: string | null;
  updatedAt: string | null; startedAt: string | null; resumeAt?: string | null;
  approvalId?: string; stale: boolean;
  lifecycle: FocusLifecycle;
  /** Fresh activity evidence. `phase.value` is set only when a phase report is fresh and evidenced. */
  evidence: { phase: FocusTelemetry; model: FocusTelemetry };
  /** Feed disagreements that were reconciled by freshness; the losing claim is kept here, never dropped. */
  conflicts: string[];
}
export interface FocusWait {
  taskId: string; executor?: string | null; model?: string | null; kind?: string;
  resumeAt: string; limitedAt?: string | null; requiresAction?: boolean;
}
interface Run { taskId: string; executor: string; title: string; phase: string; status: string; kind?: string; model?: string; startedAt: string; updatedAt: string; summary?: string }
interface Queue { taskId?: string; title?: string; executor?: string; enqueuedAt?: string; state?: string; detail?: string; args?: Record<string, unknown> }
export interface FocusState {
  executors?: {
    runs?: Run[]; cliQueue?: Queue[]; cliConcurrency?: {reason?: string};
    sessions?: {taskId:string; executor:string; model?:string; status:string; lastUsedAt?:string}[];
    usageWaits?: {available:boolean; items:FocusWait[]};
  };
  cron?: {key:string; label:string; running:boolean; lastRun:string|null}[];
  localLlm?: {jobs?: {id?:string;type?:string;status?:string;updatedAt?:string}[]; counts?:Record<string,number>};
}
export interface FocusRequest {id:string; taskId?:string; question:string; requestedAt:string; resolution?:unknown}
export interface FocusEvent {type:string; taskId?:string; at:string; progress?:{taskId:string;executor:string;phase:string;message?:string;at:string}}
export interface FocusView {
  groups: {id:string; name:string; items:FocusItem[]}[];
  running:number; waiting:number; unconfirmed:number; projectCount:number;
  label:string; tone:string;
}
export const stages:Record<string,string>={dispatching:'Starting',dispatch:'Starting',gate:'Starting',loading:'Loading',thinking:'Thinking',writing:'Building',testing:'Testing',execution:'Running',committing:'Saving changes',completing:'Finishing'};
/** Phases that claim what the model or its tools are doing right now; they need fresh evidence. Other phases are Praxis lifecycle steps. */
const toolPhases=new Set(['thinking','writing','testing']);
/** A phase report older than this no longer evidences a current sub-phase; the row shows Running. Same window as the stale flag. */
export const FRESH_MS=5*60_000;
const rank:Record<FocusStatus,number>={running:0,awaiting_input:1,blocked:2,quota:3,queued:4,unconfirmed:5};
const blockedBoard = new Set(['blocked','suspended','needs_input','awaiting_approval','awaiting_input']);
const timestamp=(v?:string|null)=>v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
const text=(v:unknown)=>typeof v==='string' && v.trim() ? v.trim() : null;
const none=(reason:string):FocusTelemetry=>({value:null,reason,source:null,at:null});
const clock=(v?:string|null)=>timestamp(v)?new Date(v as string).toISOString().slice(11,16)+' UTC':'an unknown time';

/**
 * Availability of the run/queue feed behind `state`. When the poller is
 * failing, `state` is the last good snapshot and `snapshotAt` is when it was
 * taken; the derivation then withholds live sub-phase claims from it.
 */
export interface FocusFeed { available: boolean; snapshotAt: string | null }

export function deriveCurrentFocus({projects, state, requests=[], events=[], now=Date.now(), feed}: {
  projects:BoardProject[]|null; state:FocusState|null; requests?:FocusRequest[]; events?:FocusEvent[]; now?:number; feed?:FocusFeed;
}):FocusView {
  const tasks=new Map<string,{task:BoardTask;project:BoardProject}>();
  for(const project of projects??[]) for(const task of project.tasks??[]) tasks.set(task.id,{task,project});
  // Praxis's documented QA run identity is qa--<original task ID>.
  // Resolve ownership only when that actual board task is present.
  const ownerId=(id:string)=>id.startsWith('qa--')&&tasks.has(id.slice(4))?id.slice(4):id;
  const feedReason=!state?'Run and queue feed unavailable; nothing can be attributed beyond the board.'
    :feed&&!feed.available?`Run and queue feed has not refreshed since ${clock(feed.snapshotAt)}; the last snapshot cannot evidence current activity.`:null;
  const noRunReason=(context:string)=>feedReason??`No active run is reported for this task${context}.`;
  // Durable run lifecycle per board task: the newest registry row for the task,
  // superseded by a confirmed terminal event that is newer than that row.
  const runLifecycle=new Map<string,Pick<FocusLifecycle,'run'|'runPhase'|'runAt'>>();
  for(const run of state?.executors?.runs??[]) {
    const id=ownerId(run.taskId);
    const prev=runLifecycle.get(id);
    if(prev && timestamp(prev.runAt)>timestamp(run.updatedAt)) continue;
    const status=run.status==='active'||run.status==='completed'||run.status==='failed'?run.status:null;
    runLifecycle.set(id,{run:status,runPhase:run.phase??null,runAt:run.updatedAt??null});
  }
  for(const e of events) {
    if(e.type!=='task.completed'&&e.type!=='task.failed'||!e.taskId) continue;
    const id=ownerId(e.taskId), prev=runLifecycle.get(id);
    if(prev && timestamp(prev.runAt)>=timestamp(e.at)) continue;
    runLifecycle.set(id,{run:e.type==='task.completed'?'completed':'failed',runPhase:e.type==='task.completed'?'completed':'failed',runAt:e.at});
  }
  const rows=new Map<string,FocusItem>();
  // The exemption belongs to this exact execution claim, not every row for
  // its task ID. A losing live run must not exempt another winning run row.
  const liveReports=new Set<FocusItem>();
  const claims=new Map<string,{at:number;label:string}>();
  const allClaims=new Map<string,{at:number;label:string}[]>();
  const make=(taskId:string,title?:string):FocusItem=>{
    taskId=ownerId(taskId);
    const found=tasks.get(taskId);
    return {id:taskId,taskId,title:found?.task.name || found?.task.title || title || `Task ${taskId.slice(0,8)}`,
      purpose:text(found?.task.description)?.slice(0,700)??null,projectId:found?.project.id??null,projectName:found?.project.name??'Project not reported',
      status:'unconfirmed',stage:'In progress on board',action:'No active run is reported for this task.',executor:null,model:null,
      updatedAt:found?.task.updated_at??found?.task.updatedAt??null,startedAt:null,stale:false,
      lifecycle:{board:found?.task.status??null,boardAt:found?.task.updated_at??found?.task.updatedAt??null,run:null,runPhase:null,runAt:null,...(runLifecycle.get(taskId)??{})},
      evidence:{phase:none(noRunReason('')),model:none(feedReason??'No run is reported; there is nothing to attribute a model to.')},
      conflicts:[]};
  };
  // Reconcile execution claims first; format every disagreement against the
  // final winner, rather than retaining text that names an intermediate row.
  // Invariant: place() owns conflicts during claim selection. Append other
  // conflicts (such as board disagreements) only after every place() call;
  // each placement rebuilds this list from the complete claim history.
  const place=(row:FocusItem,at:number,label:string)=>{
    const prev=rows.get(row.id), prevClaim=claims.get(row.id);
    const claim={at,label};
    const history=[...(allClaims.get(row.id)??[]),claim];
    allClaims.set(row.id,history);
    const keepPrevious=prev && prevClaim && (prevClaim.at>at || (prevClaim.at===at && at>0));
    const winner=keepPrevious?prev:row;
    const winnerClaim=keepPrevious?prevClaim:claim;
    winner.conflicts=history.filter(c=>c!==winnerClaim).map(c=>
      `${c.label} at ${clock(c.at?new Date(c.at).toISOString():null)} also names this task; showing ${winnerClaim.label} ${winnerClaim.at>c.at?'because it is newer':winnerClaim.at?'at the same timestamp (source-order tie)':'with no comparable timestamp'}.`);
    rows.set(row.id,winner); claims.set(row.id,winnerClaim);
  };
  for(const {task} of tasks.values()) {
    if(getBoardLaneId(task)==='in_progress' || blockedBoard.has(task.status??'')) {
      const row=make(task.id);
      if(blockedBoard.has(task.status??'')) {
        Object.assign(row,{status:'blocked',stage:'Needs attention',action:`Board status: ${task.status}. Open the task for details.`});
        place(row,timestamp(row.updatedAt),`board status ${task.status}`);
      } else rows.set(task.id,row);
    }
  }
  for(const [index,q] of (state?.executors?.cliQueue??[]).entries()) {
    if(q.state==='accepted'||q.state==='not_started') continue;
    const id=q.taskId??`queue-${index}`;
    const row=make(id,q.title);
    if(!q.taskId) row.taskId=null;
    Object.assign(row,{status:q.state==='reconciliation_required'?'blocked':'queued',stage:q.state==='reconciliation_required'?'Recovery needs attention':q.state==='claimed'?'Starting dispatch':'Queued',
      action:q.detail || (q.state==='claimed'?'Dispatch claimed; execution not yet confirmed.':`Queue position ${index+1}.${state?.executors?.cliConcurrency?.reason ? ` ${state.executors.cliConcurrency.reason}`:''}`),
      executor:q.executor??null,updatedAt:q.enqueuedAt??null});
    row.evidence={phase:none(noRunReason(' while it waits in the queue')),model:none(feedReason??'Not assigned until the dispatch starts.')};
    place(row,timestamp(q.enqueuedAt),`queue entry (${q.state??'queued'})`);
  }
  for(const wait of state?.executors?.usageWaits?.items??[]) {
    const row=make(wait.taskId);
    const quota=!wait.kind||wait.kind==='usage_limit';
    Object.assign(row,{status:wait.requiresAction?'blocked':quota?'quota':'queued',stage:wait.requiresAction?'Recovery needs attention':quota?'Waiting for limit reset':'Waiting to retry',
      action:wait.requiresAction?'Automatic recovery is held. Review the saved task/session before continuing.':quota?'Preserving the saved session and model until the scheduled resume.':'A recorded recovery retry is pending.',
      executor:wait.executor??null,model:wait.model??null,updatedAt:wait.limitedAt??null,resumeAt:wait.resumeAt});
    row.evidence={phase:none(noRunReason(' while its continuation waits')),model:wait.model?{value:wait.model,reason:null,source:'continuation ledger',at:wait.limitedAt??null}:none('The continuation ledger recorded no model for this wait.')};
    place(row,timestamp(wait.limitedAt),`saved wait (${wait.kind??'usage_limit'})`);
  }
  // A current run is execution evidence. A board status alone is not. Enrich
  // only a matching task/executor with events from this run, not a global feed.
  for(const run of state?.executors?.runs??[]) {
    if(run.status!=='active') continue;
    const terminal=events.find(e=>(e.type==='task.completed'||e.type==='task.failed')&&e.taskId===run.taskId&&timestamp(e.at)>timestamp(run.updatedAt));
    if(terminal) continue;
    const row=make(run.taskId,run.title);
    const progress=events.filter(e=>e.type==='executor.progress'&&e.progress?.taskId===run.taskId&&e.progress.executor===run.executor&&timestamp(e.at)>=timestamp(run.startedAt)&&timestamp(e.at)>=timestamp(run.updatedAt)).sort((a,b)=>timestamp(b.at)-timestamp(a.at))[0]?.progress;
    const session=state?.executors?.sessions?.filter(s=>s.taskId===run.taskId&&s.executor===run.executor&&s.status==='open').sort((a,b)=>timestamp(b.lastUsedAt)-timestamp(a.lastUsedAt))[0];
    const phase=phaseEvidence(run,progress,now,feed);
    // A run's own model is dispatch evidence. A saved CLI session is a cached
    // identifier: it names the model the session was opened with, and proves
    // neither provider health nor a current turn.
    const model:FocusTelemetry=text(run.model)?{value:text(run.model),reason:null,source:'run',at:run.startedAt}
      :session?text(session.model)?{value:text(session.model),reason:`From the saved CLI session recorded ${clock(session.lastUsedAt)}; a saved session proves neither provider health nor a live turn.`,source:'saved session',at:session.lastUsedAt??null}:none('The saved CLI session for this run has no model recorded.')
      :none('No model reported by the run or by a saved session for this executor.');
    const stageName=phase.value?stages[phase.value]??phase.value:'Running';
    Object.assign(row,{status:'running',stage:run.kind==='qa'?`Review · ${stageName}`:stageName,
      action:text(progress?.message)??text(run.summary),executor:run.executor,model:model.value,startedAt:run.startedAt,updatedAt:progress?.at??run.updatedAt,
      evidence:{phase,model}});
    if(progress) liveReports.add(row);
    place(row,timestamp(progress?.at??run.updatedAt),`active run (${run.executor})`);
  }
  // Questions are independent links, never competing execution claims.
  // Reconcile board/queue/wait/run evidence first, then attach the newest request.
  for(const request of [...requests].sort((a,b)=>timestamp(b.requestedAt)-timestamp(a.requestedAt))) {
    if(request.resolution) continue;
    const id=ownerId(request.taskId??`input-${request.id}`);
    const existing=rows.get(id);
    if(existing && existing.status!=='unconfirmed') {
      existing.approvalId??=request.id;
      continue;
    }
    const row=make(id,'Decision awaiting you');
    if(!request.taskId) {row.taskId=null;row.projectName='Other decisions';}
    Object.assign(row,{status:'awaiting_input',stage:'Awaiting your input',action:request.question,updatedAt:request.requestedAt,approvalId:request.id});
    row.evidence={phase:none(noRunReason(' while this question is open')),model:none(feedReason??'No run is reported; there is nothing to attribute a model to.')};
    rows.set(row.id,row);
  }
  // cron.running means the schedule is enabled, not that its callback is in
  // flight (Praxis cron-registry). Never turn enabled timers into live work.
  for(const [index,job] of (state?.localLlm?.jobs??[]).entries()) if(job.status==='running'||job.status==='queued') {
    const id=`local-${job.id??index}`;
    rows.set(id,{...make(id,job.type??'Local model job'),taskId:null,projectId:null,projectName:'Background activity',status:job.status==='running'?'running':'queued',stage:job.status==='running'?'Running':'Queued',action:null,executor:'Local LLM',updatedAt:job.updatedAt??null,
      evidence:{phase:none('The local queue reports job state only, not a sub-phase.'),model:none('The local queue does not report which model serves this job.')}});
  }
  const groups=new Map<string,FocusView['groups'][number]>();
  for(const row of rows.values()) {
    // A running row is stale when its last report is old, or when the feed
    // that carried it has itself stopped refreshing: a frozen snapshot cannot
    // report anything recent, however new its timestamps looked when taken.
    const feedAge=!liveReports.has(row)&&feed&&!feed.available?(timestamp(feed.snapshotAt)?now-timestamp(feed.snapshotAt):Number.POSITIVE_INFINITY):0;
    row.stale=row.status==='running'&&(!timestamp(row.updatedAt)||now-timestamp(row.updatedAt)>FRESH_MS||feedAge>FRESH_MS);
    // A live run against a task the board no longer lists as active is a
    // durable-versus-fresh disagreement: keep both and say so.
    const boardTask=row.taskId?tasks.get(row.taskId)?.task:undefined;
    if(row.status==='running' && boardTask && getBoardLaneId(boardTask)!=='in_progress' && !blockedBoard.has(boardTask.status??''))
      row.conflicts.push(`Board status is ${boardTask.status} while a run is active; the board has not caught up or the run outlived its task.`);
    const key=row.projectId??row.projectName;
    if(!groups.has(key)) groups.set(key,{id:key,name:row.projectName,items:[]});
    groups.get(key)!.items.push(row);
  }
  const sorted=[...groups.values()];
  for(const group of sorted) group.items.sort((a,b)=>rank[a.status]-rank[b.status]||timestamp(b.updatedAt)-timestamp(a.updatedAt)||a.title.localeCompare(b.title));
  sorted.sort((a,b)=>rank[a.items[0].status]-rank[b.items[0].status]||a.name.localeCompare(b.name));
  const all=[...rows.values()];
  const running=all.filter(x=>x.status==='running').length;
  const unconfirmed=all.filter(x=>x.status==='unconfirmed').length;
  const waiting=all.length-running-unconfirmed;
  const projectCount=new Set(all.filter(x=>x.projectId).map(x=>x.projectId)).size;
  const activeGroups=sorted.filter(g=>g.items.some(x=>x.status==='running'));
  const label=running?(activeGroups.length===1&&running===1?`${activeGroups[0].name} · ${activeGroups[0].items[0].stage}`:`${projectCount ? `${projectCount} project${projectCount===1?'':'s'}`:'Activity'} · ${running} running`)
    :waiting?`${waiting} waiting`:unconfirmed?`${unconfirmed} in progress · no live run`:'Standing by';
  return {groups:sorted,running,waiting,unconfirmed,projectCount,label,tone:running?'text-cyan-300':waiting?'text-amber-300':'text-slate-400'};
}

/**
 * Decide whether a run's phase is evidenced right now.
 *
 * The Praxis run registry keeps one cached `phase` per run: it is set to
 * `thinking` when the executor process is spawned (a start default, not a
 * report) and afterwards only changes when a tool report arrives, so its
 * timestamp is the time of the last change, not the last activity. A cached
 * phase therefore proves neither provider health nor a current tool sub-phase.
 * Rules, from docs/contracts/activity-evidence.md:
 *  - lifecycle steps Praxis itself emits (dispatching, completing, ...) are shown as recorded;
 *  - a tool phase (thinking, writing, testing) counts only while its report is within FRESH_MS;
 *  - `thinking` additionally needs a report message (tool or trace), because the bare spawn
 *    default carries none; a registry-only `thinking` is not evidence;
 *  - otherwise the value is null with a reason and the row shows Running.
 */
export function phaseEvidence(run:Pick<Run,'phase'|'updatedAt'>,progress:FocusEvent['progress']|undefined,now:number,feed?:FocusFeed):FocusTelemetry {
  const phase=text(progress?.phase)??text(run.phase);
  const at=progress?.at??run.updatedAt??null;
  const source=progress?'progress report':'run registry';
  if(!phase) return none('The run reported no phase.');
  if(!toolPhases.has(phase)) return {value:phase,reason:null,source,at};
  const age=timestamp(at)?now-timestamp(at):Number.POSITIVE_INFINITY;
  const label=stages[phase]??phase;
  // Snapshot failure invalidates registry evidence, not independently received
  // progress. Live reports are checked against their own timestamps below.
  if(!progress&&feed&&!feed.available) return {value:null,reason:`Run feed has not refreshed since ${clock(feed.snapshotAt)}; the last recorded phase (${label}, ${clock(at)}) comes from a frozen snapshot and is not evidence of what is happening now.`,source:null,at};
  if(age>FRESH_MS) return {value:null,reason:`No phase report in the last ${Math.round(FRESH_MS/60_000)} min; the last recorded phase (${label}, ${clock(at)}) is not evidence of what is happening now.`,source:null,at};
  if(phase==='thinking' && !text(progress?.message)) return {value:null,reason:progress?'Executor start default; no tool or trace report has arrived yet.':'The registry\'s cached "thinking" is the executor start default unless a tool report carried it, and none is in the live event buffer.',source:null,at};
  return {value:phase,reason:null,source,at};
}
