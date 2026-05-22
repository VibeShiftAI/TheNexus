/**
 * PraxisStatusPanel — combined "what is Praxis doing" status + actionable
 * input requests, sized to sit directly under the Praxis terminal on the
 * main dashboard. Status is driven by the live SSE presence stream; the
 * action surface is the HITL inbox (the only operator action Praxis exposes).
 */
"use client";

import { Cpu } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { getPresenceVisualState } from "@/components/presence-indicator";
import { HitlInbox } from "@/components/hitl-inbox";

function fmtTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PraxisStatusPanel() {
  const { presence, connected } = usePraxisStream();
  const activity = presence?.activity ?? "offline";
  const style = getPresenceVisualState(activity, connected);
  const summary = presence?.summary ?? (connected ? "Connecting…" : "Disconnected");

  const stats = (
    [
      { label: "Scheduled", value: presence?.scheduledTaskCount },
      { label: "Done today", value: presence?.completedTasksToday },
      { label: "Calls left", value: presence?.budget?.dailyCallsRemaining },
      { label: "Next wake", value: fmtTime(presence?.nextWakeAt) },
    ] as { label: string; value: number | string | null | undefined }[]
  ).filter((s): s is { label: string; value: number | string } => s.value !== undefined && s.value !== null);

  return (
    <div className="space-y-4">
      {/* Live status */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-cyan-400" />
            <h3 className="text-sm font-bold tracking-tight text-white">PRAXIS STATUS</h3>
          </div>
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${style.connectionClass}`}>
            {style.connectionLabel}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 shrink-0 rounded-full ${style.coreClass}`} />
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${style.textClass}`}>{style.label}</div>
            <div className="truncate text-xs text-slate-400">{summary}</div>
          </div>
        </div>

        {stats.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{s.label}</div>
                <div className="text-sm font-semibold tabular-nums text-slate-200">{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions — pending input requests from Praxis */}
      <HitlInbox />
    </div>
  );
}
