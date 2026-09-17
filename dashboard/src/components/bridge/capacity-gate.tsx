"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, Gauge } from "lucide-react";
import { gateStatusLabel, type CliLaneGate } from "@/lib/cli-lane";
import { HudModal, HudStat } from "./hud";

export function CapacityGate({ gate }: { gate: CliLaneGate }) {
  const [expanded, setExpanded] = useState(false);
  const label = gateStatusLabel(gate);
  const known = gate.limit != null;
  const limited = gate.burst === false || gate.saturated;
  const color = !known ? "#94a3b8" : limited ? "#fbbf24" : "#22d3ee";
  const mode = gate.burst === true ? "Burst" : gate.limit === 1 ? "Serial" : "Capacity";
  const segments = known ? Math.min(12, Math.max(0, Math.floor(gate.limit!))) : 0;
  const running = gate.active;

  return (
    <>
      <button
        type="button"
        aria-label={`Inspect executor capacity: ${gate.limit ?? "unknown"} at a time. ${label}`}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        onClick={() => setExpanded(true)}
        className="group relative w-full overflow-hidden rounded-xl border border-slate-700/70 bg-slate-950/80 px-3 py-2.5 text-left transition hover:border-slate-500 focus-visible:outline-2 focus-visible:outline-cyan-300"
      >
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-10" style={{background: `radial-gradient(ellipse at 0% 50%, ${color}, transparent 70%)`}} />
        <span className="relative flex items-center gap-3">
          <span aria-hidden="true" className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full border border-slate-700/60 bg-slate-950/80">
            <span className="absolute inset-1 rounded-full border-2 border-dotted opacity-60" style={{borderColor: color}} />
            <span className="text-2xl font-semibold tabular-nums" style={{color, textShadow: `0 0 18px ${color}55`}}>{gate.limit ?? "—"}</span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Gate</span>
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider" style={{color}}>{mode}<ChevronRight size={12} className="transition-transform group-hover:translate-x-0.5" /></span>
            </span>
            <span className="mt-0.5 block text-sm font-medium text-slate-200">{label}</span>
            <span className="mt-0.5 block text-[11px] text-slate-500">{known ? `${gate.limit} at a time` : "Capacity unreported"}</span>
          </span>
        </span>
        {segments > 0 && (
          <span aria-hidden="true" className="relative mt-2.5 flex gap-1">
            {Array.from({length: segments}, (_, index) => {
              const occupied = running != null && index < Math.min(running, gate.limit!);
              return <span key={index} className={`h-1 min-w-0 flex-1 rounded-full ${occupied ? "bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.5)] motion-safe:animate-pulse" : "bg-slate-700/70"}`} />;
            })}
          </span>
        )}
        <span className="relative mt-1.5 flex items-center justify-between gap-2 text-[10px] tabular-nums text-slate-500">
          <span>{running != null ? `${running} running` : "Occupancy unreported"}</span>
          <span>{gate.queued != null ? `${gate.queued} queued` : "Queue unreported"}</span>
        </span>
      </button>
      {expanded && (
        <CapacityGateDetails gate={gate} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

export function CapacityGateDetails({ gate, onClose }: { gate: CliLaneGate; onClose: () => void }) {
  const label = gateStatusLabel(gate);
  const limited = gate.burst === false || gate.saturated;
  const running = gate.active;
  return (
        <HudModal title="Executor capacity" subtitle="Praxis dispatch gate" icon={<Gauge size={16} />} accent={limited ? "amber" : "cyan"} onClose={onClose}>
          <div className="space-y-4">
            <div>
              <p className="text-lg font-semibold text-slate-100">{label}</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">Praxis adjusts how many command-line executors can run together using the schedule and machine resources. Each executor also has its own slot limit.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <HudStat label="At a time" value={gate.limit ?? "—"} />
              <HudStat label="Running" value={running ?? "—"} tone="text-cyan-300" />
              <HudStat label="Free slots" value={gate.free ?? "—"} />
              <HudStat label="Queued" value={gate.queued ?? "—"} />
            </div>
            {gate.readouts.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{gate.readouts.map(readout => <div key={readout.label} title={readout.title}><HudStat label={readout.label} value={readout.value} /></div>)}</div>}
            <p className="text-xs leading-relaxed text-slate-500">A lower cap holds new starts while existing runs finish. Burst mode permits parallel work when the configured conditions allow it.</p>
            <details className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-300 focus-visible:outline-2 focus-visible:outline-cyan-300">Full gate report</summary>
              <p className="mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-400">{gate.reason ?? "Praxis has not reported a decision reason."}</p>
            </details>
            <Link href="/ops" className="flex items-center gap-1 text-xs text-cyan-300 hover:text-white">Open Ops console <ArrowUpRight size={13} /></Link>
          </div>
        </HudModal>
  );
}
