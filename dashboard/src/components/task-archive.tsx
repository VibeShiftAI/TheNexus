"use client";

import { useState } from "react";
import { Task, TaskStatus, deleteTask, updateTask } from "@/lib/nexus";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, Archive, Trash2, RotateCcw, Search, Undo2 } from "lucide-react";

interface TaskArchiveProps {
    projectId: string;
    tasks: Task[];
    onTasksChange: () => void;
    onTaskSelect: (task: Task) => void;
}

export function TaskArchive({ projectId, tasks, onTasksChange, onTaskSelect }: TaskArchiveProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

    const completedTasks = tasks.filter(t => t.status === 'complete');
    const rejectedTasks = tasks.filter(t => t.status === 'rejected');
    const cancelledTasks = tasks.filter(t => t.status === 'cancelled');
    const totalArchived = completedTasks.length + rejectedTasks.length + cancelledTasks.length;

    if (totalArchived === 0) return null;

    const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await deleteTask(projectId, taskId);
            setDeleteConfirm(null);
            onTasksChange();
        } catch (error) {
            console.error('Failed to delete task:', error);
        }
    };

    const handleRestart = async (task: Task, e: React.MouseEvent) => {
        e.stopPropagation();
        // Reset the task back to 'idea' status - clears it from archive
        // The backend updateTask should also clear researchReport/implementationPlan
        try {
            await updateTask(projectId, task.id, { status: 'idea' });
            onTasksChange();
        } catch (error) {
            console.error('Failed to restart task:', error);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/30 overflow-hidden">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between p-4 hover:bg-slate-800/50 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Archive size={18} className="text-slate-400" />
                    <span className="font-medium text-slate-300">Archive</span>
                    <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
                        {totalArchived}
                    </span>
                </div>
                {isExpanded ? (
                    <ChevronUp size={18} className="text-slate-500" />
                ) : (
                    <ChevronDown size={18} className="text-slate-500" />
                )}
            </button>

            {isExpanded && (
                <div className="p-4 pt-0 border-t border-slate-800/50">
                    <div className="space-y-6 mt-4">
                        {/* Completed Tasks */}
                        {completedTasks.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-emerald-500/70 uppercase tracking-wider mb-3 pl-1">
                                    Completed
                                </h4>
                                <div className="space-y-2">
                                    {completedTasks.map(task => (
                                        <div
                                            key={task.id}
                                            onClick={() => onTaskSelect(task)}
                                            className="group flex items-center justify-between p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/30 cursor-pointer transition-all"
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                                                <div className="min-w-0">
                                                    <p className="text-slate-200 font-medium truncate">{task.title}</p>
                                                    <p className="text-xs text-slate-500 flex items-center gap-2">
                                                        <span>Completed on {formatDate(task.updatedAt || task.createdAt)}</span>
                                                        {task.walkthrough && (
                                                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400/70">
                                                                Has Walkthrough
                                                            </span>
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                {deleteConfirm === task.id ? (
                                                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                        <span className="text-xs text-slate-400">Delete?</span>
                                                        <button
                                                            onClick={(e) => handleDeleteTask(task.id, e)}
                                                            className="text-red-400 hover:text-red-300 text-xs font-medium"
                                                        >
                                                            Yes
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}
                                                            className="text-slate-400 hover:text-slate-300 text-xs"
                                                        >
                                                            No
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setDeleteConfirm(task.id);
                                                        }}
                                                        className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Rejected Tasks */}
                        {rejectedTasks.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-red-500/70 uppercase tracking-wider mb-3 pl-1">
                                    Rejected
                                </h4>
                                <div className="space-y-2">
                                    {rejectedTasks.map(task => (
                                        <div
                                            key={task.id}
                                            onClick={() => onTaskSelect(task)}
                                            className="group flex items-center justify-between p-3 rounded-lg bg-red-500/10 border border-red-500/20 hover:border-red-500/30 cursor-pointer transition-all"
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                <XCircle size={16} className="text-red-500 shrink-0" />
                                                <div className="min-w-0">
                                                    <p className="text-slate-200 font-medium truncate">{task.title}</p>
                                                    <p className="text-xs text-slate-500">
                                                        Rejected on {formatDate(task.updatedAt || task.createdAt)}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={(e) => handleRestart(task, e)}
                                                    className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-blue-400 transition-colors text-xs font-medium"
                                                    title="Restart Research"
                                                >
                                                    <RotateCcw size={12} />
                                                    <span>Restart</span>
                                                </button>
                                                {deleteConfirm === task.id ? (
                                                    <div className="flex items-center gap-2 ml-2" onClick={e => e.stopPropagation()}>
                                                        <span className="text-xs text-slate-400">Delete?</span>
                                                        <button
                                                            onClick={(e) => handleDeleteTask(task.id, e)}
                                                            className="text-red-400 hover:text-red-300 text-xs font-medium"
                                                        >
                                                            Yes
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}
                                                            className="text-slate-400 hover:text-slate-300 text-xs"
                                                        >
                                                            No
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setDeleteConfirm(task.id);
                                                        }}
                                                        className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors ml-1"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Cancelled Tasks */}
                        {cancelledTasks.length > 0 && (
                            <div>
                                <h4 className="text-xs font-semibold text-slate-500/70 uppercase tracking-wider mb-3 pl-1">
                                    Cancelled
                                </h4>
                                <div className="space-y-2">
                                    {cancelledTasks.map(task => (
                                        <div
                                            key={task.id}
                                            onClick={() => onTaskSelect(task)}
                                            className="group flex items-center justify-between p-3 rounded-lg bg-slate-500/10 border border-slate-500/20 hover:border-slate-500/30 cursor-pointer transition-all"
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                <Undo2 size={16} className="text-slate-500 shrink-0" />
                                                <div className="min-w-0">
                                                    <p className="text-slate-200 font-medium truncate">{task.title}</p>
                                                    <p className="text-xs text-slate-500">
                                                        Cancelled on {formatDate(task.updatedAt || task.createdAt)}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={(e) => handleRestart(task, e)}
                                                    className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-blue-400 transition-colors text-xs font-medium"
                                                    title="Restart from Idea"
                                                >
                                                    <RotateCcw size={12} />
                                                    <span>Restart</span>
                                                </button>
                                                {deleteConfirm === task.id ? (
                                                    <div className="flex items-center gap-2 ml-2" onClick={e => e.stopPropagation()}>
                                                        <span className="text-xs text-slate-400">Delete?</span>
                                                        <button
                                                            onClick={(e) => handleDeleteTask(task.id, e)}
                                                            className="text-red-400 hover:text-red-300 text-xs font-medium"
                                                        >
                                                            Yes
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}
                                                            className="text-slate-400 hover:text-slate-300 text-xs"
                                                        >
                                                            No
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setDeleteConfirm(task.id);
                                                        }}
                                                        className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors ml-1"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
