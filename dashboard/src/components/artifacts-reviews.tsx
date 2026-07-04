"use client";

import { useState, useEffect, useCallback } from "react";
import { getDashboardStats, DashboardStats } from "@/lib/nexus";
import {
    Loader2,
} from "lucide-react";
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
            <ArtifactsList
                items={stats.artifactsInReview.items}
                projectCount={stats.artifactsInReview.project}
                taskCount={stats.artifactsInReview.task}
            />

            <TaskStatusTiles stats={stats.tasksByStatus} />
        </div>
    );
}

