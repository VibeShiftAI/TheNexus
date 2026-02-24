"use client";

import {
    ClipboardList,
    CheckCircle,
    Search,
    PenTool,
    PlayCircle,
    Layers,
    FileText
} from "lucide-react";
import Link from "next/link";
import { ReviewItem } from "@/lib/nexus";

interface ArtifactsListProps {
    items: ReviewItem[];
    projectCount: number;
    taskCount: number;
    projectId?: string; // Optional: if provided, we could filter or alternate UI, but for now mostly for stats context
    className?: string; // Additional classes
}

export function ArtifactsList({ items, projectCount, taskCount, projectId, className = "" }: ArtifactsListProps) {
    // If projectId is provided, we might want to filter items client-side if the API sends all.
    // However, the dashboard sends pre-aggregated stats.
    // For the Project page, we'll assume the passed 'items' are already relevant to that project
    // unless the caller passes global items and expects us to filter.
    // Let's implement client-side filtering support just in case.
    const filteredItems = projectId
        ? items.filter(i => i.projectId === projectId)
        : items;

    // Recalculate counts if filtered
    const displayProjectCount = projectId
        ? filteredItems.filter(i => i.level === 'Project').length
        : projectCount;
    const displayTaskCount = projectId
        ? filteredItems.filter(i => i.level === 'Task').length
        : taskCount;

    return (
        <div className={`bg-slate-900/50 border border-slate-800 rounded-lg p-6 ${className}`}>
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                    <ClipboardList className="text-yellow-400" size={24} />
                    <h2 className="text-xl font-bold text-white">Artifacts In Review</h2>
                </div>
                <div className="flex gap-2">
                    <span className="px-3 py-1 rounded-full bg-slate-800 text-xs font-medium text-slate-400">
                        Project: <span className="text-white">{displayProjectCount}</span>
                    </span>
                    <span className="px-3 py-1 rounded-full bg-slate-800 text-xs font-medium text-slate-400">
                        Task: <span className="text-white">{displayTaskCount}</span>
                    </span>
                </div>
            </div>

            {filteredItems.length === 0 ? (
                <div className="text-center py-8 border border-dashed border-slate-700 rounded-lg">
                    <CheckCircle className="mx-auto text-emerald-500 mb-2" size={32} />
                    <p className="text-slate-400 text-sm">All caught up! No artifacts pending review.</p>
                </div>
            ) : (
                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                    {filteredItems.map((item, idx) => (
                        <Link
                            key={`${item.id}-${idx}`}
                            href={item.level === 'Task'
                                ? `/project/${item.projectId}?taskId=${item.id}&artifact=${item.type.replace('task-', '')}`
                                : `/project/${item.projectId}`
                            }
                            className="block p-3 rounded bg-slate-800/50 hover:bg-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all group"
                        >
                            <div className="flex items-center justify-between mb-1">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded ${item.level === 'Project' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'
                                    }`}>
                                    {item.level} Level
                                </span>
                                <span className="text-xs text-slate-500 group-hover:text-cyan-400 transition-colors">
                                    View &rarr;
                                </span>
                            </div>
                            <h4 className="text-sm font-medium text-slate-200 group-hover:text-white truncate">
                                {item.name}
                            </h4>
                            <div className="flex items-center gap-2 mt-2">
                                <TypeIcon type={item.type} />
                                <span className="text-xs text-slate-500 capitalize">
                                    {item.type.replace('task-', '').replace('project-', '').replace('-', ' ')}
                                </span>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

function TypeIcon({ type }: { type: string }) {
    switch (type) {
        case 'task-research': return <Search size={14} className="text-blue-400" />;
        case 'task-plan': return <PenTool size={14} className="text-purple-400" />;
        case 'task-walkthrough': return <PlayCircle size={14} className="text-cyan-400" />;
        case 'project-workflow': return <Layers size={14} className="text-emerald-400" />;
        case 'project-context': return <FileText size={14} className="text-orange-400" />;
        default: return <FileText size={14} className="text-slate-400" />;
    }
}
