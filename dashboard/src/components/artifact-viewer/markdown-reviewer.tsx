"use client";

import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MessageSquarePlus, Check, X, CheckCircle, CornerDownRight, Reply, Eye, EyeOff, RotateCcw } from "lucide-react";
import type { Comment } from "./artifact-panel";

interface MarkdownReviewerProps {
    content: string;
    comments: Comment[];
    onAddComment: (lineNumber: number, content: string) => void;
    onResolveComment?: (commentId: string) => void;
    onAddReply?: (commentId: string, content: string) => void;
}

export function MarkdownReviewer({
    content,
    comments,
    onAddComment,
    onResolveComment,
    onAddReply
}: MarkdownReviewerProps) {
    const [hoveredLine, setHoveredLine] = useState<number | null>(null);
    const [commentingLine, setCommentingLine] = useState<number | null>(null);
    const [newComment, setNewComment] = useState("");
    const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
    const [showResolved, setShowResolved] = useState(false);

    // Reply state
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [replyContent, setReplyContent] = useState("");

    // Defensive: ensure content is always a string (backend may send objects/arrays)
    const safeContent = typeof content === 'string' ? content : (content ? JSON.stringify(content, null, 2) : '');

    // Split content into lines for line-by-line rendering
    const lines = safeContent.split('\n');

    // Count stats
    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const resolvedCount = comments.filter(c => c.resolved).length;

    const getCommentsForLine = useCallback((lineNumber: number) => {
        return comments.filter(c => c.line_number === lineNumber && (showResolved || !c.resolved));
    }, [comments, showResolved]);

    const handleSubmitComment = () => {
        if (commentingLine !== null && newComment.trim()) {
            onAddComment(commentingLine, newComment);
            setNewComment("");
            setCommentingLine(null);
        }
    };

    const handleSubmitReply = (commentId: string) => {
        if (replyContent.trim() && onAddReply) {
            onAddReply(commentId, replyContent);
            setReplyContent("");
            setReplyingTo(null);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmitComment();
        }
        if (e.key === "Escape") {
            setCommentingLine(null);
            setNewComment("");
        }
    };

    const handleReplyKeyDown = (e: React.KeyboardEvent, commentId: string) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmitReply(commentId);
        }
        if (e.key === "Escape") {
            setReplyingTo(null);
            setReplyContent("");
        }
    };

    const toggleCommentExpanded = (commentId: string) => {
        setExpandedComments(prev => {
            const next = new Set(prev);
            if (next.has(commentId)) {
                next.delete(commentId);
            } else {
                next.add(commentId);
            }
            return next;
        });
    };

    return (
        <div className="markdown-reviewer font-mono text-sm bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/50">
                <span className="text-xs text-slate-500">
                    {lines.length} lines • Click line numbers to add comments
                </span>
                <div className="flex items-center gap-3">
                    {/* Comment count */}
                    <span className="text-xs text-slate-600">
                        {unresolvedCount} open{resolvedCount > 0 && `, ${resolvedCount} resolved`}
                    </span>

                    {/* Show resolved toggle */}
                    {resolvedCount > 0 && (
                        <button
                            onClick={() => setShowResolved(!showResolved)}
                            className={`
                                flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors
                                ${showResolved
                                    ? 'bg-slate-700 text-slate-300'
                                    : 'bg-slate-800 text-slate-500 hover:text-slate-400'}
                            `}
                            title={showResolved ? "Hide resolved" : "Show resolved"}
                        >
                            {showResolved ? <EyeOff size={12} /> : <Eye size={12} />}
                            {showResolved ? "Hide" : "Show"} resolved
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="p-2">
                {lines.map((line, index) => {
                    const lineNumber = index + 1;
                    const lineComments = getCommentsForLine(lineNumber);
                    const isHovered = hoveredLine === lineNumber;
                    const isCommenting = commentingLine === lineNumber;
                    const hasComments = lineComments.length > 0;
                    const hasUnresolved = lineComments.some(c => !c.resolved);

                    return (
                        <div key={lineNumber} className="relative">
                            {/* Line content with hover indicator */}
                            <div
                                className={`
                                    flex items-start group transition-colors duration-100
                                    ${isHovered ? 'bg-blue-500/5' : ''}
                                    ${hasUnresolved ? 'bg-amber-500/5' : hasComments ? 'bg-slate-800/30' : ''}
                                `}
                                onMouseEnter={() => setHoveredLine(lineNumber)}
                                onMouseLeave={() => setHoveredLine(null)}
                            >
                                {/* Line number gutter */}
                                <div
                                    className={`
                                        w-12 flex-shrink-0 pr-3 text-right select-none cursor-pointer
                                        transition-colors duration-100
                                        ${hasUnresolved ? 'text-amber-500 font-semibold' : hasComments ? 'text-slate-500' : 'text-slate-600'}
                                        ${isHovered ? 'text-blue-400' : ''}
                                        hover:text-blue-400
                                    `}
                                    onClick={() => setCommentingLine(lineNumber)}
                                    title="Click to add comment"
                                >
                                    {lineNumber}
                                </div>

                                {/* Comment indicator */}
                                {hasUnresolved && (
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500/50" />
                                )}
                                {hasComments && !hasUnresolved && (
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-slate-600/50" />
                                )}

                                {/* Line content */}
                                <div className={`
                                    flex-1 py-0.5 px-2 min-h-[1.5rem] text-slate-300
                                    ${hasUnresolved ? 'border-l-2 border-amber-500/30 pl-3' :
                                        hasComments ? 'border-l-2 border-slate-600/30 pl-3' : ''}
                                `}>
                                    <MarkdownLine content={line} />
                                </div>

                                {/* Add comment button (appears on hover) */}
                                <button
                                    onClick={() => setCommentingLine(lineNumber)}
                                    className={`
                                        flex-shrink-0 p-1 mr-2 rounded transition-opacity duration-100
                                        text-blue-400 hover:bg-blue-500/20
                                        ${isHovered && !isCommenting ? 'opacity-100' : 'opacity-0'}
                                    `}
                                    title="Add comment"
                                >
                                    <MessageSquarePlus size={14} />
                                </button>
                            </div>

                            {/* Inline comment input */}
                            {isCommenting && (
                                <div className="ml-12 my-2 p-3 bg-slate-800/80 border border-blue-500/30 rounded-lg shadow-lg animate-in fade-in slide-in-from-top-2 duration-150">
                                    <textarea
                                        value={newComment}
                                        onChange={(e) => setNewComment(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="Add your comment... (Ctrl+Enter to submit)"
                                        className="w-full h-20 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-300 resize-none focus:outline-none focus:border-blue-500 placeholder-slate-600"
                                        autoFocus
                                    />
                                    <div className="flex items-center justify-between mt-2">
                                        <span className="text-[10px] text-slate-600">
                                            Line {lineNumber}
                                        </span>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => { setCommentingLine(null); setNewComment(""); }}
                                                className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded"
                                            >
                                                <X size={16} />
                                            </button>
                                            <button
                                                onClick={handleSubmitComment}
                                                disabled={!newComment.trim()}
                                                className="px-3 py-1.5 bg-blue-500/20 text-blue-400 rounded text-xs font-medium hover:bg-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                                            >
                                                <Check size={14} /> Comment
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Existing comments for this line */}
                            {lineComments.map(comment => (
                                <div
                                    key={comment.id}
                                    className={`
                                        ml-12 my-2 rounded-lg overflow-hidden animate-in fade-in duration-200
                                        ${comment.resolved
                                            ? 'bg-slate-800/30 border border-slate-700/30 opacity-60'
                                            : 'bg-amber-500/5 border border-amber-500/20'}
                                    `}
                                >
                                    {/* Comment header */}
                                    <div className={`
                                        flex items-center justify-between px-3 py-2 border-b
                                        ${comment.resolved
                                            ? 'bg-slate-800/50 border-slate-700/30'
                                            : 'bg-amber-500/10 border-amber-500/10'}
                                    `}>
                                        <div className="flex items-center gap-2">
                                            <div className={`
                                                w-6 h-6 rounded-full flex items-center justify-center
                                                ${comment.resolved ? 'bg-slate-700/50' : 'bg-amber-500/20'}
                                            `}>
                                                <span className={`
                                                    text-xs font-medium
                                                    ${comment.resolved ? 'text-slate-500' : 'text-amber-400'}
                                                `}>
                                                    {comment.author[0].toUpperCase()}
                                                </span>
                                            </div>
                                            <span className={`
                                                text-xs font-medium
                                                ${comment.resolved ? 'text-slate-500 line-through' : 'text-amber-300'}
                                            `}>
                                                {comment.author}
                                            </span>
                                            <span className="text-[10px] text-slate-500">
                                                {new Date(comment.created_at).toLocaleString()}
                                            </span>
                                            {comment.resolved && (
                                                <span className="text-[10px] text-emerald-500 flex items-center gap-1">
                                                    <CheckCircle size={10} /> Resolved
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {/* Reply button */}
                                            {onAddReply && !comment.resolved && (
                                                <button
                                                    onClick={() => setReplyingTo(comment.id)}
                                                    className="p-1 text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 rounded"
                                                    title="Reply"
                                                >
                                                    <Reply size={14} />
                                                </button>
                                            )}
                                            {/* Resolve/Unresolve button */}
                                            {onResolveComment && (
                                                <button
                                                    onClick={() => onResolveComment(comment.id)}
                                                    className={`
                                                        p-1 rounded
                                                        ${comment.resolved
                                                            ? 'text-slate-400 hover:text-amber-400 hover:bg-amber-500/10'
                                                            : 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10'}
                                                    `}
                                                    title={comment.resolved ? "Unresolve" : "Resolve"}
                                                >
                                                    {comment.resolved ? <RotateCcw size={14} /> : <CheckCircle size={14} />}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Comment content */}
                                    <div className="px-3 py-2">
                                        <p className={`text-sm ${comment.resolved ? 'text-slate-500' : 'text-slate-300'}`}>
                                            {comment.content}
                                        </p>
                                    </div>

                                    {/* Reply input */}
                                    {replyingTo === comment.id && (
                                        <div className="px-3 pb-3 border-t border-amber-500/10">
                                            <div className="mt-2">
                                                <textarea
                                                    value={replyContent}
                                                    onChange={(e) => setReplyContent(e.target.value)}
                                                    onKeyDown={(e) => handleReplyKeyDown(e, comment.id)}
                                                    placeholder="Write a reply... (Ctrl+Enter to submit)"
                                                    className="w-full h-16 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-300 resize-none focus:outline-none focus:border-blue-500 placeholder-slate-600"
                                                    autoFocus
                                                />
                                                <div className="flex justify-end gap-2 mt-2">
                                                    <button
                                                        onClick={() => { setReplyingTo(null); setReplyContent(""); }}
                                                        className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        onClick={() => handleSubmitReply(comment.id)}
                                                        disabled={!replyContent.trim()}
                                                        className="px-3 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-medium hover:bg-blue-500/30 disabled:opacity-50"
                                                    >
                                                        Reply
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Replies */}
                                    {comment.replies.length > 0 && (
                                        <div className="border-t border-amber-500/10">
                                            <button
                                                onClick={() => toggleCommentExpanded(comment.id)}
                                                className="w-full px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800/50 flex items-center gap-1"
                                            >
                                                <CornerDownRight size={12} />
                                                {comment.replies.length} repl{comment.replies.length !== 1 ? 'ies' : 'y'}
                                            </button>
                                            {expandedComments.has(comment.id) && (
                                                <div className="px-3 pb-2 space-y-2">
                                                    {comment.replies.map(reply => (
                                                        <div key={reply.id} className="pl-4 border-l-2 border-slate-700">
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <span className="text-xs font-medium text-slate-400">{reply.author}</span>
                                                                <span className="text-[10px] text-slate-600">
                                                                    {new Date(reply.created_at).toLocaleString()}
                                                                </span>
                                                            </div>
                                                            <p className="text-sm text-slate-400">{reply.content}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * Renders a single line of markdown content.
 * Handles basic inline formatting without full block-level markdown.
 */
function MarkdownLine({ content }: { content: string }) {
    // Empty line - render a space to maintain line height
    if (!content.trim()) {
        return <span className="text-slate-600">&nbsp;</span>;
    }

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                // Inline code
                code({ node, inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || '');

                    // Block code (shouldn't happen in single line, but handle it)
                    if (!inline && match) {
                        return (
                            <SyntaxHighlighter
                                style={oneDark}
                                language={match[1]}
                                PreTag="div"
                                customStyle={{
                                    margin: 0,
                                    padding: '0.5rem',
                                    background: '#0f172a',
                                    borderRadius: '0.25rem',
                                }}
                                {...props}
                            >
                                {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                        );
                    }

                    // Inline code
                    return (
                        <code
                            className="bg-slate-800 px-1.5 py-0.5 rounded text-amber-300 text-[0.85em]"
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
                // Links
                a({ node, children, href, ...props }: any) {
                    return (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-400 hover:text-cyan-300 underline"
                            {...props}
                        >
                            {children}
                        </a>
                    );
                },
                // Bold
                strong({ children, ...props }: any) {
                    return <strong className="text-white font-semibold" {...props}>{children}</strong>;
                },
                // Italic
                em({ children, ...props }: any) {
                    return <em className="text-slate-200 italic" {...props}>{children}</em>;
                },
                // Headers (inline, just style them)
                h1({ children, ...props }: any) {
                    return <span className="text-xl font-bold text-white" {...props}>{children}</span>;
                },
                h2({ children, ...props }: any) {
                    return <span className="text-lg font-bold text-white" {...props}>{children}</span>;
                },
                h3({ children, ...props }: any) {
                    return <span className="text-base font-bold text-white" {...props}>{children}</span>;
                },
                // List items (show bullet inline)
                li({ children, ...props }: any) {
                    return <span className="text-slate-300" {...props}>• {children}</span>;
                },
                // Paragraphs (just return children, no wrapping)
                p({ children, ...props }: any) {
                    return <span {...props}>{children}</span>;
                },
            }}
        >
            {content}
        </ReactMarkdown>
    );
}
