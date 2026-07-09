"use client";

/**
 * Task sequence controls — predecessors and successor.
 *
 * Predecessors (the task's `dependencies` array) must ALL complete before
 * this task starts; there can be many. The successor (`successor_id`) is the
 * single task to start immediately after this one completes. Both edit
 * through the flat PATCH /api/tasks/:taskId, which validates the linked
 * tasks exist.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, X } from "lucide-react";
import { isTaskDone } from "@praxis/contract";
import { getTasks, updateTaskById, type Task, type TaskById } from "@/lib/nexus";

function isDone(status: string | undefined): boolean {
  return isTaskDone(status);
}

function TaskChip({ task, onRemove, removing }: { task: Task; onRemove?: () => void; removing?: boolean }) {
  const done = isDone(task.status);
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${done ? "bg-emerald-400" : "bg-amber-400"}`}
        title={task.status}
      />
      <Link
        href={`/task/${task.id}`}
        className="truncate text-slate-300 transition-colors hover:text-cyan-300"
        title={task.title}
      >
        {task.title}
      </Link>
      <span className="shrink-0 text-[10px] uppercase text-slate-500">{task.status}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"
          title="Remove"
          aria-label={`Remove ${task.title}`}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

export function TaskSequencePanel({
  task,
  projectId,
  onChanged,
}: {
  task: TaskById;
  projectId: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [projectTasks, setProjectTasks] = useState<Task[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getTasks(projectId)
      .then(({ tasks }) => {
        if (!cancelled) setProjectTasks(tasks);
      })
      .catch(() => {
        /* pickers degrade to raw ids */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, task.updatedAt, task.updated_at]);

  const byId = useMemo(() => new Map(projectTasks.map((t) => [t.id, t])), [projectTasks]);
  const predecessorIds = useMemo(
    () => (Array.isArray(task.dependencies) ? task.dependencies : []),
    [task.dependencies],
  );
  const successorId = task.successor_id || null;

  const addablePredecessors = useMemo(
    () => projectTasks.filter((t) => t.id !== task.id && !predecessorIds.includes(t.id)),
    [projectTasks, task.id, predecessorIds],
  );
  const successorOptions = useMemo(
    () => projectTasks.filter((t) => t.id !== task.id),
    [projectTasks, task.id],
  );

  const incompletePredecessors = predecessorIds.filter((id) => {
    const dep = byId.get(id);
    return dep ? !isDone(dep.status) : false;
  });

  const save = async (updates: { dependencies?: string[]; successor_id?: string | null }) => {
    setSaving(true);
    setError(null);
    try {
      await updateTaskById(task.id, updates);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update sequence");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <ArrowDownToLine size={15} className="text-cyan-400" /> Sequence
        {saving && <Loader2 size={13} className="animate-spin text-slate-400" />}
      </h3>

      {error && <p className="mb-2 text-xs text-rose-300">{error}</p>}

      {/* Predecessors */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Predecessors — must complete before this task starts
        </p>
        {predecessorIds.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {predecessorIds.map((id) => {
              const dep = byId.get(id) || ({ id, title: id, status: "" } as Task);
              return (
                <TaskChip
                  key={id}
                  task={dep}
                  removing={saving}
                  onRemove={() => void save({ dependencies: predecessorIds.filter((d) => d !== id) })}
                />
              );
            })}
          </div>
        ) : (
          <p className="text-xs italic text-slate-500">None — this task can start any time.</p>
        )}
        <select
          value=""
          disabled={saving || addablePredecessors.length === 0}
          onChange={(e) => {
            if (e.target.value) void save({ dependencies: [...predecessorIds, e.target.value] });
          }}
          className="h-9 w-full max-w-md rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-300 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-500/60 disabled:opacity-50"
          aria-label="Add predecessor"
        >
          <option value="">+ Add predecessor…</option>
          {addablePredecessors.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.status})
            </option>
          ))}
        </select>
        {incompletePredecessors.length > 0 && (
          <p className="text-xs text-amber-300">
            Blocked — {incompletePredecessors.length} predecessor
            {incompletePredecessors.length === 1 ? "" : "s"} not yet complete.
          </p>
        )}
      </div>

      {/* Successor */}
      <div className="mt-4 space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <ArrowUpFromLine size={12} /> Successor — starts immediately after completion
        </p>
        {successorId && (
          <div className="flex flex-wrap gap-2">
            <TaskChip
              task={byId.get(successorId) || ({ id: successorId, title: successorId, status: "" } as Task)}
              removing={saving}
              onRemove={() => void save({ successor_id: null })}
            />
          </div>
        )}
        <select
          value={successorId ?? ""}
          disabled={saving}
          onChange={(e) => void save({ successor_id: e.target.value || null })}
          className="h-9 w-full max-w-md rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-300 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-500/60 disabled:opacity-50"
          aria-label="Successor task"
        >
          <option value="">No successor</option>
          {successorOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.status})
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
