"use client";

/**
 * Task screen — the full task view that replaced the project-page overlay
 * (TaskDetailModal) and its "AI is working…" spinner.
 *
 * One page per task: full details, the executor walkthrough, every dispatch
 * attempt's input/output, an immediate Dispatch bar (worker + model dropdowns,
 * morning-plan style), and follow-up replies into a finished run's saved CLI
 * session. Board cards and old /project/<id>?taskId= deep links land here.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ClipboardCopy,
  Copy,
  FileText,
  FolderOpen,
  Loader2,
  PauseCircle,
  Rocket,
  Search,
} from "lucide-react";
import {
  getProject,
  getTaskById,
  updateTaskById,
  type Project,
  type TaskById,
} from "@/lib/nexus";
import { copyClaudeDispatch } from "@/lib/claude-dispatch";
import { STATUS_OPTIONS } from "@/components/task-edit-modal";
import { TaskDispatchConsole } from "@/components/task-view/dispatch-console";
import { QaReviewPanel } from "@/components/task-view/qa-review-panel";
import { TaskSequencePanel } from "@/components/task-view/task-sequence";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";

const TASK_POLL_MS = 20_000;

function Markdown({ content }: { content: string }) {
  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        prose-p:text-slate-300 prose-p:leading-relaxed
        prose-strong:text-white prose-li:text-slate-300
        prose-code:text-cyan-300 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
        prose-headings:text-slate-100 prose-h2:text-base prose-h3:text-sm
        prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
        prose-hr:border-slate-700"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(content)}</ReactMarkdown>
    </div>
  );
}

/** Collapsible artifact section (spec / research / plan). */
function ArtifactSection({
  title,
  icon,
  content,
  generatedAt,
}: {
  title: string;
  icon: React.ReactNode;
  content: string;
  generatedAt?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-slate-200 transition-colors hover:text-cyan-200"
        aria-expanded={open}
      >
        {icon}
        {title}
        {generatedAt && (
          <span className="text-[11px] font-normal text-slate-500">
            {new Date(generatedAt).toLocaleString()}
          </span>
        )}
        <span className="ml-auto text-xs text-slate-500">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="border-t border-slate-800 px-4 py-3">
          <Markdown content={content} />
        </div>
      )}
    </section>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked — id is still visible */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
      title={`Task ID: ${id}\nClick to copy`}
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? "copied" : id}
    </button>
  );
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = use(params);
  const [task, setTask] = useState<TaskById | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [dispatchCopied, setDispatchCopied] = useState(false);

  const projectId = task?.project_id ?? null;

  const load = useCallback(async () => {
    try {
      const t = await getTaskById(taskId);
      if (!t) {
        setNotFound(true);
        return;
      }
      setTask(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load task");
    }
  }, [taskId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Project loads lazily once the task reveals its project_id.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getProject(projectId)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch(() => {
        /* project card degrades to the raw id */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const title = task?.title || task?.name || "Task";
  const status = task?.status ?? "";
  const description = task?.description?.trim();
  const walkthrough = task?.walkthrough;
  const hasSideContent = Boolean(
    task?.spec_output || task?.researchReport?.content || task?.implementationPlan?.content,
  );
  const suspendedReason =
    status === "suspended"
      ? task?.suspended_reason ||
        (typeof task?.metadata?.status_message === "string" ? task.metadata.status_message : null)
      : null;

  const setStatus = async (nextStatus: string) => {
    if (!task) return;
    setStatusSaving(true);
    try {
      await updateTaskById(task.id, { status: nextStatus });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setStatusSaving(false);
    }
  };

  const handleCopyClaudeDispatch = async () => {
    if (!task || !projectId) return;
    try {
      await copyClaudeDispatch(task, projectId);
      setDispatchCopied(true);
      setTimeout(() => setDispatchCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy Claude dispatch brief:", err);
    }
  };

  const statusOptions = useMemo(() => {
    const known = STATUS_OPTIONS.some((o) => o.value === status);
    return known || !status ? STATUS_OPTIONS : [{ value: status, label: status }, ...STATUS_OPTIONS];
  }, [status]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="container mx-auto flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-4">
            <Link
              href="/task-board"
              className="flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white"
            >
              <ArrowLeft size={18} />
              <span>Task Board</span>
            </Link>
            <div className="h-6 w-px bg-slate-700" />
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-cyan-500" />
              <h1 className="text-xl font-bold text-white">
                THE <span className="text-cyan-400">NEXUS</span>
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            {projectId && (
              <Link
                href={`/project/${projectId}`}
                className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 transition-colors hover:border-cyan-500/50 hover:text-cyan-200"
              >
                <FolderOpen size={15} />
                {project?.name || "Project"}
              </Link>
            )}
            <button
              onClick={handleCopyClaudeDispatch}
              disabled={!projectId}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                dispatchCopied
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-slate-700 bg-slate-900 hover:border-cyan-500/50 hover:text-cyan-200"
              }`}
              title="Copy a Claude-ready brief for this task — paste into any Claude session"
            >
              {dispatchCopied ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {dispatchCopied ? "Copied!" : "Copy Claude Dispatch"}
            </button>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-5 p-6">
        {notFound ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-slate-800 p-12 text-slate-400">
            <AlertTriangle size={28} className="text-amber-400" />
            <p className="text-lg text-white">Task not found</p>
            <p className="text-sm">
              It may have been deleted or archived.{" "}
              <Link href="/task-board" className="text-cyan-300 hover:underline">
                Back to the board
              </Link>
            </p>
          </div>
        ) : !task ? (
          <div className="flex min-h-[320px] items-center justify-center text-cyan-300">
            <Loader2 className="animate-spin" size={32} />
          </div>
        ) : (
          <>
            {/* Title row */}
            <section className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
              <div className="min-w-0">
                <h2 className="text-2xl font-semibold text-white">{title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <CopyableId id={task.id} />
                  <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-400">
                    P{task.priority ?? 0}
                  </span>
                  <span>Created {new Date(task.createdAt || task.created_at || Date.now()).toLocaleString()}</span>
                  {(task.updatedAt || task.updated_at) && (
                    <span>· Updated {new Date(task.updatedAt || task.updated_at!).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {statusSaving && <Loader2 size={14} className="animate-spin text-slate-400" />}
                <select
                  value={status}
                  disabled={statusSaving}
                  onChange={(e) => void setStatus(e.target.value)}
                  className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-500/60"
                  aria-label="Task status"
                >
                  {statusOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </section>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}

            {suspendedReason && (
              <div className="flex items-start gap-3 rounded-lg border border-purple-500/40 bg-purple-500/10 p-4">
                <PauseCircle size={18} className="mt-0.5 shrink-0 text-purple-300" />
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-purple-200">Suspended — the worker asked for input</p>
                  <p className="mt-1 whitespace-pre-wrap text-purple-100/80">{suspendedReason}</p>
                  <p className="mt-2 text-xs text-purple-200/60">
                    Answer it from the HITL inbox on the bridge, or reply directly to the run below.
                  </p>
                </div>
              </div>
            )}

            <div className={hasSideContent ? "grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]" : ""}>
              {/* Main column */}
              <div className="min-w-0 space-y-5">
                <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                    <FileText size={15} className="text-cyan-400" /> Description
                  </h3>
                  {description ? (
                    <Markdown content={description} />
                  ) : (
                    <p className="text-sm italic text-slate-500">No description provided.</p>
                  )}
                </section>

                <TaskSequencePanel task={task} projectId={projectId} onChanged={load} />

                {walkthrough?.content && (
                  <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                    <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-emerald-200">
                      <BookOpen size={15} /> Walkthrough — the worker&apos;s final report
                    </h3>
                    <p className="mb-3 text-[11px] text-emerald-200/60">
                      {walkthrough.generatedAt && `Captured ${new Date(walkthrough.generatedAt).toLocaleString()}`}
                      {(walkthrough as { executor?: string }).executor &&
                        ` · by ${(walkthrough as { executor?: string }).executor}`}
                    </p>
                    <Markdown content={walkthrough.content} />
                  </section>
                )}

                <QaReviewPanel taskId={task.id} />

                <section>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
                    <Rocket size={15} className="text-cyan-400" /> Dispatch console
                  </h3>
                  <TaskDispatchConsole
                    taskId={task.id}
                    projectId={projectId}
                    defaultExecutor={task.default_executor}
                    defaultModel={task.default_model}
                    defaultInstructions={task.dispatch_instructions}
                  />
                </section>
              </div>

              {/* Side column — task artifacts (only when present) */}
              {hasSideContent && (
                <div className="min-w-0 space-y-4">
                  {task.spec_output && (
                    <ArtifactSection
                      title="Spec"
                      icon={<FileText size={14} className="text-slate-400" />}
                      content={task.spec_output}
                    />
                  )}
                  {task.researchReport?.content && (
                    <ArtifactSection
                      title="Research"
                      icon={<Search size={14} className="text-slate-400" />}
                      content={task.researchReport.content}
                      generatedAt={task.researchReport.generatedAt}
                    />
                  )}
                  {task.implementationPlan?.content && (
                    <ArtifactSection
                      title="Plan"
                      icon={<Rocket size={14} className="text-slate-400" />}
                      content={task.implementationPlan.content}
                      generatedAt={task.implementationPlan.generatedAt}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
