"use client";

import { useEffect, useState } from "react";
import {
  X,
  Save,
  Ban,
  Trash2,
  Loader2,
  AlertCircle,
  ExternalLink,
  ClipboardList,
} from "lucide-react";
import Link from "next/link";
import { updateTask, deleteTask, setTaskPriority } from "@/lib/nexus";
import type { BoardTask } from "@/lib/task-board";

/** Status options offered in the editor. Values map onto the board lanes in lib/task-board.ts. */
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "idea", label: "Idea / New" },
  { value: "planning", label: "Planning" },
  { value: "todo", label: "To Do" },
  { value: "scheduled", label: "Scheduled" },
  { value: "dispatched", label: "Dispatched" },
  { value: "in_progress", label: "In Progress" },
  { value: "needs_input", label: "Needs Input" },
  { value: "blocked", label: "Blocked" },
  { value: "ready_for_review", label: "Ready for Review" },
  { value: "review", label: "In Review" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];

const PRIORITY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "P0 — Low" },
  { value: 1, label: "P1 — Normal" },
  { value: 2, label: "P2 — High" },
];

interface TaskEditModalProps {
  task: BoardTask | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function TaskEditModal({ task, isOpen, onClose, onSaved }: TaskEditModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState(0);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = task?.projectId || task?.project_id || null;

  // Hydrate form whenever a new task is opened.
  useEffect(() => {
    if (!task) return;
    setTitle(task.title || task.name || "");
    setDescription(task.description || "");
    setStatus((task.status || "todo").toString());
    setPriority(Number(task.priority ?? 0) || 0);
    setConfirmDelete(false);
    setError(null);
  }, [task]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !deleting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, saving, deleting]);

  if (!task) return null;

  const runUpdate = async (overrides?: { status?: string }) => {
    if (!projectId) {
      setError("This task has no project — cannot update.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const nextStatus = overrides?.status ?? status;
      await updateTask(projectId, task.id, {
        title: title.trim(),
        description: description.trim(),
        status: nextStatus,
      });
      // Priority lives on a separate endpoint that handles the column directly.
      if (priority !== (Number(task.priority ?? 0) || 0)) {
        await setTaskPriority(task.id, priority);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save task");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!projectId) {
      setError("This task has no project — cannot delete.");
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteTask(projectId, task.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete task");
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting;
  const detailHref = `/task/${task.id}`;

  return (
    <div className={`fixed inset-0 z-[60] overflow-hidden transition-all duration-200 ${isOpen ? "visible" : "invisible delay-200"}`}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-slate-950/70 backdrop-blur-sm transition-opacity duration-200 ${isOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={() => !busy && onClose()}
      />

      {/* Centered panel */}
      <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
        <div
          role="dialog"
          aria-modal="true"
          className={`w-full max-w-xl rounded-xl border border-slate-800 bg-slate-900 text-slate-200 shadow-2xl transition-all duration-200 ${isOpen ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <ClipboardList size={18} className="shrink-0 text-cyan-400" />
              <span className="truncate text-xs font-semibold uppercase tracking-wider text-slate-400">
                Edit Task · {task.projectName || "Task"}
              </span>
            </div>
            <button
              onClick={() => !busy && onClose()}
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="space-y-4 px-5 py-5">
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Title */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                className="h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60 disabled:opacity-60"
                placeholder="Task title"
              />
            </label>

            {/* Status + Priority */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={busy}
                  className="h-11 w-full appearance-none rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60 disabled:opacity-60"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Priority</span>
                <select
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  disabled={busy}
                  className="h-11 w-full appearance-none rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60 disabled:opacity-60"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            </div>

            {status === "idea" && status !== (task.status || "todo").toString() && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
                Heads up: moving a task back to <strong>Idea</strong> resets its research, plan, and walkthrough outputs.
              </p>
            )}

            {/* Description */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
                rows={6}
                className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-sm text-slate-200 outline-none transition-colors focus:border-cyan-500/60 disabled:opacity-60"
                placeholder="Add context, acceptance criteria, links…"
              />
            </label>

            <Link
              href={detailHref}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-cyan-300"
            >
              <ExternalLink size={13} />
              Open full task view (research, plan, walkthrough)
            </Link>
          </div>

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-5 py-4">
            <div className="flex items-center gap-2">
              {/* Cancel task */}
              <button
                onClick={() => runUpdate({ status: "cancelled" })}
                disabled={busy || status === "cancelled"}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-amber-300 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-40"
                title="Mark this task cancelled"
              >
                <Ban size={14} />
                Cancel task
              </button>

              {/* Delete */}
              {confirmDelete ? (
                <button
                  onClick={handleDelete}
                  disabled={busy}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Confirm delete
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-400 transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => !busy && onClose()}
                disabled={busy}
                className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-50"
              >
                Close
              </button>
              <button
                onClick={() => runUpdate()}
                disabled={busy || !title.trim()}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-emerald-700 bg-emerald-950 px-4 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-900 disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
