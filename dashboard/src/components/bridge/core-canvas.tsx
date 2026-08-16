/**
 * CoreCanvas — the living Praxis orb, extracted so the bridge card and the
 * fullscreen ambient mode share one renderer.
 *
 * The orb renders the fused CoreState (lib/core-state.ts), not just presence,
 * with a distinct animation vocabulary per activity:
 *
 *   - ambient swarm     baseline aliveness; count/speed follow presence
 *   - worker comets     one per active executor, identity-colored, with a
 *                       fading trail; they decelerate emerald on success,
 *                       jitter red on failure, and fade out
 *   - council ring      live deliberations form a rotating ring of seat
 *                       sprites around the core: running seats pulse and shed
 *                       "idea motes" that stream into the orb; at synthesis
 *                       the flow reverses into converging rings while the
 *                       aggregator seat flares; the verdict radiates outward
 *   - waiting beacon    amber radar pings while Praxis waits on Robert
 *   - event ripples     task completions (emerald), failures (red + swarm
 *                       kick), HITL (amber, in/out), council verdicts
 *   - trace sparks      tiny white flecks shed while thinking/executing
 *
 * Honors prefers-reduced-motion by rendering a static — but still fully
 * informative — frame per state change: seats, comet positions, and colors
 * all render; only the motion stops.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { PresenceActivity } from "@praxis/contract";
import type { CoreState, CorePulse, CouncilKind } from "@/lib/core-state";

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

/**
 * Style lookup that cannot take the route down. `presence.activity` arrives
 * over SSE as an unvalidated cast (see use-praxis-stream), so an activity the
 * dashboard doesn't know about would make a bare `CORE_STYLES[activity]`
 * lookup undefined — and every reader immediately does `.label`/`.textClass`
 * on it, during render. An unknown state falls back to "offline", which is
 * also the honest reading: we don't know what Praxis is doing.
 */
export function coreStyle(activity: PresenceActivity | string | undefined): CoreStyle {
  return CORE_STYLES[activity as PresenceActivity] ?? CORE_STYLES.offline;
}

/** Identity colors for the crew — shared with the crew chips so a comet is
 *  visually the same being as its chip. */
export const EXECUTOR_COLORS: Record<string, string> = {
  "claude-code": "#fb923c",
  codex: "#38bdf8",
  antigravity: "#e879f9",
  "local-llm": "#a3e635",
};

const COUNCIL_COLORS: Record<CouncilKind, string> = {
  morning: "#fbbf24",
  status: "#22d3ee",
  summoned: "#a78bfa",
};

// ── Scene state (persists across frames, not across mounts) ─────────────

interface Comet {
  id: string;
  color: string;
  angle: number;
  radius: number; // current, eases toward target
  targetRadius: number;
  speed: number;
  trail: { x: number; y: number }[];
  mode: "arriving" | "active" | "done" | "failed";
  modeAt: number; // perf-clock ms of last mode change
  alpha: number;
}

interface Mote {
  seatIndex: number;
  bornAt: number;
  duration: number;
  bow: number; // perpendicular curve amplitude
}

interface Ripple {
  kind: CorePulse["kind"] | "beacon" | "converge";
  startedAt: number;
  color: string;
}

interface Spark {
  bornAt: number;
  angle: number;
  speed: number;
}

interface CouncilVis {
  sessionId: string;
  bornAt: number;
  /** Set when the council leaves state — seats disperse and fade. */
  dissolvedAt: number | null;
  rotation: number;
  lastMoteAt: number;
  lastConvergeAt: number;
}

interface Scene {
  angles: number[];
  comets: Map<string, Comet>;
  council: CouncilVis | null;
  lastCouncil: CoreState["council"];
  motes: Mote[];
  ripples: Ripple[];
  sparks: Spark[];
  seenPulses: Set<string>;
  primed: boolean;
  lastBeaconAt: number;
  lastSparkAt: number;
  turbulence: number; // 0..1, failure shockwave through the ambient swarm
  coreFlash: number; // 0..1, brief brightening when a mote lands etc.
}

