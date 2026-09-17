"use client";
import type { EndStateCriterion } from "@/lib/nexus/projects";
import { Field, inputClass, buttonClass } from "./fields";

const kinds: EndStateCriterion["kind"][] = [
  "url_up",
  "command",
  "task_set",
  "manual",
  "metric",
];
export function CriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: EndStateCriterion[];
  onChange: (criteria: EndStateCriterion[]) => void;
}) {
  function update(index: number, patch: Partial<EndStateCriterion>) {
    onChange(criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-cyan-300">
          Acceptance criteria
        </h3>
        <button
          type="button"
          className={buttonClass}
          disabled={criteria.length >= 20}
          onClick={() =>
            onChange([
              ...criteria,
              {
                id: crypto.randomUUID().slice(0, 8),
                kind: "manual",
                description: "",
                enabled: true,
                source: "operator",
              },
            ])
          }
        >
          Add criterion
        </button>
      </div>
      {!criteria.length && (
        <p className="text-xs text-slate-400">
          No criteria declared. The endpoint cannot be assessed as achieved.
        </p>
      )}
      {criteria.map((criterion, i) => (
        <fieldset
          key={criterion.id}
          className="space-y-3 rounded-lg border border-slate-800 p-3"
        >
          <legend className="px-1 font-mono text-xs text-slate-500">
            {criterion.id}
          </legend>
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <Field label="Criterion description">
              <input
                required
                className={inputClass}
                value={criterion.description}
                onChange={(e) => update(i, { description: e.target.value })}
              />
            </Field>
            <Field label="Criterion kind">
              <select
                className={inputClass}
                value={criterion.kind}
                onChange={(e) => {
                  const kind = e.target.value as EndStateCriterion["kind"];
                  update(i, {
                    kind,
                    ...(kind !== criterion.kind
                      ? { observation: undefined }
                      : {}),
                    ...(kind === "metric" && !criterion.metric
                      ? {
                          metric: { target: 0, operator: "gte" },
                        }
                      : {}),
                  });
                }}
              >
                {kinds.map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </Field>
          </div>
          {criterion.kind === "url_up" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="URL">
                <input
                  required
                  type="url"
                  className={inputClass}
                  value={criterion.url ?? ""}
                  onChange={(e) => update(i, { url: e.target.value })}
                />
              </Field>
              <Field label="Expected HTTP status (optional)">
                <input
                  type="number"
                  className={inputClass}
                  value={criterion.expect_status ?? ""}
                  onChange={(e) =>
                    update(i, {
                      expect_status:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
          )}
          {criterion.kind === "command" && (
            <Field label="Command in project workspace">
              <input
                required
                className={inputClass}
                value={criterion.command ?? ""}
                onChange={(e) => update(i, { command: e.target.value })}
              />
            </Field>
          )}
          {criterion.kind === "task_set" && (
            <Field label="Task IDs (comma separated)">
              <input
                required
                className={inputClass}
                value={(criterion.task_ids ?? []).join(", ")}
                onChange={(e) =>
                  update(i, {
                    task_ids: e.target.value.split(",").map((s) => s.trim()),
                  })
                }
              />
            </Field>
          )}
          {criterion.kind === "metric" && criterion.metric && (
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                ["baseline", "target", "window_days", "min_samples"] as const
              ).map((key) => (
                <Field
                  key={key}
                  label={
                    {
                      baseline: "Baseline",
                      target: "Target",
                      window_days: "Evidence window (days)",
                      min_samples: "Minimum samples",
                    }[key]
                  }
                >
                  <input
                    type="number"
                    required={key === "target"}
                    step={key === "min_samples" ? "1" : "any"}
                    min={
                      key === "min_samples"
                        ? 1
                        : key === "window_days"
                          ? 0.001
                          : undefined
                    }
                    className={inputClass}
                    value={criterion.metric?.[key] ?? ""}
                    onChange={(e) =>
                      update(i, {
                        metric: {
                          ...criterion.metric!,
                          [key]:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        },
                      })
                    }
                  />
                </Field>
              ))}
              <Field label="Comparison">
                <select
                  className={inputClass}
                  value={criterion.metric.operator}
                  onChange={(e) =>
                    update(i, {
                      metric: {
                        ...criterion.metric!,
                        operator: e.target.value as "gte" | "lte" | "eq",
                      },
                    })
                  }
                >
                  <option value="gte">At least (≥)</option>
                  <option value="lte">At most (≤)</option>
                  <option value="eq">Equal (=)</option>
                </select>
              </Field>
              <Field label="Unit">
                <input
                  className={inputClass}
                  value={criterion.metric.unit ?? ""}
                  onChange={(e) =>
                    update(i, {
                      metric: { ...criterion.metric!, unit: e.target.value },
                    })
                  }
                />
              </Field>
            </div>
          )}
          {(criterion.kind === "manual" || criterion.kind === "metric") && (
            <div className="space-y-3 border-t border-slate-800 pt-3">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={!!criterion.observation}
                  onChange={(e) =>
                    update(i, {
                      observation: e.target.checked
                        ? {
                            status: "unknown",
                            observed_at: new Date().toISOString(),
                            evidence_ref: "",
                          }
                        : undefined,
                    })
                  }
                />
                Record an evidence observation
              </label>
              {criterion.observation && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Observation status">
                    <select
                      className={inputClass}
                      value={criterion.observation.status}
                      onChange={(e) =>
                        update(i, {
                          observation: {
                            ...criterion.observation!,
                            status: e.target.value as
                              | "pass"
                              | "fail"
                              | "unknown"
                              | "unverifiable",
                          },
                        })
                      }
                    >
                      {["pass", "fail", "unknown", "unverifiable"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Observed at (ISO date and time)">
                    <input
                      required
                      className={inputClass}
                      value={criterion.observation.observed_at}
                      onChange={(e) =>
                        update(i, {
                          observation: {
                            ...criterion.observation!,
                            observed_at: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="Evidence reference">
                    <input
                      required
                      className={inputClass}
                      value={criterion.observation.evidence_ref}
                      onChange={(e) =>
                        update(i, {
                          observation: {
                            ...criterion.observation!,
                            evidence_ref: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="Observation detail">
                    <input
                      className={inputClass}
                      value={criterion.observation.detail ?? ""}
                      onChange={(e) =>
                        update(i, {
                          observation: {
                            ...criterion.observation!,
                            detail: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  {criterion.kind === "metric" && (
                    <>
                      {(["value", "sample_size"] as const).map((key) => (
                        <Field
                          key={key}
                          label={
                            key === "value" ? "Current value" : "Sample count"
                          }
                        >
                          <input
                            type="number"
                            step={key === "value" ? "any" : "1"}
                            min={key === "sample_size" ? 0 : undefined}
                            required={key === "value"}
                            className={inputClass}
                            value={criterion.observation?.[key] ?? ""}
                            onChange={(e) =>
                              update(i, {
                                observation: {
                                  ...criterion.observation!,
                                  [key]:
                                    e.target.value === ""
                                      ? undefined
                                      : Number(e.target.value),
                                },
                              })
                            }
                          />
                        </Field>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={criterion.enabled !== false}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              Enabled
            </label>
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                onChange(criteria.filter((_, index) => index !== i))
              }
            >
              Remove criterion
            </button>
          </div>
        </fieldset>
      ))}
    </div>
  );
}
