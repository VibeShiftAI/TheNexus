/**
 * PraxisCore — the bridge "main viewer": the living core orb (shared with
 * ambient mode via CoreCanvas) with live stat readouts and the thinking
 * trace on the left, and the Praxis terminal embedded as the viewscreen
 * beside it — presence and conversation are one station. The viewscreen is
 * kept dashboard-sized; a maximize toggle blows it up to full screen without
 * losing conversation state. Crew chips click through to executor telemetry.
 */
"use client";

import { useState } from "react";
import { Radio, Maximize2, Minimize2 } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { useCrewActivity } from "@/hooks/use-crew-activity";
import { CoreCanvas, CORE_STYLES } from "@/components/bridge/core-canvas";
import { HudPanel, HudErrorBoundary } from "@/components/bridge/hud";
import { ExecutorDetailModal, type ExecutorId } from "@/components/bridge/executor-detail";
import { AITerminal } from "@/components/ai-terminal";
import { NowStrip } from "@/components/bridge/now-strip";
import type { PresenceActivity } from "@praxis/contract";

const CREW_DOT: Record<string, string> = {
  active: "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)] motion-safe:animate-pulse",
  done: "bg-emerald-400",
  failed: "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]",
  idle: "bg-slate-700",
};

function fmtTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PraxisCore() {
  const { presence, recentEvents, connected } = usePraxisStream();
  const { crew } = useCrewActivity();
  const [viewscreenMax, setViewscreenMax] = useState(false);
  const [inspecting, setInspecting] = useState<ExecutorId | null>(null);
  const activity: PresenceActivity = connected ? (presence?.activity ?? "offline") : "offline";
  const style = CORE_STYLES[activity];
  const busyCrew = crew.filter((m) => m.state === "active").length;

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
    <HudPanel
      icon={<Radio size={16} />}
      title="MAIN VIEWER — PRAXIS CORE"
      accent="cyan"
      className="overflow-hidden"
      headerRight={
        <>
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${
              connected
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                : "border-amber-400/40 bg-amber-400/10 text-amber-200"
            }`}
          >
            {connected ? "live" : "reconnecting"}
          </span>
          <button
            onClick={() => setViewscreenMax((v) => !v)}
            className="rounded-md border border-slate-800 bg-slate-900/60 p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label={viewscreenMax ? "Restore viewscreen" : "Maximize viewscreen"}
            title={viewscreenMax ? "Restore viewscreen" : "Maximize viewscreen"}
          >
            {viewscreenMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </>
      }
    >
      {/* Live "now" heartbeat — active model, task, and token counter */}
      <NowStrip />

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Core column — presence, vitals, thought stream */}
        <div className="flex w-full shrink-0 flex-col items-center lg:w-[240px]">
          <CoreCanvas activity={activity} size={150} />

          <div className={`text-lg font-bold tracking-tight ${style.textClass}`}>{style.label}</div>
          <div className="mt-0.5 line-clamp-2 text-center text-[11px] text-slate-400" title={presence?.summary}>
            {presence?.summary ?? (connected ? "Connecting…" : "Signal lost — attempting to re-establish link")}
          </div>

          {stats.length > 0 && (
            <div className="mt-2.5 grid w-full grid-cols-2 gap-1.5">
              {stats.map((s) => (
                <div key={s.label} className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{s.label}</div>
                  <div className="text-[13px] font-semibold tabular-nums text-slate-200">{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Crew — the other pairs of hands: CLI executors + local LLM.
              Praxis can be idle while the crew works his dispatched tasks.
              Each chip opens the executor drill-down. */}
          <div className="mt-2.5 w-full">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wide text-slate-600">crew</span>
              {busyCrew > 0 && (
                <span className="text-[10px] font-semibold text-cyan-400">{busyCrew} working</span>
              )}
            </div>
            <div className="grid w-full grid-cols-2 gap-1.5">
              {crew.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setInspecting(m.id as ExecutorId)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors hover:border-slate-600 ${
                    m.state === "active"
                      ? "border-cyan-500/30 bg-cyan-500/5"
                      : m.state === "failed"
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-slate-800 bg-slate-950/50"
                  }`}
                  title={`${m.label}${m.detail ? `: ${m.detail}` : ""} — click for telemetry`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CREW_DOT[m.state]}`} />
                  <div className="min-w-0">
                    <div className={`truncate text-[10px] font-medium ${m.state === "idle" ? "text-slate-500" : "text-slate-200"}`}>
                      {m.label}
                    </div>
                    <div className={`truncate text-[9px] ${m.state === "active" ? "text-cyan-400" : m.state === "failed" ? "text-red-400" : "text-slate-600"}`}>
                      {m.detail ?? m.state}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {traceText && (activity === "thinking" || activity === "executing") && (
            <div className="mt-2.5 max-h-16 w-full overflow-hidden rounded-md border border-slate-800/60 bg-slate-950/60 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-600">thought stream</div>
              <p className="truncate font-mono text-[11px] leading-relaxed text-slate-500" title={traceText}>
                {traceText}
              </p>
            </div>
          )}
        </div>

        {/* Viewscreen — the Praxis terminal, part of the core station. The
            terminal renders frameless in inline mode, so here it's just a
            divided region of the panel; the maximized state supplies its own
            chrome. Same DOM node in both sizes so the conversation survives
            the toggle. */}
        {viewscreenMax && (
          <div
            className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
            onClick={() => setViewscreenMax(false)}
            aria-hidden
          />
        )}
        <div
          className={
            viewscreenMax
              ? "hud-scanlines fixed inset-4 z-[71] flex flex-col rounded-lg border border-slate-700 bg-slate-950/95 p-4 shadow-2xl"
              : "flex h-[420px] min-w-0 flex-1 flex-col border-t border-slate-800/70 pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
          }
        >
          <HudErrorBoundary label="viewscreen">
            <AITerminal mode="inline" />
          </HudErrorBoundary>
          {viewscreenMax && (
            <button
              onClick={() => setViewscreenMax(false)}
              className="absolute -top-2 -right-2 rounded-full border border-slate-700 bg-slate-900 p-1.5 text-slate-300 shadow-lg transition-colors hover:bg-slate-800 hover:text-white"
              aria-label="Restore viewscreen"
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>
      </div>

      {inspecting && <ExecutorDetailModal executor={inspecting} onClose={() => setInspecting(null)} />}
    </HudPanel>
  );
}
