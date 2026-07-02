/**
 * PraxisCore — the bridge "main viewer": a living canvas orb whose motion
 * tracks Praxis's presence (idle breathes, thinking swirls, executing races,
 * blocked pulses red), ringed by live stat readouts and the latest thinking
 * trace. Replaces the static PraxisStatusPanel on the command deck.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import type { PresenceActivity } from "@praxis/contract";

interface CoreStyle {
  label: string;
  color: string;
  dim: string;
  particles: number;
  speed: number;
  pulse: number;
  textClass: string;
}

const CORE_STYLES: Record<PresenceActivity, CoreStyle> = {
  idle: { label: "Idle", color: "#22d3ee", dim: "#164e63", particles: 22, speed: 0.25, pulse: 0.06, textClass: "text-cyan-300" },
  thinking: { label: "Thinking", color: "#a78bfa", dim: "#4c1d95", particles: 44, speed: 1.1, pulse: 0.1, textClass: "text-violet-300" },
  executing: { label: "Executing", color: "#34d399", dim: "#065f46", particles: 36, speed: 1.9, pulse: 0.12, textClass: "text-emerald-300" },
  waiting: { label: "Waiting on you", color: "#fbbf24", dim: "#78350f", particles: 18, speed: 0.4, pulse: 0.1, textClass: "text-amber-300" },
  sleeping: { label: "Sleeping", color: "#60a5fa", dim: "#1e3a5f", particles: 10, speed: 0.06, pulse: 0.03, textClass: "text-blue-300" },
  blocked: { label: "Blocked", color: "#f87171", dim: "#7f1d1d", particles: 28, speed: 0.6, pulse: 0.2, textClass: "text-red-300" },
  offline: { label: "Offline", color: "#64748b", dim: "#1e293b", particles: 6, speed: 0.02, pulse: 0.0, textClass: "text-slate-400" },
};

function fmtTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PraxisCore() {
  const { presence, recentEvents, connected } = usePraxisStream();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activity: PresenceActivity = connected ? (presence?.activity ?? "offline") : "offline";
  const style = CORE_STYLES[activity];
  const styleRef = useRef(style);
  styleRef.current = style;
  const [reducedMotion, setReducedMotion] = useState(false);

  const lastTrace = recentEvents.find((e) => e.type === "thinking.trace");
  const traceText = lastTrace && lastTrace.type === "thinking.trace" ? lastTrace.content : presence?.thinkingTrace;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = 210;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const cx = size / 2;
    const cy = size / 2;

    // Stable per-particle randomness so re-renders don't scramble the swarm.
    const seeds = Array.from({ length: 64 }, (_, i) => ({
      angle: (i / 64) * Math.PI * 2 + Math.sin(i * 7.3) * 0.5,
      radius: 52 + ((i * 37) % 34),
      wobble: 0.5 + ((i * 13) % 10) / 10,
      size: 1 + ((i * 29) % 20) / 14,
    }));

    let raf = 0;
    let last = performance.now();
    const angles = seeds.map((s) => s.angle);

    const draw = (now: number) => {
      const s = styleRef.current;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const t = now / 1000;
      ctx.clearRect(0, 0, size, size);

      // Outer glow
      const glow = ctx.createRadialGradient(cx, cy, 8, cx, cy, 100);
      glow.addColorStop(0, `${s.color}33`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // Orbit rings
      ctx.strokeStyle = `${s.color}2e`;
      ctx.lineWidth = 1;
      for (const r of [56, 74, 92]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Particles
      for (let i = 0; i < s.particles; i++) {
        const seed = seeds[i % seeds.length];
        angles[i % angles.length] += dt * s.speed * seed.wobble;
        const a = angles[i % angles.length];
        const r = seed.radius + Math.sin(t * 1.4 + i) * 3;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        ctx.beginPath();
        ctx.arc(x, y, seed.size, 0, Math.PI * 2);
        ctx.fillStyle = i % 3 === 0 ? s.color : `${s.color}88`;
        ctx.fill();
      }

      // Core
      const pulse = 1 + Math.sin(t * (s.speed > 1 ? 5 : 2)) * s.pulse;
      const coreR = 26 * pulse;
      const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreR);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(0.35, s.color);
      core.addColorStop(1, s.dim);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      // Core rim
      ctx.beginPath();
      ctx.arc(cx, cy, coreR + 5, 0, Math.PI * 2);
      ctx.strokeStyle = `${s.color}66`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

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
        <canvas
          ref={canvasRef}
          style={{ width: 210, height: 210 }}
          className="shrink-0"
          role="img"
          aria-label={`Praxis core status: ${style.label}`}
        />

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
