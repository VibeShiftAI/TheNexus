"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Activity, RefreshCw, Loader2, Clock3 } from 'lucide-react';
import { HudModal } from './hud';
import type { FocusItem, FocusStatus, FocusView } from '@/lib/current-focus';

const colors:Record<FocusStatus,string>={running:'border-cyan-500/30 text-cyan-300 bg-cyan-500/5',queued:'border-amber-500/25 text-amber-300 bg-amber-500/5',quota:'border-violet-500/30 text-violet-300 bg-violet-500/5',awaiting_input:'border-amber-500/30 text-amber-300 bg-amber-500/5',blocked:'border-rose-500/30 text-rose-300 bg-rose-500/5',unconfirmed:'border-slate-700 text-slate-400 bg-slate-900/40'};
const stateLabels:Record<FocusStatus,string>={running:'Running',queued:'Queued',quota:'Limit reset',awaiting_input:'Your input',blocked:'Needs attention',unconfirmed:'Board only'};
function when(value:string|null|undefined) {
  if(!value || !Number.isFinite(Date.parse(value))) return 'Not reported';
  return new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}

function FocusRow({item}:{item:FocusItem}) {
  return <article data-focus-task={item.taskId??item.id} className="rounded-lg border border-slate-800 bg-slate-900/35 p-3 text-left">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        {item.taskId ? <Link href={`/task/${encodeURIComponent(item.taskId)}`} className="break-words text-sm font-semibold text-slate-100 hover:text-cyan-200">{item.title}</Link> : <h4 className="break-words text-sm font-semibold text-slate-100">{item.title}</h4>}
        {item.purpose && <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-400">{item.purpose}</p>}
      </div>
      <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colors[item.status]}`}>{stateLabels[item.status]}</span>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={item.status==='running'?'text-cyan-300':'text-slate-300'}>{item.stage}</span>
      <span className="text-slate-500">{item.executor??'Executor not reported'}</span>
      <span className="break-all text-slate-500">{item.model??'Model not reported'}</span>
    </div>
    <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">{item.action??'No step detail reported yet.'}</p>
    {item.resumeAt && <p className="mt-2 flex items-start gap-1.5 text-xs text-violet-300"><Clock3 size={12} className="mt-0.5 shrink-0"/><span>Scheduled resume: {when(item.resumeAt)}{Date.parse(item.resumeAt)<=Date.now()?' · time reached; execution not yet confirmed':''}</span></p>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-2 text-[11px] text-slate-500">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {item.startedAt && <span>Started {when(item.startedAt)}</span>}
        <span title={item.updatedAt??undefined}>Last report {when(item.updatedAt)}</span>
        {item.stale && <span className="text-amber-300">No recent step update</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {item.approvalId && <Link href={`/inbox#${encodeURIComponent(item.approvalId)}`} className="font-semibold text-amber-300 hover:text-amber-200">Review request ↗</Link>}
        {item.taskId && <Link href={`/task/${encodeURIComponent(item.taskId)}`} className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-200">Task & activity <ArrowUpRight size={11}/></Link>}
      </div>
    </div>
  </article>;
}

export interface CurrentFocusPanelProps {
  view:FocusView; loading:boolean; errors:string[]; updatedAt:string|null;
  connected:boolean; refresh:()=>Promise<void>; onClose:()=>void;
}

export function CurrentFocusPanel({view,loading,errors,updatedAt,connected,refresh,onClose}:CurrentFocusPanelProps) {
  const [refreshing,setRefreshing]=useState(false);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const panel=document.querySelector<HTMLElement>('[role="dialog"][aria-label="Current Focus"]');
    const controls=()=>Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')??[]);
    controls()[0]?.focus();
    const onKey=(event:KeyboardEvent)=>{
      if(event.key!=='Tab') return;
      const elements=controls(), first=elements[0], last=elements[elements.length-1];
      if(event.shiftKey && (document.activeElement===first||!panel?.contains(document.activeElement))) {event.preventDefault();last?.focus();}
      else if(!event.shiftKey && (document.activeElement===last||!panel?.contains(document.activeElement))) {event.preventDefault();first?.focus();}
    };
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    document.addEventListener('keydown',onKey);
    return ()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  return <HudModal title="Current Focus" subtitle="What is happening, by project" icon={<Activity size={15}/>} accent="cyan" wide onClose={onClose}>
    <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
      <div className="flex flex-wrap gap-4 text-xs">
        <span className="text-cyan-300"><strong className="text-lg">{view.running}</strong> {errors.length?'last reported running':'running'}</span>
        <span className="text-amber-300"><strong className="text-lg">{view.waiting}</strong> waiting</span>
        {view.unconfirmed>0 && <span className="text-slate-400"><strong className="text-lg">{view.unconfirmed}</strong> on board, no live run</span>}
      </div>
      <button disabled={refreshing} onClick={async()=>{setRefreshing(true);try{await refresh()}finally{setRefreshing(false)}}} className="inline-flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-cyan-500/50 disabled:opacity-50"><RefreshCw size={12} className={refreshing?'animate-spin':''}/>Refresh</button>
    </div>
    {errors.length>0 && <div role="alert" className="mb-4 space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">{errors.map(error=><p key={error}>{error}</p>)}</div>}
    {!connected && <p className="mb-3 text-xs text-slate-500">Live updates are reconnecting. Snapshot refresh continues.</p>}
    {loading ? <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400"><Loader2 size={16} className="animate-spin"/>Reading current activity…</div> : view.groups.length>0 ? <div className="space-y-5">{view.groups.map(group=><section key={group.id} aria-label={group.name}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">{group.name}</h3>
        {group.items[0].projectId && <Link href={`/project/${encodeURIComponent(group.items[0].projectId)}`} className="inline-flex items-center gap-1 text-[11px] text-cyan-500 hover:text-cyan-300">Project <ArrowUpRight size={11}/></Link>}
      </div>
      <div className="space-y-2">{group.items.map(item=><FocusRow key={item.id} item={item}/>)}</div>
    </section>)}</div> : !errors.length && <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-400">Nothing is running or waiting in the available activity feeds.</p>}
    <p className="mt-4 border-t border-slate-800 pt-3 text-[10px] text-slate-500">Activity snapshot: {when(updatedAt)} · Work outside the connected Praxis feeds and scheduled maintenance without execution reports may not appear here.</p>
  </HudModal>;
}
