"use client";

import { useEffect, useState } from 'react';
import type { TaskById } from '@/lib/nexus';
import { buildTaskProgress, progressPreview, emptyProgressSource, type ProgressInput, type ProgressAttempt, type ProgressEvent } from '@/lib/task-progress';
import { evidencePieceAnchor } from '@/lib/task-evidence';
import { WorkAdmissionPanel } from './work-admission-panel';
import { TaskImprovementsPanel } from './task-improvements-panel';

const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Timestamp unavailable';
const initial = () => ({ progress: emptyProgressSource<NonNullable<ProgressInput['progress']['data']>>(), live: emptyProgressSource<NonNullable<ProgressInput['live']['data']>>(), pending: emptyProgressSource<NonNullable<ProgressInput['pending']['data']>>(), recent: emptyProgressSource<NonNullable<ProgressInput['recent']['data']>>(), evidence: emptyProgressSource<NonNullable<ProgressInput['evidence']['data']>>() });

export function TaskProgressPanel({ task }: { task: TaskById }) {
  const [sources, setSources] = useState(initial);
  const [now, setNow] = useState(Date.now);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false; let busy = false; const controller = new AbortController();
    setSources(initial());
    const refresh = async () => {
      if (busy) return; busy = true; setNow(Date.now());
      const id = encodeURIComponent(task.id);
      const endpoints = { progress: `/api/task-progress/${id}`, live: '/api/dispatch-insight/live-work', pending: '/api/praxis/hitl/pending', recent: '/api/praxis/hitl/recent?limit=200', evidence: `/api/task-evidence/${id}` };
      await Promise.allSettled(Object.entries(endpoints).map(async ([key, url]) => {
        try {
          const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          const data = key === 'pending' || key === 'recent' ? body.requests : body;
          if (data == null || ((key === 'pending' || key === 'recent') && !Array.isArray(data)) || (key === 'progress' && (data.taskId !== task.id || !Array.isArray(data.attempts))) || (key === 'live' && (!data.praxis || !Array.isArray(data.items)))) throw new Error('Invalid response');
          if (!cancelled) setSources(current => ({ ...current, [key]: { data, at: Date.now(), error: null } }));
        } catch {
          if (!cancelled) setSources(current => ({ ...current, [key]: { ...current[key as keyof typeof current], error: 'Source unavailable' } }));
        }
      }));
      busy = false; if (!cancelled) setNow(Date.now());
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 20_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [task.id, revision]);
  return <TaskProgressView input={{ task, now, ...sources }} onRefresh={() => setRevision(n => n + 1)} />;
}

function AttemptDetails({ attempt, current }: { attempt: ProgressAttempt; current: boolean }) {
  return <details className="mt-2 rounded-md border border-slate-800 p-3">
    <summary className="cursor-pointer text-xs text-slate-400">{current ? 'Current attempt' : 'Earlier attempt'} · {attempt.outcome} · details</summary>
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-xs text-slate-500">Started {stamp(attempt.startedAt)} · {attempt.completedAt ? `ended ${stamp(attempt.completedAt)}` : 'no end recorded'}</p>
      {attempt.parentId && <p className="text-xs text-slate-400">Follow-up to <a className="text-cyan-300" href={`#dispatch-${encodeURIComponent(attempt.parentId)}`}>recorded parent attempt</a>.</p>}
      {attempt.commentary.messages.length > 0 && <><p className="text-xs text-slate-500">Worker messages in recorded order. Message timestamps are unavailable; these are reported actions, not independent verification.</p><ol className="space-y-3 border-l border-slate-700 pl-4">{attempt.commentary.messages.map(message => <li key={message.sequence}>{message.at && <time className="text-xs text-slate-500" dateTime={message.at}>{stamp(message.at)}</time>}<p className="whitespace-pre-wrap break-words text-slate-300">{progressPreview(message.text)}</p>{progressPreview(message.text) !== message.text && <details className="mt-1"><summary className="cursor-pointer text-xs text-cyan-300">Full public message</summary><p className="mt-2 whitespace-pre-wrap break-words">{message.text}</p></details>}</li>)}</ol></>}
      {!attempt.commentary.available && <p className="text-xs text-amber-200">{attempt.commentary.reason}</p>}
      <a href={`#dispatch-${encodeURIComponent(attempt.id)}`} className="inline-block text-xs text-cyan-300 hover:underline">Open dispatch details and controls</a>
    </div>
  </details>;
}

