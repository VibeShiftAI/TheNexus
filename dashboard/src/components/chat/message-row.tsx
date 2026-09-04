"use client"

/**
 * One transcript row: system line or card, user/assistant bubble, artifact
 * renderers (plan draft/revised, compiled plan, council vote grid, unknown),
 * the full-status-report briefing player, and inline voice notes.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). Every prop,
 * title, className and data-message-row attribute is unchanged — this file is
 * a move, not a redesign.
 */

import { Bot, User, Loader2, X, XCircle, Maximize2, Square, ChevronRight, Volume2, Save } from "lucide-react";

import { MarkdownMessage, TaskLinkedText } from "@/components/chat/markdown-message";
import { fullReportAudioForMessage } from "@/lib/chat-audio";
import { voiceKeyForMessage } from "@/hooks/use-chat-audio";
import type { CritiqueFeedbackState } from "@/components/chat/plan-review-modal";
import type {
    ChatAudioNowPlaying,
    CortexArtifact,
    Message,
    PlanDraftData,
    CompiledPlanData,
    VoteSummaryData,
    UnknownArtifactData,
} from "@/components/cortex-provider";
import type { ChatAudioItem } from "@/lib/chat-audio";

export interface MessageRowProps {
    msg: Message;
    rowKey: string;
    /** Index within the visible window — the voice-memo filename uses it. */
    i: number;
    /** True for the newest visible row (drives the inline "thinking" spinner). */
    isLast: boolean;
    loading: boolean;
    readyForReview: Set<string>;
    expandedArtifact: string | null;
    setExpandedArtifact: React.Dispatch<React.SetStateAction<string | null>>;
    setReviewModalData: React.Dispatch<React.SetStateAction<{ artifact: CortexArtifact; messageKey: string } | null>>;
    critiqueFeedback: CritiqueFeedbackState;
    setCritiqueFeedback: React.Dispatch<React.SetStateAction<CritiqueFeedbackState>>;
    approvalLoading: string | null;
    setApprovalLoading: React.Dispatch<React.SetStateAction<string | null>>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    chatAudio: ChatAudioNowPlaying | null;
    toggleChatAudio: (item: ChatAudioItem) => void;
    pauseChatAudio: () => void;
    voiceAudioRefs: React.MutableRefObject<Map<string, HTMLAudioElement>>;
    nowPlayingVoiceRef: React.MutableRefObject<string | null>;
    dismissedVoice: Set<string>;
    setDismissedVoice: React.Dispatch<React.SetStateAction<Set<string>>>;
    listenedVoice: Set<string>;
    setListenedVoice: React.Dispatch<React.SetStateAction<Set<string>>>;
    getPlayedVoice: () => Set<string>;
    markVoicePlayed: (key: string) => void;
    playNextQueuedVoice: () => void;
    saveVoiceMemo: (audio: string, mimeType: string, msgIndex: number, voiceIndex: number) => void;
}

