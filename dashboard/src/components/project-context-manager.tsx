"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Project, getProjectContext, updateProjectContext, syncContextFromGit, deleteProject } from "@/lib/nexus";
import { FileText, Save, Loader2, Check, Map, Copy, RefreshCw, Plus, Trash2, AlertTriangle } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidViewer } from "./mermaid-viewer";

interface ProjectContextManagerProps {
    project: Project;
}

// Known context types with pretty labels and descriptions
const KNOWN_TYPES: Record<string, { label: string; description: string; isMap?: boolean }> = {
    'product': { label: 'Product Vision', description: 'The high-level product strategy and goals.' },
    'product-vision': { label: 'Product Vision', description: 'The high-level product strategy and goals.' },
    'tech-stack': { label: 'Tech Stack', description: 'Defined technologies and architectural choices.' },
    'product-guidelines': { label: 'Guidelines', description: 'Design principles and product guidelines.' },
    'workflow': { label: 'Workflow', description: 'Team processes and ways of working.' },
    'context_map': { label: 'System Map', description: 'Visual map of the system architecture.', isMap: true },
    'database-schema': { label: 'DB Schema', description: 'Database schema definitions.' },
    'project-workflow-map': { label: 'Project Workflow', description: 'Map of project workflows.', isMap: true },
    'task-pipeline-map': { label: 'Task Pipeline', description: 'Task pipeline visualization.', isMap: true },
    'function_map': { label: 'Function Map', description: 'Map of system functions.', isMap: true },
    'architecture': { label: 'Architecture', description: 'System architecture overview.' },
    'project-context': { label: 'Project Context', description: 'General project context and overview.' },
};

