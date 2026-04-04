"use client"

import { useCortex, AgEvent } from "./cortex-provider";
import { useState } from "react";
import {
    Radio, AlertTriangle, CheckCircle2, XCircle,
    Zap, Clock, Activity, ChevronDown, ChevronUp,
    Rocket, Shield, Eye, X
} from "lucide-react";

// ── Icon + Color mapping per event type ──────────────────────────────

const EVENT_CONFIG: Record<string, {
    icon: typeof Activity;
    gradient: string;
    pulse?: boolean;
}> = {
    task_dispatched: { icon: Rocket, gradient: "from-cyan-500 to-blue-500" },
    task_pickup: { icon: Zap, gradient: "from-cyan-500 to-blue-500" },
    task_progress: { icon: Clock, gradient: "from-blue-500 to-indigo-500" },
    task_complete: { icon: CheckCircle2, gradient: "from-emerald-500 to-green-500" },
    task_aborted: { icon: XCircle, gradient: "from-amber-500 to-orange-500" },
    approval_needed: { icon: Shield, gradient: "from-amber-400 to-yellow-500", pulse: true },
    error: { icon: XCircle, gradient: "from-red-500 to-rose-500", pulse: true },
    stall_detected: { icon: AlertTriangle, gradient: "from-amber-500 to-orange-500", pulse: true },
    health_check: { icon: Activity, gradient: "from-slate-500 to-slate-400" },
    extension_lifecycle: { icon: Radio, gradient: "from-purple-500 to-violet-500" },
};

const SEVERITY_COLORS = {
    info: "border-slate-700/50 bg-slate-800/30",
    warning: "border-amber-500/30 bg-amber-500/5",
    critical: "border-red-500/30 bg-red-500/5",
};

const SEVERITY_DOT = {
    info: "bg-cyan-500",
    warning: "bg-amber-400",
    critical: "bg-red-500",
};

