"use client"

import { useEffect, useState } from "react";
import { getActivity, Activity } from "@/lib/nexus";
import { GitCommit, Clock } from "lucide-react";

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
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
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
                            <span className="text-xs text-slate-500 font-mono">{activity.hash.substring(0, 7)}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
