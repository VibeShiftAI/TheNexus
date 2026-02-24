"use client";

import { useState, useEffect } from "react";
import { X, MessageSquare, Check, XCircle, FileText, Code, Database, Image } from "lucide-react";
import { MarkdownReviewer } from "./markdown-reviewer";
import { JsonViewer } from "./json-viewer";
import { CodeViewer } from "./code-viewer";

export interface Artifact {
    id: string;
    key: string;
    name: string;
    content: string;
    content_json?: any;
    file_path?: string;
    has_binary?: boolean;
    category: string;
    mime_type: string;
    file_extension: string;
    producer_node_type?: string;
    version?: number;
    created_at?: string;
    tags?: string[];
    metadata?: Record<string, any>;
}

export interface Comment {
    id: string;
    artifact_id: string;
    line_number: number;
    content: string;
    author: string;
    created_at: string;
    resolved: boolean;
    replies: Comment[];
}

interface ArtifactPanelProps {
    artifact: Artifact | null;
    isOpen: boolean;
    onClose: () => void;
    onApprove: (comments?: string) => void;
    onReject: (feedback: string) => void;
}

// Category styling
const CATEGORY_STYLES: Record<string, { bg: string; text: string; icon: any }> = {
    plan: { bg: "bg-purple-500/20", text: "text-purple-400", icon: FileText },
    research: { bg: "bg-cyan-500/20", text: "text-cyan-400", icon: Database },
    code: { bg: "bg-emerald-500/20", text: "text-emerald-400", icon: Code },
    document: { bg: "bg-blue-500/20", text: "text-blue-400", icon: FileText },
    media: { bg: "bg-amber-500/20", text: "text-amber-400", icon: Image },
    data: { bg: "bg-orange-500/20", text: "text-orange-400", icon: Database },
    default: { bg: "bg-slate-500/20", text: "text-slate-400", icon: FileText },
};

