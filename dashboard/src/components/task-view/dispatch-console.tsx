"use client";

/**
 * Dispatch console for the task screen (/task/[id]).
 *
 * Three pieces in one panel:
 *   - Dispatch bar: worker + model dropdowns (same options as the morning-plan
 *     card, via useExecutorModelOptions) with an immediate Dispatch button that
 *     drives Praxis POST /api/dispatch/task. A Praxis refusal (duplicate run,
 *     terminal status) surfaces with a Force override.
 *   - History: every dispatch attempt with its exact prompt (input), final
 *     output, model, outcome, duration, and CLI session id.
 *   - Follow-up composer: on claude-code/codex rows with a saved session id,
 *     "Reply" resumes THAT conversation (claude --resume / codex exec resume);
 *     the exchange lands back in the history as a follow-up row.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Loader2,
  MessageSquareText,
  Rocket,
  Send,
  XCircle,
} from "lucide-react";
import {
  canFollowUp,
  dispatchTask,
  getTaskDispatches,
  sendFollowUp,
  type TaskDispatch,
} from "@/lib/dispatches";
import {
  DEFAULT_EXECUTOR,
  EXECUTOR_OPTIONS,
  useExecutorModelOptions,
  type ExecutorName,
} from "@/hooks/use-executor-models";
import { updateTaskById } from "@/lib/nexus";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";

const POLL_ACTIVE_MS = 6_000;
const POLL_IDLE_MS = 20_000;

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const OUTCOME_STYLES: Record<string, string> = {
  running: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failure: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  timeout: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  needs_input: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  cancelled: "border-slate-600 bg-slate-800/60 text-slate-400",
};

function OutcomeChip({ outcome }: { outcome: string }) {
  const style = OUTCOME_STYLES[outcome] || OUTCOME_STYLES.cancelled;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style}`}>
      {outcome === "running" && <Loader2 size={11} className="animate-spin" />}
      {outcome.replace(/_/g, " ")}
    </span>
  );
}

/** Shared prose styling for markdown output blocks. */
function OutputMarkdown({ content }: { content: string }) {
  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        prose-p:text-slate-300 prose-p:leading-relaxed prose-p:my-1
        prose-strong:text-white prose-li:text-slate-300 prose-li:my-0.5
        prose-code:text-cyan-300 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
        prose-headings:text-slate-100 prose-h3:text-sm prose-h2:text-base
        prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
        prose-hr:border-slate-700"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(content)}</ReactMarkdown>
    </div>
  );
}

// ── Dispatch bar ──────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

