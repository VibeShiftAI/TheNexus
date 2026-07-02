"use client";

import { useState, useEffect, useCallback } from "react";
import { Archive, RotateCcw, Loader2 } from "lucide-react";
import { getArchivedProjects, unarchiveProject, type Project } from "@/lib/nexus";

interface ArchivedProjectsListProps {
    /** Bump/toggle to force a reload (e.g. when the parent modal opens). */
    reloadKey?: unknown;
}

export function ArchivedProjectsList({ reloadKey }: ArchivedProjectsListProps) {
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [restoringId, setRestoringId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setError(null);
            setProjects(await getArchivedProjects());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load archived projects");
            setProjects([]);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load, reloadKey]);

    const handleRestore = async (id: string) => {
        setRestoringId(id);
        try {
            await unarchiveProject(id);
            setProjects(prev => (prev ? prev.filter(p => p.id !== id) : prev));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to restore project");
        } finally {
            setRestoringId(null);
        }
    };

    return (
        <div>
            <div className="flex items-center gap-3 pb-1">
                <div className="h-px flex-1 bg-slate-800" />
                <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                    <Archive size={12} />
                    Archived Projects
                </span>
                <div className="h-px flex-1 bg-slate-800" />
            </div>

            {projects === null ? (
                <div className="flex items-center justify-center py-6">
                    <Loader2 className="animate-spin text-slate-500" size={20} />
                </div>
            ) : error ? (
                <p className="text-xs text-red-400 py-2">{error}</p>
            ) : projects.length === 0 ? (
                <p className="text-xs text-slate-500 py-2 text-center">No archived projects.</p>
            ) : (
                <ul className="space-y-2 mt-1">
                    {projects.map(p => (
                        <li
                            key={p.id}
                            className="flex items-center justify-between gap-3 rounded-lg bg-slate-800/60 border border-slate-700 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-200 truncate">{p.name}</p>
                                <p className="text-xs text-slate-500 font-mono truncate">{p.path}</p>
                            </div>
                            <button
                                onClick={() => handleRestore(p.id)}
                                disabled={restoringId === p.id}
                                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300 transition-colors text-xs font-semibold disabled:opacity-60"
                            >
                                {restoringId === p.id ? (
                                    <Loader2 size={13} className="animate-spin" />
                                ) : (
                                    <RotateCcw size={13} />
                                )}
                                Restore
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
