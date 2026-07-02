/**
 * FleetStation — "Tactical": real liveness + latency for every crew-member
 * service, probed server-side by /api/fleet/health (browser can't reach
 * cross-origin local ports). Rendered as a sweeping radar scope — each blip
 * is a service, pulled toward the center the faster it responds. Click a
 * blip or roster row for the full probe readout with latency history
 * accumulated client-side across polls.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Users, ArrowUpRight, Radar } from "lucide-react";
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";

export interface FleetService {
  id: string;
  label: string;
  port: number;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export interface FleetSample {
  at: number;
  ok: boolean;
  latencyMs: number | null;
}

const HISTORY_CAP = 40;

export function useFleetHealth(intervalMs = 20_000) {
  const [services, setServices] = useState<FleetService[] | null>(null);
  const [err, setErr] = useState(false);
  // Rolling per-service probe history so drill-downs can chart latency.
  const historyRef = useRef<Record<string, FleetSample[]>>({});
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/fleet/health", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (active) {
          const list: FleetService[] = data.services ?? [];
          const now = Date.now();
          for (const s of list) {
            const h = (historyRef.current[s.id] ??= []);
            h.push({ at: now, ok: s.ok, latencyMs: s.latencyMs });
            if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
          }
          setServices(list);
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
  return { services, err, history: historyRef.current };
}

function dotClass(s: FleetService) {
  if (!s.ok) return "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]";
  if ((s.latencyMs ?? 0) > 1500) return "bg-amber-400";
  return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)] motion-safe:animate-pulse";
}

function blipColor(s: FleetService) {
  if (!s.ok) return "#f87171";
  if ((s.latencyMs ?? 0) > 1500) return "#fbbf24";
  return "#34d399";
}

/** Radar scope: rings + sweep beam + one blip per service. */
function FleetRadar({
  services,
  onSelect,
}: {
  services: FleetService[];
  onSelect: (s: FleetService) => void;
}) {
  const SIZE = 148;
  const c = SIZE / 2;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-full" style={{ width: SIZE, height: SIZE }}>
      {/* sweep beam */}
      <div
        className="pointer-events-none absolute inset-0 rounded-full motion-safe:animate-[hud-radar-sweep_4.5s_linear_infinite]"
        style={{ background: "conic-gradient(from 0deg, rgba(52,211,153,0.22), transparent 70deg)" }}
      />
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="relative">
        {[0.3, 0.55, 0.8].map((f) => (
          <circle key={f} cx={c} cy={c} r={c * f} fill="none" stroke="rgba(52,211,153,0.18)" strokeWidth="1" />
        ))}
        <line x1={c} y1={4} x2={c} y2={SIZE - 4} stroke="rgba(52,211,153,0.1)" strokeWidth="1" />
        <line x1={4} y1={c} x2={SIZE - 4} y2={c} stroke="rgba(52,211,153,0.1)" strokeWidth="1" />
        <circle cx={c} cy={c} r={2.5} fill="rgba(52,211,153,0.9)" />
        {services.map((s, i) => {
          // Bearing fixed per service; range grows with latency (down = rim).
          const angle = (i / services.length) * Math.PI * 2 - Math.PI / 2;
          const range = s.ok ? 0.28 + (Math.min(s.latencyMs ?? 0, 1500) / 1500) * 0.5 : 0.85;
          const x = c + Math.cos(angle) * c * range;
          const y = c + Math.sin(angle) * c * range;
          const color = blipColor(s);
          return (
            <g
              key={s.id}
              onClick={() => onSelect(s)}
              className="cursor-pointer"
              role="button"
              aria-label={`${s.label} details`}
            >
              <circle cx={x} cy={y} r={9} fill="transparent" />
              <circle cx={x} cy={y} r={5.5} fill={color} opacity={0.18} />
              <circle cx={x} cy={y} r={2.6} fill={color}>
                {s.ok && <animate attributeName="opacity" values="1;0.5;1" dur="2.4s" repeatCount="indefinite" />}
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Tiny latency history chart drawn from the client-side probe buffer. */
function LatencySparkline({ samples }: { samples: FleetSample[] }) {
  const W = 260;
  const H = 48;
  const pts = samples.filter((s) => s.ok && s.latencyMs != null);
  if (pts.length < 2) {
    return (
      <p className="rounded border border-dashed border-slate-800 px-2 py-2 text-center text-[10px] text-slate-600">
        latency trace builds as probes accumulate (every 20s)
      </p>
    );
  }
  const max = Math.max(...pts.map((p) => p.latencyMs!), 1);
  const line = pts
    .map((p, i) => `${(i / (pts.length - 1)) * W},${H - 4 - (p.latencyMs! / max) * (H - 10)}`)
    .join(" ");
  return (
    <div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polyline points={line} fill="none" stroke="#34d399" strokeWidth="1.5" />
        <polyline points={`0,${H} ${line} ${W},${H}`} fill="rgba(52,211,153,0.12)" stroke="none" />
      </svg>
      <div className="flex justify-between text-[9px] text-slate-600">
        <span>{Math.round((Date.now() - pts[0].at) / 60_000)} min ago</span>
        <span>peak {max}ms</span>
      </div>
    </div>
  );
}

export function FleetStation() {
  const { services, err, history } = useFleetHealth();
  const [selected, setSelected] = useState<FleetService | null>(null);
  const online = services?.filter((s) => s.ok).length ?? 0;
  const total = services?.length ?? 0;

  // Keep the popup's live fields fresh as polls land.
  const selectedLive = selected ? services?.find((s) => s.id === selected.id) ?? selected : null;
  const selectedSamples = selected ? history[selected.id] ?? [] : [];
  const uptimePct =
    selectedSamples.length > 0
      ? Math.round((selectedSamples.filter((s) => s.ok).length / selectedSamples.length) * 100)
      : null;

  return (
    <HudPanel
      icon={<Users size={16} />}
      title="TACTICAL — FLEET"
      accent="purple"
      headerRight={
        <>
          {services && (
            <span className={`text-[10px] font-semibold ${online === total ? "text-emerald-400" : "text-amber-400"}`}>
              {online}/{total} online
            </span>
          )}
          <Link href="/agents" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
            registry <ArrowUpRight size={12} />
          </Link>
        </>
      }
    >
      {err && !services ? (
        <div className="py-4 text-center text-xs text-slate-500">Fleet probe unavailable</div>
      ) : !services ? (
        <div className="py-4 text-center text-xs text-slate-600">Scanning fleet…</div>
      ) : (
        <div className="flex items-center gap-4">
          <FleetRadar services={services} onSelect={setSelected} />
          <div className="min-w-0 flex-1 space-y-1">
            {services.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-slate-800/50"
                title="Open probe readout"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(s)}`} />
                <span className={`truncate ${s.ok ? "text-slate-300" : "text-slate-500"}`}>{s.label}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-slate-600">
                  {s.ok && s.latencyMs != null ? `${s.latencyMs}ms` : s.ok ? ":" + s.port : "down"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedLive && (
        <HudModal
          title={selectedLive.label}
          subtitle={`service probe · port ${selectedLive.port}`}
          icon={<Radar size={15} />}
          accent={selectedLive.ok ? "emerald" : "red"}
          onClose={() => setSelected(null)}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <HudStat
                label="status"
                value={selectedLive.ok ? "online" : "down"}
                tone={selectedLive.ok ? "text-emerald-300" : "text-red-300"}
              />
              <HudStat label="latency" value={selectedLive.latencyMs != null ? `${selectedLive.latencyMs}ms` : "—"} />
              <HudStat label="http" value={selectedLive.status ?? "—"} />
            </div>
            {uptimePct != null && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={`h-full rounded-full ${uptimePct === 100 ? "bg-emerald-400" : uptimePct >= 90 ? "bg-amber-400" : "bg-red-400"}`}
                    style={{ width: `${uptimePct}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
                  {uptimePct}% of last {selectedSamples.length} probes
                </span>
              </div>
            )}
            {selectedLive.error ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-200">
                {selectedLive.error}
              </p>
            ) : null}
            <section>
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Latency trace
              </h4>
              <LatencySparkline samples={selectedSamples} />
            </section>
          </div>
        </HudModal>
      )}
    </HudPanel>
  );
}
