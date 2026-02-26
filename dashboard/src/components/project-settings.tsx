"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Project, updateProject, deleteProject } from "@/lib/nexus";
import { Edit2, Save, X, Globe, GitBranch, Layout, Plus, Trash2, FolderOpen, AlertTriangle } from "lucide-react";

interface ProjectSettingsProps {
    project: Project;
    onUpdate: () => void;
}

export function ProjectSettings({ project, onUpdate }: ProjectSettingsProps) {
    const router = useRouter();
    const [isEditing, setIsEditing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [editedProject, setEditedProject] = useState<Project>(project);
    const [stackEntry, setStackEntry] = useState({ key: '', value: '' });

    // Delete modal state
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleteFilesOption, setDeleteFilesOption] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const handleDelete = async () => {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteProject(project.id, deleteFilesOption);
            router.push('/');
        } catch (error) {
            console.error('Failed to delete project:', error);
            setDeleteError(error instanceof Error ? error.message : 'Failed to delete project');
            setDeleting(false);
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
                stack: editedProject.stack
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
            <>
                <div className="relative group">
                    <button
                        onClick={() => setIsEditing(true)}
                        className="absolute top-0 right-0 p-2 bg-slate-800 text-slate-400 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:text-cyan-400 hover:bg-slate-700"
                    >
                        <Edit2 size={16} />
                    </button>

                    <div className="space-y-3">
                        <div>
                            <h2 className="text-2xl font-bold text-white mb-1">{project.name}</h2>
                            <p className="text-slate-400 text-sm mono">{project.path}</p>
                        </div>

                        {project.description && (
                            <p className="text-slate-300">{project.description}</p>
                        )}

                        <div className="flex flex-wrap items-center gap-4 text-sm">
                            <div className="flex items-center gap-2 text-slate-400">
                                <Layout size={16} className="text-purple-400" />
                                <span className="text-slate-200">{project.type}</span>
                            </div>
                            {project.vibe && (
                                <div className="flex items-center gap-2 text-slate-400">
                                    <span className="text-yellow-400">⚡</span>
                                    <span className="text-slate-200">{project.vibe}</span>
                                </div>
                            )}

                            {(project.urls?.production || project.urls?.repo) && (
                                <>
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
                                </>
                            )}

                            <button
                                onClick={() => setShowDeleteModal(true)}
                                className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 transition-colors ml-auto"
                            >
                                <Trash2 size={14} />
                                Delete
                            </button>
                        </div>
                    </div>
                </div>

                {/* Delete Confirmation Modal */}
                {showDeleteModal && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !deleting && setShowDeleteModal(false)}>
                        <div className="bg-slate-900 border border-red-500/30 rounded-xl p-6 max-w-md w-full mx-4 animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-3 mb-4">
                                <div className="p-2 bg-red-500/20 rounded-lg">
                                    <AlertTriangle className="text-red-400" size={24} />
                                </div>
                                <h3 className="text-xl font-semibold text-white">Delete Project</h3>
                            </div>

                            <p className="text-slate-400 mb-4">
                                Are you sure you want to delete <span className="text-white font-medium">{project.name}</span>?
                            </p>

                            <div className="space-y-3 mb-6">
                                <label className="flex items-start gap-3 p-3 bg-slate-800/50 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors">
                                    <input
                                        type="radio"
                                        name="deleteOption"
                                        checked={!deleteFilesOption}
                                        onChange={() => setDeleteFilesOption(false)}
                                        className="mt-0.5"
                                    />
                                    <div>
                                        <p className="text-white text-sm font-medium">Remove from Dashboard</p>
                                        <p className="text-slate-500 text-xs">Project files will remain on disk</p>
                                    </div>
                                </label>
                                <label className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg cursor-pointer hover:bg-red-500/20 transition-colors">
                                    <input
                                        type="radio"
                                        name="deleteOption"
                                        checked={deleteFilesOption}
                                        onChange={() => setDeleteFilesOption(true)}
                                        className="mt-0.5"
                                    />
                                    <div>
                                        <p className="text-red-400 text-sm font-medium">Delete Everything</p>
                                        <p className="text-red-400/60 text-xs">Permanently remove project folder from disk</p>
                                    </div>
                                </label>
                            </div>

                            {deleteError && (
                                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                                    {deleteError}
                                </div>
                            )}

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowDeleteModal(false)}
                                    disabled={deleting}
                                    className="flex-1 px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="flex-1 px-4 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {deleting ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-red-400/30 border-t-red-400 rounded-full animate-spin" />
                                            Deleting...
                                        </>
                                    ) : (
                                        <>
                                            <Trash2 size={16} />
                                            Delete
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    }

    return (
        <div className="bg-slate-900 border border-cyan-500/30 rounded-xl p-6 relative animate-in fade-in zoom-in-95 duration-200">
            <div className="absolute top-4 right-4 flex gap-2">
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
            </div>
        </div>
    );
}
