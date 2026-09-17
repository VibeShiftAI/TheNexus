"use client";

import { useCallback, useRef, useState } from "react";
import { PauseCircle, PlayCircle } from "lucide-react";

type AutonomyState = {
  paused: boolean;
  flag: { paused: boolean; since?: string; requestedBy?: string; by?: string; reason?: string } | null;
  inFlight: { taskId: string; title?: string; executor: string; startedAt?: string }[];
};

function validState(value: unknown): value is AutonomyState {
  if (!value || typeof value !== "object") return false;
  const state = value as AutonomyState;
  return typeof state.paused === "boolean" && Array.isArray(state.inFlight)
    && state.inFlight.every(run => run && typeof run.taskId === "string" && typeof run.executor === "string"
      && [run.title, run.startedAt].every(value => value === undefined || typeof value === "string"))
    && (state.flag === null || (typeof state.flag === "object" && typeof state.flag.paused === "boolean"
      && [state.flag.since, state.flag.requestedBy, state.flag.by, state.flag.reason].every(value => value === undefined || typeof value === "string")));
}

/** Shares the page's refresh path; never adds another polling loop. */
export function useAutonomyControl(onMessage: (message: string) => void) {
  const [autonomy, setAutonomy] = useState<AutonomyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const requestVersion = useRef(0);

  const read = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const res = await fetch("/api/praxis/autonomy", { cache: "no-store" });
      if (!res.ok) throw new Error(`Autonomy unavailable (${res.status})`);
      const data: unknown = await res.json();
      if (!validState(data)) throw new Error("Invalid autonomy state from Praxis");
      if (version === requestVersion.current) { setAutonomy(data); setError(null); }
      return data;
    } catch (e) {
      if (version === requestVersion.current) {
        setAutonomy(null);
        setError(e instanceof Error ? `Autonomy unavailable: ${e.message}` : "Autonomy unavailable");
      }
      return null;
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!acting.current) await read();
  }, [read]);

  const toggle = useCallback(async () => {
    if (!autonomy || acting.current) return;
    const action = autonomy.paused ? "resume" : "pause";
    acting.current = true;
    ++requestVersion.current; // Ignore telemetry requested before this action.
    setBusy(true);
    let accepted = false;
    let failure = "";
    try {
      const res = await fetch(`/api/praxis/autonomy/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "pause" ? { by: "Robert", reason: "ops_console" } : { by: "Robert" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      accepted = true;
    } catch (e) {
      failure = e instanceof Error ? e.message : "Praxis unreachable";
    }
    // Even an unsuccessful transport may have reached the server. Re-read
    // rather than guessing whether the flag changed or reverting optimistically.
    const confirmed = await read();
    if (!accepted) onMessage(`Autonomy ${action} failed: ${failure}.${confirmed ? " State refreshed from Praxis." : " Current state could not be verified."}`);
    else if (!confirmed) onMessage(`Autonomy ${action} accepted; could not verify current state. Refresh to retry.`);
    else if (confirmed.paused !== (action === "pause")) onMessage(`Autonomy ${action} accepted, but Praxis now reports ${confirmed.paused ? "PAUSED" : "RUNNING"}.`);
    else onMessage(action === "pause" ? "Autonomy paused. In-flight runs continue finishing." : "Autonomy resumed.");
    acting.current = false;
    setBusy(false);
  }, [autonomy, onMessage, read]);

  return { autonomy, error, busy, toggle, refresh };
}

export function AutonomyControl({ autonomy, error, busy, toggle }: ReturnType<typeof useAutonomyControl>) {
  const paused = autonomy?.paused === true;
  const label = autonomy ? (paused ? "PAUSED" : "RUNNING") : "UNKNOWN";
  const flag = autonomy?.flag;
  return (
    <section aria-label="Fleet autonomy" className={`min-w-0 rounded-lg border px-3 py-2 ${paused ? "border-red-500/70 bg-red-500/15 text-red-200" : "border-slate-700 bg-slate-900/70 text-cyan-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-bold tracking-wide" role="status">AUTONOMY {label}</div>
        <button type="button" onClick={toggle} disabled={busy || !autonomy}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${paused ? "border-red-400 bg-red-500/20 hover:bg-red-500/30" : "border-cyan-600 bg-cyan-500/10 hover:bg-cyan-500/20"}`}>
          {paused ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
          {busy ? "Updating…" : paused ? "Resume autonomy" : "Pause autonomy"}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
      {paused && <div className="mt-2 space-y-1 text-xs">
        <p>Since {flag?.since ? <time dateTime={flag.since}>{flag.since}</time> : "unknown"} · By {flag?.requestedBy || flag?.by || "unknown"}{flag?.reason ? ` · ${flag.reason}` : ""}</p>
        <p className="font-semibold">Paused — {autonomy.inFlight.length} {autonomy.inFlight.length === 1 ? "run still" : "runs still"} finishing.</p>
        <p>Pausing does not kill in-flight runs.</p>
        {autonomy.inFlight.length > 0 && <ul className="max-h-28 space-y-1 overflow-y-auto">
          {autonomy.inFlight.map((run, index) => <li key={`${run.taskId}:${index}`} className="break-words">{run.title || run.taskId} · {run.executor}{run.startedAt ? ` · Started ${run.startedAt}` : ""}</li>)}
        </ul>}
      </div>}
    </section>
  );
}