// ── Time formatting ──────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
    // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" without a timezone
    // indicator — JS Date() treats that as local time, but it's actually UTC.
    // Append 'Z' if no timezone info is present to force correct UTC parsing.
    const normalized = dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')
        ? dateStr
        : dateStr.replace(' ', 'T') + 'Z';
    const diff = Date.now() - new Date(normalized).getTime();
    const seconds = Math.max(0, Math.floor(diff / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// ── Event Row ────────────────────────────────────────────────────────

function EventRow({
    event,
    onDismiss,
}: {
    event: AgEvent;
    onDismiss?: (id: number) => void;
}) {
    const config = EVENT_CONFIG[event.event_type] || { icon: Activity, gradient: "from-slate-500 to-slate-400" };
    const Icon = config.icon;
    const severity = event.severity || "info";

    return (
        <div
            className={`
                group relative flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-all duration-200
                hover:border-slate-600/50
                ${SEVERITY_COLORS[severity]}
                ${event.requires_action && !event.action_taken ? "ring-1 ring-amber-500/20" : ""}
            `}
        >
            {/* Icon */}
            <div className={`
                mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md
                bg-gradient-to-br ${config.gradient} shadow-lg
                ${config.pulse && !event.action_taken ? "animate-pulse" : ""}
            `}>
                <Icon size={14} className="text-white" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[severity]}`} />
                    <p className="text-xs font-medium text-slate-200 truncate">
                        {event.title}
                    </p>
                </div>
                {event.message && (
                    <p className="mt-0.5 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                        {event.message}
                    </p>
                )}
                <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
                    <span>{timeAgo(event.created_at)}</span>
                    {event.task_id && (
                        <span className="font-mono bg-slate-800/50 px-1.5 py-0.5 rounded">
                            {event.task_id.slice(0, 8)}
                        </span>
                    )}
                </div>
            </div>

            {/* Action button for dismissable alerts */}
            {!!event.requires_action && !event.action_taken && onDismiss && (
                <button
                    onClick={() => onDismiss(event.id)}
                    className="
                        shrink-0 mt-0.5 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium
                        bg-amber-500/20 text-amber-300 border border-amber-500/30
                        hover:bg-amber-500/30 hover:text-amber-200 transition-all
                    "
                    title="Mark as handled"
                >
                    <X size={10} />
                    Dismiss
                </button>
            )}

            {/* Actioned badge */}
            {!!event.requires_action && !!event.action_taken && (
                <span className="shrink-0 mt-1 text-[10px] text-emerald-500 flex items-center gap-1">
                    <CheckCircle2 size={10} />
                    Done
                </span>
            )}
        </div>
    );
}

// ── Status Pulse ─────────────────────────────────────────────────────

function StatusPulse({ events }: { events: AgEvent[] }) {
    if (events.length === 0) return null;

    const latest = events[events.length - 1];

    // Only consider tasks from the last 10 minutes as "active"
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const recentEvents = events.filter(e => {
        const normalized = e.created_at.includes('T') || e.created_at.includes('Z') || e.created_at.includes('+')
            ? e.created_at
            : e.created_at.replace(' ', 'T') + 'Z';
        return new Date(normalized).getTime() > tenMinAgo;
    });

    const activeTask = recentEvents.find(
        e => e.event_type === "task_dispatched" || e.event_type === "task_progress"
    );
    const pendingAction = [...events].reverse().find(
        e => e.requires_action && !e.action_taken
    );

    // Determine state + messaging
    let dotColor: string;
    let label: string;
    let detail: string;

    if (pendingAction) {
        dotColor = "bg-amber-400 shadow-amber-400/50";
        label = "Action needed";
        detail = pendingAction.message || pendingAction.title;
    } else if (activeTask) {
        dotColor = "bg-cyan-400 shadow-cyan-400/50";
        label = "Active";
        detail = activeTask.title;
    } else {
        dotColor = "bg-emerald-400 shadow-emerald-400/50";
        // Derive a useful idle summary from the most recent health check
        const latestHealth = [...events].reverse().find(e => e.event_type === "health_check");
        const uptimeMin = latestHealth?.metadata?.uptimeMinutes;
        label = "Extension idle";
        detail = uptimeMin != null ? `healthy · Uptime: ${uptimeMin}m` : (latest.title || "healthy");
    }

    return (
        <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`h-2 w-2 rounded-full animate-pulse shadow-sm ${dotColor}`} />
            <span className={`font-medium ${pendingAction ? "text-amber-300" : ""}`}>{label}</span>
            <span className="text-slate-600">·</span>
            <span className="truncate max-w-[180px]">{detail}</span>
        </div>
    );
}

// ── Main Component ───────────────────────────────────────────────────

export function AntigravityMonitor() {
    const { agEvents, dismissAgEvent } = useCortex();
    const [expanded, setExpanded] = useState(true);

    // Show last 20 events (reversed = newest first)
    const displayEvents = [...agEvents].reverse().slice(0, 20);

    // Pending action items (the actual events, not just a count)
    const pendingActions = agEvents.filter(
        e => e.requires_action && !e.action_taken
    );

    return (
        <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-sm overflow-hidden">
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="
                    w-full flex items-center justify-between px-4 py-3
                    hover:bg-slate-800/30 transition-colors
                "
            >
                <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/30">
                        <Eye size={16} className="text-violet-400" />
                    </div>
                    <div className="text-left">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            Antigravity
                            {pendingActions.length > 0 && (
                                <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
                                    {pendingActions.length}
                                </span>
                            )}
                        </h3>
                        <StatusPulse events={agEvents} />
                    </div>
                </div>
                <div className="text-slate-500">
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
            </button>

            {/* Action Banner — surfaces exactly what needs attention */}
            {expanded && pendingActions.length > 0 && (
                <div className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-300">
                        <AlertTriangle size={12} />
                        {pendingActions.length === 1
                            ? "1 item needs your attention"
                            : `${pendingActions.length} items need your attention`}
                    </div>
                    {pendingActions.map(action => (
                        <div key={action.id} className="flex items-start justify-between gap-2 pl-5">
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-slate-200 truncate">{action.title}</p>
                                {action.message && (
                                    <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">{action.message}</p>
                                )}
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); dismissAgEvent(action.id); }}
                                className="
                                    shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium
                                    bg-amber-500/20 text-amber-300 border border-amber-500/30
                                    hover:bg-amber-500/30 hover:text-amber-200 transition-all
                                "
                                title="Dismiss"
                            >
                                <X size={10} />
                                Dismiss
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Event Stream */}
            {expanded && (
                <div className="px-3 pb-3 space-y-1.5 max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                    {displayEvents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-8 text-center">
                            <Radio size={24} className="text-slate-600 mb-2" />
                            <p className="text-xs text-slate-500">No events yet</p>
                            <p className="text-[10px] text-slate-600 mt-1">
                                Events will appear here when Antigravity is active
                            </p>
                        </div>
                    ) : (
                        displayEvents.map((event) => (
                            <EventRow
                                key={event.id}
                                event={event}
                                onDismiss={event.requires_action ? dismissAgEvent : undefined}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