export function MessageRow({
    msg,
    rowKey,
    i,
    isLast,
    loading,
    readyForReview,
    expandedArtifact,
    setExpandedArtifact,
    setReviewModalData,
    critiqueFeedback,
    setCritiqueFeedback,
    approvalLoading,
    setApprovalLoading,
    setMessages,
    chatAudio,
    toggleChatAudio,
    pauseChatAudio,
    voiceAudioRefs,
    nowPlayingVoiceRef,
    dismissedVoice,
    setDismissedVoice,
    listenedVoice,
    setListenedVoice,
    getPlayedVoice,
    markVoicePlayed,
    playNextQueuedVoice,
    saveVoiceMemo,
}: MessageRowProps) {
    return msg.role === 'system' ? (
        /* Multi-line / pre-formatted system events (e.g. [MORNING PLAN])
           render as a card with markdown. Single-line events stay compact. */
        (msg.content && msg.content.includes('\n')) ? (
            <div key={rowKey} data-message-row="system" className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-cyan-500/10 text-cyan-400">
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-500/70" />
                </div>
                <div className="min-w-0 flex-1 rounded-lg px-4 py-3 bg-slate-800/60 border border-cyan-500/20 text-slate-200">
                    <MarkdownMessage content={msg.content} />
                </div>
            </div>
        ) : (
            /* System messages: compact activity log line */
            <div key={rowKey} data-message-row="system" className="flex items-center gap-2 py-1 px-2">
                {loading && isLast ? (
                    <Loader2 size={12} className="text-cyan-500/60 animate-spin flex-shrink-0" />
                ) : (
                    <div className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-cyan-500/50" />
                    </div>
                )}
                <span className="text-xs text-slate-400"><TaskLinkedText text={msg.content} /></span>
            </div>
        )
    ) : (
        <div
            key={rowKey}
            data-message-row={msg.role}
            className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
        >
            <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                ? 'bg-cyan-500/20 text-cyan-400'
                : msg.role === 'assistant'
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'bg-red-500/20 text-red-400'
                }`}>
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </div>
            <div className={`min-w-0 break-words ${msg.role === 'user' ? 'max-w-[80%]' : 'max-w-[92%]'} rounded-lg px-4 py-2 ${msg.role === 'user'
                ? 'bg-cyan-500/10 text-white'
                : msg.role === 'assistant'
                    ? 'bg-slate-800 text-slate-200'
                    : 'bg-red-500/10 text-red-400'
                }`}>
                {/* Assistant turns render as markdown at the shared prose
                    scale so Praxis's replies match the system cards; user
                    turns stay literal (no markdown surprises on typed text). */}
                {msg.content && (msg.role === 'assistant'
                    ? <MarkdownMessage content={msg.content} />
                    : <p className="text-sm leading-relaxed whitespace-pre-wrap break-words"><TaskLinkedText text={msg.content} /></p>)}
                {/* Render PLAN_DRAFT and PLAN_REVISED artifacts */}
                {(msg.artifact?.type?.trim().toUpperCase() === 'PLAN_DRAFT' || msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED') && (
                    <div className={`mt-3 p-4 rounded-lg ${msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                        ? 'border border-emerald-500/50 bg-emerald-900/20'
                        : 'border border-blue-500/50 bg-blue-900/20'
                        }`}>
                        <div className="flex justify-between items-center">
                            <h3 className={`font-bold ${msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                                ? 'text-emerald-300'
                                : 'text-blue-300'
                                }`}>
                                {msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                                    ? `✅ Final for Review — Plan v${(msg.artifact.data as PlanDraftData).version || 1}`
                                    : (msg.artifact.data as PlanDraftData).is_final
                                        ? `Final Review: Plan v${(msg.artifact.data as PlanDraftData).version || (msg.artifact.data as PlanDraftData).revision || 1}`
                                        : `Draft Plan v${(msg.artifact.data as PlanDraftData).version || (msg.artifact.data as PlanDraftData).revision || 1}`
                                }: {(msg.artifact.data as PlanDraftData).title}
                            </h3>
                            {/* Open fullscreen review modal for markdown plans */}
                            {(msg.artifact.data as PlanDraftData).markdown && (
                                <button
                                    onClick={() => setReviewModalData({ artifact: msg.artifact!, messageKey: rowKey })}
                                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                    <Maximize2 size={12} /> Open Full View
                                </button>
                            )}
                            {/* Legacy nodes expand toggle */}
                            {!(msg.artifact.data as PlanDraftData).markdown && ((msg.artifact.data as PlanDraftData).nodes?.length || 0) > 3 && (
                                <button
                                    onClick={() => setExpandedArtifact(expandedArtifact === rowKey ? null : rowKey)}
                                    className="text-xs text-blue-400 hover:text-blue-300 underline"
                                >
                                    {expandedArtifact === rowKey ? 'Collapse' : 'Expand Details'}
                                </button>
                            )}
                        </div>
                        {/* Markdown plans: show summary + open modal button */}
                        {(msg.artifact.data as PlanDraftData).markdown ? (
                            <>
                                <div
                                    className="mt-2 text-sm text-slate-400 cursor-pointer hover:text-blue-300 transition-colors flex items-center gap-2"
                                    onClick={() => setReviewModalData({ artifact: msg.artifact!, messageKey: rowKey })}
                                >
                                    <span>Markdown Plan (v{(msg.artifact.data as PlanDraftData).version || 1})</span>
                                    <span className="text-xs text-slate-500">— click to review</span>
                                </div>
                                {(msg.artifact.data as PlanDraftData).rationale && (
                                    <div className="mt-2 text-xs text-amber-400 bg-amber-900/20 p-2 rounded">
                                        <span className="font-semibold">Rationale:</span> {(msg.artifact.data as PlanDraftData).rationale}
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div className="mt-2 text-sm text-gray-300">
                                    Proposed Steps: {(msg.artifact.data as PlanDraftData).nodes?.length || 0}
                                </div>
                                <ul className="mt-2 text-xs text-slate-400 space-y-1">
                                    {(expandedArtifact === rowKey
                                        ? (msg.artifact.data as PlanDraftData).nodes || []
                                        : ((msg.artifact.data as PlanDraftData).nodes || []).slice(0, 3)
                                    ).map((node, idx) => (
                                        <li key={idx}>• [{node.type}] {node.description}</li>
                                    ))}
                                    {expandedArtifact !== rowKey && ((msg.artifact.data as PlanDraftData).nodes?.length || 0) > 3 && (
                                        <li className="text-slate-500 cursor-pointer hover:text-blue-400" onClick={() => setExpandedArtifact(rowKey)}>...and {((msg.artifact.data as PlanDraftData).nodes?.length || 0) - 3} more</li>
                                    )}
                                </ul>
                            </>
                        )}
                        {/* Only show Approve/Critique buttons when plan is marked as final for review */}
                        {((msg.artifact?.data as PlanDraftData)?.is_final || readyForReview.has((msg.artifact?.data as any)?.thread_id)) && (
                            <div className="mt-3 flex gap-2">
                                <button
                                    onClick={async () => {
                                        const threadId = (msg.artifact?.data as any)?.thread_id;
                                        if (!threadId || threadId === 'unknown') {
                                            setMessages(prev => [...prev, {
                                                role: 'system',
                                                content: '❌ Cannot approve: No valid thread ID found. Please try again.',
                                                timestamp: new Date()
                                            }]);
                                            return;
                                        }
                                        setApprovalLoading(rowKey);
                                        const formData = new FormData();
                                        formData.append('thread_id', threadId);
                                        formData.append('action', 'APPROVE');
                                        formData.append('comment', 'Plan approved by user');
                                        try {
                                            const response = await fetch(`/api/terminal/interact`, {
                                                method: 'POST',
                                                body: formData
                                            });
                                            if (!response.ok) {
                                                throw new Error(`Server returned ${response.status}`);
                                            }
                                            setMessages(prev => [...prev, {
                                                role: 'user',
                                                content: '✅ Plan Approved - Execution starting...',
                                                timestamp: new Date()
                                            }]);
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
                                    className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    disabled={critiqueFeedback.messageKey === rowKey || approvalLoading === rowKey}
                                >
                                    {approvalLoading === rowKey && <Loader2 size={14} className="animate-spin" />}
                                    {approvalLoading === rowKey ? 'Approving...' : 'Approve'}
                                </button>
                                <button
                                    onClick={() => setCritiqueFeedback({ messageKey: rowKey, text: '', loading: false })}
                                    className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm transition-colors"
                                    disabled={critiqueFeedback.messageKey === rowKey || approvalLoading === rowKey}
                                >Critique</button>
                            </div>
                        )}
                        {/* Inline Critique Feedback Form */}
                        {critiqueFeedback.messageKey === rowKey && (
                            <div className="mt-3 border border-red-500/30 bg-red-900/20 rounded-lg p-3">
                                <label className="block text-xs text-red-300 mb-2 font-medium">Revision Feedback</label>
                                <textarea
                                    value={critiqueFeedback.text}
                                    onChange={(e) => setCritiqueFeedback(prev => ({ ...prev, text: e.target.value }))}
                                    placeholder="Describe the changes you'd like to see..."
                                    className="w-full h-24 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-red-500 focus:outline-none resize-none"
                                    autoFocus
                                    disabled={critiqueFeedback.loading}
                                />
                                <div className="mt-2 flex gap-2 justify-end">
                                    <button
                                        onClick={() => setCritiqueFeedback({ messageKey: null, text: '', loading: false })}
                                        className="px-3 py-1 text-slate-400 hover:text-white text-sm transition-colors"
                                        disabled={critiqueFeedback.loading}
                                    >Cancel</button>
                                    <button
                                        onClick={async () => {
                                            if (!critiqueFeedback.text.trim()) return;
                                            setCritiqueFeedback(prev => ({ ...prev, loading: true }));
                                            const threadId = (msg.artifact?.data as any)?.thread_id || 'unknown';
                                            const formData = new FormData();
                                            formData.append('thread_id', threadId);
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
                                        className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    >
                                        {critiqueFeedback.loading && <Loader2 size={14} className="animate-spin" />}
                                        {critiqueFeedback.loading ? 'Submitting...' : 'Submit Feedback'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {/* Render COMPILED_PLAN artifacts */}
                {msg.artifact?.type?.trim().toUpperCase() === 'COMPILED_PLAN' && (
                    <div className="mt-3 border border-emerald-500/50 bg-emerald-900/20 p-4 rounded-lg">
                        <h4 className="font-semibold text-emerald-300">🔧 Compiled Plan: {(msg.artifact.data as CompiledPlanData).title}</h4>
                        <p className="mt-1 text-sm text-slate-300">{(msg.artifact.data as CompiledPlanData).goal}</p>
                        <ul className="mt-2 text-xs text-slate-400 space-y-1">
                            {(msg.artifact.data as CompiledPlanData).nodes?.map((node, idx) => (
                                <li key={idx}>• [{node.type}] {node.description}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {/* Render COUNCIL_REVIEW artifacts - VoteGrid */}
                {(msg.artifact?.type?.trim().toUpperCase() === 'COUNCIL_REVIEW' || msg.artifact?.type?.trim().toUpperCase() === 'VOTE_SUMMARY') && (
                    <div className="mt-3 border border-purple-500/50 bg-purple-900/20 rounded-lg p-4">
                        <div className="flex justify-between items-center mb-2">
                            <h4 className="font-semibold text-purple-300">Council Review</h4>
                            <button
                                onClick={() => setExpandedArtifact(expandedArtifact === rowKey ? null : rowKey)}
                                className="text-xs text-purple-400 hover:text-purple-300 underline"
                            >
                                {expandedArtifact === rowKey ? 'Collapse' : 'Expand Details'}
                            </button>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                            {(msg.artifact.data as VoteSummaryData).votes.map((vote, idx) => (
                                <div key={idx} className={`p-2 rounded text-center cursor-pointer hover:opacity-80 ${vote.decision === 'approve' ? 'bg-green-800/50 border border-green-600/30' :
                                    vote.decision === 'reject' ? 'bg-red-800/50 border border-red-600/30' :
                                        'bg-yellow-800/50 border border-yellow-600/30'
                                    }`}
                                    onClick={() => setExpandedArtifact(expandedArtifact === rowKey ? null : rowKey)}
                                >
                                    <div className="font-semibold text-white">{vote.voter}</div>
                                    <div className={`text-lg ${vote.decision === 'approve' ? 'text-green-400' :
                                        vote.decision === 'reject' ? 'text-red-400' : 'text-yellow-400'
                                        }`}>
                                        {vote.decision === 'approve' ? '✅' : vote.decision === 'reject' ? '❌' : '❓'}
                                    </div>
                                    <div className="text-slate-400 truncate" title={vote.reasoning}>
                                        {expandedArtifact === rowKey ? vote.reasoning : vote.reasoning.substring(0, 40) + '...'}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {/* Full reasoning panel when expanded */}
                        {expandedArtifact === rowKey && (
                            <div className="mt-3 pt-3 border-t border-purple-500/30 space-y-2">
                                <h5 className="text-sm font-semibold text-purple-300">Full Reasoning:</h5>
                                {(msg.artifact.data as VoteSummaryData).votes.map((vote, idx) => (
                                    <div key={idx} className={`p-2 rounded text-xs ${vote.decision === 'approve' ? 'bg-green-900/30' :
                                        vote.decision === 'reject' ? 'bg-red-900/30' : 'bg-yellow-900/30'
                                        }`}>
                                        <div className="font-semibold text-white mb-1">{vote.voter} ({vote.decision})</div>
                                        <div className="text-slate-300 whitespace-pre-wrap break-words">{vote.reasoning}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {/* Phase 8: Render UNKNOWN_ARTIFACT with attention flag */}
                {msg.artifact?.type === 'UNKNOWN_ARTIFACT' && (
                    <div className="mt-3 border border-orange-500/50 bg-orange-900/20 rounded-lg p-4">
                        <div className="flex items-center gap-2 text-orange-400">
                            <span className="text-lg">⚠️</span>
                            <span className="font-bold">Requires Attention</span>
                        </div>
                        <p className="mt-2 text-sm text-slate-300">
                            Unknown event from node: <code className="bg-slate-800 px-1 rounded">{(msg.artifact.data as UnknownArtifactData).node_name}</code>
                        </p>
                        <pre className="mt-2 text-xs text-slate-400 bg-slate-800 p-2 rounded overflow-x-auto">
                            {(msg.artifact.data as UnknownArtifactData).data.substring(0, 200)}...
                        </pre>
                    </div>
                )}
                {/* DEFAULT: Catch-all for any unrecognized artifact type (e.g., UNKNOWN_SIGNAL) */}
                {msg.artifact && !['PLAN_DRAFT', 'PLAN_REVISED', 'COUNCIL_REVIEW', 'VOTE_SUMMARY', 'COMPILED_PLAN', 'CHAT_RESPONSE', 'UNKNOWN_ARTIFACT', 'STATUS_UPDATE', 'READY_FOR_REVIEW'].includes(msg.artifact.type) && (
                    <div className="mt-3 p-4 rounded-lg border border-yellow-500/50 bg-yellow-900/20 text-yellow-200 font-mono text-sm">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xl">⚠️</span>
                            <span className="font-bold">UNKNOWN SIGNAL</span>
                            <span className="text-xs text-yellow-400/70 ml-auto">{msg.artifact.type}</span>
                        </div>
                        <pre className="text-xs text-yellow-200/70 overflow-auto max-h-40 bg-black/40 p-2 rounded">
                            {JSON.stringify(msg.artifact.data, null, 2)}
                        </pre>
                        <div className="mt-2 text-[10px] uppercase tracking-widest text-yellow-600">
                            Flagged for Human Review
                        </div>
                    </div>
                )}
                {/* Full status-report briefing: plays on the GLOBAL player so
                    it keeps going when Robert opens the fullscreen inbox. */}
                {(() => {
                    const reportAudio = fullReportAudioForMessage(msg);
                    if (!reportAudio) return null;
                    const isCurrent = chatAudio?.item.key === reportAudio.key;
                    const isPlaying = isCurrent && chatAudio.playing;
                    const wasHeard = getPlayedVoice().has(reportAudio.key);
                    return (
                        <div className={`mt-3 w-fit rounded-lg border p-3 transition-all duration-500 ${
                            wasHeard && !isPlaying
                                ? 'border-cyan-500/10 bg-black/20'
                                : 'border-cyan-500/40 bg-cyan-950/30 shadow-[0_0_12px_rgba(34,211,238,0.15)]'
                        }`}>
                            <div className="mb-2 flex items-center gap-2 px-1">
                                <Volume2 size={12} className={isPlaying ? 'animate-pulse text-cyan-400' : 'text-cyan-400/70'} />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">
                                    Morning Status Briefing
                                </span>
                                <a
                                    href={reportAudio.src}
                                    download={reportAudio.name}
                                    className="ml-auto rounded p-1 text-cyan-400/60 transition-colors hover:bg-cyan-500/20 hover:text-cyan-300"
                                    title="Save briefing MP3"
                                >
                                    <Save size={12} />
                                </a>
                            </div>
                            <div className="flex items-center gap-3 px-1">
                                <button
                                    onClick={() => {
                                        markVoicePlayed(reportAudio.key);
                                        voiceAudioRefs.current.forEach((el) => {
                                            if (!el.paused) el.pause();
                                        });
                                        toggleChatAudio(reportAudio);
                                    }}
                                    className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-500/40 text-cyan-300 transition hover:bg-cyan-500/20"
                                    title={isPlaying ? 'Pause briefing' : 'Play briefing'}
                                >
                                    {isPlaying ? <Square size={11} /> : <ChevronRight size={16} />}
                                </button>
                                <span className="text-[10px] tabular-nums text-slate-400">
                                    {isCurrent
                                        ? `${Math.floor(chatAudio.currentTime / 60)}:${String(Math.floor(chatAudio.currentTime % 60)).padStart(2, '0')} elapsed — keeps playing across pages`
                                        : wasHeard ? 'Played on this device' : 'Full spoken briefing'}
                                </span>
                            </div>
                        </div>
                    );
                })()}
                {/* Render Voice Data (suppressed when the full briefing
                    attachment is this message's report audio) */}
                {!fullReportAudioForMessage(msg) && msg.voiceData && msg.voiceData.map((v, vidx) => {
                    const voiceKey = voiceKeyForMessage(msg, vidx);
                    if (dismissedVoice.has(voiceKey)) return null;
                    const isListened = listenedVoice.has(voiceKey) || getPlayedVoice().has(voiceKey);
                    return (
                        <div 
                            key={vidx} 
                            className={`mt-3 p-3 rounded-lg w-fit transition-all duration-500 ${
                                isListened 
                                    ? 'bg-black/20 border border-purple-500/10' 
                                    : 'bg-purple-950/30 border border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-2 px-1">
                                <Volume2 size={12} className={`${isListened ? 'text-purple-400/50' : 'text-purple-400 animate-pulse'}`} />
                                <span className={`text-[10px] uppercase tracking-wider font-bold ${isListened ? 'text-purple-400/50' : 'text-purple-400'}`}>
                                    {isListened ? 'Voice Message' : '🔔 New Voice Message'}
                                </span>
                                <div className="flex items-center gap-1 ml-auto">
                                    <button
                                        onClick={() => saveVoiceMemo(v.audio, v.mimeType, i, vidx)}
                                        className="p-1 rounded hover:bg-purple-500/20 text-purple-400/60 hover:text-purple-300 transition-colors"
                                        title="Save voice memo"
                                    >
                                        <Save size={12} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            // A dismissed note must never auto-replay after refresh.
                                            markVoicePlayed(voiceKey);
                                            setDismissedVoice(prev => new Set([...prev, voiceKey]));
                                        }}
                                        className="p-1 rounded hover:bg-red-500/20 text-slate-500 hover:text-red-400 transition-colors"
                                        title="Dismiss"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            </div>
                            <audio
                                src={`data:${v.mimeType};base64,${v.audio}`}
                                controls
                                ref={(el) => {
                                    if (el) voiceAudioRefs.current.set(voiceKey, el);
                                    else voiceAudioRefs.current.delete(voiceKey);
                                }}
                                onPlay={() => {
                                    // One voice at a time — a manual play preempts everything else,
                                    // including the global briefing player.
                                    pauseChatAudio();
                                    voiceAudioRefs.current.forEach((el, k) => {
                                        if (k !== voiceKey && !el.paused) el.pause();
                                    });
                                    nowPlayingVoiceRef.current = voiceKey;
                                    // Started once on this device = never auto-replayed
                                    // (manual replays via the controls still work).
                                    markVoicePlayed(voiceKey);
                                }}
                                onEnded={() => {
                                    setListenedVoice(prev => new Set([...prev, voiceKey]));
                                    if (nowPlayingVoiceRef.current === voiceKey) {
                                        nowPlayingVoiceRef.current = null;
                                    }
                                    playNextQueuedVoice();
                                }}
                                className="h-8 max-w-[260px] [&::-webkit-media-controls-enclosure]:bg-transparent"
                            />
                        </div>
                    );
                })}

                <span className="text-[10px] text-slate-500 mt-1 block">
                    {msg.timestamp.toLocaleTimeString()}
                </span>
            </div>
        </div>
    );
}
