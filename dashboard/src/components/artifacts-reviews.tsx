"use client";

import { useState, useEffect, useCallback } from "react";
import { getDashboardStats, DashboardStats } from "@/lib/nexus";
import {
    CheckCircle,
    Loader2,
    Layers,
    Lightbulb,
    Search,
    PenTool,
    PlayCircle,
    Brain
} from "lucide-react";
import Link from "next/link";
import { ArtifactsList } from "./artifacts-list";
import { TaskStatusTiles } from "./task-status-tiles";

interface ArtifactsReviewsProps {
    onRefresh?: () => void;
}

export function ArtifactsReviews({ onRefresh }: ArtifactsReviewsProps) {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const data = await getDashboardStats();
            setStats(data);
        } catch (err) {
            console.error("[ArtifactsReviews] Failed to load stats:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData, onRefresh]); // Reload when onRefresh triggers

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <Loader2 className="animate-spin text-cyan-400" size={24} />
            </div>
        );
    }

    if (!stats) return null;

    return (
        <div className="mb-8 grid gap-6 lg:grid-cols-2">
            {/* Left Column: Artifacts In Review */}
            <ArtifactsList
                items={stats.artifactsInReview.items}
                projectCount={stats.artifactsInReview.project}
                taskCount={stats.artifactsInReview.task}
            />

            {/* Right Column: Workflows & Tasks Stats */}
            <div className="space-y-6">
                {/* Active Workflows */}
                <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-6 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400">
                            <Layers size={24} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white">Active Project Workflows</h3>
                            <p className="text-sm text-slate-400">Workflows currently in progress</p>
                        </div>
                    </div>
                    <span className="text-3xl font-bold text-emerald-400">
                        {stats.activeProjectWorkflows}
                    </span>
                </div>

                {/* Task Status Overview */}
                <TaskStatusTiles stats={stats.tasksByStatus} />
            </div>
        </div>
    );
}