/** Tiny inline indicator for the dispatch-defaults auto-save. */
function SaveStatus({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const map: Record<Exclude<SaveState, "idle">, { icon: ReactNode; text: string; cls: string }> = {
    saving: { icon: <Loader2 size={12} className="animate-spin" />, text: "Saving…", cls: "text-slate-400" },
    saved: { icon: <CheckCircle2 size={12} />, text: "Saved", cls: "text-emerald-300" },
    error: { icon: <AlertTriangle size={12} />, text: "Save failed", cls: "text-rose-300" },
  };
  const { icon, text, cls } = map[state];
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${cls}`}
      title="Worker, Model, and instructions save to this task automatically"
    >
      {icon}
      {text}
    </span>
  );
}

function DispatchBar({
  taskId,
  defaultExecutor,
  defaultModel,
  defaultInstructions,
  onDispatched,
}: {
  taskId: string;
  /** Saved Worker for this task (persisted dispatch default). */
  defaultExecutor?: string | null;
  /** Saved Model id ("" = executor default). */
  defaultModel?: string | null;
  /** Saved standing instructions that ride every dispatch. */
  defaultInstructions?: string | null;
  onDispatched: () => void;
}) {
  const { optionsFor } = useExecutorModelOptions();

  // Initial values come straight from the task's saved dispatch defaults. The
  // task is already loaded before this bar mounts, so there's no empty flash.
  const initialExecutor: ExecutorName = EXECUTOR_OPTIONS.includes(defaultExecutor as ExecutorName)
    ? (defaultExecutor as ExecutorName)
    : DEFAULT_EXECUTOR;
  const initialModel = defaultModel ?? "";
  const initialInstructions = defaultInstructions ?? "";

  const [executor, setExecutor] = useState<ExecutorName>(initialExecutor);
  const [model, setModel] = useState(initialModel);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [showInstructions, setShowInstructions] = useState(Boolean(initialInstructions));
  // Progressive disclosure: keep the worker/model dropdowns hidden while this
  // task rides the managed default (Claude Code + CLI default model). A task
  // carrying a custom executor or a pinned model opens expanded so the operator
  // sees what's configured without hunting for it.
  const [showAdvanced, setShowAdvanced] = useState(
    !(initialExecutor === DEFAULT_EXECUTOR && !initialModel),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "refused" | "error"; text: string } | null>(null);

  const { options, fallback, note } = optionsFor(executor);
  // Human-readable model for the collapsed summary — the pinned model's label,
  // or the executor default when nothing is pinned.
  const modelLabel = model
    ? options.find((o) => o.id === model)?.label ?? model
    : `default (${fallback || "CLI default"})`;

  // ── Auto-save of the saved dispatch defaults ────────────────────────────
  // Saving is action-driven — the onChange handlers call scheduleSave(), it is
  // never triggered by a state-watching effect — so programmatic hydration can
  // never be mistaken for a user edit. savedSnapshotRef holds the last-persisted
  // [executor, model, instructions]; hydratedTaskRef guards re-hydration so the
  // parent's 20s task poll can't clobber an in-flight edit.
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const hydratedTaskRef = useRef(taskId);
  const savedSnapshotRef = useRef(JSON.stringify([initialExecutor, initialModel, initialInstructions]));
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ executor, model, instructions });
  latestRef.current = { executor, model, instructions };

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveState("saving");
    saveTimerRef.current = setTimeout(() => {
      const { executor: ex, model: md, instructions: ins } = latestRef.current;
      const snapshot = JSON.stringify([ex, md, ins]);
      if (snapshot === savedSnapshotRef.current) {
        setSaveState("idle"); // reverted to the saved value — nothing to write
        return;
      }
      updateTaskById(taskId, {
        default_executor: ex,
        default_model: md || null,
        dispatch_instructions: ins.trim() || null,
      })
        .then(() => {
          savedSnapshotRef.current = snapshot;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 700);
  }, [taskId]);

  // Re-hydrate only when the bar is reused for a DIFFERENT task (a route change
  // without remount). First mount is already covered by the initial state above.
  useEffect(() => {
    if (hydratedTaskRef.current === taskId) return;
    hydratedTaskRef.current = taskId;
    const nextExecutor: ExecutorName = EXECUTOR_OPTIONS.includes(defaultExecutor as ExecutorName)
      ? (defaultExecutor as ExecutorName)
      : DEFAULT_EXECUTOR;
    const nextModel = defaultModel ?? "";
    const nextInstructions = defaultInstructions ?? "";
    setExecutor(nextExecutor);
    setModel(nextModel);
    setInstructions(nextInstructions);
    setShowInstructions(Boolean(nextInstructions));
    setShowAdvanced(!(nextExecutor === DEFAULT_EXECUTOR && !nextModel));
    savedSnapshotRef.current = JSON.stringify([nextExecutor, nextModel, nextInstructions]);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveState("idle");
  }, [taskId, defaultExecutor, defaultModel, defaultInstructions]);

  // Flush a pending edit on unmount / task switch so a just-typed instruction or
  // a last-second Worker/Model change isn't lost before the debounce fires.
  useEffect(() => {
    const currentTaskId = taskId;
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const { executor: ex, model: md, instructions: ins } = latestRef.current;
      const snapshot = JSON.stringify([ex, md, ins]);
      if (snapshot !== savedSnapshotRef.current) {
        void updateTaskById(currentTaskId, {
          default_executor: ex,
          default_model: md || null,
          dispatch_instructions: ins.trim() || null,
        }).catch(() => {});
      }
    };
  }, [taskId]);

  const submit = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setResult(null);
      try {
        const res = await dispatchTask({
          taskId,
          executor,
          model: model || undefined,
          instructions: instructions.trim() || undefined,
          force,
        });
        if (res.refused) {
          setResult({ tone: "refused", text: res.reply });
        } else {
          setResult({ tone: "ok", text: res.reply });
          // Instructions are a saved standing default now — keep them so they
          // ride the next dispatch too, rather than clearing after each run.
          onDispatched();
        }
      } catch (err) {
        setResult({ tone: "error", text: err instanceof Error ? err.message : "Dispatch failed" });
      } finally {
        setBusy(false);
      }
    },
    [taskId, executor, model, instructions, onDispatched],
  );

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex flex-wrap items-end gap-3">
        {showAdvanced ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              Worker
              <select
                value={executor}
                disabled={busy}
                onChange={(e) => {
                  setExecutor(e.target.value as ExecutorName);
                  // A chosen model is executor-specific — clear it so the dispatch
                  // rides the new executor's default (same rule as the morning plan).
                  setModel("");
                  scheduleSave();
                }}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
              >
                {EXECUTOR_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>

            <label className="flex min-w-52 flex-col gap-1 text-xs text-slate-400">
              Model
              <select
                value={model}
                disabled={busy}
                onChange={(e) => {
                  setModel(e.target.value);
                  scheduleSave();
                }}
                title={`${executor} model for this dispatch (billed to the ${note} subscription)`}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-purple-200 outline-none focus:border-purple-500/60"
              >
                <option value="">default ({fallback || "CLI default"})</option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Collapse back to the managed default: reset the worker/model to
                // the opinionated default so "hide" actually returns to default.
                setExecutor(DEFAULT_EXECUTOR);
                setModel("");
                setShowAdvanced(false);
                scheduleSave();
              }}
              title="Return to the managed default (Claude Code · CLI default model)"
              className="h-9 self-end rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200 disabled:opacity-50"
            >
              Use default
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowAdvanced(true)}
            title="Choose a different worker or model for this dispatch"
            className="group flex h-9 items-center gap-2 rounded-md border border-slate-800 bg-slate-950/60 px-3 text-xs text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-slate-200 disabled:opacity-50"
          >
            <span className="text-slate-500">Worker</span>
            <span className="font-semibold text-slate-200">{executor}</span>
            <span className="text-slate-700">·</span>
            <span className="text-slate-500">Model</span>
            <span className="font-semibold text-purple-200">{modelLabel}</span>
            <ChevronRight size={13} className="text-slate-600 transition-transform group-hover:translate-x-0.5" />
            <span className="text-cyan-300/80">Change</span>
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => setShowInstructions((v) => !v)}
          className="h-9 self-end rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200 disabled:opacity-50"
        >
          {showInstructions ? "Hide instructions" : "Add instructions"}
        </button>

        <div className="ml-auto flex items-center gap-3">
          <SaveStatus state={saveState} />
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(false)}
            className="flex h-9 items-center gap-2 rounded-md bg-gradient-to-r from-cyan-600 to-blue-600 px-4 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-colors hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
            Dispatch
          </button>
        </div>
      </div>

      {showInstructions && (
        <textarea
          value={instructions}
          disabled={busy}
          onChange={(e) => {
            setInstructions(e.target.value);
            scheduleSave();
          }}
          placeholder="Standing instructions for this task — saved automatically and sent with every dispatch (the task description always rides along too)"
          className="mt-3 min-h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60"
        />
      )}

      {result && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md border p-2.5 text-xs ${
            result.tone === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : result.tone === "refused"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          {result.tone === "ok" ? (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          ) : result.tone === "refused" ? (
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          ) : (
            <XCircle size={14} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1 whitespace-pre-wrap">{result.text}</div>
          {result.tone === "refused" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => submit(true)}
              className="shrink-0 rounded border border-amber-400/50 px-2 py-1 font-semibold text-amber-200 transition-colors hover:bg-amber-400/10"
              title="Bypass the guard (duplicate run / terminal status) and dispatch anyway"
            >
              Force dispatch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Follow-up composer ────────────────────────────────────────────────────

function FollowUpComposer({
  taskId,
  projectId,
  dispatch,
  onSent,
}: {
  taskId: string;
  projectId: string | null;
  dispatch: TaskDispatch;
  onSent: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!prompt.trim() || !dispatch.session_id || !dispatch.workspace) return;
    setBusy(true);
    setError(null);
    try {
      await sendFollowUp({
        taskId,
        projectId,
        executor: dispatch.executor,
        sessionId: dispatch.session_id,
        prompt: prompt.trim(),
        workspace: dispatch.workspace,
        model: dispatch.model,
        parentDispatchId: dispatch.id,
      });
      setPrompt("");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Follow-up failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-slate-700/60 bg-slate-950/60 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
        <MessageSquareText size={12} />
        Reply to this {dispatch.executor} session — same conversation, full context of the run.
      </div>
      <textarea
        value={prompt}
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
        }}
        placeholder="Ask a question about this run, or give it more work… (⌘↵ to send)"
        className="min-h-16 w-full resize-y rounded border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[10px] text-slate-600">
          session {dispatch.session_id?.slice(0, 8)}… · {dispatch.workspace}
        </span>
        <button
          type="button"
          disabled={busy || !prompt.trim()}
          onClick={() => void submit()}
          className="flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          Send follow-up
        </button>
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-rose-300">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
    </div>
  );
}

// ── History row ───────────────────────────────────────────────────────────

function DispatchRow({
  taskId,
  projectId,
  dispatch,
  defaultOpen,
  highlight = false,
  onRefresh,
}: {
  taskId: string;
  projectId: string | null;
  dispatch: TaskDispatch;
  defaultOpen: boolean;
  /** True when this row is the deep-link target (e.g. from the activity feed). */
  highlight?: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isFollowUp = dispatch.kind === "follow_up";
  const duration = formatDuration(dispatch.started_at, dispatch.completed_at);
  const articleRef = useRef<HTMLElement>(null);

  // Scroll the deep-linked run into view once, so arriving from the activity
  // feed lands directly on that activity's logs rather than the top of the list.
  useEffect(() => {
    if (highlight && articleRef.current) {
      articleRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);

  return (
    <article
      ref={articleRef}
      className={`rounded-lg border bg-slate-900/50 ${
        highlight
          ? "border-cyan-500/60 ring-1 ring-cyan-500/30"
          : dispatch.outcome === "running"
            ? "border-cyan-500/40"
            : "border-slate-800"
      } ${isFollowUp ? "ml-5" : ""}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-slate-500" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-slate-500" />
        )}
        {isFollowUp && (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-300">
            <CornerDownRight size={11} /> follow-up
          </span>
        )}
        <span className="text-sm font-semibold text-slate-100">{dispatch.executor}</span>
        {dispatch.model && (
          <span className="rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[11px] text-purple-200">
            {dispatch.model}
          </span>
        )}
        {typeof dispatch.tokens === "number" && (
          <span
            className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] tabular-nums text-cyan-200"
            title={
              dispatch.tokens_estimated
                ? `~${dispatch.tokens.toLocaleString()} tokens (estimated from text volume)`
                : `${dispatch.tokens.toLocaleString()} tokens`
            }
          >
            {dispatch.tokens_estimated ? "~" : ""}
            {dispatch.tokens.toLocaleString()} tok
          </span>
        )}
        <OutcomeChip outcome={dispatch.outcome} />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
          {dispatch.session_id && (
            <span
              className="rounded border border-cyan-500/20 bg-cyan-500/5 px-1.5 py-0.5 font-mono text-cyan-300/80"
              title={`CLI session ${dispatch.session_id} — resumable with a follow-up`}
            >
              ⎔ {dispatch.session_id.slice(0, 8)}
            </span>
          )}
          <span>{formatWhen(dispatch.started_at)}</span>
          {duration && <span>· {duration}</span>}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800 px-3 py-3">
          {dispatch.instructions && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Dispatch instructions
              </h4>
              <p className="whitespace-pre-wrap rounded border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-300">
                {dispatch.instructions}
              </p>
            </div>
          )}

          {dispatch.prompt && (
            <details className="group">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:text-cyan-300">
                {isFollowUp ? "Your message" : "Input — full prompt sent to the worker"}
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950/80 p-2.5 text-[11px] leading-4 text-slate-400">
                {dispatch.prompt}
              </pre>
            </details>
          )}

          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {isFollowUp ? "Reply" : "Output"}
            </h4>
            {dispatch.outcome === "running" ? (
              <p className="flex items-center gap-2 rounded border border-cyan-500/20 bg-cyan-500/5 p-2.5 text-xs text-cyan-200">
                <Loader2 size={13} className="animate-spin" />
                Running — output lands here when the worker finishes.
              </p>
            ) : dispatch.output ? (
              <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                <OutputMarkdown content={dispatch.output} />
              </div>
            ) : (
              <p className="text-xs italic text-slate-600">No output captured.</p>
            )}
          </div>

          {dispatch.error && (
            <p className="whitespace-pre-wrap rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
              {dispatch.error}
            </p>
          )}

          {dispatch.log_path && (
            <p className="truncate text-[10px] text-slate-600" title={dispatch.log_path}>
              Full transcript: {dispatch.log_path}
            </p>
          )}

          {canFollowUp(dispatch) && (
            <FollowUpComposer
              taskId={taskId}
              projectId={projectId}
              dispatch={dispatch}
              onSent={onRefresh}
            />
          )}
        </div>
      )}
    </article>
  );
}

