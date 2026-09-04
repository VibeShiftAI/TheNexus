"use client"

/**
 * The conversation-history panel: pick a past conversation, or delete one.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03).
 */

import { Trash2, ChevronRight } from "lucide-react";

import type { ChatConversation } from "@/components/cortex-provider";

export interface ConversationListProps {
    isInline: boolean;
    conversations: ChatConversation[];
    conversationId: string | null;
    switchConversation: (id: string) => void;
    deleteConversation: (id: string) => void;
    onPicked: () => void;
}

export function ConversationList({
    isInline,
    conversations,
    conversationId,
    switchConversation,
    deleteConversation,
    onPicked,
}: ConversationListProps) {
    return (
        <div className={`border-b max-h-64 overflow-y-auto ${
            isInline ? 'border-slate-800/60 bg-slate-950/40' : 'border-slate-700 bg-slate-800/50'
        }`}>
            <div className="px-3 py-2 text-xs text-slate-400 font-medium border-b border-slate-700/50 sticky top-0 bg-slate-800/90 backdrop-blur-sm">
                Conversations
            </div>
            {conversations.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-500">No conversations yet</div>
            ) : (
                conversations.map(conv => (
                    <div
                        key={conv.id}
                        className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-l-2 ${
                            conv.id === conversationId
                                ? 'bg-cyan-500/10 border-cyan-500 text-white'
                                : 'border-transparent hover:bg-slate-700/50 text-slate-300 hover:text-white'
                        }`}
                        onClick={() => {
                            switchConversation(conv.id);
                            onPicked();
                        }}
                    >
                        <ChevronRight size={14} className={`flex-shrink-0 transition-transform ${
                            conv.id === conversationId ? 'text-cyan-400 rotate-90' : 'text-slate-500'
                        }`} />
                        <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{conv.title}</div>
                            <div className="text-[10px] text-slate-500">
                                {conv.message_count || 0} messages · {new Date(conv.updated_at).toLocaleDateString()}
                            </div>
                        </div>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (confirm('Delete this conversation?')) {
                                    deleteConversation(conv.id);
                                }
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                            title="Delete conversation"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))
            )}
        </div>
    );
}
