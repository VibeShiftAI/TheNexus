import type { BoardProject, BoardTask } from './task-board';
import { getBoardLaneId } from './task-board';

export type FocusStatus = 'running' | 'queued' | 'quota' | 'awaiting_input' | 'blocked' | 'unconfirmed';
export interface FocusItem {
  id: string; taskId: string | null; title: string; purpose: string | null;
  projectId: string | null; projectName: string; status: FocusStatus; stage: string;
  action: string | null; executor: string | null; model: string | null;
  updatedAt: string | null; startedAt: string | null; resumeAt?: string | null;
  approvalId?: string; stale: boolean;
}
export interface FocusWait {
  taskId: string; executor?: string | null; model?: string | null; kind?: string;
  resumeAt: string; limitedAt?: string | null; requiresAction?: boolean;
}
interface Run { taskId: string; executor: string; title: string; phase: string; status: string; kind?: string; startedAt: string; updatedAt: string; summary?: string }
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
const stages:Record<string,string>={dispatching:'Starting',loading:'Loading',thinking:'Thinking',writing:'Building',testing:'Testing',committing:'Saving changes',completing:'Finishing'};
const rank:Record<FocusStatus,number>={running:0,awaiting_input:1,blocked:2,quota:3,queued:4,unconfirmed:5};
const blockedBoard = new Set(['blocked','suspended','needs_input','awaiting_approval','awaiting_input']);
const timestamp=(v?:string|null)=>v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
const text=(v:unknown)=>typeof v==='string' && v.trim() ? v.trim() : null;

export function deriveCurrentFocus({projects, state, requests=[], events=[], now=Date.now()}: {
  projects:BoardProject[]|null; state:FocusState|null; requests?:FocusRequest[]; events?:FocusEvent[]; now?:number;
}):FocusView {
  const tasks=new Map<string,{task:BoardTask;project:BoardProject}>();
  for(const project of projects??[]) for(const task of project.tasks??[]) tasks.set(task.id,{task,project});
  // Praxis's documented QA run identity is qa--<original task ID>.
  // Resolve ownership only when that actual board task is present.
  const ownerId=(id:string)=>id.startsWith('qa--')&&tasks.has(id.slice(4))?id.slice(4):id;
  const rows=new Map<string,FocusItem>();
  const make=(taskId:string,title?:string):FocusItem=>{
    taskId=ownerId(taskId);
    const found=tasks.get(taskId);
    return {id:taskId,taskId,title:found?.task.name || found?.task.title || title || `Task ${taskId.slice(0,8)}`,
      purpose:text(found?.task.description)?.slice(0,700)??null,projectId:found?.project.id??null,projectName:found?.project.name??'Project not reported',
      status:'unconfirmed',stage:'In progress on board',action:'No active run is reported for this task.',executor:null,model:null,
      updatedAt:found?.task.updated_at??found?.task.updatedAt??null,startedAt:null,stale:false};
  };
  for(const {task} of tasks.values()) {
    if(getBoardLaneId(task)==='in_progress' || blockedBoard.has(task.status??'')) {
      const row=make(task.id);
      if(blockedBoard.has(task.status??'')) Object.assign(row,{status:'blocked',stage:'Needs attention',action:`Board status: ${task.status}. Open the task for details.`});
      rows.set(task.id,row);
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
    rows.set(row.id,row);
  }
  for(const wait of state?.executors?.usageWaits?.items??[]) {
    const row=make(wait.taskId);
    const quota=!wait.kind||wait.kind==='usage_limit';
    Object.assign(row,{status:wait.requiresAction?'blocked':quota?'quota':'queued',stage:wait.requiresAction?'Recovery needs attention':quota?'Waiting for limit reset':'Waiting to retry',
      action:wait.requiresAction?'Automatic recovery is held. Review the saved task/session before continuing.':quota?'Preserving the saved session and model until the scheduled resume.':'A recorded recovery retry is pending.',
      executor:wait.executor??null,model:wait.model??null,updatedAt:wait.limitedAt??null,resumeAt:wait.resumeAt});
    rows.set(row.id,row);
  }
  for(const request of requests) {
    if(request.resolution) continue;
    const row=make(request.taskId??`input-${request.id}`,'Decision awaiting you');
    if(!request.taskId) {row.taskId=null;row.projectName='Other decisions';}
    Object.assign(row,{status:'awaiting_input',stage:'Awaiting your input',action:request.question,updatedAt:request.requestedAt,approvalId:request.id});
    rows.set(row.id,row);
  }
  // A current run is execution evidence. A board status alone is not. Enrich
  // only a matching task/executor with events from this run, not a global feed.
  for(const run of state?.executors?.runs??[]) {
    if(run.status!=='active') continue;
    const terminal=events.find(e=>(e.type==='task.completed'||e.type==='task.failed')&&e.taskId===run.taskId&&timestamp(e.at)>timestamp(run.updatedAt));
    if(terminal) continue;
    const existing=rows.get(ownerId(run.taskId));
    if(existing?.status==='running' && timestamp(existing.updatedAt)>timestamp(run.updatedAt)) continue;
    if(existing && ['quota','blocked','awaiting_input'].includes(existing.status) && timestamp(existing.updatedAt)>timestamp(run.updatedAt)) continue;
    const row=make(run.taskId,run.title);
    const progress=events.filter(e=>e.type==='executor.progress'&&e.progress?.taskId===run.taskId&&e.progress.executor===run.executor&&timestamp(e.at)>=timestamp(run.startedAt)&&timestamp(e.at)>=timestamp(run.updatedAt)).sort((a,b)=>timestamp(b.at)-timestamp(a.at))[0]?.progress;
    const session=state?.executors?.sessions?.filter(s=>s.taskId===run.taskId&&s.executor===run.executor&&s.status==='open').sort((a,b)=>timestamp(b.lastUsedAt)-timestamp(a.lastUsedAt))[0];
    Object.assign(row,{status:'running',stage:run.kind==='qa'?`Review · ${stages[progress?.phase??run.phase]??run.phase}`:stages[progress?.phase??run.phase]??run.phase,
      action:text(progress?.message)??text(run.summary),executor:run.executor,model:text(session?.model),startedAt:run.startedAt,updatedAt:progress?.at??run.updatedAt,
      ...(existing?.approvalId ? {approvalId:existing.approvalId} : {})});
    rows.set(row.id,row);
  }
  // cron.running means the schedule is enabled, not that its callback is in
  // flight (Praxis cron-registry). Never turn enabled timers into live work.
  for(const [index,job] of (state?.localLlm?.jobs??[]).entries()) if(job.status==='running'||job.status==='queued') {
    const id=`local-${job.id??index}`;
    rows.set(id,{...make(id,job.type??'Local model job'),taskId:null,projectId:null,projectName:'Background activity',status:job.status==='running'?'running':'queued',stage:job.status==='running'?'Running':'Queued',action:null,executor:'Local LLM',updatedAt:job.updatedAt??null});
  }
  const groups=new Map<string,FocusView['groups'][number]>();
  for(const row of rows.values()) {
    row.stale=row.status==='running'&&(!timestamp(row.updatedAt)||now-timestamp(row.updatedAt)>5*60_000);
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
