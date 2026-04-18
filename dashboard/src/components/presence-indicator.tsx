/**
 * PresenceIndicator — compact live view of "what is Praxis doing right now."
 * Driven by the Phase 3 SSE stream via usePraxisStream().
 */
"use client";

import { usePraxisStream } from "@/hooks/use-praxis-stream";
import type { PresenceActivity } from "@praxis/contract";

type PresenceVisualState = {
  label: string;
  coreClass: string;
  haloClass: string;
  orbitClass: string;
  markerClass: string;
  motionClass: string;
  textClass: string;
  connectionLabel: string;
  connectionClass: string;
};

const ACTIVITY_STYLES: Record<PresenceActivity, Omit<PresenceVisualState, "connectionLabel" | "connectionClass">> = {
  idle: {
    label: "Idle",
    coreClass: "bg-cyan-300 shadow-[0_0_16px_rgba(103,232,249,0.45)]",
    haloClass: "border-cyan-300/30 bg-cyan-300/5 animate-pulse",
    orbitClass: "border-cyan-200/50",
    markerClass: "bg-cyan-200/40",
    motionClass: "animate-[pulse_2.2s_ease-in-out_infinite]",
    textClass: "text-cyan-100",
  },
  thinking: {
    label: "Thinking",
    coreClass: "bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.7)] animate-pulse",
    haloClass: "border-sky-300/50 bg-sky-400/10",
    orbitClass: "border-sky-200/70",
    markerClass: "bg-violet-300/80 shadow-[0_0_10px_rgba(196,181,253,0.7)]",
    motionClass: "animate-[spin_1.1s_linear_infinite]",
    textClass: "text-sky-100",
  },
  executing: {
    label: "Executing",
    coreClass: "bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.65)] animate-pulse",
    haloClass: "border-emerald-300/50 bg-emerald-400/10",
    orbitClass: "border-emerald-200/70",
    markerClass: "bg-lime-200/85 shadow-[0_0_10px_rgba(217,249,157,0.75)]",
    motionClass: "animate-[spin_0.65s_linear_infinite]",
    textClass: "text-emerald-100",
  },
  waiting: {
    label: "Waiting",
    coreClass: "bg-amber-300 shadow-[0_0_16px_rgba(252,211,77,0.55)]",
    haloClass: "border-amber-300/45 bg-amber-300/10 animate-pulse",
    orbitClass: "border-amber-200/60",
    markerClass: "bg-amber-100/70",
    motionClass: "animate-[pulse_1.25s_ease-in-out_infinite]",
    textClass: "text-amber-100",
  },
  sleeping: {
    label: "Sleeping",
    coreClass: "bg-indigo-300 shadow-[0_0_16px_rgba(165,180,252,0.45)]",
    haloClass: "border-indigo-300/35 bg-indigo-300/10",
    orbitClass: "border-indigo-200/40",
    markerClass: "bg-fuchsia-200/45",
    motionClass: "animate-[pulse_3s_ease-in-out_infinite]",
    textClass: "text-indigo-100",
  },
  blocked: {
    label: "Blocked",
    coreClass: "bg-rose-500 shadow-[0_0_18px_rgba(244,63,94,0.7)] animate-pulse",
    haloClass: "border-rose-400/50 bg-rose-500/10",
    orbitClass: "border-rose-200/70",
    markerClass: "bg-red-200/80",
    motionClass: "animate-[ping_1s_cubic-bezier(0,0,0.2,1)_infinite]",
    textClass: "text-rose-100",
  },
  offline: {
    label: "Offline",
    coreClass: "bg-zinc-500 shadow-[0_0_10px_rgba(113,113,122,0.35)]",
    haloClass: "border-zinc-500/40 bg-zinc-500/10",
    orbitClass: "border-zinc-400/40",
    markerClass: "bg-zinc-300/30",
    motionClass: "",
    textClass: "text-zinc-200",
  },
};

export function getPresenceVisualState(activity: PresenceActivity, connected: boolean): PresenceVisualState {
  return {
    ...ACTIVITY_STYLES[activity],
    connectionLabel: connected ? "live" : "reconnecting",
    connectionClass: connected
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
      : "border-amber-400/40 bg-amber-400/10 text-amber-200",
  };
}

export function PresenceIndicator({ className = "" }: { className?: string }) {
  const { presence, connected } = usePraxisStream();
  const activity = presence?.activity ?? "offline";
  const style = getPresenceVisualState(activity, connected);
  const summary = presence?.summary ?? (connected ? "Connecting…" : "Disconnected");
  const nextWake = presence?.nextWakeAt ? new Date(presence.nextWakeAt).toLocaleTimeString() : null;

  return (
    <div className={`flex items-center gap-3 text-xs ${className}`}>
      <div key={activity} className="relative grid h-12 w-12 shrink-0 place-items-center" aria-hidden="true">
        <span className={`absolute inset-1 rounded-full border ${style.haloClass}`} />
        <span className={`absolute inset-0 rounded-full border border-dashed ${style.orbitClass}`} />
        <span className={`absolute inset-0 rounded-full ${style.motionClass}`}>
          <span className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full ${style.markerClass}`} />
        </span>
        <span className={`h-4 w-4 rounded-full ${style.coreClass}`} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className={`font-semibold ${style.textClass}`}>{style.label}</span>
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${style.connectionClass}`}>
            {style.connectionLabel}
          </span>
        </div>
        <div className="truncate text-slate-400">{summary}</div>
        {nextWake && activity === "sleeping" && (
          <div className="mt-0.5 text-slate-500">wakes {nextWake}</div>
        )}
      </div>
    </div>
  );
}