// ── Console (panel + history) ─────────────────────────────────────────────

export function TaskDispatchConsole({
  taskId,
  projectId,
  defaultExecutor,
  defaultModel,
  defaultInstructions,
}: {
  taskId: string;
  projectId: string | null;
  /** Saved dispatch defaults for this task — hydrate + auto-save the bar. */
  defaultExecutor?: string | null;
  defaultModel?: string | null;
  defaultInstructions?: string | null;
}) {
  const [dispatches, setDispatches] = useState<TaskDispatch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deep-link target from the activity feed: /task/[id]#dispatch-<id>. Open and
  // highlight that specific run so drilling down from a feed row lands on it.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const match = window.location.hash.match(/^#dispatch-(.+)$/);
    if (match) setHighlightId(decodeURIComponent(match[1]));
  }, []);

  const anyRunning = useMemo(
    () => dispatches.some((d) => d.outcome === "running"),
    [dispatches],
  );

  const load = useCallback(async () => {
    try {
      const rows = await getTaskDispatches(taskId);
      setDispatches(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dispatch history");
    } finally {
      setLoaded(true);
    }
  }, [taskId]);

  // Poll faster while a run is in flight so outputs appear without a refresh.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void load(), anyRunning ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [dispatches, anyRunning, load]);

  return (
    <section className="space-y-3">
      <DispatchBar
        taskId={taskId}
        defaultExecutor={defaultExecutor}
        defaultModel={defaultModel}
        defaultInstructions={defaultInstructions}
        onDispatched={() => void load()}
      />

      {error && (
        <p className="flex items-center gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
          <AlertTriangle size={13} /> {error}
        </p>
      )}

      {!loaded ? (
        <div className="flex items-center justify-center rounded-lg border border-slate-800 p-6 text-cyan-300">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : dispatches.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
          No dispatch attempts recorded yet — history starts with the next dispatch.
        </p>
      ) : (
        <div className="space-y-2">
          {dispatches.map((d, idx) => (
            <DispatchRow
              key={d.id}
              taskId={taskId}
              projectId={projectId}
              dispatch={d}
              // Open the deep-linked run if present, else the newest attempt.
              defaultOpen={highlightId ? d.id === highlightId : idx === 0}
              highlight={d.id === highlightId}
              onRefresh={() => void load()}
            />
          ))}
        </div>
      )}
    </section>
  );
}
