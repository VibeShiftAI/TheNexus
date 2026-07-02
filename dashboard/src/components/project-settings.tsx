"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Project, updateProject, archiveProject } from "@/lib/nexus";
import { Edit2, Save, X, Globe, GitBranch, Layout, Plus, Trash2, FolderOpen, Target, Archive } from "lucide-react";

interface ProjectSettingsProps {
    project: Project;
    onUpdate: () => void;
}

export function ProjectSettings({ project, onUpdate }: ProjectSettingsProps) {
    const router = useRouter();
    const [isEditing, setIsEditing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [confirmArchive, setConfirmArchive] = useState(false);
    const [editedProject, setEditedProject] = useState<Project>(project);
    const [stackEntry, setStackEntry] = useState({ key: '', value: '' });

    const handleArchive = async () => {
        setArchiving(true);
        try {
            await archiveProject(project.id);
            // Archived projects drop off the dashboard — send the operator back there.
            router.push('/');
        } catch (error) {
            console.error('Failed to archive project:', error);
            alert(error instanceof Error ? error.message : 'Failed to archive project');
            setArchiving(false);
            setConfirmArchive(false);
        }
    };

    const handleChange = (field: keyof Project, value: any) => {
        setEditedProject(prev => ({ ...prev, [field]: value }));
    };

    const handleUrlChange = (type: 'production' | 'repo', value: string) => {
        setEditedProject(prev => ({
            ...prev,
            urls: {
                ...prev.urls,
                [type]: value
            }
        }));
    };

    const handleAddStack = () => {
        if (!stackEntry.key || !stackEntry.value) return;
        setEditedProject(prev => ({
            ...prev,
            stack: {
                ...prev.stack,
                [stackEntry.key]: stackEntry.value
            }
        }));
        setStackEntry({ key: '', value: '' });
    };

    const handleRemoveStack = (key: string) => {
        const newStack = { ...editedProject.stack };
        delete newStack[key];
        setEditedProject(prev => ({ ...prev, stack: newStack }));
    };

    const handleSave = async () => {
        setLoading(true);
        try {
            await updateProject(project.id, {
                name: editedProject.name,
                description: editedProject.description,
                type: editedProject.type,
                path: editedProject.path,
                vibe: editedProject.vibe,
                urls: editedProject.urls,
                stack: editedProject.stack,
                end_state: editedProject.end_state
            });
            setIsEditing(false);
            onUpdate();
        } catch (error) {
            console.error('Failed to update project:', error);
            alert('Failed to update project');
        } finally {
            setLoading(false);
        }
    };

    if (!isEditing) {
        return (
            <div className="relative group">
                <button
                    onClick={() => setIsEditing(true)}
                    className="absolute top-0 right-0 p-2 bg-slate-800 text-slate-400 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:text-cyan-400 hover:bg-slate-700"
                >
                    <Edit2 size={16} />
                </button>

                <div className="flex items-start justify-between gap-4">
                    {/* Left: Name + Description */}
                    <div className="min-w-0">
                        <h2 className="text-2xl font-bold text-white leading-tight">{project.name}</h2>
                        {project.description && (
                            <p className="text-slate-300 text-sm mt-1">{project.description}</p>
                        )}
                    </div>

                    {/* Right: Path + Type/Vibe badges */}
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <p className="text-slate-500 text-xs font-mono">{project.path}</p>
                        <div className="flex items-center gap-3 text-sm">
                            <div className="flex items-center gap-1.5 text-slate-400">
                                <Layout size={14} className="text-purple-400" />
                                <span className="text-slate-300 text-xs">{project.type}</span>
                            </div>
                            {project.vibe && (
                                <div className="flex items-center gap-1.5 text-slate-400">
                                    <span className="text-yellow-400 text-xs">⚡</span>
                                    <span className="text-slate-300 text-xs">{project.vibe}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* URL links */}
                {(project.urls?.production || project.urls?.repo) && (
                    <div className="flex flex-wrap items-center gap-3 text-sm mt-2">
                        {project.urls?.production && (
                            <a
                                href={project.urls.production}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 px-3 py-1.5 rounded-lg border border-cyan-500/20"
                            >
                                <Globe size={14} />
                                Production Payload
                            </a>
                        )}
                        {project.urls?.repo && (
                            <a
                                href={project.urls.repo}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-xs text-slate-400 hover:text-white bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700"
                            >
                                <GitBranch size={14} />
                                Source Matrix
                            </a>
                        )}
                    </div>
                )}

                {/* End State display */}
                {project.end_state && (
                    <div className="mt-3 p-3 rounded-lg bg-gradient-to-r from-emerald-500/5 to-cyan-500/5 border border-emerald-500/20">
                        <div className="flex items-center gap-2 mb-1">
                            <Target size={14} className="text-emerald-400" />
                            <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">End State</span>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed">{project.end_state}</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="bg-slate-900 border border-cyan-500/30 rounded-xl p-6 relative animate-in fade-in zoom-in-95 duration-200">
            <div className="sticky -top-3 z-20 -mx-6 -mt-6 mb-2 flex justify-end gap-2 px-6 py-3 bg-slate-900/95 backdrop-blur border-b border-cyan-500/20 rounded-t-xl">
                <button
                    onClick={() => setIsEditing(false)}
                    disabled={loading}
                    className="p-2 bg-slate-800 text-slate-400 rounded-lg hover:text-white transition-colors"
                >
                    <X size={16} />
                </button>
                <button
                    onClick={handleSave}
                    disabled={loading}
                    className="p-2 bg-cyan-500 text-white rounded-lg hover:bg-cyan-600 transition-colors flex items-center gap-2"
                >
                    {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={16} />}
                    Save
                </button>
            </div>

            <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500 uppercase">Project Name</label>
                        <input
                            type="text"
                            value={editedProject.name}
                            onChange={(e) => handleChange('name', e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500 uppercase">Type</label>
                        <select
                            value={editedProject.type}
                            onChange={(e) => handleChange('type', e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors appearance-none"
                        >
                            <option value="web-app">Web App</option>
                            <option value="game">Game</option>
                            <option value="tool">Tool</option>
                            <option value="mobile-app">Mobile App</option>
                            <option value="library">Library</option>
                        </select>
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-500 uppercase">Project Path</label>
                    <div className="relative">
                        <FolderOpen size={14} className="absolute left-3 top-3 text-slate-500" />
                        <input
                            type="text"
                            value={editedProject.path || ''}
                            onChange={(e) => handleChange('path', e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors font-mono text-sm"
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-500 uppercase">Description</label>
                    <textarea
                        value={editedProject.description || ''}
                        onChange={(e) => handleChange('description', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors h-24 resize-none"
                    />
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-emerald-400 uppercase flex items-center gap-2">
                        <Target size={12} />
                        End State — Goal Regression Target
                    </label>
                    <textarea
                        value={editedProject.end_state || ''}
                        onChange={(e) => handleChange('end_state', e.target.value)}
                        placeholder="Describe the desired end state of this project. Praxis will use this to backward-chain tasks and evaluate progress."
                        className="w-full bg-slate-950 border border-emerald-500/30 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-400 transition-colors h-28 resize-none placeholder:text-slate-600"
                    />
                    <p className="text-xs text-slate-500">Praxis uses this to evaluate progress, identify gaps, and auto-generate missing tasks.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500 uppercase">Vibe</label>
                        <input
                            type="text"
                            value={editedProject.vibe || ''}
                            onChange={(e) => handleChange('vibe', e.target.value)}
                            placeholder="e.g. immaculate"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500 uppercase">Production URL</label>
                        <div className="relative">
                            <Globe size={14} className="absolute left-3 top-3 text-slate-500" />
                            <input
                                type="text"
                                value={editedProject.urls?.production || ''}
                                onChange={(e) => handleUrlChange('production', e.target.value)}
                                placeholder="https://"
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                            />
                        </div>
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-500 uppercase">Tech Stack</label>
                    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-3">
                        {editedProject.stack && Object.entries(editedProject.stack).map(([key, val]) => (
                            <div key={key} className="flex items-center justify-between text-sm bg-slate-900 rounded px-2 py-1">
                                <div className="flex gap-2">
                                    <span className="text-cyan-400 font-mono">{key}:</span>
                                    <span className="text-slate-300">{val}</span>
                                </div>
                                <button onClick={() => handleRemoveStack(key)} className="text-slate-500 hover:text-red-400">
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))}
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="Key (e.g. framework)"
                                value={stackEntry.key}
                                onChange={(e) => setStackEntry(prev => ({ ...prev, key: e.target.value }))}
                                className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white focus:border-cyan-500 outline-none"
                            />
                            <input
                                type="text"
                                placeholder="Value (e.g. Next.js)"
                                value={stackEntry.value}
                                onChange={(e) => setStackEntry(prev => ({ ...prev, value: e.target.value }))}
                                className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white focus:border-cyan-500 outline-none"
                            />
                            <button
                                onClick={handleAddStack}
                                className="p-1.5 bg-cyan-500/20 text-cyan-400 rounded hover:bg-cyan-500/30"
                            >
                                <Plus size={16} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Archive (danger zone) */}
                <div className="space-y-2 pt-4 border-t border-slate-800">
                    <label className="text-xs font-medium text-amber-400/80 uppercase flex items-center gap-2">
                        <Archive size={12} />
                        Archive Project
                    </label>
                    {!confirmArchive ? (
                        <div className="flex items-center justify-between gap-3 bg-slate-950 border border-amber-500/20 rounded-lg px-3 py-2.5">
                            <p className="text-xs text-slate-400">
                                Archives this project and all its tasks, and hides it from the dashboard and AI context.
                                Code and files on disk are left untouched. Reversible.
                            </p>
                            <button
                                onClick={() => setConfirmArchive(true)}
                                disabled={archiving}
                                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300 transition-colors text-xs font-semibold"
                            >
                                <Archive size={14} />
                                Archive
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-3 bg-amber-500/5 border border-amber-500/40 rounded-lg px-3 py-2.5">
                            <p className="text-xs text-amber-300">
                                Archive <span className="font-bold">{project.name}</span> and its tasks? Files stay intact and you can restore it later.
                            </p>
                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    onClick={() => setConfirmArchive(false)}
                                    disabled={archiving}
                                    className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white transition-colors text-xs font-medium"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleArchive}
                                    disabled={archiving}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors text-xs font-bold"
                                >
                                    {archiving ? <div className="w-3.5 h-3.5 border-2 border-slate-950/30 border-t-slate-950 rounded-full animate-spin" /> : <Archive size={14} />}
                                    Confirm Archive
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
