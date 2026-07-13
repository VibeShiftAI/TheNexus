/**
 * ActivityReport — the "reports and visuals" panel of the project brief:
 * a 30-day commit tempo chart over a merged operations log (commits, crew
 * dispatches, and task completions, newest first).
 */
"use client";

import { useMemo, useState } from "react";
import type { ProjectBrief, OpsLogEvent } from "@/lib/nexus";
import { HudPanel } from "@/components/bridge/hud";
import { timeAgo } from "@/components/pulse-visuals";
import { fmtTokensShort } from "@/components/project-brief/mission-brief";
import { Activity, GitCommit, Send, CheckCircle2 } from "lucide-react";

type Filter = "all" | OpsLogEvent["type"];

const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "commit", label: "Commits" },
    { key: "dispatch", label: "Crew" },
    { key: "task", label: "Tasks" },
];

function outcomeTone(outcome?: string) {
    switch (outcome) {
        case "success":
        case "completed":
            return "text-emerald-400";
        case "failure":
        case "timeout":
            return "text-red-400";
        case "running":
            return "text-cyan-300";
        case "needs_input":
            return "text-amber-300";
        default:
            return "text-slate-500";
    }
}

function EventRow({ ev }: { ev: OpsLogEvent }) {
    const icon =
        ev.type === "commit" ? <GitCommit size={12} className="text-cyan-400" />
            : ev.type === "dispatch" ? <Send size={12} className="text-purple-400" />
                : <CheckCircle2 size={12} className="text-emerald-400" />;
    return (
        <div className="flex items-start gap-2.5 border-l border-slate-800 py-1.5 pl-3 transition-colors hover:border-cyan-500/50 hover:bg-slate-900/40">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-slate-300" title={ev.title}>{ev.title}</div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-slate-600">
                    {ev.meta && <span className="text-slate-500">{ev.meta}</span>}
                    {ev.by && <span>{ev.by}</span>}
                    {ev.outcome && <span className={outcomeTone(ev.outcome)}>{ev.outcome}</span>}
                    {typeof ev.tokens === "number" && ev.tokens > 0 && (
                        <span className="text-purple-400/80">{fmtTokensShort(ev.tokens)} tok</span>
                    )}
                </div>
            </div>
            <span className="shrink-0 pt-0.5 font-mono text-[10px] text-slate-600">Δ {timeAgo(ev.at)}</span>
        </div>
    );
}

/** 30-day tempo chart with weekly tick marks and a hover count. */
function TempoChart({ series, total }: { series: number[]; total: number }) {
    const n = series.length || 1;
    const max = Math.max(...series, 1);
    const H = 56;
    return (
        <div>
            <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[9px] uppercase tracking-widest text-slate-600">Commit tempo · 30d</span>
                <span className="font-mono text-[10px] text-slate-500">{total} commits</span>
            </div>
            <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-14 w-full" aria-hidden>
                {/* weekly gridlines */}
                {[0.25, 0.5, 0.75].map(f => (
                    <line key={f} x1={f * 100} y1={0} x2={f * 100} y2={H} stroke="#1e293b" strokeWidth={0.3} />
                ))}
                {series.map((v, i) => {
                    const slot = 100 / n;
                    const barW = slot * 0.6;
                    const h = v === 0 ? 1.5 : Math.max(3, (v / max) * (H - 6));
                    return (
                        <rect
                            key={i}
                            x={i * slot + (slot - barW) / 2}
                            y={H - h}
                            width={barW}
                            height={h}
                            rx={0.6}
                            fill={v === 0 ? "#334155" : "#22d3ee"}
                            opacity={v === 0 ? 0.5 : 0.45 + 0.55 * (v / max)}
                        >
                            <title>{`${v} commit${v === 1 ? "" : "s"}`}</title>
                        </rect>
                    );
                })}
            </svg>
            <div className="flex justify-between font-mono text-[9px] text-slate-600">
                <span>-30d</span>
                <span>-21d</span>
                <span>-14d</span>
                <span>-7d</span>
                <span>now</span>
            </div>
        </div>
    );
}

export function ActivityReport({ brief }: { brief: ProjectBrief | null }) {
    const [filter, setFilter] = useState<Filter>("all");
    const events = useMemo(
        () => (brief?.opsLog ?? []).filter(ev => filter === "all" || ev.type === filter),
        [brief, filter],
    );

    return (
        <HudPanel
            icon={<Activity size={16} />}
            title="Operations Report"
            accent="cyan"
            className="h-full"
            headerRight={
                <div className="flex items-center gap-1">
                    {FILTERS.map(f => (
                        <button
                            key={f.key}
                            onClick={() => setFilter(f.key)}
                            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${filter === f.key
                                ? "bg-cyan-500/20 text-cyan-300"
                                : "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                                }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            }
        >
            {!brief ? (
                <div className="flex h-40 items-center justify-center gap-2 text-slate-600">
                    <div className="h-3 w-3 animate-spin rounded-full border border-slate-600 border-t-transparent" />
                    <span className="text-[11px] uppercase tracking-widest">compiling report…</span>
                </div>
            ) : (
                <div className="space-y-4">
                    <TempoChart series={brief.git.series} total={brief.git.total} />
                    <div>
                        <div className="mb-1 text-[9px] uppercase tracking-widest text-slate-600">Operations log</div>
                        {events.length === 0 ? (
                            <div className="py-6 text-center text-xs text-slate-600">No recorded operations.</div>
                        ) : (
                            <div className="custom-scrollbar max-h-80 space-y-0.5 overflow-y-auto pr-1">
                                {events.map((ev, i) => (
                                    <EventRow key={`${ev.type}-${ev.at}-${i}`} ev={ev} />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </HudPanel>
    );
}
