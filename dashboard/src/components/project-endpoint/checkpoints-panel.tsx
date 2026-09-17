"use client";
/**
 * Ordered checkpoints under the long-term goal (docs/project-checkpoints.md).
 * Shows what the project is working toward now, the progress through the
 * sequence, upcoming checkpoints and the retained evidence of completed ones,
 * and lets the operator author or reorder the sequence. Completion is never
 * written from here: TheNexus advances a checkpoint only from verified
 * evidence submitted by Praxis through the transition endpoint.
 */
import { useState } from "react";
import {
  CheckpointDefinitionSchema,
  EndStateCriterionSchema,
  type Checkpoint,
} from "@praxis/contract";
import {
  updateProject,
  reopenProjectCheckpoint,
  type Project,
  type EndStateCriterion,
  type CheckpointDefinitionInput,
} from "@/lib/nexus/projects";
import {
  checkpointView,
  checkpointVerdict,
  checkpointResults,
  checkpointNeeds,
} from "@/lib/project-checkpoints";
import { CriteriaEditor } from "./criteria-editor";
import { buttonClass, inputClass, Field, EvidenceRef, Status } from "./fields";

const MAX_CHECKPOINTS = 30;

interface DraftCheckpoint {
  key: string;
  id?: string;
  title: string;
  goal: string;
  criteria: EndStateCriterion[];
  need_ids: string[];
}

function toDraft(checkpoint: Checkpoint): DraftCheckpoint {
  return {
    key: checkpoint.id,
    id: checkpoint.id,
    title: checkpoint.title,
    goal: checkpoint.goal ?? "",
    criteria: structuredClone(checkpoint.criteria ?? []) as EndStateCriterion[],
    need_ids: [...(checkpoint.need_ids ?? [])],
  };
}

function newDraft(): DraftCheckpoint {
  return { key: crypto.randomUUID(), title: "", goal: "", criteria: [], need_ids: [] };
}

function definitionOf(draft: DraftCheckpoint): CheckpointDefinitionInput {
  const { key, ...definition } = draft;
  void key;
  return definition;
}

const when = (value?: string | null) => (value ? new Date(value).toLocaleString() : "");

const eventLabels: Record<string, string> = {
  completed: "Verified",
  reopened: "Reopened",
  definition_changed: "Definition changed",
  archived: "Archived",
  restored: "Restored",
};

