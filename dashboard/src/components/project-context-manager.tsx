"use client";

import { useState, useEffect } from "react";
import { Project, getProjectContext, updateProjectContext, syncContextFromGit } from "@/lib/nexus";
import { FileText, Save, Loader2, Check, Map, Copy, RefreshCw } from "lucide-react";
import { MermaidViewer } from "./mermaid-viewer";

interface ProjectContextManagerProps {
    project: Project;
}

const CONTEXT_TYPES = [
    { id: 'product', label: 'Product Vision', description: 'The high-level product strategy and goals.' },
    { id: 'tech-stack', label: 'Tech Stack', description: 'Defined technologies and architectural choices.' },
    { id: 'product-guidelines', label: 'Guidelines', description: 'Design principles and product guidelines.' },
    { id: 'workflow', label: 'Workflow', description: 'Team processes and ways of working.' },
    { id: 'context_map', label: 'System Map', description: 'Visual map of the system architecture.', isMap: true },
    { id: 'database-schema', label: 'DB Schema', description: 'Database schema definitions.' },
    { id: 'project-workflow-map', label: 'Project Workflow', description: 'Map of project workflows.', isMap: true },
    { id: 'task-pipeline-map', label: 'Task Pipeline', description: 'Task pipeline visualization.', isMap: true },
    { id: 'function_map', label: 'Function Map', description: 'Map of system functions.', isMap: true }
];

export function ProjectContextManager({ project }: ProjectContextManagerProps) {
    const [activeType, setActiveType] = useState('product');
    const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
    const [contexts, setContexts] = useState<Record<string, { content: string, status: string }>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [copied, setCopied] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [lastSynced, setLastSynced] = useState<Date | null>(null);

    useEffect(() => {
        loadContexts();
        // Reset to preview mode if it's a map
        if (activeType.includes('map')) setViewMode('preview');
    }, [project.id]);

    const loadContexts = async () => {
        setLoading(true);
        try {
            const data = await getProjectContext(project.id);
            const contextMap: Record<string, { content: string, status: string }> = {};
            data.contexts.forEach(ctx => {
                contextMap[ctx.context_type] = {
                    content: ctx.content,
                    status: ctx.status || 'draft'
                };
            });
            setContexts(contextMap);
        } catch (error) {
            console.error('Failed to load contexts:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const current = contexts[activeType] || { content: '', status: 'draft' };
            await updateProjectContext(
                project.id,
                activeType,
                current.content,
                current.status
            );
            setLastSaved(new Date());
        } catch (error) {
            console.error('Failed to save context:', error);
            alert('Failed to save context');
        } finally {
            setSaving(false);
        }
    };

    const handleChange = (value: string) => {
        setContexts(prev => ({
            ...prev,
            [activeType]: {
                ...(prev[activeType] || { status: 'draft' }),
                content: value
            }
        }));
    };

    const handleStatusChange = (status: string) => {
        setContexts(prev => ({
            ...prev,
            [activeType]: {
                ...(prev[activeType] || { content: '' }),
                status: status
            }
        }));
    };

    const handleCopyAll = async () => {
        const allContext = CONTEXT_TYPES.map(type => {
            const contextData = contexts[type.id];
            if (!contextData || !contextData.content) return null;
            return `# ${type.label}\n\n${contextData.content}\n`;
        })
            .filter(Boolean)
            .join('\n---\n\n');

        if (allContext) {
            try {
                await navigator.clipboard.writeText(allContext);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            } catch (err) {
                console.error('Failed to copy concepts:', err);
            }
        }
    };

    const handleSync = async () => {
        setSyncing(true);
        try {
            const result = await syncContextFromGit(project.id);
            if (result.synced > 0) {
                // Reload contexts after sync
                await loadContexts();
            }
            setLastSynced(new Date());
        } catch (error) {
            console.error('Failed to sync from Git:', error);
            alert('Failed to sync from Git');
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="flex flex-col h-[500px]">
            <div className="flex flex-1 min-h-0">
                <div className="w-48 border-r border-slate-800 bg-slate-950/30 p-2 space-y-1">
                    {CONTEXT_TYPES.map(type => (
                        <button
                            key={type.id}
                            onClick={() => setActiveType(type.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${activeType === type.id
                                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                                : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                }`}
                        >
                            <div className="font-medium">{type.label}</div>
                            {/* <div className="text-xs text-slate-500 truncate">{type.description}</div> */}
                        </button>
                    ))}
                    <div className="pt-2 mt-2 border-t border-slate-800">
                        <button
                            onClick={handleCopyAll}
                            className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors text-slate-400 hover:text-white hover:bg-slate-800 flex items-center gap-2"
                        >
                            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                            <span className={copied ? "text-emerald-500" : ""}>
                                {copied ? "Copied!" : "Copy All Context"}
                            </span>
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex flex-col bg-slate-950">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50">
                        <div className="flex items-center gap-2 text-slate-300">
                            <FileText size={16} className="text-cyan-500" />
                            <span className="font-mono text-sm">{activeType}.md</span>
                        </div>
                        <div className="flex items-center gap-4">
                            {lastSynced && (
                                <span className="text-xs text-emerald-500">
                                    Synced {lastSynced.toLocaleTimeString()}
                                </span>
                            )}
                            {lastSaved && (
                                <span className="text-xs text-slate-500">
                                    Saved {lastSaved.toLocaleTimeString()}
                                </span>
                            )}
                            <select
                                value={contexts[activeType]?.status || 'draft'}
                                onChange={(e) => handleStatusChange(e.target.value)}
                                className="bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-cyan-500"
                            >
                                <option value="draft">Draft</option>
                                <option value="review_pending">Review Pending</option>
                                <option value="approved">Approved</option>
                                <option value="deprecated">Deprecated</option>
                            </select>
                            <button
                                onClick={handleSync}
                                disabled={syncing}
                                className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                                title="Pull latest from Git and sync to database"
                            >
                                {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                Sync from Git
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500 hover:bg-cyan-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                            >
                                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                Save Changes
                            </button>
                        </div>
                    </div>

                    {CONTEXT_TYPES.find(t => t.id === activeType)?.isMap && (
                        <div className="flex gap-2 px-4 py-2 bg-slate-900 border-b border-slate-800">
                            <button
                                onClick={() => setViewMode('preview')}
                                className={`text-xs px-3 py-1 rounded-full ${viewMode === 'preview' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
                            >
                                Preview
                            </button>
                            <button
                                onClick={() => setViewMode('edit')}
                                className={`text-xs px-3 py-1 rounded-full ${viewMode === 'edit' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
                            >
                                Edit Source
                            </button>
                        </div>
                    )}

                    <div className="flex-1 relative">
                        {loading ? (
                            <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                                <Loader2 className="animate-spin mb-2" />
                            </div>
                        ) : (
                            viewMode === 'preview' && CONTEXT_TYPES.find(t => t.id === activeType)?.isMap ? (
                                <MermaidViewer chart={contexts[activeType]?.content || ''} />
                            ) : (
                                <textarea
                                    value={contexts[activeType]?.content || ''}
                                    onChange={(e) => handleChange(e.target.value)}
                                    className="w-full h-full bg-slate-950 text-slate-300 font-mono text-sm p-4 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
                                    placeholder={`Enter ${activeType} content here...`}
                                    spellCheck={false}
                                />
                            )
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
