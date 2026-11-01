"use client";

import type { Project } from '@/lib/nexus';
import type { ProjectIntake } from '@praxis/contract';

const stateLabels: Record<ProjectIntake['state'], string> = {
  preparing: 'Preparing intake', awaiting_choice: 'Ready to talk', deferred: 'Waiting for you',
  interviewing: 'Conversation in progress', council_review: 'Council review',
  ready_for_decision: 'Ready for your decision', handed_off: 'Accepted for planning',
};
const briefLabels = {
  purpose: 'Purpose', outcome: 'Desired outcome', beneficiary: 'Who benefits', scope: 'Scope',
  success_criteria: 'Success criteria', decision_owner: 'Decision owner', value: 'Expected value',
  exclusions: 'Outside scope', constraints: 'Constraints', dependencies: 'Dependencies',
  assumptions: 'Assumptions', risks: 'Risks', alternatives: 'Alternatives',
  interpretations: 'Praxis’s interpretation', decisions: 'Decisions',
} as const;

function Reference({ value }: { value: string }) {
  let web = false;
  try { web = ['http:', 'https:'].includes(new URL(value).protocol); } catch { /* local or conversation reference */ }
  return web ? <a href={value} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline break-all">{value}</a>
    : <span className="font-mono text-xs text-slate-400 break-all">{value}</span>;
}

/** Intake remains a conversation. This view reads the same project/needs and
 * opens an editable chat draft; it never fabricates a second questionnaire. */
