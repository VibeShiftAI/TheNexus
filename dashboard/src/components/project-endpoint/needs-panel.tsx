"use client";
import { useState } from "react";
import { getProject, type Project, type ProjectNeed } from "@/lib/nexus/projects";
import type { Task } from "@/lib/nexus/tasks";
import { addProjectNeed, patchProjectNeed, type ProjectNeedPatch } from "@/lib/nexus/project-needs";
import { knowledgeLifecycle, knowledgeTaskIds, knowledgeApplications, hasAppliedKnowledge, knowledgePriority, prioritizeKnowledgeNeeds, needPatch } from "@/lib/project-endpoint";
import { NeedEditor, VerificationDialog, ApplicationDialog, resolutionLabels } from "./need-editor";
import { KnowledgeSearch } from "./knowledge-search";
import { buttonClass, inputClass, EvidenceRef, Status } from "./fields";

const queues = { all: "Action needed", needsAnswer: "Needs an answer", evidenceToReview: "Evidence to review", needsReview: "Needs re-verification", awaitingApplication: "Awaiting application" } as const;
type Queue = keyof typeof queues;

export function ProjectNeedsPanel({ project, tasks, onUpdate }: { project: Project; tasks: Task[]; onUpdate: (project: Project) => void }) {
  const [editing, setEditing] = useState<ProjectNeed | null>(null);
  const [dialog, setDialog] = useState<{ need: ProjectNeed; kind: "verify" | "apply" } | null>(null);
  const [filter, setFilter] = useState("");
  const [queue, setQueue] = useState<Queue>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = busy || !!editing || !!dialog;
  const all = project.needs ?? [];
  const active = all.filter(n => knowledgeLifecycle(n, undefined, tasks).actionRequired);
  const historical = all.filter(n => n.status === "dropped" || n.knowledge?.superseded_by?.length);
  const deferred = all.filter(n => !historical.includes(n) && knowledgeLifecycle(n, undefined, tasks).deferred);
  const completed = all.filter(n => !historical.includes(n) && !deferred.includes(n) && knowledgeLifecycle(n, undefined, tasks).complete);
  const needs = prioritizeKnowledgeNeeds(active.filter(n => (!filter || n.knowledge?.tags.includes(filter)) && (queue === "all" || knowledgeLifecycle(n, undefined, tasks)[queue])), project, tasks);

  async function mutate(need: ProjectNeed, patch: ProjectNeedPatch) {
    setBusy(true); setError("");
    try {
      if (need.id) await patchProjectNeed(project.id, need.id, patch);
      else await addProjectNeed(project.id, patch);
      setEditing(null); setDialog(null);
      // Refresh the complete card: the need receipt has no endpoint snapshot.
      try { onUpdate(await getProject(project.id)); }
      catch { setError("Need saved. Please reload the project to see the current endpoint and knowledge state."); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save need"); }
    finally { setBusy(false); }
  }
  function edit(need: ProjectNeed) { setEditing(structuredClone(need)); setError(""); }
  function create(structured: boolean) {
    edit({ id: "", kind: structured ? "information" : "capability", description: "", status: "open", created_at: new Date().toISOString(), source: "operator", ...(structured ? { knowledge: { question: "", purpose: "", resolution: { method: "existing_knowledge" as const }, tags: [], satisfaction_test: "", criterion_ids: [], task_ids: [], blocking: false, research_status: "open" as const, evidence: [] } } : {}) });
  }
  function openDialog(need: ProjectNeed, kind: "verify" | "apply") { setDialog({ need: structuredClone(need), kind }); setError(""); }
  function statusPatch(need: ProjectNeed, status: ProjectNeed["status"]) {
    return mutate(need, { status, source: "operator", ...(need.knowledge ? { expected_knowledge_revision: need.knowledge.revision ?? 0 } : {}) });
  }
  function renderNeed(need: ProjectNeed) {
    const k = need.knowledge;
    const state = knowledgeLifecycle(need, undefined, tasks);
    const applications = knowledgeApplications(need);
    const previouslyApplied = hasAppliedKnowledge(need);
    const retired = need.status === "dropped" || !!k?.superseded_by?.length;
    const checkpoints = project.checkpoints?.items.filter(cp => cp.need_ids.includes(need.id) || cp.criteria.some(c => k?.criterion_ids.includes(c.id))) ?? [];
    return <li key={need.id} id={`need-${need.id}`} className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[10px] text-slate-500">{need.kind} · {need.id}{k ? ` · revision ${k.revision ?? 0}` : ""}</span><Status value={need.status === "dropped" ? "dropped" : k?.superseded_by?.length ? "superseded" : state.deferred ? "deferred" : state.complete ? state.applied ? "applied" : "complete" : !state.needsVerification ? "verified" : k?.research_status ?? need.status} />{k?.blocking && state.actionRequired && <span className="text-amber-300">Blocking</span>}{k?.group && <span className="text-slate-400">{k.group}</span>}</div>
      <h3 className="whitespace-pre-wrap text-base text-slate-100">{k?.question || need.description}</h3>
      {state.actionRequired && <p className="text-amber-200">Priority: {knowledgePriority(need, project, tasks).label}</p>}
      {k ? <>
        <ol aria-label="Knowledge progress" className="flex flex-wrap gap-3 text-slate-300"><li>{state.answered ? "✓ Answer recorded" : "1. Answer needed"}</li><li>{!state.needsVerification ? "✓ Verified" : "2. Verification needed"}</li><li>{state.complete ? state.applied ? "✓ Applied" : "✓ Application accounted for" : "3. Application pending"}</li></ol>
        {state.complete && <p className="text-emerald-300">Nothing left to do for this answer.</p>}
        {need.description !== k.question && <p className="text-slate-500">{need.description}</p>}
        <p className="text-slate-300"><span className="text-slate-500">Why it matters: </span>{k.purpose || "Purpose not recorded. Clarify it when resolving this question."}</p>
        <div className="grid gap-2 rounded border border-slate-800 p-3 sm:grid-cols-2">
          <p className="text-slate-300"><span className="text-slate-500">Route: </span>{k.resolution ? resolutionLabels[k.resolution.method] : "Choose a resolution route"}</p>
          <p className="text-slate-300"><span className="text-slate-500">Owner: </span>{k.resolution?.owner || "Not assigned"}</p>
          {!state.complete && <p className="text-slate-300 sm:col-span-2"><span className="text-slate-500">Next action: </span>{state.awaitingApplication ? `Apply the verified answer${state.remainingTaskIds.length ? ` to ${state.remainingTaskIds.length} remaining task${state.remainingTaskIds.length === 1 ? "" : "s"}` : " to affected work"} and record the result.` : k.resolution?.next_action || "Review the question and existing evidence."}</p>}
          {state.deferred && <p className="text-amber-200 sm:col-span-2">Deferred: {k.deferred_reason || `until ${new Date(k.deferred_until!).toLocaleString()}`}</p>}
        </div>
        <p className="text-slate-300"><span className="text-slate-500">Enough evidence: </span>{k.satisfaction_test}</p>
        {k.review_reason && <p className="text-amber-300">Review needed: {k.review_reason}</p>}
        <div className="flex flex-wrap gap-2 text-slate-400">
          {checkpoints.map(cp => <span key={cp.id}>Checkpoint: {cp.title}</span>)}
          {k.criterion_ids.map(id => <span key={id}>Criterion: {project.end_state_criteria?.find(c => c.id === id)?.description || project.checkpoints?.items.flatMap(cp => cp.criteria).find(c => c.id === id)?.description || id}</span>)}
          {knowledgeTaskIds(need, tasks).map(id => <a key={id} href={`/task/${encodeURIComponent(id)}`} className="text-cyan-300 underline">{tasks.find(t => t.id === id)?.title || id}</a>)}
          {k.superseded_by?.map(id => <a key={id} href={`#need-${encodeURIComponent(id)}`} className="text-cyan-300 underline">Successor question {id}</a>)}
        </div>
        <div className="grid gap-4 border-y border-slate-800 py-3 md:grid-cols-2">
          <section aria-label="Current answer"><h4 className="mb-2 font-semibold text-slate-400">Answer</h4><p className="whitespace-pre-wrap text-sm text-slate-200">{k.answer || "No answer recorded."}</p></section>
          <section aria-label="Current evidence"><h4 className="mb-2 font-semibold text-slate-400">Evidence ({k.evidence.length})</h4>{!k.evidence.length && <p className="text-slate-500">No evidence recorded.</p>}<ul className="space-y-3">{k.evidence.map(e => <li key={e.ref}><EvidenceRef refValue={e.ref} />{e.summary && <p className="mt-1 whitespace-pre-wrap text-slate-300">{e.summary}</p>}{e.checked_at && <p className="text-slate-500">Checked {new Date(e.checked_at).toLocaleString()}</p>}</li>)}</ul></section>
        </div>
        <section aria-label="Answer verification" className="space-y-1"><h4 className="font-semibold text-slate-400">Verification: {!state.needsVerification ? "verified" : "not verified for current use"}</h4>{k.verified_at && <p className="text-slate-500">{!state.needsVerification ? "Verified" : "Historical verification"} {new Date(k.verified_at).toLocaleString()} by {k.verified_by || "unknown"}{k.verification ? ` · revision ${k.verification.revision}` : ""}</p>}{k.verification?.rationale && <p className="text-slate-300">{k.verification.rationale}</p>}{k.verification?.evidence_refs.map(ref => <div key={ref}><EvidenceRef refValue={ref} /></div>)}{state.verificationProblems.map(problem => <p key={problem} className="text-amber-200">{problem}</p>)}</section>
        <section aria-label="Task application history" className="space-y-2"><h4 className="font-semibold text-slate-400">Application to tasks</h4>{!applications.length && <p className="text-slate-500">No task applications recorded.{state.verified ? " The verified answer is ready to apply." : ""}</p>}<ul className="space-y-2">{applications.map((a, index) => <li key={a.id || index} className="rounded border border-slate-800 p-2"><Status value={a.status} /> {a.task_id && <a className="text-cyan-300 underline" href={`/task/${encodeURIComponent(a.task_id)}`}>{tasks.find(t => t.id === a.task_id)?.title || a.task_id}</a>}{a.answer_revision !== undefined && <span className="text-slate-500"> · answer revision {a.answer_revision}</span>}{a.at && <p className="text-slate-500">{new Date(a.at).toLocaleString()}</p>}{a.notes && <p className="whitespace-pre-wrap text-slate-300">{a.notes}</p>}{a.evidence_ref && <EvidenceRef refValue={a.evidence_ref} />}</li>)}</ul></section>
        {!!k.history?.length && <details className="space-y-2 text-slate-400"><summary className="cursor-pointer">Prior answers and evidence ({k.history.length})</summary>{k.history.map((old, index) => <section key={`${old.revision}-${index}`} className="mt-3 space-y-2 border-l border-slate-700 pl-3"><h4>Revision {old.revision} · {new Date(old.at).toLocaleString()}</h4><p className="whitespace-pre-wrap text-slate-200">{old.question}</p><p>Enough evidence: {old.satisfaction_test}</p><p className="whitespace-pre-wrap">{old.answer || "No answer at this revision."}</p>{old.evidence.map(e => <div key={e.ref}><EvidenceRef refValue={e.ref} />{e.summary && <p>{e.summary}</p>}</div>)}{old.verification && <p>Verification: {old.verification.rationale}</p>}</section>)}</details>}
        {!!k.tags.length && <div className="flex flex-wrap gap-1">{k.tags.map(tag => <button key={tag} disabled={busy} onClick={() => { setFilter(tag); setQuery(tag); }} className="rounded border border-cyan-900/50 px-2 py-1 text-cyan-300 hover:bg-cyan-950">#{tag}</button>)}</div>}
      </> : need.kind === "information" && <p className="text-amber-200">Legacy information need. Clarify one question, its purpose and its resolution route.</p>}
      {need.notes && <p className="whitespace-pre-wrap text-slate-400">{need.notes}</p>}
      {previouslyApplied && retired && <p className="text-amber-200">{k?.superseded_by?.length ? "Revise the successor question using its link above." : "Reopen this question before revising its applied answer."}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={locked || (previouslyApplied && retired)} className={buttonClass} onClick={() => edit(need)}>{previouslyApplied ? "Revise applied answer" : need.kind === "information" ? state.primaryAction : "Edit need"}</button>
        {k && need.status !== "dropped" && <><button disabled={locked || !state.needsVerification || !!state.verificationProblems.length} className={buttonClass} onClick={() => openDialog(need, "verify")}>{!state.needsVerification ? "Verified" : "Verify answer"}</button><button disabled={locked || !state.active || !state.canApply || state.complete} className={buttonClass} onClick={() => openDialog(need, "apply")}>{state.complete ? state.applied ? "Applied" : "Application accounted for" : state.canApply ? "Apply to task" : "Apply after verification"}</button><button disabled={busy || !!dialog} className={buttonClass} onClick={() => setQuery(`${k.question} ${k.tags.join(" ")}`.trim())}>Search question</button></>}
        {need.status === "open" ? <>{!k && need.kind !== "information" && <button disabled={locked} className={buttonClass} onClick={() => void statusPatch(need, "met")}>Mark met</button>}<button disabled={locked} className={buttonClass} onClick={() => void statusPatch(need, "dropped")}>Drop</button></> : (!previouslyApplied || need.status === "dropped") && !k?.superseded_by?.length && <button disabled={locked} className={buttonClass} onClick={() => void statusPatch(need, "open")}>Reopen</button>}
      </div>
    </li>;
  }
  return <section className="min-w-0 space-y-4 rounded-xl border border-amber-900/40 bg-slate-900/40 p-5" aria-label="Project needs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold uppercase tracking-wider text-amber-300">Needs & knowledge</h2><div className="flex gap-2"><button disabled={locked} className={buttonClass} onClick={() => create(true)}>Add question</button><button disabled={locked} className={buttonClass} onClick={() => create(false)}>Add need</button></div></div>
    {error && !dialog && <p role="alert" className="text-sm text-amber-300">{error}</p>}
    <label className="block space-y-1 text-xs text-slate-400"><span>Question review queue</span><select className={inputClass} value={queue} onChange={event => setQueue(event.target.value as Queue)}>{Object.entries(queues).map(([value, label]) => <option key={value} value={value}>{label} ({value === "all" ? active.length : active.filter(n => knowledgeLifecycle(n, undefined, tasks)[value as Exclude<Queue, "all">]).length})</option>)}</select></label>
    {filter && <div className="flex items-center gap-2 text-xs text-slate-400">Showing #{filter} needs ({needs.length})<button className={buttonClass} onClick={() => setFilter("")}>Show all needs</button></div>}
    {query && <KnowledgeSearch key={query} query={query} onClose={() => setQuery("")} />}
    {editing && <NeedEditor key={editing.id || "new"} need={editing} project={project} tasks={tasks} busy={busy} onCancel={() => { setEditing(null); setError(""); }} onSave={draft => { const patch = editing.id ? needPatch(editing, draft) : draft; if (!Object.keys(patch).length) { setEditing(null); return; } void mutate(editing, { ...patch, source: "operator" }); }} />}
    {dialog?.kind === "verify" && <VerificationDialog need={dialog.need} busy={busy} error={error} onSave={patch => void mutate(dialog.need, { ...patch, source: "operator" })} onCancel={() => { setDialog(null); setError(""); }} />}
    {dialog?.kind === "apply" && <ApplicationDialog need={dialog.need} tasks={tasks} busy={busy} error={error} onSave={patch => void mutate(dialog.need, { ...patch, source: "operator" })} onCancel={() => { setDialog(null); setError(""); }} />}
    <p className="text-xs text-slate-400">Only needs requiring action are shown here. Current checkpoint blockers come first, followed by other blockers and questions linked to unfinished work.</p>
    {!needs.length && <p className="text-xs text-slate-400">{active.length ? "No questions match this view." : "No needs require action right now."}</p>}
    <ul aria-label="Needs requiring action" className="space-y-4">{needs.map(renderNeed)}</ul>
    {!!completed.length && <details className="text-xs text-slate-400"><summary className="cursor-pointer">Completed needs ({completed.length})</summary><ul className="mt-3 space-y-4">{completed.map(renderNeed)}</ul></details>}
    {!!deferred.length && <details className="text-xs text-slate-400"><summary className="cursor-pointer">Deferred questions ({deferred.length})</summary><ul className="mt-3 space-y-4">{deferred.map(renderNeed)}</ul></details>}
    {!!historical.length && <details className="text-xs text-slate-400"><summary className="cursor-pointer">Superseded and dropped needs ({historical.length})</summary><ul className="mt-3 space-y-4">{historical.map(renderNeed)}</ul></details>}
  </section>;
}
