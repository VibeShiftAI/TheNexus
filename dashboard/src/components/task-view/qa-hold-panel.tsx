/**
 * QaHoldPanel — the task screen's answer to "this says todo, why isn't it
 * moving?" when the task's QA correction was withheld.
 *
 * A held task is NOT an ordinary todo. Its review ran and FAILED, but autonomy
 * was paused so the correction was never re-dispatched: the task parked at
 * `todo` with its findings kept and — importantly — no strike spent. A plain
 * dispatch resumes it with those findings. Before this panel the only place
 * that story existed was a chat ack (2026-09-02: three of Robert's tasks).
 *
 * The board card links here (`#qa-hold`), so this is where the findings live
 * in full rather than truncated into a tooltip.
 */
"use client";

import { PauseCircle } from "lucide-react";
import { useQaHolds } from "@/hooks/use-qa-holds";
import { qaHoldBadge } from "@/lib/qa-hold-badge";

export function QaHoldPanel({ taskId }: { taskId: string }) {
  const { byTaskId } = useQaHolds();
  const hold = byTaskId.get(taskId);
  if (!hold) return null;

  const badge = qaHoldBadge(hold);
  return (
    <section
      id="qa-hold"
      // scroll-mt keeps the anchored panel clear of the sticky page header.
      className="scroll-mt-24 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
      aria-label={badge.title}
    >
      <div className="flex items-start gap-3">
        <PauseCircle size={18} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-200">
            QA failed — correction held
          </h3>
          <p className="mt-1 text-sm text-amber-100/80">{hold.reason ?? "Autonomy is paused."}</p>
          <p className="mt-2 text-xs text-amber-200/60">
            Parked at <code className="rounded bg-slate-900 px-1">todo</code> with its findings
            kept and <strong>no strike spent</strong> — dispatching this task resumes it with them.
            {hold.operatorInitiated
              ? " Robert started this task by hand; the explicit stop holds its correction too."
              : ""}
            {hold.heldAt ? ` Held ${hold.heldAt}.` : ""}
          </p>
        </div>
      </div>

      {hold.findings ? (
        <details className="mt-3 group" open>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-amber-300/80 outline-none focus-visible:ring-1 focus-visible:ring-amber-400">
            Reviewer findings
          </summary>
          <pre className="custom-scrollbar mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-amber-500/20 bg-slate-950/60 p-3 text-[12px] leading-5 text-amber-50/80">
            {hold.findings}
          </pre>
        </details>
      ) : (
        <p className="mt-3 text-xs italic text-amber-200/50">
          The hold event carried no findings body.
        </p>
      )}
    </section>
  );
}