export function ProjectIntakePanel({ project, onDiscuss }: { project: Project; onDiscuss: (text: string) => void }) {
  const intake = project.intake;
  if (!intake) return null;
  const needs = (project.needs ?? []).filter(need => intake.need_ids.includes(need.id));
  const pending = needs.find(need => need.id === intake.pending_need_id);
  const open = needs.filter(need => need.status === 'open');
  const discuss = (request: string) => onDiscuss(`${request} for project ${JSON.stringify(project.id)} (${project.name}). First read the saved intake and authoritative knowledge needs using project_intake action=read. Preserve the project identity and history; keep the current folder unless I request a change.`);
  const review = intake.review;
  return <section aria-label="Project intake" className="rounded-xl border border-cyan-500/30 bg-slate-900/70 p-5 space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-white">Project intake</h2>
        <p className="text-sm text-cyan-300">{stateLabels[intake.state]}</p>
        <p className="mt-1 text-xs text-slate-400">Brief version {intake.brief_revision} · {open.length} open questions of {needs.length}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950" onClick={() => discuss(intake.state === 'handed_off' ? 'Discuss the accepted intake and next planning step' : 'Resume intake from the pending question')}>{intake.state === 'handed_off' ? 'Discuss next step' : 'Resume intake'}</button>
        <button className="rounded-md border border-slate-600 px-3 py-2 text-sm" onClick={() => discuss('I want to correct an answer; ask which answer and save the correction with its history')}>Correct an answer</button>
        <button className="rounded-md border border-slate-600 px-3 py-2 text-sm" onClick={() => discuss('I want to add a source; ask for the reference and reconcile it with existing answers')}>Add a source</button>
        <button className="rounded-md border border-slate-600 px-3 py-2 text-sm" onClick={() => discuss('I want to change the project folder; use the exact new path I provide through attach_workspace and retain the previous binding in history')}>Change folder</button>
      </div>
    </header>
    {intake.state === 'deferred' && <p className="text-sm text-slate-300">Your idea and questions are saved. The interview and unsolicited research will wait; requested tasks and research can continue.</p>}
    {pending && <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/30 p-3"><h3 className="text-xs uppercase text-cyan-400">Next question</h3><p className="mt-1 text-slate-100">{pending.knowledge?.question || pending.description}</p></div>}
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3"><h3 className="font-semibold text-white">Intake brief</h3>
        <dl className="space-y-3">{Object.entries(briefLabels).map(([key, label]) => {
          const value = intake.brief[key as keyof typeof briefLabels];
          if (!value || (Array.isArray(value) && !value.length)) return null;
          return <div key={key}><dt className="text-xs font-semibold text-slate-400">{label}</dt><dd className="mt-1 whitespace-pre-wrap text-sm text-slate-200">{Array.isArray(value) ? <ul className="list-disc pl-5">{value.map((item, i) => <li key={i}>{item}</li>)}</ul> : value}</dd></div>;
        })}</dl>
        {!!intake.brief.facts?.length && <div><h4 className="text-xs text-slate-400">Sourced facts</h4><ul className="space-y-2 text-sm">{intake.brief.facts.map((fact, i) => <li key={i}>{fact.statement}<div>{fact.source_refs.map(ref => <div key={ref}><Reference value={ref} /></div>)}</div></li>)}</ul></div>}
        {!Object.keys(intake.brief).length && <p className="text-sm text-slate-400">The brief is being prepared from your idea and materials.</p>}
        <details className="text-sm"><summary className="cursor-pointer text-slate-400">Original idea</summary><p className="mt-2 whitespace-pre-wrap">{intake.original.problem}</p><Reference value={intake.original.source_ref} /></details>
      </div>
      <div className="space-y-4"><div><h3 className="font-semibold text-white">Materials</h3>
        {intake.sources.length ? <ul className="mt-2 space-y-3">{intake.sources.map((source, i) => <li key={`${source.ref}-${i}`} className="text-sm"><Reference value={source.ref} /><span className="ml-2 text-xs text-slate-400">{source.availability}</span>{source.processing_result && <p className="text-slate-300">{source.processing_result}</p>}{source.summary && <p className="mt-1 text-slate-400">{source.summary}</p>}</li>)}</ul> : <p className="mt-2 text-sm text-slate-400">No additional materials recorded.</p>}
      </div><div><h3 className="font-semibold text-white">Project folder</h3><p className="mt-1 text-sm text-slate-300">{intake.workspace.state === 'unassigned' ? 'No folder assigned. A folder and repository can be added later.' : intake.workspace.state === 'unavailable' ? 'Your supplied folder is currently unavailable; its location is preserved.' : 'Using your existing folder.'}</p>{intake.workspace.path && <Reference value={intake.workspace.path} />}</div></div>
    </div>
    <div><h3 className="font-semibold text-white">Knowledge needs</h3><ul className="mt-3 space-y-3">{needs.map(need => <li key={need.id} className="rounded-lg border border-slate-700/60 p-3">
      <div className="flex gap-3 justify-between"><h4 className="text-sm font-medium text-slate-100">{need.knowledge?.question || need.description}</h4><span className="text-xs text-slate-400">{need.status}</span></div>
      {need.knowledge?.purpose && <p className="mt-1 text-xs text-slate-400">{need.knowledge.purpose}</p>}
      {need.knowledge?.answer && <p className="mt-2 whitespace-pre-wrap text-sm">{need.knowledge.answer}</p>}
      {!!need.knowledge?.evidence?.length && <ul className="mt-2 text-xs text-slate-400">{need.knowledge.evidence.map((e, i) => <li key={i}><Reference value={e.ref} />{e.summary && <span> — {e.summary}</span>}</li>)}</ul>}
      {need.knowledge?.resolution && <p className="mt-2 text-xs text-slate-400">{[need.knowledge.resolution.method, need.knowledge.resolution.owner, need.knowledge.resolution.next_action].filter(Boolean).join(' · ')}</p>}
    </li>)}</ul>{!needs.length && <p className="mt-2 text-sm text-slate-400">Initial questions have not been prepared yet.</p>}</div>
    {review && <div><h3 className="font-semibold text-white">Council findings <span className="text-sm font-normal text-slate-400">· {review.status}</span></h3>
      <a className="text-xs text-cyan-300 underline" href={`/council?session=${encodeURIComponent(review.session_id)}`}>Open council session</a>
      {review.status === 'pending' && <p className="mt-2 text-sm text-slate-400">The review is pending. Its findings have not been accepted.</p>}
      {['failed', 'partial'].includes(review.status) && <p className="mt-2 text-sm text-amber-300">The council did not complete. Resume intake to review the saved result or retry.</p>}
      <ul className="mt-2 space-y-2 text-sm">{review.findings.map((finding, i) => <li key={i}>{finding.summary}<span className="ml-2 text-xs text-slate-400">{finding.disposition.replaceAll('_', ' ')}</span>{finding.rationale && <p className="text-slate-400">{finding.rationale}</p>}</li>)}</ul>
    </div>}
    {intake.acceptance && <div className="rounded-lg bg-emerald-950/30 p-3 text-sm text-emerald-200">
      <p>Accepted brief version {intake.acceptance.brief_revision}. Next step: {intake.acceptance.next_step}</p>
      {intake.acceptance.decision_note && <p className="mt-2">{intake.acceptance.decision_note}</p>}
      {intake.acceptance.review_disposition && <p className="mt-2">Council review: {intake.acceptance.review_disposition.replaceAll('_', ' ')}</p>}
      {!!intake.acceptance.readiness_gaps?.length && <div className="mt-3 text-slate-300"><h3 className="font-medium">Carried into planning</h3><ul className="mt-1 list-disc pl-5">{intake.acceptance.readiness_gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div>}
    </div>}
    {!!intake.workspace_history?.length && <details className="text-sm"><summary className="cursor-pointer text-slate-400">Folder history ({intake.workspace_history.length})</summary><ul className="mt-2 space-y-2">{intake.workspace_history.map((entry, i) => <li key={i}><Reference value={entry.previous.path || 'No folder assigned'} /> → <Reference value={entry.next.path || 'No folder assigned'} /><span className="ml-2 text-xs text-slate-400">{entry.at}</span></li>)}</ul></details>}
    {!!intake.review_history.length && <details className="text-sm"><summary className="cursor-pointer text-slate-400">Earlier councils ({intake.review_history.length})</summary><ul className="mt-3 space-y-3">{intake.review_history.map((prior, i) => <li key={i}>
      <a className="text-cyan-300 underline" href={`/council?session=${encodeURIComponent(prior.session_id)}`}>{prior.mode === 'preparation' ? 'Intake preparation' : 'Brief review'} · version {prior.brief_revision} · {prior.status}</a>
      <ul className="mt-1 text-slate-400">{prior.findings.map((finding, j) => <li key={j}>{finding.summary}</li>)}</ul>
    </li>)}</ul></details>}
    {!!intake.brief_history.length && <details className="text-sm"><summary className="cursor-pointer text-slate-400">Earlier brief versions ({intake.brief_history.length})</summary><ul className="mt-2 space-y-2">{intake.brief_history.map((prior, i) => <li key={i}><details><summary className="cursor-pointer">Version {prior.brief_revision} · {prior.at}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-400">{JSON.stringify(prior.brief, null, 2)}</pre></details></li>)}</ul></details>}
  </section>;
}
