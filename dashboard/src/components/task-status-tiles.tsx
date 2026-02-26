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
        <div className={`bg-slate-900/50 border border-slate-800 rounded-lg p-4 ${className}`}>
            <div className="flex items-center gap-2 mb-3">
                <Brain className="text-cyan-400" size={16} />
                <h3 className="text-sm font-bold text-white">Task Status</h3>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <StatusCard
                    label="Ideas"
                    count={stats['idea'] || 0}
                    icon={Lightbulb}
                    color="text-blue-600"
                    bg="bg-blue-600/10"
                />
                <StatusCard
                    label="Research"
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
                    label="Building"
                    count={(stats['implementing'] || 0) + (stats['testing'] || 0)}
                    icon={PlayCircle}
                    color="text-cyan-400"
                    bg="bg-cyan-400/10"
                />
                <StatusCard
                    label="Done"
                    count={stats['complete'] || 0}
                    icon={CheckCircle}
                    color="text-emerald-400"
                    bg="bg-emerald-400/10"
                    className="col-span-2"
                />
            </div>
        </div>
    );
}

function StatusCard({ label, count, icon: Icon, color, bg, className = "" }: { label: string, count: number, icon: any, color: string, bg: string, className?: string }) {
    return (
        <div className={`px-2.5 py-2 rounded-lg border border-slate-800 ${bg} flex items-center gap-2 ${className}`}>
            <Icon size={14} className={`${color} shrink-0`} />
            <span className="text-lg font-bold text-white">{count}</span>
            <span className="text-xs text-slate-400">{label}</span>
        </div>
    );
}
