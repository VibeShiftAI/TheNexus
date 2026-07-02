/**
 * PraxisCore — the bridge "main viewer": the living core orb (shared with
 * ambient mode via CoreCanvas), live stat readouts, and the latest thinking
 * trace from the stream. Replaces the static PraxisStatusPanel on the deck.
 */
"use client";

import { Radio } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { CoreCanvas, CORE_STYLES } from "@/components/bridge/core-canvas";
import type { PresenceActivity } from "@praxis/contract";

function fmtTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PraxisCore() {
  const { presence, recentEvents, connected } = usePraxisStream();
  const activity: PresenceActivity = connected ? (presence?.activity ?? "offline") : "offline";
  const style = CORE_STYLES[activity];

  const lastTrace = recentEvents.find((e) => e.type === "thinking.trace");
  const traceText = lastTrace && lastTrace.type === "thinking.trace" ? lastTrace.content : presence?.thinkingTrace;

  const stats = (
    [
      { label: "Scheduled", value: presence?.scheduledTaskCount },
      { label: "Done today", value: presence?.completedTasksToday },
      { label: "Calls left", value: presence?.budget?.dailyCallsRemaining },
      { label: "Next wake", value: fmtTime(presence?.nextWakeAt) },
    ] as { label: string; value: number | string | null | undefined }[]
  ).filter((s): s is { label: string; value: number | string } => s.value !== undefined && s.value !== null);

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio size={16} className="text-cyan-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">MAIN VIEWER — PRAXIS CORE</h3>
        </div>
        <span
          className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${
            connected
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
              : "border-amber-400/40 bg-amber-400/10 text-amber-200"
          }`}
        >
          {connected ? "live" : "reconnecting"}
        </span>
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <CoreCanvas activity={activity} size={210} />

        <div className="min-w-0 flex-1 self-stretch py-2">
          <div className={`text-2xl font-bold tracking-tight ${style.textClass}`}>{style.label}</div>
          <div className="mt-1 text-sm text-slate-400">
            {presence?.summary ?? (connected ? "Connecting…" : "Signal lost — attempting to re-establish link")}
          </div>

          {stats.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{s.label}</div>
                  <div className="text-sm font-semibold tabular-nums text-slate-200">{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {traceText && (activity === "thinking" || activity === "executing") && (
            <div className="mt-3 max-h-16 overflow-hidden rounded-md border border-slate-800/60 bg-slate-950/60 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-600">thought stream</div>
              <p className="truncate font-mono text-[11px] leading-relaxed text-slate-500" title={traceText}>
                {traceText}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
