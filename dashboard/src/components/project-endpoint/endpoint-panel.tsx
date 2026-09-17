"use client";
import { useState } from "react";
import {
  EndStateCriterionSchema,
  EndpointDefinitionSchema,
} from "@praxis/contract";
import { updateProject, type Project } from "@/lib/nexus/projects";
import { endpointReadiness, proposalAcceptance } from "@/lib/project-endpoint";
import { CriteriaEditor } from "./criteria-editor";
import { buttonClass, inputClass, Field, EvidenceRef, Status } from "./fields";

const boundaries = {
  beneficiary: "Beneficiary",
  scope: "Scope",
  exclusions: "Exclusions",
  resource_budget: "Resource budget",
  review_at: "Review date",
} as const;
const policies = {
  complete: "Complete",
  maintain: "Maintain",
  park: "Park",
  propose_next: "Propose next endpoint",
} as const;

export function ProjectEndpointPanel({
  project,
  onUpdate,
}: {
  project: Project;
  onUpdate: (project: Project) => void;
}) {
  const [draft, setDraft] = useState<Project | null>(null);
  const [reason, setReason] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readiness = endpointReadiness(project);
  async function save(updates: Parameters<typeof updateProject>[1]) {
    setBusy(true);
    setError("");
    try {
      const updated = await updateProject(project.id, updates);
      onUpdate(updated);
      setDraft(null);
      setAccepting(false);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save endpoint");
    } finally {
      setBusy(false);
    }
  }
  function saveDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const endpoint = EndpointDefinitionSchema.safeParse(draft.endpoint ?? {});
    const criteria = (draft.end_state_criteria ?? []).map((c) =>
      EndStateCriterionSchema.safeParse(c),
    );
    const invalid = criteria.find((c) => !c.success);
    if (!endpoint.success || invalid) {
      setError(
        !endpoint.success
          ? endpoint.error.issues.map((i) => i.message).join("; ")
          : invalid!.error!.issues.map((i) => i.message).join("; "),
      );
      return;
    }
    void save({
      end_state: draft.end_state,
      endpoint: endpoint.data,
      end_state_criteria: draft.end_state_criteria ?? [],
      expected_updated_at: draft.updated_at,
      end_state_source: "operator",
      end_state_reason:
        reason.trim() || "Endpoint definition or evidence updated",
    });
  }
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-cyan-900/50 bg-slate-900/40 p-5"
      aria-label="Project endpoint"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-cyan-300">
          Endpoint & evidence
        </h2>
        {!draft && (
          <button
            className={buttonClass}
            onClick={() => {
              setDraft(structuredClone(project));
              setError("");
            }}
          >
            Edit endpoint
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-amber-300">
          {error}
        </p>
      )}
      {draft ? (
        <form onSubmit={saveDraft} className="space-y-4">
          <Field label="Current endpoint">
            <textarea
              className={inputClass}
              rows={3}
              value={draft.end_state ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, end_state: e.target.value })
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(boundaries).map(([key, label]) => (
              <Field key={key} label={label}>
                <textarea
                  className={inputClass}
                  rows={2}
                  value={draft.endpoint?.[key as keyof typeof boundaries] ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      endpoint: {
                        completion_policy: "propose_next",
                        ...draft.endpoint,
                        [key]: e.target.value,
                      },
                    })
                  }
                />
              </Field>
            ))}
            <Field label="When achieved">
              <select
                className={inputClass}
                value={draft.endpoint?.completion_policy ?? "propose_next"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    endpoint: {
                      ...draft.endpoint,
                      completion_policy: e.target
                        .value as keyof typeof policies,
                    },
                  })
                }
              >
                {Object.entries(policies).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Proposed next endpoint (requires separate acceptance)">
            <textarea
              rows={2}
              className={inputClass}
              value={draft.endpoint?.proposed_next ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  endpoint: {
                    completion_policy: "propose_next",
                    ...draft.endpoint,
                    proposed_next: e.target.value,
                  },
                })
              }
            />
          </Field>
          <CriteriaEditor
            criteria={draft.end_state_criteria ?? []}
            onChange={(criteria) =>
              setDraft({ ...draft, end_state_criteria: criteria })
            }
          />
          <Field label="Reason for this revision">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <p className="text-xs text-slate-400">
            Changes invalidate the last assessment. Linked knowledge stays
            available and reopens for review.
          </p>
          <div className="flex gap-2">
            <button disabled={busy} className={buttonClass}>
              Save endpoint
            </button>
            <button
              type="button"
              disabled={busy}
              className={buttonClass}
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm text-slate-200">
            {project.end_state || "No endpoint declared."}
          </p>
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            {Object.entries(boundaries).map(
              ([key, label]) =>
                project.endpoint?.[key as keyof typeof boundaries] && (
                  <div key={key}>
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-slate-300">
                      {project.endpoint[key as keyof typeof boundaries]}
                    </dd>
                  </div>
                ),
            )}
            <div>
              <dt className="text-slate-500">When achieved</dt>
              <dd className="mt-1 text-slate-300">
                {
                  policies[
                    project.endpoint?.completion_policy ?? "propose_next"
                  ]
                }
              </dd>
            </div>
          </dl>
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs">
            <div className="font-semibold text-slate-200">
              {readiness.achieved
                ? "Endpoint achieved"
                : !readiness.criteria.length
                  ? "Not assessed — no enabled criteria"
                  : !readiness.current
                    ? "Awaiting evaluation"
                    : "Endpoint not yet achieved"}
            </div>
            <div className="mt-1 text-slate-400">
              Required knowledge: {readiness.required - readiness.unresolved}/
              {readiness.required} satisfied · {readiness.unresolved} unresolved
            </div>
            <div className="mt-1 text-slate-500">
              {project.end_state_assessment
                ? `Last evaluated ${new Date(project.end_state_assessment.evaluated_at).toLocaleString()}${readiness.current ? "" : " · previous revision"}`
                : "No assessment recorded."}
            </div>
          </div>
          <ul className="space-y-3">
            {(project.end_state_criteria ?? []).map((c) => {
              const result = readiness.results.get(c.id);
              return (
                <li
                  key={c.id}
                  className="space-y-1 border-l-2 border-slate-700 pl-3 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-200">{c.description}</span>
                    <Status
                      value={
                        c.enabled === false
                          ? "disabled"
                          : (result?.status ?? "unknown")
                      }
                    />
                    <span className="font-mono text-[10px] text-slate-500">
                      {c.kind} · {c.id}
                    </span>
                  </div>
                  {c.metric && (
                    <p className="text-slate-400">
                      Baseline {c.metric.baseline ?? "—"} → target{" "}
                      {{ gte: "≥", lte: "≤", eq: "=" }[c.metric.operator]}{" "}
                      {c.metric.target} {c.metric.unit} · current{" "}
                      {c.observation?.value ?? result?.value ?? "unknown"}
                      {c.metric.window_days
                        ? ` · ${c.metric.window_days}-day evidence window`
                        : ""}
                      {c.metric.min_samples
                        ? ` · minimum ${c.metric.min_samples} samples`
                        : ""}
                    </p>
                  )}
                  {(c.url || c.command || c.task_ids?.length) && (
                    <p className="break-all font-mono text-slate-500">
                      {c.url || c.command || c.task_ids?.join(", ")}
                    </p>
                  )}
                  {result && (
                    <p className="text-slate-400">
                      {result.detail} · Checked{" "}
                      {new Date(result.checked_at).toLocaleString()}
                      {result.sample_size !== undefined
                        ? ` · ${result.sample_size} samples`
                        : ""}
                    </p>
                  )}
                  {(c.observation || result?.evidence_ref) && (
                    <div className="space-y-1 text-slate-400">
                      <EvidenceRef
                        refValue={
                          c.observation?.evidence_ref ||
                          result?.evidence_ref ||
                          ""
                        }
                      />
                      {c.observation && (
                        <p>
                          Observed{" "}
                          {new Date(c.observation.observed_at).toLocaleString()}{" "}
                          · {c.observation.status}
                          {c.observation.sample_size !== undefined
                            ? ` · ${c.observation.sample_size} samples`
                            : ""}
                          {c.observation.detail
                            ? ` · ${c.observation.detail}`
                            : ""}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {project.endpoint?.proposed_next && (
            <div className="space-y-2 rounded-lg border border-violet-900 bg-violet-950/20 p-3">
              <h3 className="text-xs font-semibold text-violet-300">
                Proposed next endpoint
              </h3>
              <p className="whitespace-pre-wrap text-sm text-slate-300">
                {project.endpoint.proposed_next}
              </p>
              {accepting ? (
                <>
                  <p className="text-xs text-slate-400">
                    Accepting replaces the current endpoint sentence, records a
                    revision, and reopens linked knowledge for review.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      className={buttonClass}
                      onClick={() => void save(proposalAcceptance(project))}
                    >
                      Accept as current endpoint
                    </button>
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() => setAccepting(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className={buttonClass}
                  onClick={() => setAccepting(true)}
                >
                  Review proposal
                </button>
              )}
            </div>
          )}
          {!!project.end_state_history?.length && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer">
                Endpoint history ({project.end_state_history.length} revisions)
              </summary>
              <ul className="mt-2 space-y-3">
                {[...project.end_state_history].reverse().map((revision, i) => (
                  <li key={i}>
                    <p className="text-slate-500">
                      {new Date(revision.at).toLocaleString()} ·{" "}
                      {revision.source}
                      {revision.reason ? ` · ${revision.reason}` : ""}
                    </p>
                    <p className="whitespace-pre-wrap">
                      {revision.end_state || "(cleared)"}
                    </p>
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
