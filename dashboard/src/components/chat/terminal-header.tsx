"use client"

/**
 * The terminal's own title bar: mode label, project-scope badge, and the
 * new-conversation / history / close controls.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). The bridge
 * viewscreen hides this (hideHeader) and hoists the same controls into the
 * PraxisCore station header, so the chat reads as one surface.
 */

import { Bot, X, Lock, Plus, History } from "lucide-react";

export interface TerminalHeaderProps {
    isInline: boolean;
    scopedProjectId: string | null;
    showConversations: boolean;
    onToggleConversations: () => void;
    onNewConversation: () => void;
    onClose?: () => void;
}

export function TerminalHeader({
    isInline,
    scopedProjectId,
    showConversations,
    onToggleConversations,
    onNewConversation,
    onClose,
}: TerminalHeaderProps) {
    return (
        <div className={`flex items-center justify-between ${
            isInline
                ? 'px-1 pb-1.5 border-b border-slate-800/60'
                : 'px-4 py-3 border-b border-slate-700 bg-slate-800/50'
        }`}>
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                    {isInline ? (
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                            viewscreen · direct line
                        </span>
                    ) : (
                        <>
                            <Bot size={20} className="text-cyan-400" />
                            <span className="font-bold text-white">Praxis Terminal</span>
                        </>
                    )}
                    {scopedProjectId && (
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            <Lock size={10} />
                            <span className="text-[10px] uppercase font-bold tracking-wider">Scoped: {scopedProjectId}</span>
                        </div>
                    )}
                </div>
                {!isInline && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                        Praxis
                    </span>
                )}
            </div>
            <div className="flex items-center gap-1">
                <button
                    onClick={onNewConversation}
                    className="p-1.5 rounded text-slate-400 hover:text-emerald-400 hover:bg-slate-700 transition-colors"
                    title="New Conversation"
                >
                    <Plus size={isInline ? 15 : 18} />
                </button>
                <button
                    onClick={onToggleConversations}
                    className={`p-1.5 rounded transition-colors ${showConversations ? 'text-cyan-400 bg-slate-700' : 'text-slate-400 hover:text-cyan-400 hover:bg-slate-700'}`}
                    title="Conversation History"
                >
                    <History size={isInline ? 15 : 18} />
                </button>
                {!isInline && onClose && (
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                    >
                        <X size={18} />
                    </button>
                )}
            </div>
        </div>
    );
}