function CriteriaList({ checkpoint }: { checkpoint: Checkpoint }) {
  const results = checkpointResults(checkpoint);
  const criteria = checkpoint.criteria ?? [];
  if (!criteria.length)
    return (
      <p className="mt-2 text-xs text-amber-300">
        No acceptance criteria: this checkpoint cannot be verified until criteria are added.
      </p>
    );
  return (
    <ul className="mt-2 space-y-1.5">
      {criteria.map((c) => {
        const result = results.get(c.id);
        const evidence = result?.evidence_ref || c.observation?.evidence_ref || "";
        return (
          <li key={c.id} className="flex flex-wrap items-start gap-2 text-xs">
            <Status value={c.enabled === false ? "disabled" : (result?.status ?? "unknown")} />
            <span className="min-w-0 flex-1 break-words text-slate-200">
              {c.description}
              <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                {c.kind} · {c.id}
              </span>
              {result?.detail && (
                <span className="block text-slate-400">
                  {result.detail}
                  {result.checked_at ? ` · checked ${when(result.checked_at)}` : ""}
                </span>
              )}
              {evidence && (
                <span className="block">
                  <EvidenceRef refValue={evidence} />
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function History({ checkpoint }: { checkpoint: Checkpoint }) {
  if (!checkpoint.history?.length) return null;
  return <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">Evidence history ({checkpoint.history.length})</summary>
    <ul className="mt-2 space-y-2">{checkpoint.history.map((event, i) => <li key={i} className="break-words">
      {when(event.at)} · {eventLabels[event.kind] ?? event.kind}{event.reason ? ` · ${event.reason}` : ""}
      {event.definition && <p>{event.definition.title}: {event.definition.goal}</p>}
      {event.definition?.criteria.map(c => <p key={c.id}>{c.description}{c.observation?.evidence_ref && <> · <EvidenceRef refValue={c.observation.evidence_ref} /></>}</p>)}
      {event.assessment?.results.map(r => <p key={r.id}>{r.description || r.id}: {r.status} · {r.detail}{r.evidence_ref && <> · <EvidenceRef refValue={r.evidence_ref} /></>}</p>)}
    </li>)}</ul>
  </details>;
}

function VerdictLine({ checkpoint }: { checkpoint: Checkpoint }) {
  const verdict = checkpointVerdict(checkpoint);
  const tone =
    verdict.verdict === "verified"
      ? "text-emerald-300"
      : verdict.verdict === "recorded"
        ? "text-amber-300"
        : "text-slate-300";
  return (
    <p className="mt-2 text-xs">
      <span className={`font-semibold ${tone}`}>{verdict.label}</span>
      <span className="text-slate-400"> · {verdict.detail}</span>
    </p>
  );
}

function NeedsList({ checkpoint, project }: { checkpoint: Checkpoint; project: Project }) {
  const needs = checkpointNeeds(checkpoint, project);
  if (!needs.length) return null;
  return (
    <div className="mt-2 text-xs">
      <div className="text-slate-500">Required knowledge for this checkpoint</div>
      <ul className="mt-1 space-y-1">
        {needs.map(({ need, satisfied }) => (
          <li key={need.id} className="flex flex-wrap items-start gap-2">
            <Status value={satisfied ? "satisfied" : "unresolved"} />
            <span className="min-w-0 flex-1 break-words text-slate-300">
              {need.knowledge?.question || need.description}
              <span className="ml-1 font-mono text-[10px] text-slate-500">{need.id}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectCheckpointsPanel({
  project,
  onUpdate,
}: {
  project: Project;
  onUpdate: (project: Project) => void;
}) {
  const [draftBase, setDraftBase] = useState<Project | null>(null);
  const [drafts, setDrafts] = useState<DraftCheckpoint[] | null>(null);
  const [reopening, setReopening] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const view = checkpointView(project);
  const needOptions = (project.needs ?? []).filter(
    (n) => n.kind === "information" && n.status !== "dropped" && n.knowledge,
  );

  async function run(action: () => Promise<Project>) {
    setBusy(true);
    setError("");
    try {
      const updated = await action();
      onUpdate(updated);
      setDrafts(null);
      setReopening(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save checkpoints");
    } finally {
      setBusy(false);
    }
  }

  function update(index: number, patch: Partial<DraftCheckpoint>) {
    if (!drafts) return;
    setDrafts(drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function move(index: number, delta: number) {
    if (!drafts) return;
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    [next[index], next[target]] = [next[target], next[index]];
    setDrafts(next);
  }

  function saveDrafts(e: React.FormEvent) {
    e.preventDefault();
    if (!drafts) return;
    for (const [index, draft] of drafts.entries()) {
      const parsed = CheckpointDefinitionSchema.safeParse({
        ...definitionOf(draft),
        id: draft.id ?? "new",
      });
      const invalidCriterion = draft.criteria
        .map((c) => EndStateCriterionSchema.safeParse(c))
        .find((r) => !r.success);
      if (!parsed.success || invalidCriterion) {
        const issues = !parsed.success
          ? parsed.error.issues.map((i) => i.message)
          : invalidCriterion!.error!.issues.map((i) => i.message);
        setError(`Checkpoint ${index + 1}: ${issues.join("; ")}`);
        return;
      }
    }
    void run(() =>
      updateProject(project.id, {
        checkpoints: drafts.map(definitionOf),
        expected_checkpoints_revision: draftBase?.checkpoints?.revision ?? null,
        expected_updated_at: draftBase?.updated_at,
        end_state_source: "operator",
      }),
    );
  }

  const longTermGoal = project.end_state?.trim() || "No long-term goal declared.";

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-cyan-900/50 bg-slate-900/40 p-4 sm:p-5"
      aria-label="Project checkpoints"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-cyan-300">
          Checkpoints
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {view.total > 0 && (
            <span className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase text-slate-300">
              {view.completed.length} of {view.total} verified
            </span>
          )}
          {!drafts && (
            <button
              className={buttonClass}
              onClick={() => {
                setDraftBase(structuredClone(project));
                setDrafts(view.active.map(toDraft));
                setError("");
              }}
            >
              {view.total ? "Edit checkpoints" : "Add checkpoints"}
            </button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Long-term goal
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">{longTermGoal}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-amber-300">
          {error}
        </p>
      )}

      {drafts ? (
        <form onSubmit={saveDrafts} className="space-y-4">
          <p className="text-xs text-slate-400">
            Order matters: the first unverified checkpoint is the effective endpoint. Changing a
            checkpoint&apos;s goal, criteria or required knowledge returns it to unverified and keeps
            its earlier evidence as history. Removed checkpoints are archived with their evidence.
          </p>
          {drafts.length === 0 && (
            <p className="text-xs text-slate-400">No checkpoints yet. Add the first one below.</p>
          )}
          {drafts.map((draft, index) => (
            <fieldset
              key={draft.key}
              data-checkpoint={draft.key}
              className="space-y-3 rounded-lg border border-slate-800 p-3"
            >
              <legend className="px-1 font-mono text-xs text-slate-500">
                Checkpoint {index + 1}
                {draft.id ? ` · ${draft.id}` : " · new"}
              </legend>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Field label="Checkpoint title">
                  <input
                    required
                    className={inputClass}
                    value={draft.title}
                    onChange={(e) => update(index, { title: e.target.value })}
                  />
                </Field>
                <Field label="Checkpoint goal (what is observably true when it is reached)">
                  <textarea
                    rows={2}
                    className={inputClass}
                    value={draft.goal}
                    onChange={(e) => update(index, { goal: e.target.value })}
                  />
                </Field>
              </div>
              <CriteriaEditor
                criteria={draft.criteria}
                onChange={(criteria) => update(index, { criteria })}
              />
              {needOptions.length > 0 && (
                <div className="space-y-1 text-xs text-slate-400">
                  <div>Required knowledge for this checkpoint</div>
                  {needOptions.map((n) => (
                    <label key={n.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={draft.need_ids.includes(n.id)}
                        onChange={(e) =>
                          update(index, {
                            need_ids: e.target.checked
                              ? [...draft.need_ids, n.id]
                              : draft.need_ids.filter((id) => id !== n.id),
                          })
                        }
                      />
                      <span className="min-w-0 break-words">
                        {n.knowledge?.question || n.description}
                        {n.knowledge?.blocking ? " · blocking" : " · optional"}
                        <span className="ml-1 font-mono text-[10px] text-slate-500">{n.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={drafts.length >= MAX_CHECKPOINTS}
              onClick={() => setDrafts([...drafts, newDraft()])}
            >
              Add checkpoint
            </button>
            <button disabled={busy} className={buttonClass}>
              Save checkpoints
            </button>
            <button
              type="button"
              disabled={busy}
              className={buttonClass}
              onClick={() => {
                setDrafts(null);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {view.phase === "none" && (
            <p className="text-sm text-slate-400">
              No checkpoints defined. The long-term goal is the effective endpoint until a
              checkpoint sequence is adopted.
            </p>
          )}

          {view.phase === "current" && view.current && (
            <div className="rounded-lg border border-cyan-700/60 bg-cyan-950/20 p-4">
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-cyan-300">
                <span>Working toward now</span>
                <span className="font-mono text-cyan-500/80">
                  checkpoint {view.position} of {view.total}
                </span>
              </div>
              <h3 className="mt-1 break-words text-base font-semibold text-white">
                {view.current.title}
              </h3>
              {view.current.goal && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">
                  {view.current.goal}
                </p>
              )}
              <VerdictLine checkpoint={view.current} />
              <CriteriaList checkpoint={view.current} />
              <NeedsList checkpoint={view.current} project={project} />
              <History checkpoint={view.current} />
            </div>
          )}

          {view.phase === "complete" && (
            <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-4 text-sm">
              <div className="font-semibold text-emerald-300">
                All {view.total} checkpoints verified
                {project.checkpoints?.sequence_completed_at
                  ? ` on ${when(project.checkpoints.sequence_completed_at)}`
                  : ""}
              </div>
              <p className="mt-1 text-xs text-slate-300">
                {view.finalGoal.achieved
                  ? "Final goal verified against its own criteria."
                  : view.finalGoal.assessed
                    ? "Final goal not yet verified: its criteria are evaluated separately from the checkpoints."
                    : "Final goal not yet verified: awaiting an evaluation of the long-term criteria."}
              </p>
            </div>
          )}

          {view.upcoming.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Upcoming
              </div>
              <ol className="mt-1 space-y-1 text-xs text-slate-400">
                {view.upcoming.map((cp) => (
                  <li key={cp.id} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-slate-600">
                      {view.active.findIndex((c) => c.id === cp.id) + 1}.
                    </span>
                    <span className="min-w-0 break-words text-slate-300">{cp.title}</span>
                    <span className="text-slate-600">
                      {(cp.criteria ?? []).filter((c) => c.enabled !== false).length} criteria
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {view.completed.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Completed
              </div>
              <ul className="mt-1 space-y-2">
                {view.completed.map((cp) => (
                  <li key={cp.id}>
                    <details className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs">
                      <summary className="cursor-pointer text-slate-200">
                        <span className="font-mono text-slate-600">
                          {view.active.findIndex((c) => c.id === cp.id) + 1}.
                        </span>{" "}
                        {cp.title}
                        <span className="ml-2 text-emerald-300">
                          {checkpointVerdict(cp).label}
                        </span>
                      </summary>
                      {cp.goal && (
                        <p className="mt-2 whitespace-pre-wrap break-words text-slate-400">{cp.goal}</p>
                      )}
                      <CriteriaList checkpoint={cp} />
                      <History checkpoint={cp} />
                      {cp.history.length > 0 && (
                        <ul className="mt-2 space-y-0.5 text-slate-500">
                          {cp.history.map((event, i) => (
                            <li key={i}>
                              {when(event.at)} · {eventLabels[event.kind] ?? event.kind}
                              {event.source ? ` · ${event.source}` : ""}
                              {event.reason ? ` · ${event.reason}` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                      {reopening?.id === cp.id ? (
                        <div className="mt-2 space-y-2">
                          <p className="text-slate-400">
                            Reopening makes this the current checkpoint again. Its completion
                            evidence stays in the history.
                          </p>
                          <Field label="Why is this checkpoint being reopened?">
                            <input
                              className={inputClass}
                              value={reopening.reason}
                              onChange={(e) => setReopening({ id: cp.id, reason: e.target.value })}
                            />
                          </Field>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              className={buttonClass}
                              onClick={() =>
                                void run(() =>
                                  reopenProjectCheckpoint(project.id, cp.id, {
                                    reason: reopening.reason.trim() || undefined,
                                    expected_checkpoints_revision:
                                      project.checkpoints?.revision ?? null,
                                  }),
                                )
                              }
                            >
                              Confirm reopen
                            </button>
                            <button
                              type="button"
                              className={buttonClass}
                              onClick={() => setReopening(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`${buttonClass} mt-2`}
                          onClick={() => setReopening({ id: cp.id, reason: "" })}
                        >
                          Reopen checkpoint
                        </button>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.archived.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">
                Archived checkpoints ({view.archived.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {view.archived.map((cp) => (
                  <li key={cp.id} className="break-words">
                    {cp.title}
                    {cp.archived_at ? ` · archived ${when(cp.archived_at)}` : ""}
                    {cp.completion ? ` · was verified ${when(cp.completion.at)}` : ""}
                    <CriteriaList checkpoint={cp} />
                    <History checkpoint={cp} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
