"use client"

import { useEffect, useState } from "react";
import { getActivity, Activity } from "@/lib/nexus";
import { GitCommit, Clock, Cpu, Coins } from "lucide-react";

// Compact token count: 12345 → "12.3k", 2_000_000 → "2M".
function formatTokens(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function ActivityFeed() {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getActivity()
            .then(setActivities)
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    const formatRelativeTime = (dateStr: string) => {
        // Normalize SQLite "YYYY-MM-DD HH:MM:SS" (UTC but no suffix) → ISO with Z
        const normalized = dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')
            ? dateStr
            : dateStr.replace(' ', 'T') + 'Z';
        const date = new Date(normalized);
        const now = new Date();
        const diffMs = Math.max(0, now.getTime() - date.getTime());
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <Clock size={18} className="text-cyan-400" />
                    Recent Activity
                </h3>
                <div className="text-slate-500 text-sm animate-pulse">Loading activity...</div>
            </div>
        );
    }

    if (activities.length === 0) {
        return (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <Clock size={18} className="text-cyan-400" />
                    Recent Activity
                </h3>
                <div className="text-slate-500 text-sm">No recent activity</div>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Clock size={18} className="text-cyan-400" />
                Recent Activity
            </h3>
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {activities.map((activity, i) => (
                    <div key={`${activity.hash}-${i}`} className="flex items-start gap-3 group">
                        <div className="rounded-full bg-slate-800 p-1.5 mt-0.5">
                            <GitCommit size={12} className="text-cyan-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs font-medium text-cyan-400">{activity.projectName}</span>
                                <span className="text-xs text-slate-600">{formatRelativeTime(activity.date)}</span>
                            </div>
                            <p className="text-sm text-slate-300 truncate" title={activity.message}>
                                {activity.message}
                            </p>
                            <div className="mt-1 flex items-center gap-1.5">
                                <span className="text-xs text-slate-500 font-mono">{activity.hash.substring(0, 7)}</span>
                                {/* Model attribution — neutral placeholder when unknown */}
                                {activity.model ? (
                                    <span
                                        className="inline-flex items-center gap-1 rounded bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-300"
                                        title={
                                            activity.modelInferred
                                                ? `Model: ${activity.model} (inferred from the executor that ran this)`
                                                : `Model: ${activity.model}`
                                        }
                                    >
                                        <Cpu size={9} className="shrink-0" />
                                        <span className="max-w-[9rem] truncate">{activity.model}</span>
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
                                {typeof activity.tokens === "number" ? (
                                    <span
                                        className="inline-flex items-center gap-1 rounded bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300 tabular-nums"
                                        title={
                                            activity.tokensEstimated
                                                ? `~${activity.tokens.toLocaleString()} tokens (estimated from text volume)`
                                                : `${activity.tokens.toLocaleString()} tokens`
                                        }
                                    >
                                        <Coins size={9} className="shrink-0" />
                                        {activity.tokensEstimated ? "~" : ""}{formatTokens(activity.tokens)}
                                    </span>
                                ) : (
                                    <span
                                        className="inline-flex items-center gap-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600"
                                        title="No token count recorded for this activity"
                                    >
                                        <Coins size={9} className="shrink-0" />—
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
