/**
 * NowStrip — the Praxis Terminal's live "now" heartbeat: a compact strip at the
 * top of the main viewer showing what's executing this instant — the active
 * model, the task/activity it's on, and a live token counter — with a clear
 * idle state when nothing is running.
 *
 * The model, task name, and token count come from task-correlated dispatch
 * telemetry (the in-flight dispatch row) via useActiveWork — so they always
 * describe the running task, never a global feed — with presence/crew supplying
 * the running/idle heartbeat. The strip stays cheap and flicker-free: it only
 * re-renders when the memoized signal actually changes.
 */
"use client";

import { Cpu, Coins } from "lucide-react";
import { useActiveWork } from "@/hooks/use-active-work";
import { coreStyle } from "@/components/bridge/core-canvas";

// Compact token count: 12345 → "12.3k", 2_000_000 → "2M".
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function NowStrip({ bare = false }: { bare?: boolean } = {}) {
  const {
    running,
    activity,
    taskLabel,
    model,
    tokens,
    tokensEstimated,
    tokensCountedRuns,
    tokensTotalRuns,
    connected,
  } = useActiveWork();
  // The cumulative figure covers only the runs that reported usage. When some
  // did not, the count is a floor, not the task's total, and saying so is the
  // difference between a partial measurement and a wrong one.
  const partialCoverage = tokensTotalRuns > 0 && tokensCountedRuns < tokensTotalRuns;
  const coverageNote =
    tokensTotalRuns > 0
      ? `counted from ${tokensCountedRuns} of ${tokensTotalRuns} run${tokensTotalRuns === 1 ? "" : "s"}`
      : null;
  const style = coreStyle(activity);
  const stateLabel = running ? style.label : "Idle";
  const name = running
    ? taskLabel ?? style.label
    : connected
    ? "Nothing executing — standing by"
    : "Signal lost — reconnecting";

  return (
    <div
      className={
        bare
          ? "flex min-w-0 items-center gap-2.5"
          : "mb-3 flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
      }
    >
      {/* Status dot + NOW + activity state */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="relative flex h-2 w-2 items-center justify-center">
          {running && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400/60 motion-safe:animate-ping" />
          )}
          <span className={`h-2 w-2 rounded-full ${running ? "bg-cyan-400" : "bg-slate-600"}`} />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Now</span>
        <span className={`text-[11px] font-semibold ${running ? style.textClass : "text-slate-500"}`}>
          {stateLabel}
        </span>
      </div>

      {/* Task / activity name */}
      <div
        className={`min-w-0 flex-1 truncate text-[12px] ${running ? "text-slate-300" : "text-slate-500"}`}
        title={name}
      >
        {name}
      </div>

      {/* Active model + live token counter */}
      <div className="flex shrink-0 items-center gap-1.5">
        {model ? (
          <span
            className="inline-flex items-center gap-1 rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-200"
            title={`Active model: ${model}`}
          >
            <Cpu size={9} className="shrink-0" />
            <span className="max-w-[9rem] truncate">{model}</span>
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600"
            title={running ? "Model not reported for this task" : "No active model"}
          >
            <Cpu size={9} className="shrink-0" />—
          </span>
        )}
        {tokens != null ? (
          <span
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
              partialCoverage
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-cyan-500/25 bg-cyan-500/10 text-cyan-200"
            }`}
            title={`${tokensEstimated ? "~" : ""}${tokens.toLocaleString()} tokens for this task${
              tokensEstimated ? " (estimated)" : ""
            }${
              partialCoverage
                ? `, ${coverageNote}. The other ${
                    tokensTotalRuns - tokensCountedRuns
                  } left no usage record, so this task's total is unknown, not this figure.`
                : coverageNote
                ? `, ${coverageNote}`
                : ""
            }`}
          >
            <Coins size={9} className="shrink-0" />
            {tokensEstimated ? "~" : ""}
            {fmtTokens(tokens)}
            {partialCoverage && (
              <span className="font-normal text-amber-300/80">
                · {tokensCountedRuns}/{tokensTotalRuns} runs
              </span>
            )}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600"
            title={
              tokensTotalRuns > 0
                ? `No usage recorded for any of this task's ${tokensTotalRuns} run${
                    tokensTotalRuns === 1 ? "" : "s"
                  }, so its token count is unknown (not zero).`
                : running
                ? "Token count pending (reported at completion)"
                : "No token usage recorded"
            }
          >
            <Coins size={9} className="shrink-0" />
            {tokensTotalRuns > 0 ? <span>unknown</span> : "—"}
          </span>
        )}
      </div>
    </div>
  );
}
