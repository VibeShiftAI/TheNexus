/**
 * CouncilChamberMini — the bridge-panel miniature of the Council Chamber.
 * Reference seats arc over the aggregator and light up as their theses land
 * (amber pulse while speaking, cyan once reported, red on failure); the
 * aggregator breathes amber while it drafts the verdict. When the chamber is
 * dark the latest session renders dimmed and static. Same visual language as
 * /council, sized for a HUD station.
 */
"use client";

import {
  isAggregatorVoice,
  seatDisplayName,
  type CouncilPhase,
  type CouncilVoice,
} from "@/lib/council";

type SeatVisual = "waiting" | "speaking" | "reported" | "failed";

function seatVisual(voice: CouncilVoice): SeatVisual {
  if (voice.status === "success") return "reported";
  if (voice.status === "running") return "speaking";
  if (voice.status === "pending") return "waiting";
  return "failed";
}

const SEAT_COLORS: Record<SeatVisual, { ring: string; fill: string; text: string }> = {
  waiting: { ring: "#334155", fill: "#0f172a", text: "#64748b" },
  speaking: { ring: "#f59e0b", fill: "#1e1305", text: "#fbbf24" },
  reported: { ring: "#22d3ee", fill: "#062a30", text: "#67e8f9" },
  failed: { ring: "#f87171", fill: "#2a0c0c", text: "#fca5a5" },
};

const W = 260;
const H = 80;
const CX = W / 2;
const CY = 62;
const RX = 100;
const RY = 38;

export function CouncilChamberMini({
  voices,
  phase,
  live,
}: {
  voices: CouncilVoice[];
  phase: CouncilPhase;
  live: boolean;
}) {
  const refs = voices.filter((v) => !isAggregatorVoice(v));
  const aggregator = voices.find(isAggregatorVoice);

  // Seats spread across the top arc, 160° → 20°.
  const seats = refs.map((voice, i) => {
    const t = refs.length === 1 ? 0.5 : i / (refs.length - 1);
    const rad = ((160 - t * 140) * Math.PI) / 180;
    return {
      voice,
      x: CX + RX * Math.cos(rad),
      y: CY - RY * Math.sin(rad),
    };
  });

  const aggregatorState: SeatVisual = aggregator
    ? seatVisual(aggregator)
    : phase === "complete"
      ? "reported"
      : "waiting";
  const deliberating = live && phase === "deliberation";
  const synthesizing = live && (phase === "synthesis" || phase === "refinement");

  const arcStart = { x: CX + RX * Math.cos((160 * Math.PI) / 180), y: CY - RY * Math.sin((160 * Math.PI) / 180) };
  const arcEnd = { x: CX + RX * Math.cos((20 * Math.PI) / 180), y: CY - RY * Math.sin((20 * Math.PI) / 180) };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Council chamber">
      <style>{`
        .hud-council-flow { animation: hud-council-flow 1.2s linear infinite; }
        @keyframes hud-council-flow { to { stroke-dashoffset: -20; } }
        .hud-council-pulse { animation: hud-council-pulse 2s ease-out infinite; transform-box: fill-box; transform-origin: center; }
        .hud-council-pulse-delay { animation-delay: 1s; }
        @keyframes hud-council-pulse { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
        .hud-council-breathe { animation: hud-council-breathe 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes hud-council-breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
      <defs>
        <radialGradient id="hud-chamber-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Table arc through the seats */}
      <path
        d={`M ${arcStart.x} ${arcStart.y} A ${RX} ${RY} 0 0 1 ${arcEnd.x} ${arcEnd.y}`}
        fill="none"
        stroke="#1e293b"
        strokeWidth="1"
        strokeDasharray="3 5"
      />

      {/* Spokes seat → aggregator; flowing dashes once a seat reports */}
      {seats.map(({ voice, x, y }) => {
        const v = seatVisual(voice);
        const flowing = v === "reported" && (deliberating || synthesizing);
        return (
          <line
            key={`spoke-${voice.name}`}
            x1={x}
            y1={y}
            x2={CX}
            y2={CY}
            stroke={v === "reported" ? "#155e6b" : "#1e293b"}
            strokeWidth="1"
            strokeDasharray={flowing ? "4 6" : v === "reported" ? "none" : "2 6"}
            className={flowing ? "hud-council-flow" : undefined}
            opacity={v === "waiting" ? 0.4 : 0.9}
          />
        );
      })}

      {/* Reference seats */}
      {seats.map(({ voice, x, y }) => {
        const v = seatVisual(voice);
        const c = SEAT_COLORS[v];
        return (
          <g key={voice.name}>
            <title>{`${seatDisplayName(voice.name)} — ${v}`}</title>
            {live && v === "speaking" && (
              <>
                <circle cx={x} cy={y} r="11" fill="none" stroke={c.ring} strokeWidth="1" className="hud-council-pulse" />
                <circle cx={x} cy={y} r="11" fill="none" stroke={c.ring} strokeWidth="0.75" className="hud-council-pulse hud-council-pulse-delay" />
              </>
            )}
            <circle cx={x} cy={y} r="8" fill={c.fill} stroke={c.ring} strokeWidth="1.5" />
            <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill={c.text}>
              {v === "reported" ? "✓" : v === "failed" ? "✕" : v === "speaking" ? "…" : "·"}
            </text>
            <text x={x} y={y - 13} textAnchor="middle" fontSize="7" fontWeight="600" fill={c.text}>
              {seatDisplayName(voice.name)}
            </text>
          </g>
        );
      })}

      {/* Aggregator at the head of the table */}
      <g>
        <title>{`Aggregator${aggregator ? ` — ${seatDisplayName(aggregator.name)}` : ""}`}</title>
        {synthesizing && <circle cx={CX} cy={CY} r="26" fill="url(#hud-chamber-glow)" className="hud-council-breathe" />}
        <circle
          cx={CX}
          cy={CY}
          r="11"
          fill={synthesizing ? "#1e1305" : SEAT_COLORS[aggregatorState].fill}
          stroke={synthesizing ? "#f59e0b" : SEAT_COLORS[aggregatorState].ring}
          strokeWidth="1.5"
          className={synthesizing ? "hud-council-breathe" : undefined}
        />
        <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fontSize="9">
          ⚖️
        </text>
      </g>
    </svg>
  );
}
