"use client";

/**
 * QA review panel for the task screen (/task/[id]).
 *
 * Cross-executor QA reviews are dispatched against a shadow task id
 * (`qa--<origTaskId>`) — a DIFFERENT executor reviews the author's work and
 * writes its verdict as the dispatch output. Those rows live in the same
 * task_dispatches table, so we fetch them with the ordinary dispatch reader
 * (getTaskDispatches) under the `qa--` prefix and render them read-only beside
 * the original task.
 *
 * This is what the Monday QA spot-audit links into: open the reviewed task,
 * read the reviewer's actual verdict (and any fail→pass correction loop), and
 * decide whether the pass holds up. Renders nothing when a task never went
 * through QA, so it's safe to mount on every task.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { getTaskDispatches, type TaskDispatch } from "@/lib/dispatches";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";

/** The QA task id is the reviewed task id behind a `qa--` prefix. */
function qaTaskId(taskId: string): string {
  return `qa--${taskId}`;
}

type Verdict = "pass" | "fail" | null;

/**
 * The reviewer states its verdict in prose ("QA pass" / "QA failed —
 * corrections required"); there's no structured verdict column. Derive a badge
 * from that text with a neutral fallback so the transcript stays the source of
 * truth. `dispatch.outcome` is only whether the review RUN completed, not the
 * QA verdict, so it can't stand in here.
 */
function deriveVerdict(output: string | null): Verdict {
  if (!output) return null;
  const text = output.toLowerCase();
  if (/qa\s*fail|corrections?\s*required|failed\s*—|did not pass|does not pass/.test(text)) {
    return "fail";
  }
  if (/qa\s*pass|passed\b|verdict[:\s]*pass/.test(text)) return "pass";
  return null;
}

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

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (verdict === "pass") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
        <CheckCircle2 size={11} /> QA pass
      </span>
    );
  }
  if (verdict === "fail") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
        <XCircle size={11} /> QA fail
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-slate-600 bg-slate-800/60 px-2 py-0.5 text-[11px] font-semibold text-slate-400">
      verdict in transcript
    </span>
  );
}

function ReviewMarkdown({ content }: { content: string }) {
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

function ReviewRow({ review, defaultOpen }: { review: TaskDispatch; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const verdict = deriveVerdict(review.output);
  return (
    <article className="rounded-lg border border-sky-500/20 bg-slate-900/50">
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
        <span className="text-sm font-semibold text-slate-100">{review.executor}</span>
        <span className="text-[11px] text-slate-500">reviewer</span>
        {review.model && (
          <span className="rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[11px] text-purple-200">
            {review.model}
          </span>
        )}
        <VerdictBadge verdict={verdict} />
        <span className="ml-auto text-[11px] text-slate-500">{formatWhen(review.started_at)}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800 px-3 py-3">
          {review.prompt && (
            <details className="group">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:text-sky-300">
                What the reviewer was asked
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950/80 p-2.5 text-[11px] leading-4 text-slate-400">
                {review.prompt}
              </pre>
            </details>
          )}

          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Reviewer verdict
            </h4>
            {review.output ? (
              <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
                <ReviewMarkdown content={review.output} />
              </div>
            ) : (
              <p className="text-xs italic text-slate-600">No verdict text captured.</p>
            )}
          </div>

          {review.error && (
            <p className="whitespace-pre-wrap rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">
              {review.error}
            </p>
          )}

          {review.log_path && (
            <p className="truncate text-[10px] text-slate-600" title={review.log_path}>
              Full transcript: {review.log_path}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function QaReviewPanel({ taskId }: { taskId: string }) {
  const [reviews, setReviews] = useState<TaskDispatch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const rows = await getTaskDispatches(qaTaskId(taskId));
      if (!cancelledRef.current) setReviews(rows);
    } catch {
      // A missing/empty QA history is the common case — degrade to "no reviews"
      // rather than surfacing an error banner on tasks that never hit QA.
      if (!cancelledRef.current) setReviews([]);
    } finally {
      if (!cancelledRef.current) setLoaded(true);
    }
  }, [taskId]);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  // Oldest → newest so a fail→pass correction loop reads in the order it happened.
  const ordered = useMemo(
    () => [...reviews].sort((a, b) => a.started_at.localeCompare(b.started_at)),
    [reviews],
  );

  // Nothing to show until we've loaded AND there's at least one review — the
  // panel self-hides on tasks that never went through cross-executor QA.
  if (!loaded || ordered.length === 0) return null;

  const latestVerdict = deriveVerdict(ordered[ordered.length - 1]?.output ?? null);

  return (
    <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-sky-200">
        <ShieldCheck size={15} /> QA review — cross-executor verdict
        <span className="ml-1 rounded-full border border-sky-500/30 px-1.5 py-0 text-[11px] font-normal text-sky-300/80">
          {ordered.length} review{ordered.length === 1 ? "" : "s"}
        </span>
        {latestVerdict && (
          <span className="ml-auto">
            <VerdictBadge verdict={latestVerdict} />
          </span>
        )}
      </h3>
      <p className="mb-3 text-[11px] text-sky-200/60">
        A different executor reviewed this work. The final verdict above is the latest of{" "}
        {ordered.length} review{ordered.length === 1 ? "" : "s"}
        {ordered.length > 1 ? " (earlier ones may be corrections)" : ""}.
      </p>
      <div className="space-y-2">
        {ordered.map((review, idx) => (
          <ReviewRow
            key={review.id}
            review={review}
            // Open the most recent review by default; older correction rounds stay collapsed.
            defaultOpen={idx === ordered.length - 1}
          />
        ))}
      </div>
    </section>
  );
}