function newScene(seedAngles: number[]): Scene {
  return {
    angles: [...seedAngles],
    comets: new Map(),
    council: null,
    lastCouncil: null,
    motes: [],
    ripples: [],
    sparks: [],
    seenPulses: new Set(),
    primed: false,
    lastBeaconAt: 0,
    lastSparkAt: 0,
    turbulence: 0,
    coreFlash: 0,
  };
}

const TAU = Math.PI * 2;
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

const SEAT_STATUS_ALPHA: Record<string, number> = { pending: 0.45, running: 1, success: 0.95, error: 0.8 };

const PULSE_COLORS: Record<CorePulse["kind"], string> = {
  "task-complete": "#34d399",
  "task-fail": "#f87171",
  "hitl-created": "#fbbf24",
  "hitl-resolved": "#fbbf24",
  "council-verdict": "#a78bfa",
  trace: "#e2e8f0",
};

// ── Renderer ─────────────────────────────────────────────────────────────

export function CoreCanvas({ state, size = 210 }: { state: CoreState; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sceneRef = useRef<Scene | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Reduced motion renders one static frame per state change; this key is
  // what "state change" means for that frame.
  const staticKey = reducedMotion
    ? JSON.stringify([
        state.activity,
        state.label,
        state.waiting,
        state.council?.phase,
        state.council?.seats,
        state.workers,
      ])
    : "";

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
      angle: (i / 64) * TAU + Math.sin(i * 7.3) * 0.5,
      radius: (52 + ((i * 37) % 34)) * scale,
      wobble: 0.5 + ((i * 13) % 10) / 10,
      size: (1 + ((i * 29) % 20) / 14) * Math.max(1, scale * 0.8),
    }));
    if (!sceneRef.current) sceneRef.current = newScene(seeds.map((s) => s.angle));
    const scene = sceneRef.current;

    let raf = 0;
    let last = performance.now();

    const seatPosition = (index: number, count: number, rotation: number, t: number, radius: number) => {
      const angle = rotation + (index / Math.max(count, 1)) * TAU - Math.PI / 2;
      const bob = Math.sin(t * 0.9 + index * 1.7) * 2 * scale;
      return { x: cx + Math.cos(angle) * (radius + bob), y: cy + Math.sin(angle) * (radius + bob), angle };
    };

    const draw = (now: number) => {
      const s = stateRef.current;
      const style = coreStyle(s.activity);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const t = now / 1000;
      const epochNow = Date.now();
      const councilColor = s.council ? COUNCIL_COLORS[s.council.kind] : COUNCIL_COLORS.summoned;
      const seatRingR = 84 * scale;

      // ── Ingest new pulses → ripples/sparks/turbulence ────────────
      // First frame primes without spawning so a page load doesn't replay
      // the last 50 events as a firework show.
      for (const pulse of s.pulses) {
        if (scene.seenPulses.has(pulse.id)) continue;
        scene.seenPulses.add(pulse.id);
        if (!scene.primed || reducedMotion || epochNow - pulse.at > 6_000) continue;
        if (pulse.kind === "trace") {
          if (now - scene.lastSparkAt > 300 && (s.activity === "thinking" || s.activity === "executing")) {
            scene.lastSparkAt = now;
            scene.sparks.push({ bornAt: now, angle: Math.random() * TAU, speed: (22 + Math.random() * 18) * scale });
          }
          continue;
        }
        scene.ripples.push({ kind: pulse.kind, startedAt: now, color: PULSE_COLORS[pulse.kind] });
        if (pulse.kind === "task-fail") scene.turbulence = 1;
        if (pulse.kind === "task-complete" || pulse.kind === "council-verdict") scene.coreFlash = 1;
      }
      scene.primed = true;
      if (scene.seenPulses.size > 400) {
        scene.seenPulses = new Set(s.pulses.map((p) => p.id));
      }
      scene.turbulence = Math.max(0, scene.turbulence - dt / 1.6);
      scene.coreFlash = Math.max(0, scene.coreFlash - dt / 1.1);

      ctx.clearRect(0, 0, size, size);

      // ── Backdrop glow ────────────────────────────────────────────
      const glowAlpha = 0.14 + s.intensity * 0.14;
      const glow = ctx.createRadialGradient(cx, cy, 8 * scale, cx, cy, 100 * scale);
      glow.addColorStop(0, `${style.color}${Math.round(glowAlpha * 255).toString(16).padStart(2, "0")}`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // ── Orbit rings ──────────────────────────────────────────────
      ctx.lineWidth = 1;
      for (const r of [56, 74, 92]) {
        ctx.strokeStyle = `${style.color}2e`;
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, TAU);
        ctx.stroke();
      }

      // ── Ambient swarm ────────────────────────────────────────────
      // Trimmed while a council sits so the formation reads as figures,
      // not noise; kicked outward briefly by a failure shockwave.
      const particleCount = Math.round(style.particles * (s.council ? 0.55 : 1));
      for (let i = 0; i < particleCount; i++) {
        const seed = seeds[i % seeds.length];
        scene.angles[i % scene.angles.length] += dt * style.speed * seed.wobble * (1 + scene.turbulence * 1.5);
        const a = scene.angles[i % scene.angles.length];
        const kick = scene.turbulence * Math.sin(i * 3.1 + t * 9) * 7 * scale;
        const r = seed.radius + Math.sin(t * 1.4 + i) * 3 * scale + kick;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, seed.size, 0, TAU);
        ctx.fillStyle = i % 3 === 0 ? style.color : `${style.color}88`;
        ctx.fill();
      }

      // ── Council formation ────────────────────────────────────────
      const liveCouncil = s.council;
      if (liveCouncil) {
        if (!scene.council || scene.council.sessionId !== liveCouncil.sessionId) {
          scene.council = { sessionId: liveCouncil.sessionId, bornAt: now, dissolvedAt: null, rotation: -Math.PI / 7, lastMoteAt: now, lastConvergeAt: now };
          scene.motes = [];
        }
        scene.council.dissolvedAt = null;
        scene.lastCouncil = liveCouncil;
      } else if (scene.council && scene.council.dissolvedAt === null) {
        // Under reduced motion there is no dissolve tween — the formation
        // simply isn't drawn on the next static frame.
        if (reducedMotion) {
          scene.council = null;
          scene.lastCouncil = null;
        } else {
          scene.council.dissolvedAt = now;
          scene.motes = [];
        }
      }

      const vis = scene.council;
      const drawnCouncil = liveCouncil ?? scene.lastCouncil;
      if (vis && drawnCouncil) {
        const dissolveP = vis.dissolvedAt ? Math.min((now - vis.dissolvedAt) / 1200, 1) : 0;
        if (dissolveP >= 1) {
          scene.council = null;
          scene.lastCouncil = null;
        } else {
          const birthP = reducedMotion ? 1 : easeOut(Math.min((now - vis.bornAt) / 700, 1));
          const kindColor = COUNCIL_COLORS[drawnCouncil.kind];
          const seats = drawnCouncil.seats;
          const inSynthesis = drawnCouncil.phase === "synthesis" || drawnCouncil.phase === "refinement";
          vis.rotation += dt * 0.06;
          // Birth: seats emanate from the orb to the ring. Dissolve: they
          // drift outward and fade — the council rises, then adjourns.
          const ringR = seatRingR * (birthP * (1 + dissolveP * 0.35));
          const formationAlpha = birthP * (1 - dissolveP);

          // Council's own orbit ring, brighter than the ambient ones.
          ctx.strokeStyle = `${kindColor}${inSynthesis ? "55" : "3a"}`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, ringR, 0, TAU);
          ctx.stroke();

          // Deliberation: running seats shed idea motes that stream inward.
          if (!vis.dissolvedAt && !reducedMotion && drawnCouncil.phase === "deliberation") {
            const runningSeats = seats.map((seat, i) => ({ seat, i })).filter(({ seat }) => seat.status === "running");
            if (runningSeats.length > 0 && now - vis.lastMoteAt > 700) {
              vis.lastMoteAt = now;
              const pick = runningSeats[Math.floor(Math.random() * runningSeats.length)];
              scene.motes.push({ seatIndex: pick.i, bornAt: now, duration: 1300 + Math.random() * 400, bow: (Math.random() - 0.5) * 26 * scale });
            }
          }
          // Synthesis: the flow reverses — rings converge into the core.
          if (!vis.dissolvedAt && !reducedMotion && inSynthesis && now - vis.lastConvergeAt > 900) {
            vis.lastConvergeAt = now;
            scene.ripples.push({ kind: "converge", startedAt: now, color: kindColor });
          }

          // Spokes.
          ctx.lineWidth = 1;
          for (let i = 0; i < seats.length; i++) {
            const pos = seatPosition(i, seats.length, vis.rotation, t, ringR);
            ctx.strokeStyle = `${kindColor}${inSynthesis ? "2e" : "14"}`;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(pos.angle) * 30 * scale, cy + Math.sin(pos.angle) * 30 * scale);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
          }

          // Motes.
          scene.motes = scene.motes.filter((m) => now - m.bornAt < m.duration);
          for (const mote of scene.motes) {
            const p = easeInOut((now - mote.bornAt) / mote.duration);
            const from = seatPosition(mote.seatIndex % seats.length, seats.length, vis.rotation, t, ringR);
            const toX = cx;
            const toY = cy;
            const mx = from.x + (toX - from.x) * p;
            const my = from.y + (toY - from.y) * p;
            const perpA = from.angle + Math.PI / 2;
            const bow = Math.sin(p * Math.PI) * mote.bow;
            const x = mx + Math.cos(perpA) * bow;
            const y = my + Math.sin(perpA) * bow;
            ctx.beginPath();
            ctx.arc(x, y, 1.6 * scale, 0, TAU);
            ctx.fillStyle = `${kindColor}cc`;
            ctx.fill();
            if (p > 0.93) scene.coreFlash = Math.min(scene.coreFlash + 0.12, 0.5);
          }

          // Seats.
          for (let i = 0; i < seats.length; i++) {
            const seat = seats[i];
            const pos = seatPosition(i, seats.length, vis.rotation, t, ringR);
            const statusAlpha = (SEAT_STATUS_ALPHA[seat.status] ?? 0.6) * formationAlpha;
            const baseR = (seat.aggregator ? 4.4 : 3.2) * scale;
            const seatColor = seat.status === "error" ? "#f87171" : kindColor;

            if (seat.status === "running") {
              const halo = 0.5 + Math.sin(t * 5.2 + i) * 0.5;
              ctx.beginPath();
              ctx.arc(pos.x, pos.y, baseR + (2.5 + halo * 3) * scale, 0, TAU);
              ctx.fillStyle = `${seatColor}${Math.round(halo * 45 * formationAlpha).toString(16).padStart(2, "0")}`;
              ctx.fill();
            }
            const flare = seat.aggregator && inSynthesis ? 0.75 + Math.sin(t * 6) * 0.25 : 1;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, baseR * flare, 0, TAU);
            if (seat.status === "pending") {
              ctx.strokeStyle = `${seatColor}${Math.round(statusAlpha * 160).toString(16).padStart(2, "0")}`;
              ctx.lineWidth = 1.2;
              ctx.stroke();
            } else {
              ctx.fillStyle = `${seatColor}${Math.round(statusAlpha * 255).toString(16).padStart(2, "0")}`;
              ctx.fill();
            }
            if (seat.aggregator) {
              // The arbiter's chair gets a thin coronet.
              ctx.beginPath();
              ctx.arc(pos.x, pos.y, baseR + 2.4 * scale, 0, TAU);
              ctx.strokeStyle = `${seatColor}${Math.round(formationAlpha * 110).toString(16).padStart(2, "0")}`;
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
        }
      }

      // ── Worker comets ────────────────────────────────────────────
      const activeIds = new Set<string>();
      const workerList = s.workers.filter((w) => w.id !== "local-llm" || w.state !== "done");
      workerList.forEach((worker, index) => {
        activeIds.add(worker.id);
        let comet = scene.comets.get(worker.id);
        const bands = [64, 80, 96];
        const targetRadius = bands[index % bands.length] * scale;
        if (!comet) {
          // Static frames skip the fly-in: the comet is already on station.
          comet = {
            id: worker.id,
            color: EXECUTOR_COLORS[worker.id] ?? "#94a3b8",
            angle: Math.random() * TAU,
            radius: reducedMotion ? targetRadius : size * 0.72,
            targetRadius,
            speed: 1.5,
            trail: [],
            mode: reducedMotion ? "active" : "arriving",
            modeAt: now,
            alpha: reducedMotion ? 1 : 0,
          };
          scene.comets.set(worker.id, comet);
        }
        comet.targetRadius = targetRadius;
        const mapped: Comet["mode"] = worker.state === "active" ? "active" : worker.state === "failed" ? "failed" : "done";
        if (comet.mode !== mapped && !(comet.mode === "arriving" && mapped === "active")) {
          comet.mode = mapped;
          comet.modeAt = now;
        }
      });
      for (const comet of scene.comets.values()) {
        if (!activeIds.has(comet.id) && comet.mode !== "done" && comet.mode !== "failed") {
          comet.mode = "done";
          comet.modeAt = now;
        }
      }

      for (const [id, comet] of scene.comets) {
        const age = (now - comet.modeAt) / 1000;
        if (comet.mode === "arriving") {
          comet.alpha = Math.min(comet.alpha + dt * 2.5, 1);
          if (Math.abs(comet.radius - comet.targetRadius) < 2 * scale && comet.alpha >= 1) {
            comet.mode = "active";
            comet.modeAt = now;
          }
        } else if (comet.mode === "active") {
          comet.alpha = Math.min(comet.alpha + dt * 2.5, 1);
        } else {
          // done/failed: linger a moment, then fade away.
          const fadeAfter = comet.mode === "done" ? 1.8 : 2.4;
          comet.alpha = Math.max(0, 1 - Math.max(0, age - fadeAfter) / 1.2);
          if (comet.alpha <= 0) {
            scene.comets.delete(id);
            continue;
          }
        }

        const speedTarget =
          comet.mode === "active" || comet.mode === "arriving"
            ? 1.4 + s.intensity * 0.9
            : comet.mode === "done"
            ? 0.25
            : 0.9;
        comet.speed += (speedTarget - comet.speed) * Math.min(dt * 3, 1);
        comet.angle += dt * comet.speed;
        comet.radius += (comet.targetRadius - comet.radius) * Math.min(dt * 3.2, 1);
        const jitter = comet.mode === "failed" && age < 2.4 ? Math.sin(t * 31 + comet.angle) * 3 * scale : 0;
        const r = comet.radius + jitter;
        const x = cx + Math.cos(comet.angle) * r;
        const y = cy + Math.sin(comet.angle) * r;

        comet.trail.unshift({ x, y });
        if (comet.trail.length > 15) comet.trail.pop();

        const color = comet.mode === "done" ? "#34d399" : comet.mode === "failed" ? "#f87171" : comet.color;
        for (let i = 1; i < comet.trail.length; i++) {
          const p = comet.trail[i];
          const prev = comet.trail[i - 1];
          const fade = (1 - i / comet.trail.length) * comet.alpha;
          ctx.strokeStyle = `${color}${Math.round(fade * 130).toString(16).padStart(2, "0")}`;
          ctx.lineWidth = Math.max(0.5, 2.4 * scale * (1 - i / comet.trail.length));
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        // Head with a soft two-step glow (no shadowBlur — it's slow).
        ctx.beginPath();
        ctx.arc(x, y, 4.6 * scale, 0, TAU);
        ctx.fillStyle = `${color}${Math.round(comet.alpha * 50).toString(16).padStart(2, "0")}`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 2.3 * scale, 0, TAU);
        ctx.fillStyle = `${color}${Math.round(comet.alpha * 255).toString(16).padStart(2, "0")}`;
        ctx.fill();
      }

      // ── Waiting beacon ───────────────────────────────────────────
      if (s.waiting && !reducedMotion && now - scene.lastBeaconAt > 2400) {
        scene.lastBeaconAt = now;
        scene.ripples.push({ kind: "beacon", startedAt: now, color: "#fbbf24" });
      }

      // ── Ripples ──────────────────────────────────────────────────
      scene.ripples = scene.ripples.filter((ripple) => {
        const life = ripple.kind === "council-verdict" ? 2200 : ripple.kind === "converge" ? 900 : 1600;
        const p = (now - ripple.startedAt) / life;
        if (p >= 1) return false;
        const inward = ripple.kind === "hitl-resolved" || ripple.kind === "converge";
        const minR = 32 * scale;
        const maxR = ripple.kind === "converge" ? seatRingR : size * 0.47;
        const r = inward ? maxR - (maxR - minR) * easeOut(p) : minR + (maxR - minR) * easeOut(p);
        const alpha = (1 - p) * (ripple.kind === "beacon" ? 0.5 : 0.62);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.strokeStyle = `${ripple.color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
        ctx.lineWidth = (ripple.kind === "council-verdict" ? 2.4 : 1.6) * scale;
        ctx.stroke();
        if (ripple.kind === "hitl-created" && p < 0.8) {
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.8, 0, TAU);
          ctx.strokeStyle = `${ripple.color}${Math.round(alpha * 140).toString(16).padStart(2, "0")}`;
          ctx.lineWidth = 1 * scale;
          ctx.stroke();
        }
        return true;
      });

      // ── Trace sparks ─────────────────────────────────────────────
      scene.sparks = scene.sparks.filter((spark) => {
        const p = (now - spark.bornAt) / 700;
        if (p >= 1) return false;
        const r = 30 * scale + spark.speed * p;
        const x = cx + Math.cos(spark.angle) * r;
        const y = cy + Math.sin(spark.angle) * r;
        ctx.beginPath();
        ctx.arc(x, y, 1.1 * scale, 0, TAU);
        ctx.fillStyle = `#f1f5f9${Math.round((1 - p) * 210).toString(16).padStart(2, "0")}`;
        ctx.fill();
        return true;
      });

      // ── Core orb ─────────────────────────────────────────────────
      const pulseHz = 0.35 + s.intensity * 1.5;
      const pulseAmp = 0.04 + s.intensity * 0.09 + scene.coreFlash * 0.05;
      const pulse = 1 + Math.sin(t * pulseHz * TAU) * pulseAmp;
      const coreR = 26 * scale * pulse;
      const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreR);
      const whiteStop = 0.35 - scene.coreFlash * 0.15 - (s.council && s.council.phase !== "deliberation" ? 0.08 : 0);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(Math.max(whiteStop, 0.12), style.color);
      core.addColorStop(1, style.dim);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TAU);
      ctx.fillStyle = core;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, coreR + 5 * scale, 0, TAU);
      ctx.strokeStyle = s.waiting ? "#fbbf2499" : `${style.color}66`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (s.council) {
        // A second faint band in the council's color: the orb wears the
        // deliberation while it runs.
        ctx.beginPath();
        ctx.arc(cx, cy, coreR + 9 * scale, 0, TAU);
        ctx.strokeStyle = `${councilColor}55`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // staticKey re-renders the single frame under reduced motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, size, staticKey]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="shrink-0"
      role="img"
      aria-label={`Praxis core status: ${state.label}`}
    />
  );
}