/** Auto-generate a pretty label from a context type ID */
function typeToLabel(id: string): string {
    return id
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

interface ContextTypeEntry {
    id: string;
    label: string;
    description: string;
    isMap?: boolean;
    hasContent?: boolean;
}

export function ProjectContextManager({ project }: ProjectContextManagerProps) {
    const router = useRouter();
    const [activeType, setActiveType] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<'edit' | 'preview'>('preview');
    const [contexts, setContexts] = useState<Record<string, { content: string, status: string }>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [copied, setCopied] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [lastSynced, setLastSynced] = useState<Date | null>(null);

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

    // Dynamically build context type list from API data
    const contextTypes: ContextTypeEntry[] = useMemo(() => {
        const typeIds = Object.keys(contexts);
        if (typeIds.length === 0) return [];

        return typeIds.map(id => {
            const known = KNOWN_TYPES[id];
            return {
                id,
                label: known?.label || typeToLabel(id),
                description: known?.description || `Documentation: ${typeToLabel(id)}`,
                isMap: known?.isMap || id.includes('map'),
                hasContent: !!(contexts[id]?.content),
            };
        }).sort((a, b) => {
            // Sort: items with content first, then alphabetically
            if (a.hasContent && !b.hasContent) return -1;
            if (!a.hasContent && b.hasContent) return 1;
            return a.label.localeCompare(b.label);
        });
    }, [contexts]);

    useEffect(() => {
        // Auto-sync from Git first to catch any files on disk not yet in DB,
        // then load contexts from DB
        const init = async () => {
            try {
                await syncContextFromGit(project.id);
            } catch (e) {
                // Non-fatal — just load whatever's in DB
                console.warn('Auto-sync failed:', e);
            }
            await loadContexts();
        };
        init();
    }, [project.id]);

    // Auto-select first type when context types change
    useEffect(() => {
        if (contextTypes.length > 0 && (!activeType || !contexts[activeType])) {
            setActiveType(contextTypes[0].id);
        }
    }, [contextTypes]);

    // Reset to preview mode if it's a map
    useEffect(() => {
        if (activeType?.includes('map')) setViewMode('preview');
    }, [activeType]);

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
        if (!activeType) return;
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
        if (!activeType) return;
        setContexts(prev => ({
            ...prev,
            [activeType]: {
                ...(prev[activeType] || { status: 'draft' }),
                content: value
            }
        }));
    };

    const handleStatusChange = (status: string) => {
        if (!activeType) return;
        setContexts(prev => ({
            ...prev,
            [activeType]: {
                ...(prev[activeType] || { content: '' }),
                status: status
            }
        }));
    };

    const handleCopyAll = async () => {
        const allContext = contextTypes.map(type => {
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
        <>
            <div className="flex flex-col h-[500px]">
                <div className="flex flex-1 min-h-0">
                    <div className="w-48 border-r border-slate-800 bg-slate-950/30 p-2 space-y-1 overflow-y-auto">
                        {loading ? (
                            <div className="flex items-center justify-center py-8 text-slate-500">
                                <Loader2 size={16} className="animate-spin" />
                            </div>
                        ) : contextTypes.length === 0 ? (
                            <div className="text-xs text-slate-500 text-center py-4 px-2">
                                No context files found.<br />Run a doc workflow or add files to <code className="text-cyan-500">.context/</code>
                            </div>
                        ) : (
                            contextTypes.map(type => (
                                <button
                                    key={type.id}
                                    onClick={() => setActiveType(type.id)}
                                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${activeType === type.id
                                        ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                        }`}
                                >
                                    <div className="flex items-center gap-1.5">
                                        {type.isMap ? <Map size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
                                        <span className="font-medium truncate">{type.label}</span>
                                    </div>
                                </button>
                            ))
                        )}
                        {contextTypes.length > 0 && (
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
                        )}
                        <div className={`pt-2 mt-2 border-t border-slate-800 ${contextTypes.length === 0 ? 'mt-auto' : ''}`}>
                            <button
                                onClick={() => setShowDeleteModal(true)}
                                className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors text-red-400/50 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-2"
                            >
                                <Trash2 size={14} />
                                <span>Delete Project</span>
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 flex flex-col bg-slate-950">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50">
                            <div className="flex items-center gap-2 text-slate-300">
                                <FileText size={16} className="text-cyan-500" />
                                <span className="font-mono text-sm">{activeType ? `${activeType}.md` : 'No file selected'}</span>
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
                                    value={(activeType && contexts[activeType]?.status) || 'draft'}
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

                        <div className="flex-1 relative overflow-auto">
                            {loading ? (
                                <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                                    <Loader2 className="animate-spin mb-2" />
                                </div>
                            ) : (
                                viewMode === 'preview' ? (
                                    <div className="p-4 prose prose-invert prose-sm max-w-none">
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                                h1: ({ children }) => (
                                                    <h1 className="text-xl font-bold text-white mt-6 mb-3 pb-2 border-b border-cyan-500/30">{children}</h1>
                                                ),
                                                h2: ({ children }) => (
                                                    <h2 className="text-lg font-semibold text-slate-100 mt-5 mb-2 pb-1.5 border-b border-slate-700">{children}</h2>
                                                ),
                                                h3: ({ children }) => (
                                                    <h3 className="text-base font-semibold text-slate-200 mt-4 mb-2">{children}</h3>
                                                ),
                                                h4: ({ children }) => (
                                                    <h4 className="text-sm font-semibold text-slate-300 mt-3 mb-1">{children}</h4>
                                                ),
                                                p: ({ children }) => (
                                                    <p className="text-sm text-slate-300 leading-relaxed mb-3">{children}</p>
                                                ),
                                                ul: ({ children }) => (
                                                    <ul className="list-disc list-inside text-sm text-slate-300 space-y-1 mb-3 ml-2">{children}</ul>
                                                ),
                                                ol: ({ children }) => (
                                                    <ol className="list-decimal list-inside text-sm text-slate-300 space-y-1 mb-3 ml-2">{children}</ol>
                                                ),
                                                li: ({ children }) => (
                                                    <li className="text-sm text-slate-300 leading-relaxed">{children}</li>
                                                ),
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                code({ node, inline, className, children, ...props }: any) {
                                                    const match = /language-(\w+)/.exec(className || '');
                                                    const isMermaid = match && match[1] === 'mermaid';

                                                    if (!inline && isMermaid) {
                                                        return (
                                                            <div className="my-4 p-4 rounded-lg border border-slate-800 bg-slate-900/50 overflow-x-auto">
                                                                <MermaidViewer chart={String(children).replace(/\n$/, '')} />
                                                            </div>
                                                        );
                                                    }
                                                    return !inline ? (
                                                        <pre className="bg-slate-950 border border-slate-700 rounded-lg p-3 overflow-x-auto mb-3">
                                                            <code className={`text-xs font-mono text-slate-300 ${className || ''}`} {...props}>
                                                                {children}
                                                            </code>
                                                        </pre>
                                                    ) : (
                                                        <code className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 text-xs font-mono border border-slate-700" {...props}>
                                                            {children}
                                                        </code>
                                                    );
                                                },
                                                blockquote: ({ children }) => (
                                                    <blockquote className="border-l-3 border-purple-500/50 pl-4 py-1 my-3 bg-purple-500/5 rounded-r-lg text-slate-400 italic">{children}</blockquote>
                                                ),
                                                table: ({ children }) => (
                                                    <div className="overflow-x-auto mb-3">
                                                        <table className="min-w-full text-xs border-collapse border border-slate-700 rounded-lg overflow-hidden">{children}</table>
                                                    </div>
                                                ),
                                                thead: ({ children }) => (
                                                    <thead className="bg-slate-800">{children}</thead>
                                                ),
                                                th: ({ children }) => (
                                                    <th className="px-3 py-2 text-left text-slate-300 font-semibold border border-slate-700">{children}</th>
                                                ),
                                                td: ({ children }) => (
                                                    <td className="px-3 py-2 text-slate-400 border border-slate-700">{children}</td>
                                                ),
                                                hr: () => (
                                                    <hr className="border-slate-700 my-4" />
                                                ),
                                                strong: ({ children }) => (
                                                    <strong className="text-slate-100 font-semibold">{children}</strong>
                                                ),
                                                a: ({ href, children }) => (
                                                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline decoration-cyan-500/30 hover:decoration-cyan-400 transition-colors">{children}</a>
                                                ),
                                            }}
                                        >
                                            {(activeType && contexts[activeType]?.content) || ''}
                                        </ReactMarkdown>
                                    </div>
                                ) : (
                                    <textarea
                                        value={(activeType && contexts[activeType]?.content) || ''}
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
