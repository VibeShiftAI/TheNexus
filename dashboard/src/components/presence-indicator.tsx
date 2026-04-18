/**
 * PresenceIndicator — compact live view of "what is Praxis doing right now."
 * Driven by the Phase 3 SSE stream via usePraxisStream().
 */
"use client";

import { usePraxisStream } from "@/hooks/use-praxis-stream";
import type { PresenceActivity } from "@praxis/contract";

const ACTIVITY_STYLES: Record<PresenceActivity, { dot: string; label: string }> = {
  idle:      { dot: "bg-slate-400",       label: "Idle" },
  thinking:  { dot: "bg-sky-400 animate-pulse",   label: "Thinking" },
  executing: { dot: "bg-emerald-500 animate-pulse", label: "Executing" },
  waiting:   { dot: "bg-amber-400",       label: "Waiting" },
  sleeping:  { dot: "bg-indigo-400",      label: "Sleeping" },
  blocked:   { dot: "bg-rose-500 animate-pulse",  label: "Blocked" },
  offline:   { dot: "bg-zinc-600",        label: "Offline" },
};

export function PresenceIndicator({ className = "" }: { className?: string }) {
  const { presence, connected } = usePraxisStream();
  const activity = presence?.activity ?? "offline";
  const style = ACTIVITY_STYLES[activity];
  const summary = presence?.summary ?? (connected ? "Connecting…" : "Disconnected");
  const nextWake = presence?.nextWakeAt ? new Date(presence.nextWakeAt).toLocaleTimeString() : null;

  return (
    <div className={`flex items-center gap-2 text-xs ${className}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
      <span className="font-medium">{style.label}</span>
      <span className="text-muted-foreground truncate max-w-[24ch]">{summary}</span>
      {nextWake && activity === "sleeping" && (
        <span className="text-muted-foreground">· wakes {nextWake}</span>
      )}
      {!connected && (
        <span className="text-muted-foreground italic">(offline)</span>
      )}
    </div>
  );
}
