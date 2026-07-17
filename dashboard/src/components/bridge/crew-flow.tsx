/**
 * CrewFlow — the Ops station's unified crew graph. The three CLI providers
 * (Antigravity, Codex, Claude Code), the local LLM, and the Praxis hub render
 * as one network; each provider node wears its current role — executor
 * (cyan, progress ring), QA gatekeeper (violet, with the handoff edge drawn
 * from the executor whose work it audits), council seat or aggregator (amber,
 * theses converging on the aggregator) — and packets travel the edges as work
 * moves through the system. Data: SSE lane state + the Praxis run registry +
 * the live council session.
 */
"use client";

import { isAggregatorVoice, type CouncilSessionSummary, type CouncilVoice } from "@/lib/council";
import type { ExecutorId } from "@/components/bridge/executor-detail";
import type { ExecutorRun } from "@/components/bridge/dispatch-station";

export interface CrewLaneView {
  pct: number;
  phase: string;
  status: "active" | "done" | "failed";
}

type ProviderId = "antigravity" | "codex" | "claude-code";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "antigravity", label: "Antigravity" },
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
];

const W = 480;
const H = 140;
const POS: Record<ProviderId, { x: number; y: number }> = {
  antigravity: { x: 88, y: 40 },
  codex: { x: 240, y: 34 },
  "claude-code": { x: 392, y: 40 },
};
const HUB = { x: 240, y: 112 };
const LOCAL = { x: 66, y: 112 };

type SeatVisual = "waiting" | "speaking" | "reported" | "failed";

function seatVisual(voice: CouncilVoice): SeatVisual {
  if (voice.status === "success") return "reported";
  if (voice.status === "running") return "speaking";
  if (voice.status === "pending") return "waiting";
  return "failed";
}

interface Palette {
  ring: string;
  fill: string;
  text: string;
}

const IDLE: Palette = { ring: "#334155", fill: "#0f172a", text: "#64748b" };
const CYAN: Palette = { ring: "#22d3ee", fill: "#062a30", text: "#67e8f9" };
const EMERALD: Palette = { ring: "#34d399", fill: "#052e22", text: "#6ee7b7" };
const RED: Palette = { ring: "#f87171", fill: "#2a0c0c", text: "#fca5a5" };
const AMBER: Palette = { ring: "#f59e0b", fill: "#1e1305", text: "#fbbf24" };
const VIOLET: Palette = { ring: "#a78bfa", fill: "#1a1033", text: "#c4b5fd" };

const SEAT_COLORS: Record<SeatVisual, Palette> = {
  waiting: IDLE,
  speaking: AMBER,
  reported: CYAN,
  failed: RED,
};

