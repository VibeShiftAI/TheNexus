"use client";
import { useState } from "react";
import { ProjectNeedSchema, type KnowledgeNeed } from "@praxis/contract";
import type { Project, ProjectNeed } from "@/lib/nexus/projects";
import type { Task } from "@/lib/nexus/tasks";
import { buttonClass, inputClass, Field } from "./fields";

function emptyKnowledge(question: string): KnowledgeNeed {
  return {
    question,
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
  const [draft, setDraft] = useState(() => structuredClone(need));
  const [tags, setTags] = useState((need.knowledge?.tags ?? []).join(", "));
  const [taskIds, setTaskIds] = useState(
    (need.knowledge?.task_ids ?? []).join(", "),
  );
  const [error, setError] = useState("");
  const k = draft.knowledge;
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
        {need.id ? "Edit need" : "Add need"}
      </h3>
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
            setDraft({ ...draft, kind: e.target.value as ProjectNeed["kind"] })
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
            setDraft({ ...draft, knowledge: emptyKnowledge(draft.description) })
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
            {(project.end_state_criteria ?? []).map((c) => (
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
            {!project.end_state_criteria?.length && (
              <p className="text-xs text-slate-500">
                No endpoint criteria yet.
              </p>
            )}
            {k.criterion_ids
              .filter(
                (id) => !project.end_state_criteria?.some((c) => c.id === id),
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
              {["open", "researching", "evidence_ready", "stale"].map((s) => (
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
          <details
            className="space-y-3 text-xs text-slate-400"
            open={!!k.application}
          >
            <summary className="cursor-pointer">Application feedback</summary>
            <Field label="Application outcome">
              <select
                className={inputClass}
                value={k.application?.status ?? "untried"}
                onChange={(e) =>
                  knowledge({
                    application: {
                      ...k.application,
                      status: e.target.value as NonNullable<
                        KnowledgeNeed["application"]
                      >["status"],
                      at: new Date().toISOString(),
                    },
                  })
                }
              >
                {["untried", "successful", "insufficient", "outdated"].map(
                  (status) => (
                    <option key={status}>{status}</option>
                  ),
                )}
              </select>
            </Field>
            {(["task_id", "evidence_ref", "notes", "at"] as const).map(
              (key) => (
                <Field
                  key={key}
                  label={
                    {
                      task_id: "Application task ID",
                      evidence_ref: "Application evidence reference",
                      notes: "Application notes",
                      at: "Applied at (ISO date and time)",
                    }[key]
                  }
                >
                  <input
                    className={inputClass}
                    value={k.application?.[key] ?? ""}
                    onChange={(e) =>
                      knowledge({
                        application: {
                          status: "untried",
                          ...k.application,
                          [key]:
                            (key === "at" || key === "evidence_ref") &&
                            !e.target.value
                              ? undefined
                              : e.target.value,
                        },
                      })
                    }
                  />
                </Field>
              ),
            )}
            <p>
              Insufficient or outdated application reopens this need as stale
              and preserves its previous evidence.
            </p>
          </details>
          <p className="text-xs text-slate-400">
            Save the answer and evidence, then explicitly satisfy the need.
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
          Save need
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