export function ArtifactPanel({ artifact, isOpen, onClose, onApprove, onReject }: ArtifactPanelProps) {
    const [comments, setComments] = useState<Comment[]>([]);
    const [rejectFeedback, setRejectFeedback] = useState("");
    const [showRejectInput, setShowRejectInput] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Fetch comments when artifact changes
    useEffect(() => {
        if (artifact?.id && isOpen) {
            setIsLoading(true);
            fetch(`http://localhost:8000/api/artifacts/${artifact.id}/comments`)
                .then(r => r.json())
                .then(data => {
                    setComments(data.comments || []);
                    setIsLoading(false);
                })
                .catch(err => {
                    console.error("Failed to fetch comments:", err);
                    setIsLoading(false);
                });
        }
    }, [artifact?.id, isOpen]);

    // Reset state when panel closes
    useEffect(() => {
        if (!isOpen) {
            setRejectFeedback("");
            setShowRejectInput(false);
        }
    }, [isOpen]);

    if (!isOpen || !artifact) return null;

    const handleAddComment = async (lineNumber: number, content: string) => {
        try {
            const res = await fetch(`http://localhost:8000/api/artifacts/${artifact.id}/comments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ line_number: lineNumber, content }),
            });
            if (res.ok) {
                const data = await res.json();
                setComments(prev => [...prev, data.comment]);
            }
        } catch (err) {
            console.error("Failed to add comment:", err);
        }
    };

    const handleResolveComment = async (commentId: string) => {
        // Find the comment to check its current state
        const comment = comments.find(c => c.id === commentId);
        if (!comment) return;

        const endpoint = comment.resolved
            ? `http://localhost:8000/api/comments/${commentId}/unresolve`
            : `http://localhost:8000/api/comments/${commentId}/resolve`;

        try {
            await fetch(endpoint, { method: "POST" });
            setComments(prev => prev.map(c =>
                c.id === commentId ? { ...c, resolved: !c.resolved } : c
            ));
        } catch (err) {
            console.error("Failed to toggle comment resolved state:", err);
        }
    };

    const handleAddReply = async (commentId: string, content: string) => {
        try {
            const res = await fetch(`http://localhost:8000/api/comments/${commentId}/reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            });
            if (res.ok) {
                const data = await res.json();
                // Add reply to the parent comment's replies array
                setComments(prev => prev.map(c =>
                    c.id === commentId
                        ? { ...c, replies: [...c.replies, data.reply] }
                        : c
                ));
            }
        } catch (err) {
            console.error("Failed to add reply:", err);
        }
    };

    const getCategoryStyle = () => {
        return CATEGORY_STYLES[artifact.category] || CATEGORY_STYLES.default;
    };

    const renderContent = () => {
        const mimeType = artifact.mime_type;

        // JSON content
        if (mimeType === "application/json" || artifact.content_json) {
            return <JsonViewer data={artifact.content_json || JSON.parse(artifact.content || "{}")} />;
        }

        // Markdown content (research, plans, documents)
        if (mimeType === "text/markdown" ||
            mimeType.startsWith("text/markdown") ||
            artifact.category === "research" ||
            artifact.category === "plan" ||
            artifact.category === "document") {
            return (
                <MarkdownReviewer
                    content={artifact.content || ""}
                    comments={comments}  // Pass all comments, component handles filtering
                    onAddComment={handleAddComment}
                    onResolveComment={handleResolveComment}
                    onAddReply={handleAddReply}
                />
            );
        }

        // Code content
        if (mimeType === "text/x-code" || artifact.category === "code") {
            // Try to detect language from file extension
            const langMap: Record<string, string> = {
                ".py": "python",
                ".js": "javascript",
                ".ts": "typescript",
                ".tsx": "tsx",
                ".jsx": "jsx",
                ".json": "json",
                ".html": "html",
                ".css": "css",
                ".md": "markdown",
            };
            const language = langMap[artifact.file_extension] || "text";
            return <CodeViewer content={artifact.content || ""} language={language} />;
        }

        // Default: plain text as code
        return <CodeViewer content={artifact.content || ""} language="text" />;
    };

    const style = getCategoryStyle();
    const IconComponent = style.icon;
    const unresolvedCount = comments.filter(c => !c.resolved).length;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/30 z-40 transition-opacity duration-300"
                onClick={onClose}
            />

            {/* Panel */}
            <div className={`
                fixed right-0 top-0 h-full w-[650px] 
                bg-slate-900 border-l border-slate-700 
                shadow-2xl z-50
                transform transition-transform duration-300 ease-out
                ${isOpen ? 'translate-x-0' : 'translate-x-full'}
                flex flex-col
            `}>
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-slate-700 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${style.bg}`}>
                            <IconComponent size={18} className={style.text} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-lg font-semibold text-white">{artifact.name || artifact.key}</h2>
                                <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${style.bg} ${style.text}`}>
                                    {artifact.category}
                                </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                                {artifact.mime_type} • v{artifact.version || 1}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
                    >
                        <X size={20} className="text-slate-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 min-h-0">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-32">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
                        </div>
                    ) : (
                        renderContent()
                    )}
                </div>

                {/* Review Actions Footer */}
                <div className="flex-shrink-0 p-4 border-t border-slate-700 bg-slate-900/95 backdrop-blur">
                    {showRejectInput ? (
                        <div className="space-y-3">
                            <label className="block text-sm font-medium text-slate-300">
                                What needs to be revised?
                            </label>
                            <textarea
                                value={rejectFeedback}
                                onChange={(e) => setRejectFeedback(e.target.value)}
                                placeholder="Explain what changes are needed..."
                                className="w-full h-24 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 resize-none focus:outline-none focus:border-red-500/50 placeholder-slate-600"
                                autoFocus
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowRejectInput(false)}
                                    className="flex-1 py-2 px-4 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => {
                                        onReject(rejectFeedback);
                                        setShowRejectInput(false);
                                    }}
                                    disabled={!rejectFeedback.trim()}
                                    className="flex-1 py-2 px-4 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Request Revisions
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowRejectInput(true)}
                                    className="flex-1 py-3 px-4 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 flex items-center justify-center gap-2 transition-colors"
                                >
                                    <XCircle size={18} /> Request Revisions
                                </button>
                                <button
                                    onClick={() => onApprove()}
                                    className="flex-1 py-3 px-4 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 flex items-center justify-center gap-2 transition-colors"
                                >
                                    <Check size={18} /> Approve
                                </button>
                            </div>

                            {unresolvedCount > 0 && (
                                <div className="flex items-center justify-center gap-2 text-xs text-amber-400 bg-amber-500/10 py-2 rounded-lg">
                                    <MessageSquare size={14} />
                                    {unresolvedCount} unresolved comment{unresolvedCount !== 1 ? 's' : ''}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
