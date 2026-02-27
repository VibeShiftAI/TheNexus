'use client';

/**
 * AnnotatedMarkdown - Markdown viewer with inline commenting
 * 
 * Features:
 * - Renders markdown with proper formatting
 * - Users can select text and add comments
 * - Comments appear as highlights with popovers
 * - Comments can be marked as resolved
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquare, Check, X, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { InlineComment, getInlineComments, addInlineComment, resolveInlineComment } from '@/lib/nexus';

interface AnnotatedMarkdownProps {
    content: string;
    stage: 'research' | 'plan' | 'walkthrough' | 'spec';
    taskId: string;
    projectId: string;
    readOnly?: boolean;
    onCommentAdded?: (comment: InlineComment) => void;
}

export function AnnotatedMarkdown({
    content,
    stage,
    taskId,
    projectId,
    readOnly = false,
    onCommentAdded
}: AnnotatedMarkdownProps) {
    const [comments, setComments] = useState<InlineComment[]>([]);
    const [selectedText, setSelectedText] = useState<string>('');
    const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
    const [showCommentInput, setShowCommentInput] = useState(false);
    const [newComment, setNewComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showCommentsSidebar, setShowCommentsSidebar] = useState(true);
    const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Load comments
    useEffect(() => {
        async function loadComments() {
            const loaded = await getInlineComments(projectId, taskId, stage);
            setComments(loaded);
        }
        loadComments();
    }, [projectId, taskId, stage]);

    // Handle text selection
    const handleMouseUp = useCallback(() => {
        if (readOnly) return;

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) {
            setSelectedText('');
            setShowCommentInput(false);
            return;
        }

        const text = selection.toString().trim();
        if (text.length > 0 && text.length < 500) {
            setSelectedText(text);

            // Try to get character offsets relative to content
            const range = selection.getRangeAt(0);
            const preSelectionRange = range.cloneRange();
            if (contentRef.current) {
                preSelectionRange.selectNodeContents(contentRef.current);
                preSelectionRange.setEnd(range.startContainer, range.startOffset);
                const start = preSelectionRange.toString().length;
                setSelectionRange({ start, end: start + text.length });
            }

            setShowCommentInput(true);
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [readOnly]);

    // Submit comment
    const handleSubmitComment = async () => {
        if (!newComment.trim() || !selectedText) return;

        setIsSubmitting(true);
        try {
            const result = await addInlineComment(projectId, taskId, {
                stage,
                selectionText: selectedText,
                selectionStart: selectionRange?.start,
                selectionEnd: selectionRange?.end,
                comment: newComment.trim()
            });

            setComments(prev => [...prev, result.comment]);
            setNewComment('');
            setSelectedText('');
            setShowCommentInput(false);
            onCommentAdded?.(result.comment);
        } catch (error) {
            console.error('Failed to add comment:', error);
        } finally {
            setIsSubmitting(false);
        }
    };

    // Resolve comment
    const handleResolveComment = async (commentId: string, resolved: boolean) => {
        try {
            const result = await resolveInlineComment(projectId, taskId, commentId, resolved);
            setComments(prev => prev.map(c => c.id === commentId ? result.comment : c));
        } catch (error) {
            console.error('Failed to resolve comment:', error);
        }
    };

    // Highlight text that has comments
    const getHighlightedContent = () => {
        if (comments.length === 0) return content;

        // For now, we'll show comments in sidebar and highlight on hover
        // Full inline highlighting requires complex text range tracking
        return content;
    };

    const unresolvedComments = comments.filter(c => !c.resolved);
    const resolvedComments = comments.filter(c => c.resolved);

    return (
        <div className="annotated-markdown relative">
            {/* Comment count badge */}
            {comments.length > 0 && (
                <button
                    onClick={() => setShowCommentsSidebar(!showCommentsSidebar)}
                    className="absolute -right-2 -top-2 flex items-center gap-1 px-2 py-1 rounded-full bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs hover:bg-purple-500/30 transition-colors z-10"
                >
                    <MessageSquare size={12} />
                    {unresolvedComments.length > 0 && (
                        <span>{unresolvedComments.length}</span>
                    )}
                    {showCommentsSidebar ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
            )}

            <div className="flex gap-4">
                {/* Main content */}
                <div
                    ref={contentRef}
                    className="flex-1 prose prose-invert prose-sm max-w-none"
                    onMouseUp={handleMouseUp}
                >
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
                            code: ({ className, children, ...props }) => {
                                const isInline = !className;
                                if (isInline) {
                                    return <code className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 text-xs font-mono border border-slate-700">{children}</code>;
                                }
                                return (
                                    <pre className="bg-slate-950 border border-slate-700 rounded-lg p-3 overflow-x-auto mb-3">
                                        <code className={`text-xs font-mono text-slate-300 ${className}`}>{children}</code>
                                    </pre>
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
                    >{getHighlightedContent()}</ReactMarkdown>
                </div>

                {/* Comments sidebar */}
                {showCommentsSidebar && comments.length > 0 && (
                    <div className="w-72 shrink-0 space-y-3">
                        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                            Comments ({comments.length})
                        </div>

                        {/* Unresolved comments */}
                        {unresolvedComments.map(comment => (
                            <div
                                key={comment.id}
                                className={`p-3 rounded-lg border transition-all ${activeCommentId === comment.id
                                    ? 'border-purple-500 bg-purple-500/10'
                                    : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                                    }`}
                                onMouseEnter={() => setActiveCommentId(comment.id)}
                                onMouseLeave={() => setActiveCommentId(null)}
                            >
                                <div className="text-xs text-slate-500 mb-2 italic truncate">
                                    "{comment.selectionText.slice(0, 50)}..."
                                </div>
                                <div className="text-sm text-slate-300 mb-2">
                                    {comment.comment}
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-slate-500">
                                        {new Date(comment.createdAt).toLocaleDateString()}
                                    </span>
                                    <button
                                        onClick={() => handleResolveComment(comment.id, true)}
                                        className="flex items-center gap-1 px-2 py-1 rounded text-xs text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                    >
                                        <Check size={12} />
                                        Resolve
                                    </button>
                                </div>
                            </div>
                        ))}

                        {/* Resolved comments (collapsed) */}
                        {resolvedComments.length > 0 && (
                            <details className="group">
                                <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400">
                                    {resolvedComments.length} resolved comment{resolvedComments.length > 1 ? 's' : ''}
                                </summary>
                                <div className="mt-2 space-y-2">
                                    {resolvedComments.map(comment => (
                                        <div
                                            key={comment.id}
                                            className="p-2 rounded border border-slate-700/50 bg-slate-800/30 opacity-60"
                                        >
                                            <div className="text-xs text-slate-500 line-through">
                                                {comment.comment}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                )}
            </div>

            {/* Comment input popup */}
            {showCommentInput && selectedText && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[500px] p-4 rounded-xl bg-slate-800 border border-slate-600 shadow-2xl z-50">
                    <div className="flex items-start gap-3">
                        <MessageSquare size={20} className="text-purple-400 mt-1 shrink-0" />
                        <div className="flex-1">
                            <div className="text-xs text-slate-400 mb-2">
                                Commenting on: <span className="text-purple-300 italic">"{selectedText.slice(0, 60)}{selectedText.length > 60 ? '...' : ''}"</span>
                            </div>
                            <textarea
                                ref={inputRef}
                                value={newComment}
                                onChange={(e) => setNewComment(e.target.value)}
                                placeholder="Add your comment or feedback..."
                                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-purple-500 resize-none"
                                rows={2}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        handleSubmitComment();
                                    }
                                    if (e.key === 'Escape') {
                                        setShowCommentInput(false);
                                        setSelectedText('');
                                    }
                                }}
                            />
                            <div className="flex items-center justify-between mt-2">
                                <span className="text-xs text-slate-500">
                                    Ctrl+Enter to submit, Esc to cancel
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => {
                                            setShowCommentInput(false);
                                            setSelectedText('');
                                        }}
                                        className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:bg-slate-700"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleSubmitComment}
                                        disabled={!newComment.trim() || isSubmitting}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isSubmitting ? 'Saving...' : (
                                            <>
                                                <Send size={14} />
                                                Add Comment
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}


export default AnnotatedMarkdown;
