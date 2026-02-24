"use client";

import {
    Brain,
    Lightbulb,
    Search,
    PenTool,
    PlayCircle,
    CheckCircle
} from "lucide-react";

interface TaskStatusTilesProps {
    stats: Record<string, number>;
    className?: string;
}

export function TaskStatusTiles({ stats, className = "" }: TaskStatusTilesProps) {
    return (
        <div className={`bg-slate-900/50 border border-slate-800 rounded-lg p-6 ${className}`}>
            <div className="flex items-center gap-2 mb-4">
                <Brain className="text-cyan-400" size={20} />
                <h3 className="text-lg font-bold text-white">Task Status Overview</h3>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <StatusCard
                    label="Ideas"
                    count={stats['idea'] || 0}
                    icon={Lightbulb}
                    color="text-blue-600"
                    bg="bg-blue-600/10"
                />
                <StatusCard
                    label="Researching"
                    count={(stats['researching'] || 0) + (stats['researched'] || 0)}
                    icon={Search}
                    color="text-blue-400"
                    bg="bg-blue-400/10"
                />
                <StatusCard
                    label="Planning"
                    count={(stats['planning'] || 0) + (stats['planned'] || 0)}
                    icon={PenTool}
                    color="text-purple-400"
                    bg="bg-purple-400/10"
                />
                <StatusCard
                    label="Implementing"
                    count={(stats['implementing'] || 0) + (stats['testing'] || 0)}
                    icon={PlayCircle}
                    color="text-cyan-400"
                    bg="bg-cyan-400/10"
                />
                <StatusCard
                    label="Completed"
                    count={stats['complete'] || 0}
                    icon={CheckCircle}
                    color="text-emerald-400"
                    bg="bg-emerald-400/10"
                />
            </div>
        </div>
    );
}

function StatusCard({ label, count, icon: Icon, color, bg }: { label: string, count: number, icon: any, color: string, bg: string }) {
    return (
        <div className={`p-3 rounded-lg border border-slate-800 ${bg} flex flex-col items-center justify-center text-center`}>
            <Icon size={18} className={`${color} mb-1`} />
            <span className="text-xl font-bold text-white">{count}</span>
            <span className="text-xs text-slate-400">{label}</span>
        </div>
    );
}
