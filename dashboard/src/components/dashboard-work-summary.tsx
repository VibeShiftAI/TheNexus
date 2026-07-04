"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
        <div className="mb-8">
            <TaskStatusTiles stats={stats.tasksByStatus} />
        </div>
    );
}
