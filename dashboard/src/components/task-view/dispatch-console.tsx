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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  EXECUTOR_OPTIONS,
  useExecutorModelOptions,
  type ExecutorName,
} from "@/hooks/use-executor-models";
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

function DispatchBar({
  taskId,
  onDispatched,
}: {
  taskId: string;
  onDispatched: () => void;
}) {
  const { optionsFor } = useExecutorModelOptions();
  const [executor, setExecutor] = useState<ExecutorName>("claude-code");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "refused" | "error"; text: string } | null>(null);

  const { options, fallback, note } = optionsFor(executor);

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
          setInstructions("");
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
            onChange={(e) => setModel(e.target.value)}
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
          onClick={() => setShowInstructions((v) => !v)}
          className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200 disabled:opacity-50"
        >
          {showInstructions ? "Hide instructions" : "Add instructions"}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => submit(false)}
          className="ml-auto flex h-9 items-center gap-2 rounded-md bg-gradient-to-r from-cyan-600 to-blue-600 px-4 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition-colors hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
          Dispatch
        </button>
      </div>

      {showInstructions && (
        <textarea
          value={instructions}
          disabled={busy}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Extra dispatch-time instructions for the worker (optional — the task description always rides along)"
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
  onRefresh,
}: {
  taskId: string;
  projectId: string | null;
  dispatch: TaskDispatch;
  defaultOpen: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isFollowUp = dispatch.kind === "follow_up";
  const duration = formatDuration(dispatch.started_at, dispatch.completed_at);

  return (
    <article
      className={`rounded-lg border bg-slate-900/50 ${
        dispatch.outcome === "running" ? "border-cyan-500/40" : "border-slate-800"
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
}: {
  taskId: string;
  projectId: string | null;
}) {
  const [dispatches, setDispatches] = useState<TaskDispatch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <DispatchBar taskId={taskId} onDispatched={() => void load()} />

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
              defaultOpen={idx === 0}
              onRefresh={() => void load()}
            />
          ))}
        </div>
      )}
    </section>
  );
}