export function TaskProgressView({ input, onRefresh }: { input: ProgressInput; onRefresh?: () => void }) {
  const view = buildTaskProgress(input);
  const timeline: Array<ProgressEvent & { attempt?: ProgressAttempt }> = [...view.history];
  for (const attempt of view.attempts) {
    timeline.push({ id: `start-${attempt.id}`, title: `Attempt started · ${attempt.executor}`, text: '', at: attempt.startedAt, attempt });
    if (attempt.completedAt) timeline.push({ id: `end-${attempt.id}`, title: `Attempt ended · ${attempt.outcome}`, text: attempt.outcome === 'success' ? 'The worker reported success. See verification evidence above.' : 'Recorded outcome; this does not establish the cause of a later attempt.', at: attempt.completedAt, href: `#dispatch-${encodeURIComponent(attempt.id)}` });
  }
  timeline.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const renderEvent = (event: typeof timeline[number]) => <li key={event.id} className="relative border-l border-slate-700 pb-5 pl-4"><span className="absolute -left-1 top-1 h-2 w-2 rounded-full bg-slate-500" /><p className="text-sm font-medium text-slate-200" data-timeline-title>{event.title}</p><time className="text-xs text-slate-500">{stamp(event.at)}</time>{event.text && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-400">{progressPreview(event.text)}</p>}{event.text && progressPreview(event.text) !== event.text && <details className="mt-2"><summary className="cursor-pointer text-xs text-cyan-300">Full event detail</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-400">{event.text}</p></details>}{event.href && <a href={event.href} className="mt-1 inline-block text-xs text-cyan-300 hover:underline">Open record</a>}{event.attempt && <AttemptDetails attempt={event.attempt} current={event.attempt.id === view.latest?.id} />}</li>;
  return <section aria-label="Task progress and history" className="rounded-xl border border-cyan-500/25 bg-slate-900/50 p-5" data-task-progress>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-white">Current progress</h3><button type="button" onClick={onRefresh} className="text-xs text-cyan-300">Refresh</button></div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><span className="rounded-md border border-slate-600 px-2 py-1 text-sm text-cyan-200">{view.state}</span><time className="text-xs text-slate-500">{view.state === 'Active' ? 'Started' : 'State recorded'} {stamp(view.stateAt)}</time></div>
    {view.statusReason && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-amber-200" data-runtime-hold>{view.statusReason}</p>}
    {view.admission && <WorkAdmissionPanel receipt={view.admission} />}
    <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{view.state === 'Completed' || view.state === 'Reported complete' ? 'Latest result · worker-reported' : 'Latest step · worker-reported'}</p>
    <p className="mt-1 text-xs text-slate-400" data-message-updated>{view.currentStepAt ? <>Message updated <time dateTime={view.currentStepAt}>{stamp(view.currentStepAt)}</time></> : 'Message update time unavailable'}</p>
    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">{progressPreview(view.currentStep)}</p>
    {progressPreview(view.currentStep) !== view.currentStep && <details className="mt-2"><summary className="cursor-pointer text-xs text-cyan-300">Full worker update</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-400">{view.currentStep}</p></details>}
    <p className="mt-2 text-xs text-slate-500">Worker-reported updates describe the latest recorded message, not a live activity heartbeat. Messages without source timestamps show no update time.</p>
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div><h4 className="text-sm font-medium text-slate-200">{view.verification}</h4><p className="mt-1 text-sm text-slate-400">{view.remaining}</p><div className="mt-2 flex flex-wrap gap-3">{view.dossier?.state !== 'not_completed' && view.dossier?.pieces.map(piece => <a key={piece.key} href={`#${evidencePieceAnchor(piece.key)}`} className="text-xs text-cyan-300 hover:underline">{piece.label}: {piece.status}</a>)}</div><p className="mt-2 text-xs text-slate-500">Requirement-by-requirement completion is not inferred from worker messages. <a href="#task-description" className="text-cyan-300">Review the brief</a>.</p></div>
      <div><h4 className="text-sm font-medium text-slate-200">{view.action}</h4>{view.questions.map(question => <div key={question.id} className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"><p className="whitespace-pre-wrap text-sm text-amber-100">{question.question}</p><a href={`/inbox#${encodeURIComponent(question.id)}`} className="mt-2 inline-block text-xs text-cyan-300">Answer this request in the inbox</a></div>)}<p className="mt-2 text-xs text-slate-500">This action summary covers the task inbox. Document review and contract controls remain below.</p></div>
    </div>
    <TaskImprovementsPanel source={input.progress} now={input.now} />
    {view.gaps.length > 0 && <details className="mt-4 rounded-md border border-amber-500/25 p-3"><summary className="cursor-pointer text-xs text-amber-200">Source gaps or stale information ({view.gaps.length})</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-100/80">{view.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></details>}
    <details className="mt-5 border-t border-slate-800 pt-4" open><summary className="cursor-pointer text-sm font-semibold text-slate-200">Progress and decision history</summary><p className="my-3 text-xs text-slate-500">Chronological records. Questions and answers have no attempt assignment unless the source records one. Decision history covers the most recent 200 system requests; older records may be absent. Retry causes are shown only when explicitly recorded.</p>
      {timeline.length === 0 ? <p className="text-sm text-slate-500">No history available from the loaded sources.</p> : <><ol>{timeline.length > 12 && <li><details className="mb-4"><summary className="cursor-pointer text-xs text-cyan-300">Earlier history ({timeline.length - 12} records)</summary><ol className="mt-4">{timeline.slice(0, -12).map(renderEvent)}</ol></details></li>}{timeline.slice(-12).map(renderEvent)}</ol></>}
    </details>
  </section>;
}
