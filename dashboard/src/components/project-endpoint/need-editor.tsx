"use client";
import { useState, useEffect, useRef, type ReactNode } from "react";
import { ProjectNeedSchema, type KnowledgeNeed, type KnowledgeApplication } from "@praxis/contract";
import type { Project, ProjectNeed } from "@/lib/nexus/projects";
import type { Task } from "@/lib/nexus/tasks";
import { verificationPatch, applicationPatch, knowledgeLifecycle, hasAppliedKnowledge, appliedKnowledgeChanged } from "@/lib/project-endpoint";
import type { ProjectNeedPatch } from "@/lib/nexus/project-needs";
import { buttonClass, inputClass, Field, EvidenceRef } from "./fields";

function emptyKnowledge(question: string): KnowledgeNeed {
  return {
    question,
    purpose: "", resolution: { method: "existing_knowledge" },
    tags: [],
    satisfaction_test: "",
    criterion_ids: [],
    task_ids: [],
    blocking: false,
    research_status: "open",
    evidence: [],
  };
}

export function NeedEditor({
  need,
  project,
  tasks,
  busy,
  onSave,
  onCancel,
}: {
  need: ProjectNeed;
  project: Project;
  tasks: Task[];
  busy: boolean;
  onSave: (need: ProjectNeed) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => need.kind === "information" && !need.knowledge ? { ...structuredClone(need), status: "open" as const, knowledge: emptyKnowledge("") } : structuredClone(need));
  const [tags, setTags] = useState((need.knowledge?.tags ?? []).join(", "));
  const [taskIds, setTaskIds] = useState(
    (need.knowledge?.task_ids ?? []).join(", "),
  );
  const [error, setError] = useState("");
  const k = draft.knowledge;
  const criteria = [...(project.end_state_criteria ?? []), ...(project.checkpoints?.items ?? []).flatMap(cp => cp.criteria)];
  function knowledge(patch: Partial<KnowledgeNeed>) {
    setDraft({ ...draft, knowledge: { ...k!, ...patch } });
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = {
      ...draft,
      ...(k
        ? {
            knowledge: {
              ...k,
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              task_ids: taskIds
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            },
          }
        : {}),
    };
    if (candidate.kind === "information" && (!k?.purpose?.trim() || !k.resolution)) { setError("Record why this question matters and choose its resolution route."); return; }
    const parsed = ProjectNeedSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
      return;
    }
    onSave({
      ...candidate,
      ...parsed.data,
      ...(candidate.knowledge
        ? { knowledge: { ...candidate.knowledge, ...parsed.data.knowledge } }
        : {}),
    });
  }
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-amber-900/60 bg-slate-950/70 p-4"
    >
      <h3 className="text-sm font-semibold text-amber-300">
        {hasAppliedKnowledge(need) ? "Revise applied answer" : need.id ? "Edit need" : "Add need"}
      </h3>
      {hasAppliedKnowledge(need) && <p className="text-xs text-amber-200">This answer has already been applied. Changing the question, answer, evidence, satisfaction test or acceptance links saves a new revision and updates affected tasks that have never run. Started or completed work gets a new follow-up task. The revised answer needs verification before it is used.</p>}
      {need.kind === "information" && !need.knowledge && <p className="text-xs text-amber-200">Legacy information need: clarify one answerable question. Its description and notes are retained.</p>}
      {error && (
        <p role="alert" className="text-xs text-amber-300">
          {error}
        </p>
      )}
      <Field label="Need description">
        <textarea
          required
          className={inputClass}
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </Field>
      <Field label="Need kind">
        <select
          className={inputClass}
          disabled={!!k}
          value={draft.kind}
          onChange={(e) =>
            setDraft({ ...draft, kind: e.target.value as ProjectNeed["kind"], ...(e.target.value === "information" ? { knowledge: emptyKnowledge("") } : {}) })
          }
        >
          {[
            "capability",
            "resource",
            "credential",
            "decision",
            "information",
          ].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
      </Field>
      {draft.kind === "information" && !k && (
        <button
          type="button"
          className={buttonClass}
          onClick={() =>
            setDraft({ ...draft, knowledge: emptyKnowledge("") })
          }
        >
          Define knowledge question
        </button>
      )}
      {k && (
        <>
          <Field label="Knowledge question">
            <textarea
              required
              className={inputClass}
              rows={2}
              value={k.question}
              onChange={(e) => knowledge({ question: e.target.value })}
            />
          </Field>
          <Field label="Why this question matters">
            <textarea required className={inputClass} rows={2} value={k.purpose ?? ""} onChange={e => knowledge({ purpose: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Resolution route"><select required className={inputClass} value={k.resolution?.method ?? ""} onChange={e => knowledge({ resolution: { ...k.resolution, method: e.target.value as NonNullable<KnowledgeNeed["resolution"]>["method"] } })}><option value="" disabled>Choose a route</option>{Object.entries(resolutionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            <Field label="Responsible owner"><input className={inputClass} value={k.resolution?.owner ?? ""} onChange={e => knowledge({ resolution: { method: "existing_knowledge", ...k.resolution, owner: e.target.value } })} /></Field>
          </div>
          <Field label="Next action"><textarea className={inputClass} rows={2} value={k.resolution?.next_action ?? ""} onChange={e => knowledge({ resolution: { method: "existing_knowledge", ...k.resolution, next_action: e.target.value } })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Question group"><input className={inputClass} value={k.group ?? ""} onChange={e => knowledge({ group: e.target.value })} /></Field>
            <Field label="Deferred until (ISO date and time)"><input className={inputClass} placeholder="2026-10-20T12:00:00Z" value={k.deferred_until ?? ""} onChange={e => knowledge({ deferred_until: e.target.value || new Date().toISOString() })} /></Field>
          </div>
          <Field label="Defer until this condition is met"><input className={inputClass} value={k.deferred_reason ?? ""} onChange={e => knowledge({ deferred_reason: e.target.value })} /></Field>
          {(k.deferred_reason?.trim() || (k.deferred_until && Date.parse(k.deferred_until) > Date.now())) && <button type="button" className={buttonClass} onClick={() => knowledge({ deferred_until: new Date().toISOString(), deferred_reason: "" })}>Resume now</button>}
          <Field label="Satisfaction test">
            <textarea
              required
              className={inputClass}
              rows={2}
              value={k.satisfaction_test}
              onChange={(e) => knowledge({ satisfaction_test: e.target.value })}
            />
          </Field>
          <Field label="Knowledge tags (comma separated)">
            <input
              className={inputClass}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="#recovery, database"
            />
          </Field>
          <p className="text-xs text-slate-500">
            Question tags are searchable and separate from project topic tags.
          </p>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs text-slate-400">
              Linked criteria
            </legend>
            {criteria.map((c) => (
              <label
                key={c.id}
                className="flex items-start gap-2 text-xs text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={k.criterion_ids.includes(c.id)}
                  onChange={(e) =>
                    knowledge({
                      criterion_ids: e.target.checked
                        ? [...k.criterion_ids, c.id]
                        : k.criterion_ids.filter((id) => id !== c.id),
                    })
                  }
                />
                {c.description}{" "}
                <span className="font-mono text-slate-500">{c.id}</span>
              </label>
            ))}
            {!criteria.length && (
              <p className="text-xs text-slate-500">
                No endpoint criteria yet.
              </p>
            )}
            {k.criterion_ids
              .filter(
                (id) => !criteria.some((c) => c.id === id),
              )
              .map((id) => (
                <label
                  key={id}
                  className="flex items-center gap-2 text-xs text-amber-300"
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      knowledge({
                        criterion_ids: k.criterion_ids.filter((c) => c !== id),
                      })
                    }
                  />
                  Removed criterion: {id} (uncheck to unlink)
                </label>
              ))}
          </fieldset>
          <Field label="Dependent task IDs (comma separated)">
            <input
              className={inputClass}
              value={taskIds}
              onChange={(e) => setTaskIds(e.target.value)}
              list={`need-tasks-${need.id}`}
            />
          </Field>
          <datalist id={`need-tasks-${need.id}`}>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </datalist>
          <label className="flex items-center gap-2 text-xs text-amber-200">
            <input
              type="checkbox"
              checked={k.blocking}
              onChange={(e) => knowledge({ blocking: e.target.checked })}
            />
            Blocking knowledge — required for endpoint readiness
          </label>
          <Field label="Research state">
            <select
              className={inputClass}
              value={k.research_status}
              onChange={(e) =>
                knowledge({
                  research_status: e.target
                    .value as KnowledgeNeed["research_status"],
                })
              }
            >
              {["open", "researching", "evidence_received", "awaiting_answer", "evidence_ready", "stale"].map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Answer">
            <textarea
              className={inputClass}
              rows={4}
              value={k.answer ?? ""}
              onChange={(e) => knowledge({ answer: e.target.value })}
            />
          </Field>
          <div className="space-y-3">
            <div className="flex justify-between">
              <h4 className="text-xs font-semibold text-slate-300">
                Evidence references
              </h4>
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  knowledge({ evidence: [...k.evidence, { ref: "" }] })
                }
              >
                Add evidence
              </button>
            </div>
            {k.evidence.map((evidence, index) => (
              <div
                key={index}
                className="space-y-2 rounded border border-slate-800 p-3"
              >
                {(["ref", "summary", "checked_at"] as const).map((key) => (
                  <Field
                    key={key}
                    label={
                      {
                        ref: "Reference (URL, document or artifact)",
                        summary: "Evidence summary",
                        checked_at: "Checked at (ISO date and time, optional)",
                      }[key]
                    }
                  >
                    <input
                      required={key === "ref"}
                      className={inputClass}
                      value={evidence[key] ?? ""}
                      onChange={(e) =>
                        knowledge({
                          evidence: k.evidence.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  [key]:
                                    key === "checked_at" && !e.target.value
                                      ? undefined
                                      : e.target.value,
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                ))}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    knowledge({
                      evidence: k.evidence.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove evidence
                </button>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            Save the answer and evidence, then use Verify answer to explain how they meet the satisfaction test.
            Changes to verified answers or acceptance scope require another
            review.
          </p>
        </>
      )}
      <Field label="Notes">
        <textarea
          className={inputClass}
          rows={2}
          value={draft.notes ?? ""}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </Field>
      <div className="flex gap-2">
        <button className={buttonClass} disabled={busy}>
          {appliedKnowledgeChanged(need, draft) ? "Save revision & update work" : "Save need"}
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}


export const resolutionLabels: Record<NonNullable<KnowledgeNeed["resolution"]>["method"], string> = {
  existing_knowledge: "Review existing knowledge", research: "Research", experiment: "Experiment", human: "Human answer", decision: "Decision", acceptance: "Version acceptance",
};

function ReviewDialog({ title, busy, error, onCancel, children }: { title: string; busy: boolean; error: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("textarea, select, input, button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div role="dialog" aria-modal="true" aria-label={title} ref={ref} className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-xl" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); }
      if (event.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? [])];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <h3 className="mb-3 text-lg font-semibold text-slate-100">{title}</h3>
      {error && <p role="alert" className="mb-3 text-sm text-amber-300">{error} Your entries are still here.</p>}
      {children}
    </div>
  </div>;
}

export function VerificationDialog({ need, busy, error, onSave, onCancel }: { need: ProjectNeed; busy: boolean; error: string; onSave: (patch: ProjectNeedPatch) => void; onCancel: () => void }) {
  const [rationale, setRationale] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [localError, setLocalError] = useState("");
  const k = need.knowledge!;
  return <ReviewDialog title="Verify answer" busy={busy} error={error || localError} onCancel={onCancel}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); try { onSave(verificationPatch(need, rationale, selected)); } catch (e) { setLocalError((e as Error).message); } }}>
      <p className="whitespace-pre-wrap text-sm text-slate-200">{k.question}</p>
      <p className="text-sm text-slate-400">Enough evidence: {k.satisfaction_test}</p>
      {k.review_reason && <p className="text-sm text-amber-300">Review needed: {k.review_reason}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-label="Answer to verify"><h4 className="mb-2 text-sm text-slate-400">Saved answer · revision {k.revision ?? 0}</h4><p className="whitespace-pre-wrap text-sm text-slate-200">{k.answer}</p></section>
        <fieldset aria-label="Evidence for verification" className="space-y-3"><legend className="mb-2 text-sm text-slate-400">Select supporting evidence</legend>{k.evidence.map(e => <div key={e.ref}><label className="flex items-start gap-2 text-sm text-slate-200"><input type="checkbox" checked={selected.includes(e.ref)} onChange={event => setSelected(event.target.checked ? [...selected, e.ref] : selected.filter(ref => ref !== e.ref))} /><span className="break-all">{e.summary || e.ref}</span></label><EvidenceRef refValue={e.ref} /></div>)}</fieldset>
      </div>
      <Field label="Verification rationale"><textarea required rows={3} className={inputClass} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Explain how these sources answer this question and meet the test, including why earlier gaps are resolved." /></Field>
      <div className="flex gap-2"><button className={buttonClass} disabled={busy || !rationale.trim() || !selected.length}>Confirm verification</button><button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>
  </ReviewDialog>;
}

export function ApplicationDialog({ need, tasks, busy, error, onSave, onCancel }: { need: ProjectNeed; tasks: Task[]; busy: boolean; error: string; onSave: (patch: ProjectNeedPatch) => void; onCancel: () => void }) {
  const k = need.knowledge!;
  const verified = knowledgeLifecycle(need).verified && k.verification?.revision === (k.revision ?? 0);
  const [application, setApplication] = useState<KnowledgeApplication>(() => ({ id: crypto.randomUUID(), task_id: k.task_ids[0] || "", status: verified ? "applied" : "ready", notes: "" }));
  const [localError, setLocalError] = useState("");
  const options = [...new Set([...k.task_ids, ...tasks.map(task => task.id)])];
  const positive = ["applied", "validated", "successful"].includes(application.status);
  return <ReviewDialog title="Apply to task" busy={busy} error={error || localError} onCancel={onCancel}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); try { onSave(applicationPatch(need, application)); } catch (e) { setLocalError((e as Error).message); } }}>
      <p className="text-sm text-slate-200">{k.question}</p>
      <p className="text-sm text-slate-400">Record how this answer affected a task. Each result is kept in application history.</p>
      {!verified && <p className="text-sm text-amber-300">Verify the current answer before recording applied or validated work.</p>}
      <Field label="Application task"><select required className={inputClass} value={application.task_id ?? ""} onChange={e => setApplication({ ...application, task_id: e.target.value })}><option value="">Choose a task</option>{options.map(id => <option key={id} value={id}>{tasks.find(t => t.id === id)?.title || id}</option>)}</select></Field>
      <Field label="Application outcome"><select className={inputClass} value={application.status} onChange={e => setApplication({ ...application, status: e.target.value as KnowledgeApplication["status"] })}>{["ready", "applied", "validated", "not_relevant", "insufficient", "outdated"].map(status => <option key={status} value={status} disabled={!verified && ["applied", "validated"].includes(status)}>{status.replaceAll("_", " ")}</option>)}</select></Field>
      <Field label="Application explanation"><textarea required className={inputClass} rows={3} value={application.notes ?? ""} onChange={e => setApplication({ ...application, notes: e.target.value })} /></Field>
      <Field label="Application evidence reference"><input required={positive} className={inputClass} value={application.evidence_ref ?? ""} onChange={e => setApplication({ ...application, evidence_ref: e.target.value || undefined })} /></Field>
      {["insufficient", "outdated"].includes(application.status) && <label className="flex items-start gap-2 text-sm text-amber-200"><input type="checkbox" checked={application.challenges_knowledge ?? false} onChange={e => setApplication({ ...application, challenges_knowledge: e.target.checked })} />This result challenges the answer itself and requires a new knowledge review.</label>}
      <div className="flex gap-2"><button className={buttonClass} disabled={busy || !application.task_id || !application.notes?.trim() || (positive && (!verified || !application.evidence_ref?.trim()))}>Record application</button><button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>
  </ReviewDialog>;
}
