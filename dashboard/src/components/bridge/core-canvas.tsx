/**
 * CoreCanvas — the living Praxis orb, extracted so the bridge card and the
 * fullscreen ambient mode share one renderer. Motion maps to presence
 * activity; honors prefers-reduced-motion by rendering a single static frame.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { PresenceActivity } from "@praxis/contract";

export interface CoreStyle {
  label: string;
  color: string;
  dim: string;
  particles: number;
  speed: number;
  pulse: number;
  textClass: string;
}

export const CORE_STYLES: Record<PresenceActivity, CoreStyle> = {
  idle: { label: "Idle", color: "#22d3ee", dim: "#164e63", particles: 22, speed: 0.25, pulse: 0.06, textClass: "text-cyan-300" },
  thinking: { label: "Thinking", color: "#a78bfa", dim: "#4c1d95", particles: 44, speed: 1.1, pulse: 0.1, textClass: "text-violet-300" },
  executing: { label: "Executing", color: "#34d399", dim: "#065f46", particles: 36, speed: 1.9, pulse: 0.12, textClass: "text-emerald-300" },
  waiting: { label: "Waiting on you", color: "#fbbf24", dim: "#78350f", particles: 18, speed: 0.4, pulse: 0.1, textClass: "text-amber-300" },
  sleeping: { label: "Sleeping", color: "#60a5fa", dim: "#1e3a5f", particles: 10, speed: 0.06, pulse: 0.03, textClass: "text-blue-300" },
  blocked: { label: "Blocked", color: "#f87171", dim: "#7f1d1d", particles: 28, speed: 0.6, pulse: 0.2, textClass: "text-red-300" },
  offline: { label: "Offline", color: "#64748b", dim: "#1e293b", particles: 6, speed: 0.02, pulse: 0.0, textClass: "text-slate-400" },
};

export function CoreCanvas({ activity, size = 210 }: { activity: PresenceActivity; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const styleRef = useRef(CORE_STYLES[activity]);
  styleRef.current = CORE_STYLES[activity];
  const [reducedMotion, setReducedMotion] = useState(false);

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

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const cx = size / 2;
    const cy = size / 2;
    const scale = size / 210;

    // Stable per-particle randomness so re-renders don't scramble the swarm.
    const seeds = Array.from({ length: 64 }, (_, i) => ({
      angle: (i / 64) * Math.PI * 2 + Math.sin(i * 7.3) * 0.5,
      radius: (52 + ((i * 37) % 34)) * scale,
      wobble: 0.5 + ((i * 13) % 10) / 10,
      size: (1 + ((i * 29) % 20) / 14) * Math.max(1, scale * 0.8),
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

      const glow = ctx.createRadialGradient(cx, cy, 8 * scale, cx, cy, 100 * scale);
      glow.addColorStop(0, `${s.color}33`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = `${s.color}2e`;
      ctx.lineWidth = 1;
      for (const r of [56, 74, 92]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (let i = 0; i < s.particles; i++) {
        const seed = seeds[i % seeds.length];
        angles[i % angles.length] += dt * s.speed * seed.wobble;
        const a = angles[i % angles.length];
        const r = seed.radius + Math.sin(t * 1.4 + i) * 3 * scale;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        ctx.beginPath();
        ctx.arc(x, y, seed.size, 0, Math.PI * 2);
        ctx.fillStyle = i % 3 === 0 ? s.color : `${s.color}88`;
        ctx.fill();
      }

      const pulse = 1 + Math.sin(t * (s.speed > 1 ? 5 : 2)) * s.pulse;
      const coreR = 26 * scale * pulse;
      const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreR);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(0.35, s.color);
      core.addColorStop(1, s.dim);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, coreR + 5 * scale, 0, Math.PI * 2);
      ctx.strokeStyle = `${s.color}66`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="shrink-0"
      role="img"
      aria-label={`Praxis core status: ${CORE_STYLES[activity].label}`}
    />
  );
}
