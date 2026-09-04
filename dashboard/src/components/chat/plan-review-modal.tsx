"use client"

/**
 * Fullscreen plan-review modal: the markdown plan, the council rationale, and
 * the approve / request-revisions actions.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03) so the terminal
 * no longer reaches for ReactMarkdown / the syntax highlighter itself. The
 * modal keeps its OWN prose scale (roomier than the transcript's) — that is
 * deliberate, not a drift from MarkdownMessage.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { X, FileText, XCircle, Loader2 } from "lucide-react";

import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import type { CortexArtifact, Message, PlanDraftData } from "@/components/cortex-provider";

export interface CritiqueFeedbackState {
    messageKey: string | null;
    text: string;
    loading: boolean;
}

export interface PlanReviewModalProps {
    data: { artifact: CortexArtifact; messageKey: string };
    readyForReview: Set<string>;
    critiqueFeedback: CritiqueFeedbackState;
    setCritiqueFeedback: React.Dispatch<React.SetStateAction<CritiqueFeedbackState>>;
    approvalLoading: string | null;
    setApprovalLoading: React.Dispatch<React.SetStateAction<string | null>>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    onClose: () => void;
}

export function PlanReviewModal({
    data: reviewModalData,
    readyForReview,
    critiqueFeedback,
    setCritiqueFeedback,
    approvalLoading,
    setApprovalLoading,
    setMessages,
    onClose,
}: PlanReviewModalProps) {
    const planData = reviewModalData.artifact.data as PlanDraftData;
    const modalMsgKey = reviewModalData.messageKey;
    const isRevised = reviewModalData.artifact.type?.trim().toUpperCase() === 'PLAN_REVISED';
    const threadId = (planData as any)?.thread_id;
    const showActions = (planData as any)?.is_final || readyForReview.has(threadId);
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                onClick={() => onClose()}
            />
            {/* Modal */}
            <div className="relative z-10 w-[92vw] max-w-5xl h-[90vh] rounded-2xl border border-slate-600 bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
                {/* Modal Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-800/60 flex-shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={`p-2 rounded-lg ${isRevised ? 'bg-emerald-500/20' : 'bg-blue-500/20'}`}>
                            <FileText size={20} className={isRevised ? 'text-emerald-400' : 'text-blue-400'} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold text-white truncate">
                                {isRevised ? '✅ Final for Review' : 'Draft Plan'} — {planData.title}
                            </h2>
                            <div className="flex items-center gap-2 mt-0.5">
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isRevised
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                                    }`}>v{planData.version || 1}</span>
                                <span className="text-xs text-slate-500">Markdown Plan</span>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={() => onClose()}
                        className="p-2 hover:bg-slate-700 rounded-lg transition-colors flex-shrink-0"
                    >
                        <X size={20} className="text-slate-400" />
                    </button>
                </div>

                {/* Modal Body — Rendered Markdown */}
                <div className="flex-1 overflow-y-auto px-8 py-6 min-h-0">
                    <div className="prose prose-invert prose-sm max-w-none break-words
                        prose-headings:text-slate-100 prose-headings:font-bold
                        prose-h1:text-2xl prose-h1:border-b prose-h1:border-slate-600/50 prose-h1:pb-3 prose-h1:mb-6
                        prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:text-slate-50
                        prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3 prose-h3:text-cyan-300
                        prose-h4:text-base prose-h4:mt-6 prose-h4:mb-2 prose-h4:text-slate-200
                        prose-p:text-slate-300 prose-p:leading-relaxed prose-p:my-3
                        prose-li:text-slate-300 prose-li:my-1 prose-li:leading-relaxed
                        prose-ul:my-3 prose-ol:my-3
                        prose-strong:text-white prose-strong:font-semibold
                        prose-em:text-slate-200
                        prose-code:text-cyan-300 prose-code:bg-slate-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
                        prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
                        prose-hr:border-slate-700/50 prose-hr:my-8
                        prose-blockquote:border-l-cyan-500/70 prose-blockquote:bg-slate-800/30 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:italic prose-blockquote:text-slate-400
                        prose-table:text-sm prose-th:text-slate-200 prose-th:bg-slate-800/50 prose-th:px-4 prose-th:py-2 prose-td:text-slate-300 prose-td:px-4 prose-td:py-2 prose-td:border-slate-700/50
                    ">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                code({ node, inline, className, children, ...props }: any) {
                                    const match = /language-(\w+)/.exec(className || '');
                                    return !inline && match ? (
                                        <SyntaxHighlighter
                                            style={oneDark as any}
                                            language={match[1]}
                                            PreTag="div"
                                            className="rounded-lg !bg-slate-950 !text-sm"
                                            customStyle={{ whiteSpace: "pre-wrap", overflowWrap: "break-word", overflowX: "hidden" }}
                                            codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }}
                                            {...props}
                                        >
                                            {String(children).replace(/\n$/, '')}
                                        </SyntaxHighlighter>
                                    ) : (
                                        <code className={className} {...props}>{children}</code>
                                    );
                                },
                            }}
                        >
                            {normalizeMarkdown(planData.markdown) || ''}
                        </ReactMarkdown>
                    </div>

                    {/* Rationale — shown at bottom after reading the plan */}
                    {planData.rationale && (
                        <div className="mt-8 px-5 py-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                            <div className="flex items-center gap-2 mb-3">
                                <div className="w-1 h-5 rounded-full bg-amber-400/60" />
                                <span className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Council Rationale</span>
                            </div>
                            <div className="prose prose-invert prose-sm max-w-none
                                prose-p:text-amber-200/90 prose-p:leading-relaxed prose-p:my-2
                                prose-strong:text-amber-300 prose-strong:font-semibold
                                prose-li:text-amber-200/90 prose-li:my-1
                                prose-ol:my-2 prose-ul:my-2
                                prose-code:text-amber-300 prose-code:bg-amber-900/30 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
                            ">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {planData.rationale}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>

                {/* Modal Footer — Actions */}
                {showActions && (
                    <div className="flex-shrink-0 px-6 py-4 border-t border-slate-700 bg-slate-800/60">
                        {critiqueFeedback.messageKey === modalMsgKey ? (
                            <div className="space-y-3">
                                <label className="block text-sm font-medium text-red-300">Revision Feedback</label>
                                <textarea
                                    value={critiqueFeedback.text}
                                    onChange={(e) => setCritiqueFeedback(prev => ({ ...prev, text: e.target.value }))}
                                    placeholder="Describe the changes you'd like to see..."
                                    className="w-full h-28 bg-slate-950 border border-slate-600 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-red-500 focus:outline-none resize-none"
                                    autoFocus
                                    disabled={critiqueFeedback.loading}
                                />
                                <div className="flex gap-3 justify-end">
                                    <button
                                        onClick={() => setCritiqueFeedback({ messageKey: null, text: '', loading: false })}
                                        className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors"
                                        disabled={critiqueFeedback.loading}
                                    >Cancel</button>
                                    <button
                                        onClick={async () => {
                                            if (!critiqueFeedback.text.trim()) return;
                                            setCritiqueFeedback(prev => ({ ...prev, loading: true }));
                                            const formData = new FormData();
                                            formData.append('thread_id', threadId || 'unknown');
                                            formData.append('action', 'REJECT');
                                            formData.append('comment', critiqueFeedback.text);
                                            try {
                                                const response = await fetch(`/api/terminal/interact`, {
                                                    method: 'POST',
                                                    body: formData
                                                });
                                                if (!response.ok) throw new Error('Failed to submit feedback');
                                                setMessages(prev => [...prev, {
                                                    role: 'user',
                                                    content: `🔄 Requested revision: ${critiqueFeedback.text}`,
                                                    timestamp: new Date()
                                                }]);
                                                setCritiqueFeedback({ messageKey: null, text: '', loading: false });
                                                onClose();
                                            } catch (e) {
                                                console.error('Critique failed:', e);
                                                setMessages(prev => [...prev, {
                                                    role: 'system',
                                                    content: '❌ Failed to submit feedback. Please try again.',
                                                    timestamp: new Date()
                                                }]);
                                                setCritiqueFeedback(prev => ({ ...prev, loading: false }));
                                            }
                                        }}
                                        disabled={critiqueFeedback.loading || !critiqueFeedback.text.trim()}
                                        className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    >
                                        {critiqueFeedback.loading && <Loader2 size={14} className="animate-spin" />}
                                        {critiqueFeedback.loading ? 'Submitting...' : 'Submit Feedback'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setCritiqueFeedback({ messageKey: modalMsgKey, text: '', loading: false })}
                                    className="flex-1 py-3 px-4 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 flex items-center justify-center gap-2 transition-colors font-medium"
                                    disabled={approvalLoading === modalMsgKey}
                                >
                                    <XCircle size={18} /> Request Revisions
                                </button>
                                <button
                                    onClick={async () => {
                                        if (!threadId || threadId === 'unknown') {
                                            setMessages(prev => [...prev, {
                                                role: 'system',
                                                content: '❌ Cannot approve: No valid thread ID found. Please try again.',
                                                timestamp: new Date()
                                            }]);
                                            return;
                                        }
                                        setApprovalLoading(modalMsgKey);
                                        const formData = new FormData();
                                        formData.append('thread_id', threadId);
                                        formData.append('action', 'APPROVE');
                                        formData.append('comment', 'Plan approved by user');
                                        try {
                                            const response = await fetch(`/api/terminal/interact`, {
                                                method: 'POST',
                                                body: formData
                                            });
                                            if (!response.ok) throw new Error(`Server returned ${response.status}`);
                                            setMessages(prev => [...prev, {
                                                role: 'user',
                                                content: '✅ Plan Approved - Execution starting...',
                                                timestamp: new Date()
                                            }]);
                                            onClose();
                                        } catch (e) {
                                            console.error('Approve failed:', e);
                                            setMessages(prev => [...prev, {
                                                role: 'system',
                                                content: `❌ Approval failed: ${e instanceof Error ? e.message : 'Unknown error'}. Please try again.`,
                                                timestamp: new Date()
                                            }]);
                                        } finally {
                                            setApprovalLoading(null);
                                        }
                                    }}
                                    className="flex-1 py-3 px-4 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 flex items-center justify-center gap-2 transition-colors font-medium"
                                    disabled={approvalLoading === modalMsgKey}
                                >
                                    {approvalLoading === modalMsgKey && <Loader2 size={14} className="animate-spin" />}
                                    {approvalLoading === modalMsgKey ? 'Approving...' : '✅ Approve Plan'}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
