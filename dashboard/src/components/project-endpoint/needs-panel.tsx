"use client";
import { useState } from "react";
import {
  getProject,
  type Project,
  type ProjectNeed,
} from "@/lib/nexus/projects";
import type { Task } from "@/lib/nexus/tasks";
import {
  addProjectNeed,
  patchProjectNeed,
  type ProjectNeedPatch,
} from "@/lib/nexus/project-needs";
import {
  canSatisfyNeed,
  knowledgeSatisfied,
  needPatch,
} from "@/lib/project-endpoint";
import { NeedEditor } from "./need-editor";
import { KnowledgeSearch } from "./knowledge-search";
import { buttonClass, EvidenceRef, Status } from "./fields";

export function ProjectNeedsPanel({
  project,
  tasks,
  onUpdate,
}: {
  project: Project;
  tasks: Task[];
  onUpdate: (project: Project) => void;
}) {
  const [editing, setEditing] = useState<ProjectNeed | null>(null);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needs = (project.needs ?? []).filter(
    (n) => !filter || n.knowledge?.tags.includes(filter),
  );
  async function mutate(need: ProjectNeed, patch: ProjectNeedPatch) {
    setBusy(true);
    setError("");
    try {
      if (need.id) await patchProjectNeed(project.id, need.id, patch);
      else await addProjectNeed(project.id, patch);
      setEditing(null);
      // A need response has a newer guard but no endpoint snapshot. Fetch the
      // complete card before exposing that guard to other project editors.
      try {
        onUpdate(await getProject(project.id));
      } catch {
        setError(
          "Need saved. Please reload the project to see the current endpoint and knowledge state.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save need");
    } finally {
      setBusy(false);
    }
  }
  function create(structured: boolean) {
    setError("");
    setEditing({
      id: "",
      kind: structured ? "information" : "capability",
      description: "",
      status: "open",
      created_at: new Date().toISOString(),
      source: "operator",
      ...(structured
        ? {
            knowledge: {
              question: "",
              tags: [],
              satisfaction_test: "",
              criterion_ids: [],
              task_ids: [],
              blocking: false,
              research_status: "open",
              evidence: [],
            },
          }
        : {}),
    });
  }
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-amber-900/40 bg-slate-900/40 p-5"
      aria-label="Project needs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-300">
          Needs & knowledge
        </h2>
        <div className="flex gap-2">
          <button
            disabled={!!editing || busy}
            className={buttonClass}
            onClick={() => create(true)}
          >
            Add question
          </button>
          <button
            disabled={!!editing || busy}
            className={buttonClass}
            onClick={() => create(false)}
          >
            Add need
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-amber-300">
          {error}
        </p>
      )}
      {filter && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          Showing #{filter} needs ({needs.length})
          <button className={buttonClass} onClick={() => setFilter("")}>
            Show all needs
          </button>
        </div>
      )}
      {query && (
        <KnowledgeSearch
          key={query}
          query={query}
          onClose={() => setQuery("")}
        />
      )}
      {editing && (
        <NeedEditor
          key={editing.id || "new"}
          need={editing}
          project={project}
          tasks={tasks}
          busy={busy}
          onCancel={() => {
            setEditing(null);
            setError("");
          }}
          onSave={(draft) => {
            const patch = editing.id ? needPatch(editing, draft) : draft;
            if (!Object.keys(patch).length) {
              setEditing(null);
              return;
            }
            void mutate(editing, { ...patch, source: "operator" });
          }}
        />
      )}
      {!needs.length && (
        <p className="text-xs text-slate-400">
          {filter
            ? "No needs match this tag."
            : "No needs declared. Add a question with an acceptance test or another missing resource."}
        </p>
      )}
      <ul className="space-y-3">
        {needs.map((need) => {
          const k = need.knowledge;
          return (
            <li
              key={need.id}
              className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] text-slate-500">
                  {need.kind} · {need.id}
                </span>
                <Status
                  value={
                    need.status === "met"
                      ? !k ||
                        knowledgeSatisfied(need, project.end_state_updated_at)
                        ? "satisfied"
                        : "needs review"
                      : need.status === "dropped"
                        ? "dropped"
                        : (k?.research_status ?? "open")
                  }
                />
                {k?.blocking && (
                  <span className="text-amber-300">Blocking</span>
                )}
              </div>
              <h3 className="text-sm text-slate-200">
                {k?.question || need.description}
              </h3>
              {k && (
                <>
                  {need.description !== k.question && (
                    <p className="text-slate-500">{need.description}</p>
                  )}
                  <p className="text-slate-400">
                    <span className="text-slate-500">Satisfied when: </span>
                    {k.satisfaction_test}
                  </p>
                  {!!k.tags.length && (
                    <div className="flex flex-wrap gap-1">
                      {k.tags.map((tag) => (
                        <button
                          key={tag}
                          disabled={busy}
                          onClick={() => {
                            setFilter(tag);
                            setQuery(tag);
                          }}
                          className="rounded border border-cyan-900/50 px-2 py-1 text-cyan-300 hover:bg-cyan-950"
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  )}
                  {k.review_reason && (
                    <p className="text-amber-300">
                      Review needed: {k.review_reason}
                    </p>
                  )}
                  {(k.criterion_ids.length > 0 || k.task_ids.length > 0) && (
                    <div className="flex flex-wrap gap-2 text-slate-500">
                      {k.criterion_ids.map((id) => (
                        <span key={id}>
                          Criterion:{" "}
                          {project.end_state_criteria?.find((c) => c.id === id)
                            ?.description || id}
                        </span>
                      ))}
                      {k.task_ids.map((id) => (
                        <a
                          key={id}
                          href={`/task/${encodeURIComponent(id)}`}
                          className="text-cyan-400 underline"
                        >
                          {tasks.find((t) => t.id === id)?.title || id}
                        </a>
                      ))}
                    </div>
                  )}
                  {(k.answer || k.evidence.length > 0) && (
                    <details>
                      <summary className="cursor-pointer text-slate-300">
                        Answer & evidence ({k.evidence.length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        <p className="whitespace-pre-wrap text-slate-300">
                          {k.answer || "No answer recorded."}
                        </p>
                        <ul className="space-y-2">
                          {k.evidence.map((e, i) => (
                            <li key={i}>
                              <EvidenceRef refValue={e.ref} />
                              {e.summary && (
                                <p className="text-slate-400">{e.summary}</p>
                              )}
                              {e.checked_at && (
                                <p className="text-slate-500">
                                  Checked{" "}
                                  {new Date(e.checked_at).toLocaleString()}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  )}
                  {k.verified_at && (
                    <p className="text-slate-500">
                      Last verified {new Date(k.verified_at).toLocaleString()}{" "}
                      by {k.verified_by || "unknown"}
                      {!knowledgeSatisfied(need, project.end_state_updated_at)
                        ? " · historical verification"
                        : ""}
                    </p>
                  )}
                  {k.application && (
                    <p className="text-slate-400">
                      Application: {k.application.status}
                      {k.application.at
                        ? ` · ${new Date(k.application.at).toLocaleString()}`
                        : ""}
                      {k.application.task_id
                        ? ` · task ${k.application.task_id}`
                        : ""}
                      {k.application.notes ? ` · ${k.application.notes}` : ""}
                      {k.application.evidence_ref && (
                        <>
                          {" "}
                          ·{" "}
                          <EvidenceRef refValue={k.application.evidence_ref} />
                        </>
                      )}
                    </p>
                  )}
                </>
              )}
              {need.notes && (
                <p className="whitespace-pre-wrap text-slate-500">
                  {need.notes}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  disabled={busy || !!editing}
                  className={buttonClass}
                  onClick={() => {
                    setEditing(structuredClone(need));
                    setError("");
                  }}
                >
                  Edit need
                </button>
                {need.status === "open" ? (
                  <>
                    <button
                      disabled={busy || !!editing || !canSatisfyNeed(need)}
                      title={
                        !canSatisfyNeed(need)
                          ? "Record an answer and evidence before satisfying this need"
                          : undefined
                      }
                      className={buttonClass}
                      onClick={() =>
                        void mutate(need, { status: "met", source: "operator" })
                      }
                    >
                      {k ? "Satisfy" : "Mark met"}
                    </button>
                    <button
                      disabled={busy || !!editing}
                      className={buttonClass}
                      onClick={() =>
                        void mutate(need, {
                          status: "dropped",
                          source: "operator",
                        })
                      }
                    >
                      Drop
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy || !!editing}
                    className={buttonClass}
                    onClick={() =>
                      void mutate(need, { status: "open", source: "operator" })
                    }
                  >
                    Reopen
                  </button>
                )}
                {k && (
                  <button
                    className={buttonClass}
                    onClick={() =>
                      setQuery(`${k.question} ${k.tags.join(" ")}`.trim())
                    }
                  >
                    Search question
                  </button>
                )}
              </div>
              {k && need.status === "open" && !canSatisfyNeed(need) && (
                <p className="text-[11px] text-slate-500">
                  An answer and evidence reference are required before
                  satisfaction.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
