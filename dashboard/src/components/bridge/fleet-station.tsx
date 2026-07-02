/**
 * FleetStation — "Tactical": real liveness + latency for every crew-member
 * service, probed server-side by /api/fleet/health (browser can't reach
 * cross-origin local ports). Replaces decorative status text with signals
 * that are actually measured.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, ArrowUpRight } from "lucide-react";

export interface FleetService {
  id: string;
  label: string;
  port: number;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export function useFleetHealth(intervalMs = 20_000) {
  const [services, setServices] = useState<FleetService[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/fleet/health", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (active) {
          setServices(data.services ?? []);
          setErr(false);
        }
      } catch {
        if (active) setErr(true);
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { services, err };
}

function dotClass(s: FleetService) {
  if (!s.ok) return "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]";
  if ((s.latencyMs ?? 0) > 1500) return "bg-amber-400";
  return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)] motion-safe:animate-pulse";
}

export function FleetStation() {
  const { services, err } = useFleetHealth();
  const online = services?.filter((s) => s.ok).length ?? 0;
  const total = services?.length ?? 0;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-purple-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">TACTICAL — FLEET</h3>
          {services && (
            <span className={`text-[10px] font-semibold ${online === total ? "text-emerald-400" : "text-amber-400"}`}>
              {online}/{total} online
            </span>
          )}
        </div>
        <Link href="/agents" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          registry <ArrowUpRight size={12} />
        </Link>
      </div>

      {err && !services ? (
        <div className="py-4 text-center text-xs text-slate-500">Fleet probe unavailable</div>
      ) : !services ? (
        <div className="py-4 text-center text-xs text-slate-600">Scanning fleet…</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-[11px]" title={s.error ?? `HTTP ${s.status ?? "—"}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(s)}`} />
              <span className={`truncate ${s.ok ? "text-slate-300" : "text-slate-500"}`}>{s.label}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-slate-600">
                {s.ok && s.latencyMs != null ? `${s.latencyMs}ms` : s.ok ? ":" + s.port : "down"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
