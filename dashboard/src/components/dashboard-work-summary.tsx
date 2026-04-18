"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import { getDashboardStats, type DashboardStats } from "@/lib/nexus";
import { TaskStatusTiles } from "./task-status-tiles";

interface DashboardWorkSummaryProps {
    onRefresh?: () => void;
}

export function DashboardWorkSummary({ onRefresh }: DashboardWorkSummaryProps) {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const data = await getDashboardStats();
            setStats(data);
        } catch (err) {
            console.error("[DashboardWorkSummary] Failed to load stats:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData, onRefresh]);

    if (loading) {
        return (
            <div className="mb-8 flex items-center justify-center rounded-lg border border-slate-800 bg-slate-900/50 py-8">
                <Loader2 className="animate-spin text-cyan-400" size={24} />
            </div>
        );
    }

    if (!stats) return null;

    return (
        <div className="mb-8 grid gap-6 lg:grid-cols-[360px_1fr]">
            <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400">
                        <Layers size={20} />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-white">Active Project Workflows</h3>
                        <p className="text-xs text-slate-400">Currently in progress</p>
                    </div>
                </div>
                <span className="text-2xl font-bold text-emerald-400">
                    {stats.activeProjectWorkflows}
                </span>
            </div>

            <TaskStatusTiles stats={stats.tasksByStatus} />
        </div>
    );
}
