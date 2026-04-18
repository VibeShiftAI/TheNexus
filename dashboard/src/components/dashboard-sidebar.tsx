"use client";

import { useState, useEffect, useCallback } from "react";
import { getDashboardStats, DashboardStats } from "@/lib/nexus";
import {
    Loader2,
    Layers,
} from "lucide-react";
import { ArtifactsList } from "./artifacts-list";
import { TaskStatusTiles } from "./task-status-tiles";
import { PresenceIndicator } from "./presence-indicator";
import { HitlInbox } from "./hitl-inbox";

interface DashboardSidebarProps {
    onRefresh?: () => void;
}

export function DashboardSidebar({ onRefresh }: DashboardSidebarProps) {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const data = await getDashboardStats();
            setStats(data);
        } catch (err) {
            console.error("[DashboardSidebar] Failed to load stats:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData, onRefresh]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8 h-full">
                <Loader2 className="animate-spin text-cyan-400" size={24} />
            </div>
        );
    }

    if (!stats) return null;

    return (
        <div className="space-y-4 pr-1">
            {/* Praxis presence — live via SSE (Phase 3) */}
            <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Praxis</div>
                <PresenceIndicator />
            </div>

            <HitlInbox />

            {/* Artifacts In Review */}
            <ArtifactsList
                items={stats.artifactsInReview.items}
                projectCount={stats.artifactsInReview.project}
                taskCount={stats.artifactsInReview.task}
            />

            {/* Active Workflows */}
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

            {/* Task Status Overview */}
            <TaskStatusTiles stats={stats.tasksByStatus} />
        </div>
    );
}