function cliIdFromVoice(name: string): string | null {
  const m = name.replace(/\s*\(aggregator\)\s*$/, "").match(/^cli:([\w-]+)/);
  return m ? m[1] : null;
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, curve = false): string {
  if (!curve) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${Math.max(a.y, b.y) + 44} ${b.x} ${b.y}`;
}

interface Edge {
  key: string;
  path: string;
  stroke: string;
  flow: boolean;
  packet: boolean;
  dur?: number;
  opacity?: number;
}

interface NodeView {
  id: ProviderId;
  label: string;
  colors: Palette;
  glyph: string;
  role: string;
  pct?: number;
  pulse?: boolean;
  breathe?: boolean;
  tip: string;
}

const CIRC = 2 * Math.PI * 16; // progress-arc circumference

export function CrewFlow({
  lanes,
  runs,
  council,
  local,
  onInspect,
}: {
  lanes: Partial<Record<string, CrewLaneView>>;
  runs: ExecutorRun[] | undefined;
  council: CouncilSessionSummary | null;
  local: { running: number; queued: number; paused: boolean };
  onInspect: (id: ExecutorId) => void;
}) {
  const deliberating = council?.phase === "deliberation";
  const synthesizing = council?.phase === "synthesis" || council?.phase === "refinement";

  const aggVoice = council?.voices.find(isAggregatorVoice);
  const aggId = aggVoice ? cliIdFromVoice(aggVoice.name) : null;
  const seatByProvider: Partial<Record<ProviderId, CouncilVoice>> = {};
  for (const v of council?.voices ?? []) {
    if (isAggregatorVoice(v)) continue;
    const id = cliIdFromVoice(v.name);
    if (id && id in POS) seatByProvider[id as ProviderId] = v;
  }

  const activeRunFor = (id: ProviderId) => runs?.find((r) => r.executor === id && r.status === "active");

  const nodes: NodeView[] = [];
  const edges: Edge[] = [];

  for (const p of PROVIDERS) {
    const pos = POS[p.id];
    const seat = seatByProvider[p.id];
    const isAgg = council !== null && aggId === p.id;
    const lane = lanes[p.id];

    if (isAgg) {
      const st: SeatVisual = aggVoice ? seatVisual(aggVoice) : "waiting";
      const drafting = synthesizing;
      nodes.push({
        id: p.id,
        label: p.label,
        colors: drafting ? AMBER : SEAT_COLORS[st],
        glyph: "⚖",
        role: drafting
          ? "aggregator · drafting"
          : st === "reported"
            ? "aggregator · delivered"
            : st === "failed"
              ? "aggregator · failed"
              : "aggregator · awaiting",
        breathe: drafting,
        tip: `${p.label} — council aggregator`,
      });
      if (drafting) {
        edges.push({
          key: `verdict-${p.id}`,
          path: edgePath(pos, HUB),
          stroke: "#f59e0b",
          flow: true,
          packet: true,
          dur: 2,
          opacity: 0.7,
        });
      }
    } else if (council && seat) {
      const v = seatVisual(seat);
      const c = SEAT_COLORS[v];
      nodes.push({
        id: p.id,
        label: p.label,
        colors: c,
        glyph: v === "reported" ? "✓" : v === "failed" ? "✕" : v === "speaking" ? "…" : "·",
        role: `seat · ${v === "speaking" ? "deliberating" : v}`,
        pulse: v === "speaking" && (deliberating || council.phase === "setup"),
        tip: `${p.label} — council seat (${v})`,
      });
      const target = aggId && aggId in POS ? POS[aggId as ProviderId] : HUB;
      if (v === "reported") {
        edges.push({
          key: `thesis-${p.id}`,
          path: edgePath(pos, target, target !== HUB),
          stroke: "#d97706",
          flow: true,
          packet: deliberating || synthesizing,
          dur: 1.8,
          opacity: 0.75,
        });
      } else if (v === "speaking") {
        edges.push({
          key: `thesis-${p.id}`,
          path: edgePath(pos, target, target !== HUB),
          stroke: "#92400e",
          flow: false,
          packet: false,
          opacity: 0.35,
        });
      }
    } else if (lane) {
      const run = activeRunFor(p.id);
      const qa = run?.kind === "qa";
      const roleWord = run?.kind === "qa" ? "qa" : run?.kind === "agent" ? "agent" : "exec";
      const c = lane.status === "failed" ? RED : lane.status === "done" ? EMERALD : qa ? VIOLET : CYAN;
      nodes.push({
        id: p.id,
        label: p.label,
        colors: c,
        glyph: lane.status === "done" ? "✓" : lane.status === "failed" ? "✕" : "…",
        role: `${roleWord} · ${lane.phase}`,
        pct: lane.status === "active" ? lane.pct : undefined,
        tip: `${p.label} — ${roleWord} ${lane.phase}${run?.title ? ` · ${run.title}` : ""}`,
      });
      if (lane.status === "active") {
        // QA runs draw the handoff from the executor whose work they audit.
        const source =
          qa && run
            ? runs?.find((r) => r.taskId === run.taskId && r.kind === "task" && r.executor !== p.id)
            : undefined;
        const from = source && source.executor in POS ? POS[source.executor as ProviderId] : HUB;
        edges.push({
          key: `work-${p.id}`,
          path: edgePath(from, pos, from !== HUB),
          stroke: qa ? "#a78bfa" : "#22d3ee",
          flow: true,
          packet: true,
          dur: 2.2,
          opacity: 0.7,
        });
      } else if (lane.status === "done") {
        edges.push({
          key: `work-${p.id}`,
          path: edgePath(pos, HUB),
          stroke: "#34d399",
          flow: false,
          packet: true,
          dur: 2.2,
          opacity: 0.5,
        });
      } else {
        edges.push({
          key: `work-${p.id}`,
          path: edgePath(pos, HUB),
          stroke: "#f87171",
          flow: false,
          packet: false,
          opacity: 0.4,
        });
      }
    } else {
      nodes.push({
        id: p.id,
        label: p.label,
        colors: IDLE,
        glyph: "·",
        role: "idle",
        tip: `${p.label} — idle`,
      });
    }
  }

  if (local.running > 0) {
    edges.push({
      key: "local",
      path: edgePath(HUB, LOCAL),
      stroke: "#22d3ee",
      flow: true,
      packet: true,
      dur: 2.4,
      opacity: 0.55,
    });
  }

  const anyActive = edges.some((e) => e.flow || e.packet);
  const localColors = local.running > 0 ? CYAN : IDLE;
  const localStatus = local.paused
    ? "paused"
    : local.running > 0
      ? `${local.running} running${local.queued > 0 ? ` · ${local.queued} queued` : ""}`
      : "quiet";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Crew dispatch flow">
      <style>{`
        .hud-crew-flow { animation: hud-crew-flow 1.2s linear infinite; }
        @keyframes hud-crew-flow { to { stroke-dashoffset: -20; } }
        .hud-crew-pulse { animation: hud-crew-pulse 2s ease-out infinite; transform-box: fill-box; transform-origin: center; }
        .hud-crew-pulse-delay { animation-delay: 1s; }
        @keyframes hud-crew-pulse { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
        .hud-crew-breathe { animation: hud-crew-breathe 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes hud-crew-breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
      <defs>
        <radialGradient id="hud-crew-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Base spokes: the standing dispatch topology */}
      {PROVIDERS.map((p) => (
        <path
          key={`spoke-${p.id}`}
          d={edgePath(HUB, POS[p.id])}
          fill="none"
          stroke="#1e293b"
          strokeWidth="1"
          strokeDasharray="2 6"
          opacity="0.5"
        />
      ))}
      <path d={edgePath(HUB, LOCAL)} fill="none" stroke="#1e293b" strokeWidth="1" strokeDasharray="2 6" opacity="0.5" />

      {/* Live work edges + packets */}
      {edges.map((e) => (
        <g key={e.key}>
          <path
            d={e.path}
            fill="none"
            stroke={e.stroke}
            strokeWidth="1.25"
            strokeDasharray={e.flow ? "4 6" : "none"}
            className={e.flow ? "hud-crew-flow" : undefined}
            opacity={e.opacity ?? 0.7}
          />
          {e.packet && (
            <circle r="2.5" fill={e.stroke}>
              <animateMotion dur={`${e.dur ?? 2}s`} repeatCount="indefinite" path={e.path} />
            </circle>
          )}
        </g>
      ))}

      {/* Praxis hub */}
      <g>
        <title>Praxis — dispatcher</title>
        {synthesizing && <circle cx={HUB.x} cy={HUB.y} r="30" fill="url(#hud-crew-glow)" className="hud-crew-breathe" />}
        <circle cx={HUB.x} cy={HUB.y} r="15" fill="#0b1220" stroke={synthesizing ? "#f59e0b" : "#334155"} strokeWidth="1.5" />
        <circle
          cx={HUB.x}
          cy={HUB.y}
          r="5"
          fill={anyActive ? "#22d3ee" : "#0e7490"}
          className={anyActive ? "hud-crew-breathe" : undefined}
        />
        <text x={HUB.x} y={HUB.y + 31} textAnchor="middle" fontSize="7" fontWeight="600" fill="#475569">
          PRAXIS
        </text>
      </g>

      {/* Local LLM satellite */}
      <g onClick={() => onInspect("local-llm")} className="cursor-pointer">
        <title>{`Local LLM — ${localStatus}`}</title>
        <circle cx={LOCAL.x} cy={LOCAL.y} r="8" fill={localColors.fill} stroke={localColors.ring} strokeWidth="1.5" />
        <text x={LOCAL.x} y={LOCAL.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize="7" fill={localColors.text}>
          {local.running > 0 ? "…" : "·"}
        </text>
        <text x={LOCAL.x} y={LOCAL.y + 22} textAnchor="middle" fontSize="6.5" fill={local.paused ? "#fbbf24" : localColors.text}>
          Local LLM · {localStatus}
        </text>
      </g>

      {/* Provider nodes */}
      {nodes.map((n) => {
        const pos = POS[n.id];
        return (
          <g key={n.id} onClick={() => onInspect(n.id)} className="cursor-pointer">
            <title>{n.tip}</title>
            {n.pulse && (
              <>
                <circle cx={pos.x} cy={pos.y} r="16" fill="none" stroke={n.colors.ring} strokeWidth="1" className="hud-crew-pulse" />
                <circle cx={pos.x} cy={pos.y} r="16" fill="none" stroke={n.colors.ring} strokeWidth="0.75" className="hud-crew-pulse hud-crew-pulse-delay" />
              </>
            )}
            {n.breathe && <circle cx={pos.x} cy={pos.y} r="26" fill="url(#hud-crew-glow)" className="hud-crew-breathe" />}
            {n.pct !== undefined && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r="16"
                fill="none"
                stroke={n.colors.ring}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${(Math.max(2, Math.min(100, n.pct)) / 100) * CIRC} ${CIRC}`}
                transform={`rotate(-90 ${pos.x} ${pos.y})`}
                opacity="0.9"
              />
            )}
            <circle
              cx={pos.x}
              cy={pos.y}
              r="12"
              fill={n.colors.fill}
              stroke={n.colors.ring}
              strokeWidth="1.5"
              className={n.breathe ? "hud-crew-breathe" : undefined}
            />
            <text x={pos.x} y={pos.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill={n.colors.text}>
              {n.glyph}
            </text>
            <text x={pos.x} y={pos.y - 17} textAnchor="middle" fontSize="8.5" fontWeight="600" fill={n.colors.text}>
              {n.label}
            </text>
            <text x={pos.x} y={pos.y + 23} textAnchor="middle" fontSize="6.5" fill={n.role === "idle" ? "#475569" : n.colors.text}>
              {n.role}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
