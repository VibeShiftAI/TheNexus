"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getActivity, getActivityEvents, Activity, ActivityEvent } from "@/lib/nexus";
import { useLiveRefetch } from "@/components/live-board-state";
import { GitCommit, Clock, Cpu, Coins, ChevronRight, FileX2, User, Radio, AlertTriangle, Siren, ChevronDown } from "lucide-react";

// Compact token count: 12345 → "12.3k", 2_000_000 → "2M".
function formatTokens(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

// SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no suffix; git dates and the
// event relay both carry their own offset. Normalize before Date parses it, or
// every SQLite row reads hours off.
function parseFeedDate(dateStr: string): Date {
    const normalized = dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')
        ? dateStr
        : dateStr.replace(' ', 'T') + 'Z';
    return new Date(normalized);
}

function formatRelativeTime(dateStr: string) {
    const date = parseFeedDate(dateStr);
    const diffMs = Math.max(0, Date.now() - date.getTime());
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

/** One row of the merged feed: a git commit or a Praxis operational event. */
export type FeedRow =
    | { kind: 'commit'; at: number; key: string; commit: Activity }
    | { kind: 'event'; at: number; key: string; event: ActivityEvent };

export type Filter = 'all' | 'events' | 'commits';

/** How many rows the panel holds before the oldest fall off. */
const FEED_LIMIT = 60;

/**
 * Interleave commits and events onto one newest-first timeline.
 *
 * The two halves arrive from different sources with different clocks — git
 * dates carry an offset, SQLite rows do not — so both go through
 * parseFeedDate before they are compared. Exported for the unit test; the
 * component just renders what comes back.
 */
export function mergeActivityRows(
    activities: Activity[],
    events: ActivityEvent[],
    filter: Filter,
): FeedRow[] {
    const merged: FeedRow[] = [];
    if (filter !== 'events') {
        for (const commit of activities) {
            merged.push({
                kind: 'commit',
                at: parseFeedDate(commit.date).getTime(),
                key: `c-${commit.hash}-${commit.projectId}`,
                commit,
            });
        }
    }
    if (filter !== 'commits') {
        for (const event of events) {
            merged.push({
                kind: 'event',
                at: parseFeedDate(event.created_at).getTime(),
                key: `e-${event.id}`,
                event,
            });
        }
    }
    return merged.sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT);
}

const SEVERITY = {
    critical: { icon: Siren, ring: "border-red-500/30 bg-red-500/10", text: "text-red-300" },
    warning: { icon: AlertTriangle, ring: "border-amber-500/30 bg-amber-500/10", text: "text-amber-300" },
    info: { icon: Radio, ring: "border-slate-700 bg-slate-800", text: "text-slate-400" },
} as const;

/** Praxis writes event types as snake_case; render them as words. */
function humanizeEventType(eventType: string) {
    return eventType.replace(/[._]/g, ' ');
}

function EventRow({ event, onOpenTask }: { event: ActivityEvent; onOpenTask: (taskId: string) => void }) {
    const [expanded, setExpanded] = useState(false);
    const tone = SEVERITY[event.severity] ?? SEVERITY.info;
    const Icon = tone.icon;
    // The full card is what the chat used to carry; keep it one click away
    // rather than on screen by default.
    const detail = event.message?.trim();

    return (
        <div className="flex items-start gap-3 group rounded-lg -mx-2 px-2 py-1">
            <div className={`rounded-full border p-1.5 mt-0.5 ${tone.ring}`}>
                <Icon size={12} className={tone.text} />
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-xs font-medium ${tone.text}`}>{humanizeEventType(event.event_type)}</span>
                    <span className="text-xs text-slate-600">{formatRelativeTime(event.created_at)}</span>
                    {Boolean(event.requires_action) && (
                        <span className="rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                            needs you
                        </span>
                    )}
                </div>
                <p className="text-sm text-slate-300 break-words" title={event.title}>{event.title}</p>
                <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 font-mono truncate max-w-[10rem]" title={event.source}>
                        {event.source}
                    </span>
                    {event.task_id && (
                        <button
                            type="button"
                            onClick={() => onOpenTask(event.task_id!)}
                            className="inline-flex items-center gap-0.5 rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20"
                            title={`Open task ${event.task_id}`}
                        >
                            Task
                            <ChevronRight size={10} className="shrink-0" />
                        </button>
                    )}
                    {detail && (
                        <button
                            type="button"
                            onClick={() => setExpanded(v => !v)}
                            aria-expanded={expanded}
                            className="ml-auto inline-flex items-center gap-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:text-slate-300"
                        >
                            {expanded ? 'Less' : 'Detail'}
                            <ChevronDown size={11} className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                    )}
                </div>
                {expanded && detail && (
                    <pre className="custom-scrollbar mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950/60 p-2 text-[11px] leading-relaxed text-slate-400">
                        {detail}
                    </pre>
                )}
            </div>
        </div>
    );
}

function CommitRow({ commit, onOpenLogs }: { commit: Activity; onOpenLogs: (a: Activity) => void }) {
    const hasLogs = Boolean(commit.taskId);
    return (
        <div
            className={`flex items-start gap-3 group rounded-lg -mx-2 px-2 py-1 transition-colors ${
                hasLogs
                    ? "cursor-pointer hover:bg-slate-800/50 focus-visible:bg-slate-800/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
                    : ""
            }`}
            {...(hasLogs
                ? {
                      role: "button",
                      tabIndex: 0,
                      title: "Open the log viewer for this activity",
                      onClick: () => onOpenLogs(commit),
                      onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpenLogs(commit);
                          }
                      },
                  }
                : {})}
        >
            <div className="rounded-full bg-slate-800 p-1.5 mt-0.5">
                <GitCommit size={12} className="text-cyan-400" />
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-cyan-400">{commit.projectName}</span>
                    <span className="text-xs text-slate-600">{formatRelativeTime(commit.date)}</span>
                </div>
                <p className="text-sm text-slate-300 truncate" title={commit.message}>
                    {commit.message}
                </p>
                <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs text-slate-500 font-mono">{commit.hash.substring(0, 7)}</span>
                    {/* Who made the update: the model when an AI ran it, else the
                        git author (hand-authored and system commits), else "—". */}
                    {commit.model ? (
                        <span
                            className="inline-flex items-center gap-1 rounded bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-300"
                            title={
                                commit.modelInferred
                                    ? `Model: ${commit.model} (inferred from the executor that ran this)`
                                    : `Model: ${commit.model}`
                            }
                        >
                            <Cpu size={9} className="shrink-0" />
                            <span className="max-w-[9rem] truncate">{commit.model}</span>
                        </span>
                    ) : commit.author ? (
                        <span
                            className="inline-flex items-center gap-1 rounded bg-slate-500/10 border border-slate-500/20 px-1.5 py-0.5 text-[10px] font-medium text-slate-400"
                            title={`Committed by ${commit.author} (no model attribution)`}
                        >
                            <User size={9} className="shrink-0" />
                            <span className="max-w-[9rem] truncate">{commit.author}</span>
                        </span>
                    ) : (
                        <span
                            className="inline-flex items-center gap-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600"
                            title="No model attribution for this activity"
                        >
                            <Cpu size={9} className="shrink-0" />—
                        </span>
                    )}
                    {/* Token usage — neutral placeholder when not recorded */}
                    {typeof commit.tokens === "number" ? (
                        <span
                            className="inline-flex items-center gap-1 rounded bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300 tabular-nums"
                            title={
                                commit.tokensEstimated
                                    ? `~${commit.tokens.toLocaleString()} tokens (estimated from text volume)`
                                    : `${commit.tokens.toLocaleString()} tokens`
                            }
                        >
                            <Coins size={9} className="shrink-0" />
                            {commit.tokensEstimated ? "~" : ""}{formatTokens(commit.tokens)}
                        </span>
                    ) : (
                        <span
                            className="inline-flex items-center gap-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600"
                            title="No token count recorded for this activity"
                        >
                            <Coins size={9} className="shrink-0" />—
                        </span>
                    )}
                    {/* Drill-down affordance — logs to open, or a clear no-logs state */}
                    {hasLogs ? (
                        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] font-medium text-cyan-400/50 transition-colors group-hover:text-cyan-300">
                            Logs
                            <ChevronRight size={11} className="shrink-0" />
                        </span>
                    ) : (
                        <span
                            className="ml-auto inline-flex items-center gap-1 text-[10px] text-slate-600"
                            title="No logs available for this activity"
                        >
                            <FileX2 size={10} className="shrink-0" />
                            no logs
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Recent Activity — commits AND Praxis operational events on one timeline.
 *
 * The event half is where the [PRAXIS EVENT] cards went. Praxis relays every
 * operational event to /api/ag/events and only puts the ones that need Robert
 * into the chat, so this feed is the complete record: nothing that left the
 * chat left the system.
 */
export function ActivityFeed() {
    const router = useRouter();
    const [activities, setActivities] = useState<Activity[]>([]);
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [filter, setFilter] = useState<Filter>('all');
    const [loading, setLoading] = useState(true);

    // Navigate to the run's logs: the task Dispatch Console is the drill-down Log
    // Viewer. The #dispatch-<id> hash tells it which run this activity came from,
    // so it opens scoped to this activity rather than the newest attempt.
    const openLogs = (activity: Activity) => {
        if (!activity.taskId) return;
        const hash = activity.dispatchId ? `#dispatch-${activity.dispatchId}` : "";
        router.push(`/task/${activity.taskId}${hash}`);
    };

    const cancelled = useRef(false);
    useEffect(() => {
        cancelled.current = false;
        return () => { cancelled.current = true; };
    }, []);

    const load = useCallback(() => {
        // Independent halves: a git error must not blank the event feed
        // (and vice versa), so each settles on its own.
        getActivity().then(rows => { if (!cancelled.current) setActivities(rows); }).catch(console.error);
        getActivityEvents().then(rows => { if (!cancelled.current) setEvents(rows); }).catch(console.error)
            .finally(() => { if (!cancelled.current) setLoading(false); });
    }, []);

    // Events land continuously while the day runs; commits do not. The shared
    // live subscription refetches the moment anything happens, and the 60s
    // fallback poll keeps commits (which produce no stream frame) current.
    useLiveRefetch(["activity"], load);

    const rows = useMemo(() => mergeActivityRows(activities, events, filter), [activities, events, filter]);

    const tab = (value: Filter, label: string, count: number) => (
        <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                filter === value
                    ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                    : "border border-transparent text-slate-500 hover:text-slate-300"
            }`}
        >
            {label}
            <span className="ml-1 tabular-nums opacity-60">{count}</span>
        </button>
    );

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-4 flex items-center justify-between gap-2">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Clock size={18} className="text-cyan-400" />
                    Recent Activity
                </h3>
                <div className="flex items-center gap-1">
                    {tab('all', 'All', activities.length + events.length)}
                    {tab('events', 'Events', events.length)}
                    {tab('commits', 'Commits', activities.length)}
                </div>
            </div>
            {loading ? (
                <div className="text-slate-500 text-sm animate-pulse">Loading activity...</div>
            ) : rows.length === 0 ? (
                <div className="text-slate-500 text-sm">No recent activity</div>
            ) : (
                <div className="custom-scrollbar max-h-[400px] space-y-3 overflow-y-auto overflow-x-hidden pr-1">
                    {rows.map(row =>
                        row.kind === 'commit' ? (
                            <CommitRow key={row.key} commit={row.commit} onOpenLogs={openLogs} />
                        ) : (
                            <EventRow key={row.key} event={row.event} onOpenTask={(taskId) => router.push(`/task/${taskId}`)} />
                        ),
                    )}
                </div>
            )}
        </div>
    );
}
