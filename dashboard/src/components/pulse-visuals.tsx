/**
 * Pulse visuals — small readout primitives shared by the project cards and
 * the project brief screen: commit-tempo sparkline, activity LED, and the
 * short relative-time formatter that keeps readouts terse ("3h", "12d").
 */
"use client";

import type { ProjectPulse } from "@/lib/nexus";

/** "42s" / "3h" / "12d" — terse HUD-style relative time. */
export function timeAgo(dateStr: string | null | undefined): string | null {
    if (!dateStr) return null;
    const ms = Date.parse(dateStr);
    if (!Number.isFinite(ms)) return null;
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

export type ActivityBand = "hot" | "warm" | "cool" | "dormant";

/** Classify recency: <24h hot, <7d warm, <30d cool, else dormant. */
export function activityBand(lastActivityAt: string | null | undefined): ActivityBand {
    if (!lastActivityAt) return "dormant";
    const age = Date.now() - Date.parse(lastActivityAt);
    if (!Number.isFinite(age)) return "dormant";
    if (age < 24 * 3600_000) return "hot";
    if (age < 7 * 24 * 3600_000) return "warm";
    if (age < 30 * 24 * 3600_000) return "cool";
    return "dormant";
}

export const BAND_STYLES: Record<
    ActivityBand,
    { led: string; text: string; bar: string; label: string; pulse: boolean }
> = {
    hot: { led: "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)]", text: "text-cyan-300", bar: "#22d3ee", label: "ACTIVE", pulse: true },
    warm: { led: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]", text: "text-emerald-300", bar: "#34d399", label: "RECENT", pulse: false },
    cool: { led: "bg-amber-400/80", text: "text-amber-300/90", bar: "#fbbf24", label: "IDLE", pulse: false },
    dormant: { led: "bg-slate-600", text: "text-slate-500", bar: "#475569", label: "DORMANT", pulse: false },
};

/**
 * Commit-tempo bars. Renders `series` (oldest→newest) as an SVG bar strip;
 * zero-days show a faint baseline tick so the time axis stays readable.
 */
export function PulseSparkline({
    series,
    color = "#22d3ee",
    height = 26,
    className = "",
}: {
    series: number[];
    color?: string;
    height?: number;
    className?: string;
}) {
    const n = series.length;
    if (n === 0) return null;
    const max = Math.max(...series, 1);
    const slot = 100 / n;
    const barW = slot * 0.62;
    return (
        <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            className={`w-full ${className}`}
            style={{ height }}
            aria-hidden
        >
            {series.map((v, i) => {
                const h = v === 0 ? 1.5 : Math.max(3, (v / max) * (height - 2));
                const isLatest = i === n - 1;
                return (
                    <rect
                        key={i}
                        x={i * slot + (slot - barW) / 2}
                        y={height - h}
                        width={barW}
                        height={h}
                        rx={0.8}
                        fill={v === 0 ? "#334155" : color}
                        opacity={v === 0 ? 0.55 : isLatest ? 1 : 0.45 + 0.5 * (v / max)}
                    />
                );
            })}
        </svg>
    );
}

/** Status LED — solid dot with a slow ping halo when the band is hot. */
export function ActivityLed({ band }: { band: ActivityBand }) {
    const s = BAND_STYLES[band];
    return (
        <span className="relative inline-flex h-2 w-2 shrink-0">
            {s.pulse && (
                <span className={`absolute inline-flex h-full w-full rounded-full ${s.led} opacity-60 motion-safe:animate-ping`} />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${s.led}`} />
        </span>
    );
}

/** Compact executor/model chip for "last crew run" readouts. */
export function CrewChip({ crew }: { crew: ProjectPulse["crew"] }) {
    if (crew.running > 0) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-cyan-300">
                <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute h-full w-full rounded-full bg-cyan-400 opacity-70 motion-safe:animate-ping" />
                    <span className="relative h-1.5 w-1.5 rounded-full bg-cyan-400" />
                </span>
                {crew.running} crew engaged
            </span>
        );
    }
    if (!crew.last) return null;
    const ok = crew.last.outcome === "success";
    const failed = crew.last.outcome === "failure" || crew.last.outcome === "timeout";
    return (
        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
            <span className={ok ? "text-emerald-400" : failed ? "text-red-400" : "text-slate-400"}>
                {ok ? "✓" : failed ? "✕" : "•"}
            </span>
            <span className="truncate">
                {crew.last.executor}
                {crew.last.model ? ` · ${crew.last.model}` : ""}
            </span>
            <span className="shrink-0 text-slate-600">{timeAgo(crew.last.at)}</span>
        </span>
    );
}
